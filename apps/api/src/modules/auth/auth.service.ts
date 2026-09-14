import type { LoginRequest, PublicUser, RegisterRequest } from '@confluence/shared';
import { Prisma, type User } from '../../generated/prisma/client.js';
import { AUDIT_ACTIONS, audit, type RequestContext } from '../../lib/audit.js';
import { sendInBackground } from '../../lib/mailer.js';
import { prisma } from '../../lib/prisma.js';
import { consume, peek, RATE_LIMITS, reset } from '../../lib/rate-limiter.js';
import { HttpError } from '../../middleware/error-handler.js';
import { alreadyRegisteredEmail, verificationEmail } from './emails.js';
import { burnPasswordCheck, hashPassword, isHashOutdated, verifyPassword } from './password.js';
import { createSession, type IssuedSession } from './session.service.js';
import { EMAIL_TOKEN_TTL_MS, generateOpaqueToken, hashToken } from './tokens.js';

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}

/** Only the newest link works: issuing a token invalidates older unused ones. */
async function issueVerificationToken(userId: string): Promise<string> {
  const token = generateOpaqueToken();
  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId, usedAt: null } }),
    prisma.emailVerificationToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS),
      },
    }),
  ]);
  return token;
}

async function handleExistingRegistration(
  existing: User,
  password: string,
  context: RequestContext,
): Promise<void> {
  // Spend the hashing time the new-account path would have spent.
  await burnPasswordCheck(password);

  if (existing.emailVerifiedAt) {
    sendInBackground(alreadyRegisteredEmail(existing.email, existing.displayName));
  } else {
    // An unverified account probably means the first email got lost. Re-send
    // the link rather than leaving the address permanently stuck.
    const token = await issueVerificationToken(existing.id);
    sendInBackground(verificationEmail(existing.email, existing.displayName, token));
  }
  audit(AUDIT_ACTIONS.REGISTER_DUPLICATE, context, { userId: existing.id });
}

/**
 * Deliberately returns nothing. The caller answers "check your email" whether
 * the address was new or already registered, so registration cannot be used
 * to discover which emails have accounts.
 */
export async function register(input: RegisterRequest, context: RequestContext): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    await handleExistingRegistration(existing, input.password, context);
    return;
  }

  const passwordHash = await hashPassword(input.password);

  let user: User;
  try {
    user = await prisma.user.create({
      data: { email: input.email, passwordHash, displayName: input.displayName },
    });
  } catch (error) {
    // Two concurrent registrations for the same email: the loser takes the
    // duplicate path instead of surfacing a 500.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await prisma.user.findUnique({ where: { email: input.email } });
      if (winner) {
        await handleExistingRegistration(winner, input.password, context);
        return;
      }
    }
    throw error;
  }

  const token = await issueVerificationToken(user.id);
  sendInBackground(verificationEmail(user.email, user.displayName, token));
  audit(AUDIT_ACTIONS.REGISTER, context, { userId: user.id });
}

export async function verifyEmail(token: string, context: RequestContext): Promise<string> {
  const record = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!record || record.usedAt || record.expiresAt <= new Date()) {
    throw new HttpError(
      'INVALID_TOKEN',
      'This verification link is invalid or has expired. Request a new one.',
    );
  }

  const verified = await prisma.$transaction(async (tx) => {
    // Conditional update: a double-clicked link must not verify twice.
    const claimed = await tx.emailVerificationToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) return false;

    if (!record.user.emailVerifiedAt) {
      await tx.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      });
    }
    return true;
  });

  if (!verified) {
    throw new HttpError('INVALID_TOKEN', 'This verification link has already been used.');
  }

  audit(AUDIT_ACTIONS.EMAIL_VERIFIED, context, { userId: record.userId });
  return record.user.email;
}

/** Always succeeds from the caller's point of view, for the same reason as register. */
export async function resendVerification(email: string, context: RequestContext): Promise<void> {
  const limit = await consume(RATE_LIMITS.resendVerification, email);
  if (!limit.allowed) return;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.emailVerifiedAt) return;

  const token = await issueVerificationToken(user.id);
  sendInBackground(verificationEmail(user.email, user.displayName, token));
  audit(AUDIT_ACTIONS.VERIFICATION_RESENT, context, { userId: user.id });
}

const INVALID_CREDENTIALS = 'Incorrect email or password.';

export async function login(
  input: LoginRequest,
  context: RequestContext,
): Promise<{ user: User; session: IssuedSession }> {
  // Checked before touching the password, so a locked-out email costs the
  // attacker nothing to try and the server no argon2 time.
  const gate = await peek(RATE_LIMITS.loginFailures, input.email);
  if (!gate.allowed) {
    audit(AUDIT_ACTIONS.LOGIN_RATE_LIMITED, context);
    throw new HttpError(
      'RATE_LIMITED',
      `Too many failed attempts. Try again in ${Math.ceil(gate.retryAfterSeconds / 60)} minutes.`,
    );
  }

  const user = await prisma.user.findUnique({ where: { email: input.email } });

  if (!user) {
    await burnPasswordCheck(input.password);
    await consume(RATE_LIMITS.loginFailures, input.email);
    audit(AUDIT_ACTIONS.LOGIN_FAILURE, context, { metadata: { reason: 'unknown_email' } });
    throw new HttpError('UNAUTHENTICATED', INVALID_CREDENTIALS);
  }

  if (!(await verifyPassword(user.passwordHash, input.password))) {
    await consume(RATE_LIMITS.loginFailures, input.email);
    audit(AUDIT_ACTIONS.LOGIN_FAILURE, context, {
      userId: user.id,
      metadata: { reason: 'bad_password' },
    });
    throw new HttpError('UNAUTHENTICATED', INVALID_CREDENTIALS);
  }

  await reset(RATE_LIMITS.loginFailures, input.email);

  // Only reachable with the correct password, so this reveals nothing to
  // someone who does not already control the account.
  if (!user.emailVerifiedAt) {
    audit(AUDIT_ACTIONS.LOGIN_UNVERIFIED, context, { userId: user.id });
    throw new HttpError(
      'EMAIL_NOT_VERIFIED',
      'Verify your email before signing in. Check your inbox for the link.',
    );
  }

  // Transparently upgrade hashes created under older argon2 parameters.
  if (isHashOutdated(user.passwordHash)) {
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(input.password) },
    });
  }

  const session = await createSession(user.id, context);
  audit(AUDIT_ACTIONS.LOGIN_SUCCESS, context, {
    userId: user.id,
    metadata: { sessionId: session.sessionId },
  });
  return { user, session };
}
