import express from "express";
import dotenv from "dotenv";
import dns from "node:dns";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import setupRoutes from "./app/routes/index.js";
import { initSocket, getIO } from "./app/socket/socketManager.js";
import { registerOrderSocketGetter } from "./app/services/orderSocketEmitter.js";
import { registerTicketSocketGetter } from "./app/services/ticketSocketEmitter.js";
import {
  globalApiRateLimiter,
} from "./app/middleware/securityMiddlewares.js";
import { structuredRequestLogger, correlationIdMiddleware } from "./app/middleware/requestLogger.js";
import { trackInFlightRequests } from "./app/middleware/metricsMiddleware.js";
import { errorHandler, notFoundHandler } from "./app/middleware/errorMiddleware.js";
import { getProcessRole, isComponentEnabled } from "./app/core/processRole.js";
import { startup } from "./app/core/startup.js";
import {
  registerShutdownHandlers,
  registerHttpServer,
  registerSocketIO,
  registerBullQueue,
  registerSchedulerStopper,
} from "./app/core/shutdown.js";
import { registerScheduledJob, startScheduledJobs } from "./app/services/distributedScheduler.js";
import {
  getFirebaseTrackingCleanupJobHandler,
  getFirebaseTrackingCleanupJobInterval,
  isFirebaseTrackingCleanupJobEnabled,
} from "./app/jobs/firebaseTrackingCleanupJob.js";
import {
  getScheduledParcelDispatchJobHandler,
  getScheduledParcelDispatchJobInterval,
  isScheduledParcelDispatchJobEnabled,
} from "./app/jobs/scheduledParcelDispatchJob.js";
import {
  getStalledAcceptedParcelJobHandler,
  getStalledAcceptedParcelJobInterval,
  isStalledAcceptedParcelJobEnabled,
} from "./app/jobs/stalledAcceptedParcelJob.js";
import {
  getAbandonedCheckoutJobHandler,
  getAbandonedCheckoutJobInterval,
  isAbandonedCheckoutJobEnabled,
} from "./app/jobs/abandonedCheckoutJob.js";
import {
  getReconcilePorterPaymentsJobHandler,
  getReconcilePorterPaymentsJobInterval,
  isReconcilePorterPaymentsJobEnabled,
} from "./app/jobs/reconcilePorterPaymentsJob.js";
import logger from "./app/services/logger.js";
import { stopScheduledJobs } from "./app/services/distributedScheduler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, ".env") });

const PORT = parseInt(process.env.PORT || '7000', 10);
const HEALTH_CHECK_PORT = parseInt(process.env.HEALTH_CHECK_PORT || '9090', 10);
const NODE_ENV = process.env.NODE_ENV || "development";

/**
 * Force public DNS resolvers to avoid local DNS issues (Atlas SRV lookups).
 * - Enabled by default in development when using `mongodb+srv://`
 * - Can be forced via `FORCE_PUBLIC_DNS=true` or disabled via `FORCE_PUBLIC_DNS=false`
 * - Optional override list via `PUBLIC_DNS_SERVERS=8.8.8.8,8.8.4.4,1.1.1.1`
 */
function maybeForcePublicDnsResolvers() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || "";
  const usesSrv = mongoUri.startsWith("mongodb+srv://");

  const forceFlag = (process.env.FORCE_PUBLIC_DNS || "").toLowerCase();
  const enabled =
    usesSrv &&
    (forceFlag === "true" || (forceFlag !== "false" && NODE_ENV === "development"));

  if (!enabled) return;

  const servers = (process.env.PUBLIC_DNS_SERVERS || "8.8.8.8,8.8.4.4,1.1.1.1")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (servers.length === 0) return;

  dns.setServers(servers);
  logger.info("Using custom DNS resolvers for SRV lookups", { servers });
}

maybeForcePublicDnsResolvers();

/**
 * Parse allowed origins from environment
 */
function parseAllowedOrigins() {
  const raw =
    process.env.CORS_ALLOWED_ORIGINS ||
    process.env.FRONTEND_URL ||
    "http://localhost:5173,http://localhost:3000";
  const parsed = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const expanded = new Set(parsed);
  for (const origin of parsed) {
    try {
      const url = new URL(origin);
      if (url.hostname === "localhost") {
        expanded.add(`${url.protocol}//127.0.0.1${url.port ? `:${url.port}` : ""}`);
      } else if (url.hostname === "127.0.0.1") {
        expanded.add(`${url.protocol}//localhost${url.port ? `:${url.port}` : ""}`);
      }
    } catch {
      // Ignore invalid origin entries; startup validation handles env quality elsewhere.
    }
  }

  return [...expanded];
}

/**
 * Parse trust proxy configuration
 */
function parseTrustProxy(value) {
  if (value == null || value === "") return false;
  if (value === "true") return 1;
  if (value === "false") return false;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  return value;
}

/**
 * Create Express app with middleware
 */
