// One-off: assigns ticketNumber ("TKT-000123") to every Ticket row created
// before that field existed, ordered by createdAt so earlier tickets get
// lower numbers. Uses the same atomic counter new tickets draw from — the
// `ticketSequence` field on the Setting singleton (models/counter.js), not
// its own collection, since the shared Atlas cluster is near its collection
// cap — so numbers never collide with ones already issued.
// Dry run by default. Pass --apply to write.
//   node scripts/backfill-ticket-numbers.js
//   node scripts/backfill-ticket-numbers.js --apply
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const APPLY = process.argv.includes("--apply");

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const missing = await db
    .collection("tickets")
    .find({ $or: [{ ticketNumber: { $exists: false } }, { ticketNumber: null }] })
    .sort({ createdAt: 1 })
    .toArray();

  console.log(`${missing.length} ticket(s) without a ticketNumber`);

  for (const ticket of missing) {
    const counter = await db
      .collection("settings")
      .findOneAndUpdate(
        {},
        { $inc: { ticketSequence: 1 } },
        { upsert: true, returnDocument: "after" },
      );
    const seq = counter.value?.ticketSequence ?? counter.ticketSequence;
    const ticketNumber = `TKT-${String(seq).padStart(6, "0")}`;

    console.log(`${ticket._id} -> ${ticketNumber}${APPLY ? "" : " (dry run)"}`);
    if (APPLY) {
      await db.collection("tickets").updateOne({ _id: ticket._id }, { $set: { ticketNumber } });
    }
  }

  if (!APPLY && missing.length) {
    console.log("\nDry run only — nothing written. Re-run with --apply to write.");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
