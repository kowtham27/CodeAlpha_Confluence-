import type { Request } from 'express';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

export const AUDIT_ACTIONS = {
  REGISTER: 'auth.register',
  REGISTER_DUPLICATE: 'auth.register.duplicate',
  EMAIL_VERIFIED: 'auth.email.verified',
  VERIFICATION_RESENT: 'auth.email.verification_resent',
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILURE: 'auth.login.failure',
  LOGIN_UNVERIFIED: 'auth.login.unverified',
  LOGIN_RATE_LIMITED: 'auth.login.rate_limited',
  REFRESH_REUSE_DETECTED: 'auth.refresh.reuse_detected',
  LOGOUT: 'auth.logout',
  LOGOUT_ALL: 'auth.logout_all',
  PASSWORD_RESET_REQUESTED: 'auth.password_reset.requested',
  PASSWORD_RESET_COMPLETED: 'auth.password_reset.completed',
  ROOM_CREATED: 'room.created',
  ROOM_JOINED: 'room.joined',
  ROOM_ENDED: 'room.ended',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export function requestContext(req: Request): RequestContext {
  return {
    ip: req.ip ?? null,
    // Bounded: the header is attacker-controlled and lands in the database.
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
  };
}

/**
 * Fire-and-forget. An audit write failing must never fail the user's request,
 * but it must be loud, because a silent gap in the audit log is its own
 * security problem.
 */
export function audit(
  action: AuditAction,
  context: RequestContext,
  details: {
    userId?: string | null;
    roomId?: string | null;
    metadata?: Record<string, string>;
  } = {},
): void {
  prisma.auditLog
    .create({
      data: {
        action,
        ip: context.ip,
        userAgent: context.userAgent,
        userId: details.userId ?? null,
        roomId: details.roomId ?? null,
        ...(details.metadata ? { metadata: details.metadata } : {}),
      },
    })
    .catch((error: unknown) => {
      logger.error({ err: error, action }, 'audit write failed');
    });
}