function createApp() {
  const app = express();
  const allowedOrigins = parseAllowedOrigins();
  
  app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

  const corsOptions = {
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Correlation-Id",
      "X-Request-Id",
      "X-Admin-Bootstrap-Secret",
    ],
  };

  // Middleware
  app.use(correlationIdMiddleware);
  app.use(structuredRequestLogger);
  app.use(trackInFlightRequests);
  app.use(compression({
    threshold: 1024, // only compress responses > 1KB
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
    },
  }));
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  app.use(cors(corsOptions));
  app.use(globalApiRateLimiter);

  // The gateway webhook signature is computed over the exact bytes sent, so
  // this path must never see a re-serialised body. Mounted before the JSON
  // parser for that reason.
  app.use(
    "/api/payments/webhook/razorpay",
    express.raw({
      type: "application/json",
      limit: process.env.PAYMENT_WEBHOOK_MAX_PAYLOAD || "1mb",
    }),
  );

  // Static storage fallback for uploaded media
  const uploadsDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  app.use(
    "/uploads",
    (req, res, next) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Access-Control-Allow-Origin", "*");
      next();
    },
    express.static(uploadsDir)
  );

  app.use(express.json({ limit: process.env.API_JSON_LIMIT || "25mb" }));
  app.use(express.urlencoded({ limit: process.env.API_URLENCODED_LIMIT || "25mb", extended: true }));

  // Root endpoint
  app.get("/", (req, res) => {
    res.status(200).json({
      success: true,
      error: false,
      message: "SunGguard Courier API",
      result: {
        version: "1.0.0",
        status: "running",
        role: getProcessRole(),
        environment: NODE_ENV,
        correlationId: req.correlationId,
      },
    });
  });

  app.get("/ready", async (req, res) => {
    try {
      const { getReadinessStatus } = await import("./app/services/healthCheck.js");
      const status = await getReadinessStatus();
      if (status.ready) {
        return res.status(200).json({ success: true, error: false, result: status });
      }
      return res.status(503).json({ success: false, error: true, result: status });
    } catch (error) {
      return res.status(503).json({
        success: false,
        error: true,
        message: "Readiness check failed",
        result: { message: error.message },
      });
    }
  });

  // Setup all routes (includes /health, /metrics, /api/*)
  setupRoutes(app);
  
  // Error handlers
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Start HTTP server (API role)
 */
async function startHttpServer() {
  const app = createApp();
  const server = http.createServer(app);
  
  // Initialize Socket.IO
  const allowedOrigins = parseAllowedOrigins();
  const io = new Server(server, {
    cors: {
      origin: true,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });
  
  initSocket(io);
  registerOrderSocketGetter(getIO);
  registerTicketSocketGetter(getIO);
  
  // Register for graceful shutdown
  registerHttpServer(server);
  registerSocketIO(io);
  
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        const isAirPlayPort = PORT === 7000 || PORT === 5000;
        const airPlayHint = isAirPlayPort
          ? "\n\n" +
            "=".repeat(60) +
            "\n[PORT CONFLICT] Port 7000 is occupied by macOS AirPlay Receiver by default!\n" +
            "To free it immediately:\n" +
            "  1. Open macOS System Settings\n" +
            "  2. Go to General > AirDrop & AirPlay (or AirDrop & Handoff)\n" +
            "  3. Toggle 'AirPlay Receiver' to OFF\n" +
            "Alternatively, set PORT=7001 in backend/.env\n" +
            "=".repeat(60)
          : `\n\nPort ${PORT} is already in use by another process.`;
        logger.error(`Failed to start HTTP server: ${err.message}${airPlayHint}`);
      }
      reject(err);
    });

    server.listen(PORT, "0.0.0.0", () => {
      logger.info('HTTP server started', {
        port: PORT,
        environment: NODE_ENV,
        role: getProcessRole()
      });
      resolve(server);
    });
  });
}

/**
 * Start queue workers (Worker role)
 */
async function startQueueWorkers() {
  const { registerNotificationQueueProcessors } = await import(
    "./app/modules/notifications/notification.worker.js"
  );
  const { notificationQueue, notificationDeadQueue } = await import(
    "./app/modules/notifications/notification.queue.js"
  );

  registerNotificationQueueProcessors();

  // Register queues for graceful shutdown
  registerBullQueue(notificationQueue);
  registerBullQueue(notificationDeadQueue);

  logger.info('Queue workers started', {
    queues: [
      'notifications',
      'notifications-dead',
    ],
    role: getProcessRole()
  });
}

/**
 * Start scheduled jobs (Scheduler role)
 */
