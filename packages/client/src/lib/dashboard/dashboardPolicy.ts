/**
 * Pure dashboard-lifecycle policy helpers (spec §11, §15, §16). No React/DOM deps so the
 * timing + presentation logic can be unit-tested in the Node environment; the component
 * only wires these constants and formatters into effects.
 */

/**
 * How often the active dashboard device refreshes its presence. Must stay comfortably
 * within the server's presence TTL so the shop reads as "online" between beats (§15).
 */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** Default TTL for a shop-scoped transfer session (mirrors the server default, §16). */
export const TRANSFER_SESSION_TTL_SECONDS = 900;

/**
 * True when a transfer session's expiry (ISO string or epoch ms) is at or before `now`.
 * A non-parseable value is treated as expired so the caller renews rather than trusting it.
 */
export function isSessionExpired(expiresAt: string | number, now: number): boolean {
  const t = typeof expiresAt === 'string' ? new Date(expiresAt).getTime() : expiresAt;
  return !Number.isFinite(t) || t <= now;
}

/** Compact "x ago" phrasing for the take-over prompt. Pure — `now` is injected. */
export function formatRelativeTime(from: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - from) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** One-line description of the device currently holding the dashboard (take-over UI). */
export function describeActiveDevice(
  device: { deviceLabel: string; lastSeenAt: number },
  now: number
): string {
  return `${device.deviceLabel} · last active ${formatRelativeTime(device.lastSeenAt, now)}`;
}
