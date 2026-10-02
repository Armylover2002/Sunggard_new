import { getRedisClient } from "../config/redis.js";

/**
 * Fixed-window request counter shared by every OTP send/verify gate
 * (customer, delivery). Redis-backed when available so limits hold across
 * processes; falls back to an in-memory map (per-process only) when Redis
 * is disabled, same as the rest of the app's rate limiters.
 *
 * Returns true while under `limit` for the window, false once it's hit.
 */
export async function incrementWindowCounter(redisKey, { limit, windowSeconds }) {
  const redis = getRedisClient();
  if (redis) {
    try {
      const [count] = await Promise.all([
        redis.incr(redisKey),
        redis.expire(redisKey, windowSeconds),
      ]);
      return Number(count) <= limit;
    } catch {
      // fallback below
    }
  }

  if (!globalThis.__OTP_WINDOW_COUNTER__) {
    globalThis.__OTP_WINDOW_COUNTER__ = new Map();
  }
  const now = Date.now();
  const map = globalThis.__OTP_WINDOW_COUNTER__;
  const entry = map.get(redisKey);
  if (!entry || entry.expiresAt <= now) {
    map.set(redisKey, {
      count: 1,
      expiresAt: now + windowSeconds * 1000,
    });
    return true;
  }
  entry.count += 1;
  map.set(redisKey, entry);
  return entry.count <= limit;
}