async function startScheduler() {
  // Firebase RTDB tracking cleanup — safety net for rider-presence nodes
  // that escape the synchronous lifecycle hooks (force-quit, network drop).
  // Per-order tracking is cleaned by hooks; this job only sweeps stale
  // /fleet/active and /deliveries/*/current entries. Toggle via env.
  if (isFirebaseTrackingCleanupJobEnabled()) {
    registerScheduledJob(
      'firebaseTrackingCleanupJob',
      getFirebaseTrackingCleanupJobInterval(),
      getFirebaseTrackingCleanupJobHandler()
    );
  }

  // Bookings whose payment sheet was never completed. Listings already hide
  // them; this stops them accumulating in the collection forever.
  if (isAbandonedCheckoutJobEnabled()) {
    registerScheduledJob(
      'abandonedCheckoutJob',
      getAbandonedCheckoutJobInterval(),
      getAbandonedCheckoutJobHandler()
    );
  }

  // Courier requests booked for a later date and time go out at that time.
  if (isScheduledParcelDispatchJobEnabled()) {
    registerScheduledJob('scheduledParcelDispatchJob', getScheduledParcelDispatchJobInterval(), getScheduledParcelDispatchJobHandler());
  }

  // Rider accepted a courier request and never moved it forward. Cancels it
  // after 3 hours with no status change and refunds any online payment.
  if (isStalledAcceptedParcelJobEnabled()) {
    registerScheduledJob(
      'stalledAcceptedParcelJob',
      getStalledAcceptedParcelJobInterval(),
      getStalledAcceptedParcelJobHandler()
    );
  }

  // Payments Razorpay captured but that never got confirmed back to us —
  // the webhook didn't arrive (or isn't configured) and the client never
  // called /verify. Re-reads status straight from Razorpay for anything
  // stuck past the grace period, same as the webhook would.
  if (isReconcilePorterPaymentsJobEnabled()) {
    registerScheduledJob(
      'reconcilePorterPaymentsJob',
      getReconcilePorterPaymentsJobInterval(),
      getReconcilePorterPaymentsJobHandler()
    );
  }

  // Start all registered jobs
  await startScheduledJobs();
  registerSchedulerStopper(stopScheduledJobs);

  const scheduledJobs = [];
  if (isFirebaseTrackingCleanupJobEnabled()) scheduledJobs.push('firebaseTrackingCleanupJob');
  if (isAbandonedCheckoutJobEnabled()) scheduledJobs.push('abandonedCheckoutJob');
  if (isReconcilePorterPaymentsJobEnabled()) scheduledJobs.push('reconcilePorterPaymentsJob');
  logger.info('Scheduler started', {
    jobs: scheduledJobs,
    role: getProcessRole()
  });
}

/**
 * Start minimal health check server for worker/scheduler roles
 */
async function startHealthCheckServer() {
  const app = express();
  const { getHealthStatus, getReadinessStatus } = await import('./app/services/healthCheck.js');
  
  app.get('/health', async (req, res) => {
    try {
      const status = await getHealthStatus();
      res.status(200).json({ success: true, result: status });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  app.get('/health/ready', async (req, res) => {
    try {
      const status = await getReadinessStatus();
      if (status.ready) {
        res.status(200).json({ success: true, result: status });
      } else {
        res.status(503).json({ success: false, result: status });
      }
    } catch (error) {
      res.status(503).json({ success: false, error: error.message });
    }
  });

  app.get('/ready', async (req, res) => {
    try {
      const status = await getReadinessStatus();
      if (status.ready) {
        res.status(200).json({ success: true, result: status });
      } else {
        res.status(503).json({ success: false, result: status });
      }
    } catch (error) {
      res.status(503).json({ success: false, error: error.message });
    }
  });
  
  return new Promise((resolve) => {
    const server = app.listen(HEALTH_CHECK_PORT, "0.0.0.0", () => {
      logger.info('Health check server started', {
        port: HEALTH_CHECK_PORT,
        role: getProcessRole()
      });
      resolve(server);
    });
    
    registerHttpServer(server);
  });
}

/**
 * Main application bootstrap
 */
async function main() {
  try {
    // Register shutdown handlers first
    registerShutdownHandlers();
    
    // Run startup sequence (validates dependencies, connects to DB/Redis)
    await startup();
    
    const role = getProcessRole();
    
    // Start components based on process role
    if (isComponentEnabled('http')) {
      await startHttpServer();
    }
    
    if (isComponentEnabled('worker')) {
      await startQueueWorkers();
      
      // Start health check server for worker role
      if (!isComponentEnabled('http')) {
        await startHealthCheckServer();
      }
    }
    
    if (isComponentEnabled('scheduler')) {
      await startScheduler();
      
      // Start health check server for scheduler role
      if (!isComponentEnabled('http')) {
        await startHealthCheckServer();
      }
    }
    
    logger.info('Application started successfully', {
      role,
      environment: NODE_ENV,
      components: {
        http: isComponentEnabled('http'),
        worker: isComponentEnabled('worker'),
        scheduler: isComponentEnabled('scheduler')
      }
    });
    
  } catch (error) {
    logger.error('Application startup failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Start the application
main();
