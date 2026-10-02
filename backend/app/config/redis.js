import Redis from "ioredis";

let _client = null;
let _lastSharedErrorLog = 0;
let _connectionAttempts = 0;

const REDIS_ERROR_LOG_INTERVAL_MS = () =>
  parseInt(process.env.REDIS_ERROR_LOG_INTERVAL_MS || "60000", 10);

/**
 * Single source of truth for whether Redis is used at all. Gated ONLY by
 * REDIS_ENABLED (connection details come solely from REDIS_URL).
 *
 * When false, no Redis connections are created: shared client is null and Bull
 * queues are no-op stubs (use MongoDB orderAutoCancelJob for timeouts).
 *
 * In production mode (NODE_ENV=production), Redis is MANDATORY and this function
 * will throw an error if Redis is not properly configured.
 */
export function isRedisEnabled() {
  const e = process.env.REDIS_ENABLED;
  const isProduction = process.env.NODE_ENV === "production";

  // Default: disable Redis in Jest to avoid open handles + noisy retries.
  // Opt-in by setting REDIS_ENABLED=true.
  if (process.env.NODE_ENV === "test" && !(e === "true" || e === "1")) return false;

  if (e === "false" || e === "0") {
    if (isProduction) {
      throw new Error(
        "Redis is required in production mode (NODE_ENV=production). " +
        "Set REDIS_ENABLED=true and provide REDIS_URL."
      );
    }
    return false;
  }

  // In production, verify Redis configuration is present
  if (isProduction) {
    const hasConfig = !!(process.env.REDIS_URL || e === "true" || e === "1");
    if (!hasConfig) {
      throw new Error(
        "Redis is required in production mode (NODE_ENV=production). " +
        "Please set REDIS_ENABLED=true and REDIS_URL."
      );
    }
  }

  return e === "true" || e === "1" || isProduction;
}

/**
 * Whether Bull queues/workers should run. Gated by BULLMQ_ENABLED, but only
 * ever true when Redis itself is enabled (queues need a Redis connection).
 * Defaults to enabled (true) when unset, so existing REDIS_ENABLED-only
 * deployments keep working without also having to set this flag.
 */
export function isBullMQEnabled() {
  if (!isRedisEnabled()) return false;

  const b = process.env.BULLMQ_ENABLED;
  if (b === "false" || b === "0") return false;
  return true;
}

/**
 * Single error handler so ioredis does not emit "Unhandled error event" when
 * Redis is down; logs are rate-limited.
 */
function attachRedisErrorHandler(client) {
  if (!client || client.__qcRedisErrorHandler) return;
  client.__qcRedisErrorHandler = true;

  client.on("connect", () => {
    _connectionAttempts = 0;
  });

  client.on("ready", () => {
    // suppress per-connection ready noise
  });

  client.on("error", (err) => {
    const now = Date.now();
    const interval = REDIS_ERROR_LOG_INTERVAL_MS();
    if (now - _lastSharedErrorLog > interval) {
      _lastSharedErrorLog = now;
      const isProduction = process.env.NODE_ENV === "production";
      const message = isProduction
        ? `[Redis] ERROR: ${err?.code || err?.message || String(err)} - Redis is required in production`
        : `[Redis] ${err?.code || err?.message || String(err)} — set REDIS_ENABLED=false to run without Redis.`;
      console.warn(message);
    }
  });

  client.on("close", () => {
    // suppress close noise
  });

  client.on("reconnecting", () => {
    _connectionAttempts++;
  });
}

function urlOptions() {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      if (times > 20) return null;
      return Math.min(times * 200, 3000);
    },
  };
}

/**
 * Shared Redis client for caching / rate limits (optional).
 * Returns null when REDIS_ENABLED=false.
 */
export function getRedisClient() {
  if (!isRedisEnabled()) return null;
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_ENABLED=true requires REDIS_URL to be set.");
  }
  _client = new Redis(url, urlOptions());

  attachRedisErrorHandler(_client);
  return _client;
}

/**
 * Bull passes (type, config) where config is merged from options.redis.
 * Mirrors bull/lib/queue.js defaults and attaches the same error handler.
 *
 * `lazyConnect` is deliberately NOT set here. Bull's "bclient" polls jobs via
 * a blocking BRPOPLPUSH loop that starts once the client reaches "ready" —
 * with lazyConnect, ioredis never opens the socket until a command is sent,
 * and Bull never sends that first command until it sees "ready". The two
 * wait on each other forever: the client connects (TCP + CLIENT SETNAME
 * still happen because Bull does send *that* command), but the actual job
 * loop never starts, so every job piles up in "wait" with no error anywhere.
 * Confirmed directly: the same queue/Redis drains immediately the moment
 * lazyConnect is removed.
 */
export function createBullRedisClient(type, config) {
  let client;
  if (typeof config === "string") {
    client = new Redis(config, {
      maxRetriesPerRequest: null,
      retryStrategy(times) {
        if (times > 20) return null;
        return Math.min(times * 200, 3000);
      },
    });
  } else if (["bclient", "subscriber"].includes(type)) {
    client = new Redis({
      ...config,
      maxRetriesPerRequest: null,
    });
  } else {
    client = new Redis({
      ...config,
      maxRetriesPerRequest: null,
    });
  }
  attachRedisErrorHandler(client);
  return client;
}

/**
 * Connection string for Bull, sourced solely from REDIS_URL.
 */
export function getRedisOptionsForBull() {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_ENABLED=true requires REDIS_URL to be set.");
  }
  return url;
}

/**
 * Validate Redis connectivity with PING command
 * @returns {Promise<boolean>} True if Redis responds to PING
 */
export async function validateRedisConnection() {
  const client = getRedisClient();
  if (!client) return false;

  try {
    const result = await client.ping();
    return result === "PONG";
  } catch (error) {
    console.error("[Redis] Validation failed:", error.message);
    return false;
  }
}

/**
 * Wait for Redis connection with exponential backoff retry logic
 * @param {number} maxRetries - Maximum retry attempts (default: 10)
 * @param {number} baseDelay - Base delay in ms (default: 1000)
 * @returns {Promise<void>}
 * @throws {Error} if connection fails after max retries
 */
export async function waitForRedis(maxRetries = 10, baseDelay = 1000) {
  if (!isRedisEnabled()) {
    return;
  }

  const client = getRedisClient();
  if (!client) {
    throw new Error("Redis client is not initialized");
  }

  const isProduction = process.env.NODE_ENV === "production";
  const maxDelay = 30000; // 30 seconds max delay

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Try to connect if not already connected
      if (client.status !== "ready" && client.status !== "connect") {
        await client.connect();
      }

      // Validate connection with PING
      const isValid = await validateRedisConnection();
      if (isValid) {
        return;
      }
    } catch (error) {
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      const isLastAttempt = attempt === maxRetries;

      if (isLastAttempt) {
        const errorMessage = `Failed to connect to Redis after ${maxRetries} attempts: ${error.message}`;
        if (isProduction) {
          console.warn(`[Redis] ⚠️ CRITICAL: ${errorMessage} - Continuing without Redis in production.`);
          return;
        } else {
          console.warn(`[Redis] ${errorMessage} - Continuing without Redis`);
          return;
        }
      }

      console.log(
        `[Redis] Connection attempt ${attempt}/${maxRetries} failed: ${error.message}. ` +
        `Retrying in ${delay}ms...`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
