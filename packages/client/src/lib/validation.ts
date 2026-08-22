/**
 * Client-side form pre-validation that reuses the SAME shared Zod schemas the server
 * enforces (spec §2, §5). This is a UX convenience only — the server always re-validates —
 * but sharing the schemas keeps the messages and rules identical on both sides.
 *
 * Each function returns `null` when valid, or the first human-readable error message.
 */
import { z } from 'zod';
import { EmailSchema, PasswordSchema, CreateShopRequestSchema } from '@quickdrop/shared';

function firstIssue<T>(result: z.SafeParseReturnType<unknown, T>): string | null {
  return result.success ? null : result.error.issues[0]?.message ?? 'Invalid value.';
}

/** Email must be a valid address (matches server EmailSchema). */
export function validateEmail(email: string): string | null {
  return firstIssue(EmailSchema.safeParse(email));
}

/** Registration password policy: length only (matches server PasswordSchema, min 8). */
export function validatePassword(password: string): string | null {
  return firstIssue(PasswordSchema.safeParse(password));
}

/** Login only requires a non-empty password (server LoginRequestSchema uses min 1). */
export function validateLoginPassword(password: string): string | null {
  return password.length > 0 ? null : 'Password is required.';
}

/** Shop name: required, ≤ 80 chars (matches server CreateShopRequestSchema). */
export function validateShopName(name: string): string | null {
  return firstIssue(CreateShopRequestSchema.safeParse({ name }));
}
