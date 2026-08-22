import { z } from 'zod';

/**
 * Shop-owner authentication DTOs.
 *
 * IMPORTANT: this module intentionally contains NO password hash, auth token, or
 * any secret-bearing shape. Those live only server-side (identity store). Only
 * safe request/response DTOs cross the wire, so a password/hash can never leak
 * into the shared or client bundle. (Spec §2.)
 */

/** Password policy for shop owners. MVP: length only — never logged or echoed. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email({ message: 'Enter a valid email address.' })
  .max(254, { message: 'Email is too long.' });

export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` })
  .max(PASSWORD_MAX_LENGTH, { message: 'Password is too long.' });

/** POST /api/auth/register — create a shop-owner account. */
export const RegisterRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/** POST /api/auth/login */
export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, { message: 'Password is required.' }).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * The safe, public-facing view of a user. Deliberately excludes passwordHash and
 * anything sensitive — this is the ONLY user shape returned by the API.
 */
export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  createdAt: z.number(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

/** GET /api/auth/me — session check. `authenticated:false` for anonymous callers. */
export const MeResponseSchema = z.object({
  authenticated: z.boolean(),
  user: AuthUserSchema.optional(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
