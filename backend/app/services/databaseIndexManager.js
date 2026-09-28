import mongoose from "mongoose";
import * as logger from "./logger.js";

/**
 * Database Index Manager Service
 * 
 * Manages database indexes for optimal query performance across all collections.
 * Provides functions to create, verify, analyze, and monitor indexes.
 */

/**
 * Index definitions for all collections.
 *
 * Phase 3 (P3-2/P3-3/P3-4) rule: this file declares only indexes that are
 * truly *additive* to what model schemas already declare. Any index that
 * already lives on a schema (e.g. `transactionSchema.index({...})`) is NOT
 * repeated here — Mongo would silently no-op the duplicate, but the
 * duplicate misleads future devs into thinking the manager owns it.
 *
 * Removed in Phase 3:
 *   - transactions: two indexes on a `userId` field that does not exist
 *     (schema field is `user`). Replaced with one real-shape index
 *     (`user + userModel + type + createdAt`) that backs withdrawal-history
 *     queries which the legacy indexes failed to cover.
 *   - notifications: index on `read` which is actually `isRead`. Schema
 *     already declares `(recipient, isRead)` and
 *     `(recipient, recipientModel, isRead, createdAt)`, so the manager
 *     entry was both dead and redundant.
 *   - ledgerentries: index on `ownerType`/`ownerId` (schema fields are
 *     `actorType`/`actorId`). Replaced with the real-shape index.
 *   - withdrawals: an entire dead collection block — withdrawals live in
 *     `transactions` with `type:"Withdrawal"`, so the manager was creating
 *     an empty collection on every boot.
 *   - paymentwebhookevents.eventId: schema declares `unique:true`, so
 *     the manager entry was a duplicate that risked an
 *     `IndexOptionsConflict` if options diverged.
 *   - payments.gatewayOrderId: schema declares `unique:true`; the manager
 *     declared `unique:false`. Mongo throws code 85 which the
 *     `createAllIndexes` try/catch silently swallowed.
 */
const INDEX_DEFINITIONS = {
  transactions: [
    // P3-2 fix: the `type:"Withdrawal"` history filter (used by
    // walletAdminService.getSellerWithdrawalsData and the seller wallet
    // history endpoint) needs `type` in the index. Schema already covers
    // `(user, userModel, status, createdAt)` so we add only the type
    // variant here.
    { keys: { user: 1, userModel: 1, type: 1, createdAt: -1 }, options: { name: "idx_user_userModel_type_created", background: true } },
  ],

  notifications: [
    // Schema covers `(recipient, isRead)` and
    // `(recipient, recipientModel, isRead, createdAt)`. The remaining
    // additive needs are the cleanup-job-by-type and the bare
    // recipient+createdAt range scan.
    { keys: { recipient: 1, createdAt: -1 }, options: { name: "idx_recipient_created", background: true } },
    { keys: { type: 1, createdAt: -1 }, options: { name: "idx_type_created", background: true } },
  ],

  sellers: [
    { keys: { isVerified: 1, isActive: 1, createdAt: -1 }, options: { name: "idx_isVerified_isActive_created", background: true } },
    { keys: { email: 1 }, options: { name: "idx_email", background: true, sparse: true } },
    { keys: { phone: 1 }, options: { name: "idx_phone", background: true, sparse: true } },
  ],

  customers: [
    { keys: { phone: 1 }, options: { name: "idx_phone", background: true, sparse: true } },
    { keys: { email: 1 }, options: { name: "idx_email", background: true, sparse: true } },
    { keys: { createdAt: -1 }, options: { name: "idx_created", background: true } },
  ],

  deliveries: [
    { keys: { phone: 1 }, options: { name: "idx_phone", background: true, sparse: true } },
    { keys: { isOnline: 1, isVerified: 1, isActive: 1 }, options: { name: "idx_online_verified_active", background: true } },
  ],

  // NOTE: the `withdrawals` block previously declared here was a phantom
  // collection — withdrawals are stored as `Transaction.type:"Withdrawal"`
  // rows in the `transactions` collection. Removed in P3-2. The migration
  // script `backend/scripts/migrations/drop-dead-indexes.js` drops the
  // empty stray collection on existing deployments.

  tickets: [
    { keys: { status: 1, priority: 1, createdAt: -1 }, options: { name: "idx_status_priority_created", background: true } },
    { keys: { userId: 1, status: 1, createdAt: -1 }, options: { name: "idx_userId_status_created", background: true } },
  ],

  ledgerentries: [
    // P3-2 fix: schema fields are `actorType` + `actorId`, not
    // `ownerType` + `ownerId`. The old manager index was dead.
    { keys: { orderId: 1, actorType: 1, createdAt: -1 }, options: { name: "idx_orderId_actorType_created", background: true } },
    { keys: { actorType: 1, actorId: 1, createdAt: -1 }, options: { name: "idx_actorType_actorId_created", background: true } },
  ],

  paymentwebhookevents: [
    // P3-3 fix: schema already declares `eventId: { unique:true }`. The
    // additive index here is for `(gatewayName, createdAt)` admin filters.
    { keys: { gatewayName: 1, createdAt: -1 }, options: { name: "idx_gatewayName_created", background: true } },
  ],

  payments: [
    // P3-3 fix: schema declares `gatewayOrderId: { unique:true }`. The
    // manager previously declared a conflicting `unique:false` variant.
    // Removed. The additive index below is for the admin
    // `(order, customer)` history aggregation.
    { keys: { order: 1, customer: 1, createdAt: -1 }, options: { name: "idx_order_customer_created", background: true } },
  ],

  // ---- P3-4: missing performance indexes ----

  wallets: [
    // Backs wallet-status filters and the wallet-ledger verifier cron
    // (P2-9), which scans most-recently-touched wallets and computes
    // ledger drift per owner. Schema declares the unique
    // `(ownerType, ownerId)` index but not the status-filtered variant.
    { keys: { ownerType: 1, ownerId: 1, status: 1 }, options: { name: "idx_ownerType_ownerId_status", background: true } },
  ],

  payouts: [
    // Schema declares `(beneficiaryId, payoutType, status)`. The seller /
    // rider history page sorts by `createdAt:-1` — extending the compound
    // with the sort key avoids an in-memory sort step on hot pages.
    { keys: { beneficiaryId: 1, payoutType: 1, status: 1, createdAt: -1 }, options: { name: "idx_beneficiary_payoutType_status_created", background: true } },
  ],

  financeauditlogs: [
    // Backs "show all audit events for order X" — current schema covers
    // each field individually but not the `(orderId, action)` compound.
    { keys: { orderId: 1, action: 1, createdAt: -1 }, options: { name: "idx_orderId_action_created", background: true } },
  ],
};

