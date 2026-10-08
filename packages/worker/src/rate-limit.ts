// Rate limiting of failed attempts (wrong login tokens, wrong download
// passwords, wrong bearer tokens), in a SQLite-backed Durable Object: one
// object per key, e.g. "login:<ip>". Why a Durable Object and not the Rate
// Limiting binding or the Cache API: see "Implementation notes" in
// docs/design/api.md.
//
// Only failures count. Every attempt is still checked against the counter
// *before* its result is given away: a client that is over the limit gets 429
// whether its guess was right or wrong, so the limit cannot be used as an
// oracle.
//
// Checks whose verdict is cheap (token compares) are decided first and sent
// in one call, hit(failed). Download passwords need PBKDF2, which takes time;
// a check followed by a separate count would let a parallel burst through
// before any failure is counted. So they reserve(): the attempt counts as a
// failure up front, atomically with the check, and a correct password gives
// its slot back with refund().

import { DurableObject } from "cloudflare:workers";

export interface RateLimitRule {
  /** Prefix of the key, so rules never share a counter. */
  name: string;
  /** Failures allowed within the window; the next attempt is refused. */
  limit: number;
  windowSeconds: number;
}

export const RULES = {
  login: { name: "login", limit: 5, windowSeconds: 60 },
  downloadPassword: { name: "dlpw", limit: 5, windowSeconds: 60 },
  bearer: { name: "bearer", limit: 20, windowSeconds: 60 },
} satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the next attempt is allowed (0 when allowed). */
  retryAfter: number;
}

export interface Reservation extends RateLimitResult {
  /** The entry reserved for this attempt, to refund() it; absent if refused (or failed open). */
  at?: number;
}

/**
 * One counter: the times of the failures within the window (a sliding log of at
 * most `limit` entries). Stored, so a restart or eviction does not reset it.
 */
export class RateLimiter extends DurableObject {
  /**
   * Check an attempt and, if it is allowed and `failed`, count it. An attempt
   * made while over the limit is refused and not counted.
   */
  hit(failed: boolean, limit: number, windowSeconds: number): RateLimitResult {
    const { allowed, retryAfter } = this.check(failed, limit, windowSeconds);
    return { allowed, retryAfter };
  }

  /**
   * Check an attempt and, if it is allowed, count it as a failure right away,
   * before its result is known. Check and count are one step (a Durable Object
   * runs one call at a time, and this one never awaits), so of a parallel
   * burst at most `limit` attempts are allowed. A successful attempt gives its
   * entry back with refund().
   */
  reserve(limit: number, windowSeconds: number): Reservation {
    return this.check(true, limit, windowSeconds);
  }

  /** Remove the entry a successful attempt reserved, so successes never use up the limit. */
  refund(at: number): void {
    const failures = this.ctx.storage.kv.get<number[]>("failures") ?? [];
    const index = failures.indexOf(at);
    if (index === -1) return; // already outside the window
    failures.splice(index, 1);
    this.ctx.storage.kv.put("failures", failures);
  }

  private check(count: boolean, limit: number, windowSeconds: number): Reservation {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const recent = (this.ctx.storage.kv.get<number[]>("failures") ?? []).filter(
      (at) => at > now - windowMs,
    );

    if (recent.length >= limit) {
      const oldest = Math.min(...recent);
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      };
    }
    if (!count) return { allowed: true, retryAfter: 0 };
    // Entries are unique, so refund() removes exactly the one it reserved.
    let at = now;
    while (recent.includes(at)) at++;
    recent.push(at);
    this.ctx.storage.kv.put("failures", recent.slice(-limit));
    // Delete the counter once its window has passed, so idle keys leave no data.
    void this.ctx.storage.setAlarm(at + windowMs + 1000);
    return { allowed: true, retryAfter: 0, at };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const failures = this.ctx.storage.kv.get<number[]>("failures") ?? [];
    // A rule's window is at most a minute; anything newer keeps the object alive.
    const latest = Math.max(0, ...failures);
    if (latest > now - 60_000) {
      await this.ctx.storage.setAlarm(latest + 61_000);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}

/**
 * Record an attempt for `key` under `rule` and say whether it may proceed.
 * Pass `failed: false` to only check (successes never count).
 *
 * Fails open: if the Durable Object cannot be reached (e.g. the free plan's
 * daily Durable Object quota is used up), the attempt is allowed and the error
 * logged. The limit is a second line of defence; the token's length is the first.
 */
export async function rateLimit(
  namespace: DurableObjectNamespace<RateLimiter>,
  rule: RateLimitRule,
  key: string,
  failed: boolean,
): Promise<RateLimitResult> {
  try {
    const stub = namespace.get(namespace.idFromName(`${rule.name}:${key}`));
    return await stub.hit(failed, rule.limit, rule.windowSeconds);
  } catch (err) {
    console.error(`[rate-limit] ${rule.name} check failed, allowing the attempt:`, err);
    return { allowed: true, retryAfter: 0 };
  }
}

/**
 * Reserve an attempt for `key` under `rule` before an expensive check: it
 * counts as a failure unless refundAttempt() gives it back. Fails open like
 * rateLimit().
 */
export async function reserveAttempt(
  namespace: DurableObjectNamespace<RateLimiter>,
  rule: RateLimitRule,
  key: string,
): Promise<Reservation> {
  try {
    const stub = namespace.get(namespace.idFromName(`${rule.name}:${key}`));
    return await stub.reserve(rule.limit, rule.windowSeconds);
  } catch (err) {
    console.error(`[rate-limit] ${rule.name} check failed, allowing the attempt:`, err);
    return { allowed: true, retryAfter: 0 };
  }
}

/** Give back a reserved attempt that succeeded. Best effort: an error is only logged. */
export async function refundAttempt(
  namespace: DurableObjectNamespace<RateLimiter>,
  rule: RateLimitRule,
  key: string,
  reservation: Reservation,
): Promise<void> {
  if (reservation.at === undefined) return;
  try {
    const stub = namespace.get(namespace.idFromName(`${rule.name}:${key}`));
    await stub.refund(reservation.at);
  } catch (err) {
    console.error(`[rate-limit] ${rule.name} refund failed:`, err);
  }
}
