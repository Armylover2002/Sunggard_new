/**
 * Long-lived disposable MongoDB for the QA run — test tooling only.
 *
 * Runs the in-memory replica set in its OWN process so the API can be
 * restarted (to pick up a code fix) without losing the test data that has
 * been built up through the UI. Storage is still a temp directory that is
 * discarded when this process exits — nothing is written to a real cluster.
 */

import { MongoMemoryReplSet } from "mongodb-memory-server";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const qaDir = dirname(fileURLToPath(import.meta.url));

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});

const uri = replSet.getUri("couriergo_qa");

if (uri.includes("mongodb.net") || !/^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(uri)) {
  console.error(`ABORT: not a disposable local URI: ${uri}`);
  process.exit(1);
}

writeFileSync(join(qaDir, ".test-uri"), uri, "utf8");
console.log(`QA MongoDB ready (disposable, in-memory): ${uri}`);
console.log("Leave this process running. Ctrl-C discards all test data.");

const shutdown = async () => {
  await replSet.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Hold the process open.
setInterval(() => {}, 1 << 30);