/**
 * Create all required indexes across all collections
 * @returns {Promise<void>}
 */
export async function createAllIndexes() {
  const startTime = Date.now();
  logger.info("[DatabaseIndexManager] Starting index creation...");
  
  const results = {
    created: 0,
    existing: 0,
    failed: 0,
    errors: [],
  };
  
  try {
    for (const [collectionName, indexes] of Object.entries(INDEX_DEFINITIONS)) {
      const collection = mongoose.connection.collection(collectionName);
      
      for (const indexDef of indexes) {
        try {
          const indexName = indexDef.options?.name || Object.keys(indexDef.keys).join("_");
          
          const existingIndexes = await collection.indexes();
          const indexExists = existingIndexes.some(idx => idx.name === indexName);
          
          if (indexExists) {
            results.existing++;
            continue;
          }
          
          const options = { ...indexDef.options, background: true };
          await collection.createIndex(indexDef.keys, options);
          logger.info(`[DatabaseIndexManager] Created index "${indexName}" on ${collectionName}`);
          results.created++;
          
        } catch (error) {
          if (error.code === 85 || error.codeName === "IndexOptionsConflict") {
            results.existing++;
            continue;
          }
          if (error.code === 26 || error.codeName === "NamespaceNotFound") {
            try {
              await mongoose.connection.createCollection(collectionName);
              const options = { ...indexDef.options, background: true };
              await collection.createIndex(indexDef.keys, options);
              results.created++;
              continue;
            } catch (retryErr) {
              if (retryErr.code === 85 || retryErr.codeName === "IndexOptionsConflict") {
                results.existing++;
                continue;
              }
            }
          }
          
          logger.error(`[DatabaseIndexManager] Failed to create index on ${collectionName}:`, error);
          results.failed++;
          results.errors.push({
            collection: collectionName,
            index: indexDef.options?.name || "unnamed",
            error: error.message,
          });
        }
      }
    }
    
    const duration = Date.now() - startTime;
    logger.info(`[DatabaseIndexManager] Index creation completed in ${duration}ms`, {
      created: results.created,
      existing: results.existing,
      failed: results.failed,
    });
    
    if (results.failed > 0) {
      logger.warn(`[DatabaseIndexManager] ${results.failed} indexes failed to create:`, results.errors);
    }
    
  } catch (error) {
    logger.error("[DatabaseIndexManager] Fatal error during index creation:", error);
    throw error;
  }
}

/**
 * Verify index existence and performance
 * @returns {Promise<Object>} Index health report
 */
