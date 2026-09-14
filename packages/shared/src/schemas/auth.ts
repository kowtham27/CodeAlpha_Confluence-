import { z } from 'zod';
import { displayNameSchema, emailSchema } from './common.js';

/**
 * Length is the only composition rule. NIST SP 800-63B: minimum length beats
 * "one uppercase, one symbol" rules, which push users to predictable patterns.
 * The upper bound caps argon2 input so a 10MB "password" cannot be used to
 * burn server CPU.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

/** 32 random bytes, base64url: exactly 43 characters. */
export const opaqueTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid token');

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  // Deliberately not passwordSchema: a login must not reveal the password
  // policy or reject old passwords that predate a policy change.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const verifyEmailRequestSchema = z.object({ token: opaqueTokenSchema });

export const resendVerificationRequestSchema = z.object({ email: emailSchema });

export const forgotPasswordRequestSchema = z.object({ email: emailSchema });

export const resetPasswordRequestSchema = z.object({
  token: opaqueTokenSchema,
  // The new password gets the full policy, unlike login.
  password: passwordSchema,
});

export const publicUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
});

export const authResponseSchema = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int().positive(),
  user: publicUserSchema,
});

export const messageResponseSchema = z.object({ message: z.string() });

export const verifyEmailResponseSchema = z.object({
  message: z.string(),
  email: z.string(),
});

export const resetPasswordResponseSchema = z.object({
  message: z.string(),
  email: z.string(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;
export type ResendVerificationRequest = z.infer<typeof resendVerificationRequestSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type MessageResponse = z.infer<typeof messageResponseSchema>;
export type VerifyEmailResponse = z.infer<typeof verifyEmailResponseSchema>;
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
export type ResetPasswordResponse = z.infer<typeof resetPasswordResponseSchema>;