export async function verifyIndexes() {
  logger.info("[DatabaseIndexManager] Verifying indexes...");
  
  const report = {
    collections: {},
    summary: {
      totalExpected: 0,
      totalExisting: 0,
      missing: [],
      healthy: true,
    },
  };
  
  try {
    for (const [collectionName, expectedIndexes] of Object.entries(INDEX_DEFINITIONS)) {
      const collection = mongoose.connection.collection(collectionName);
      const existingIndexes = await collection.indexes();
      
      const collectionReport = {
        expected: expectedIndexes.length,
        existing: existingIndexes.length,
        missing: [],
        extra: [],
      };
      
      // Check for missing indexes
      for (const indexDef of expectedIndexes) {
        const indexName = indexDef.options?.name || Object.keys(indexDef.keys).join("_");
        const exists = existingIndexes.some(idx => idx.name === indexName);
        
        if (!exists) {
          collectionReport.missing.push(indexName);
          report.summary.missing.push({ collection: collectionName, index: indexName });
          report.summary.healthy = false;
        }
      }
      
      report.collections[collectionName] = collectionReport;
      report.summary.totalExpected += expectedIndexes.length;
      report.summary.totalExisting += existingIndexes.length;
    }
    
    if (report.summary.healthy) {
      logger.info("[DatabaseIndexManager] All indexes verified successfully");
    } else {
      logger.warn("[DatabaseIndexManager] Missing indexes detected:", report.summary.missing);
    }
    
    return report;
    
  } catch (error) {
    logger.error("[DatabaseIndexManager] Error verifying indexes:", error);
    throw error;
  }
}

/**
 * Analyze slow queries and suggest indexes
 * @param {number} thresholdMs - Slow query threshold in milliseconds (default: 100ms)
 * @returns {Promise<Array>} Array of index suggestions
 */
export async function analyzeSlowQueries(thresholdMs = 100) {
  logger.info(`[DatabaseIndexManager] Analyzing slow queries (threshold: ${thresholdMs}ms)...`);
  
  const suggestions = [];
  
  try {
    // Enable profiling if not already enabled
    const adminDb = mongoose.connection.db.admin();
    await mongoose.connection.db.setProfilingLevel(1, { slowms: thresholdMs });
    
    // Query system.profile collection for slow queries
    const profileCollection = mongoose.connection.db.collection("system.profile");
    const slowQueries = await profileCollection
      .find({ millis: { $gte: thresholdMs } })
      .sort({ ts: -1 })
      .limit(100)
      .toArray();
    
    // Analyze query patterns
    const queryPatterns = new Map();
    
    for (const query of slowQueries) {
      if (!query.ns || !query.command) continue;
      
      const collection = query.ns.split(".").pop();
      const operation = query.op || "unknown";
      const filter = query.command?.filter || query.command?.query || {};
      
      const pattern = {
        collection,
        operation,
        fields: Object.keys(filter),
        executionTime: query.millis,
        timestamp: query.ts,
      };
      
      const key = `${collection}:${pattern.fields.join(",")}`;
      
      if (!queryPatterns.has(key)) {
        queryPatterns.set(key, {
          ...pattern,
          count: 1,
          avgTime: query.millis,
        });
      } else {
        const existing = queryPatterns.get(key);
        existing.count++;
        existing.avgTime = (existing.avgTime * (existing.count - 1) + query.millis) / existing.count;
      }
    }
    
    // Generate suggestions
    for (const [key, pattern] of queryPatterns) {
      if (pattern.count >= 5 && pattern.avgTime >= thresholdMs) {
        suggestions.push({
          collection: pattern.collection,
          suggestedIndex: pattern.fields.reduce((acc, field) => {
            acc[field] = 1;
            return acc;
          }, {}),
          reason: `Frequent slow query (${pattern.count} occurrences, avg ${pattern.avgTime.toFixed(2)}ms)`,
          priority: pattern.avgTime > 500 ? "high" : pattern.avgTime > 200 ? "medium" : "low",
        });
      }
    }
    
    logger.info(`[DatabaseIndexManager] Found ${suggestions.length} index suggestions`);
    return suggestions;
    
  } catch (error) {
    logger.error("[DatabaseIndexManager] Error analyzing slow queries:", error);
    return suggestions;
  }
}

/**
 * Get index usage statistics for a collection
 * @param {string} collectionName - Collection name
 * @returns {Promise<Array>} Array of index statistics
 */
export async function getIndexStats(collectionName) {
  logger.info(`[DatabaseIndexManager] Getting index stats for ${collectionName}...`);
  
  try {
    const collection = mongoose.connection.collection(collectionName);
    
    // Use $indexStats aggregation to get usage statistics
    const stats = await collection.aggregate([
      { $indexStats: {} }
    ]).toArray();
    
    const formattedStats = stats.map(stat => ({
      name: stat.name,
      operations: stat.accesses?.ops || 0,
      since: stat.accesses?.since || null,
      key: stat.key,
      isUnused: (stat.accesses?.ops || 0) === 0,
    }));
    
    // Log unused indexes
    const unusedIndexes = formattedStats.filter(stat => stat.isUnused && stat.name !== "_id_");
    if (unusedIndexes.length > 0) {
      logger.warn(`[DatabaseIndexManager] Unused indexes on ${collectionName}:`, 
        unusedIndexes.map(idx => idx.name)
      );
    }
    
    return formattedStats;
    
  } catch (error) {
    logger.error(`[DatabaseIndexManager] Error getting index stats for ${collectionName}:`, error);
    throw error;
  }
}

export default {
  createAllIndexes,
  verifyIndexes,
  analyzeSlowQueries,
  getIndexStats,
};
