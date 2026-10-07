/**
 * One-off: bring old "Cash Collection" ledger rows in line with the booking.
 *
 * Before the fix in riderCashService.recordCodCollection, every COD cash
 * collection was written "Settled" the moment the rider took the money. The
 * booking itself (Parcel.codSettlement.status) was always right — RIDER_HOLDING
 * until a deposit is approved — so those old rows now disagree with it and the
 * admin Funds Settlement screen shows cash as settled that a rider still holds.
 *
 * This sets each row to match its booking:
 *   booking REMITTED_TO_ADMIN  -> Settled
 *   anything else              -> Pending
 *
 * Only Transaction.status of "Cash Collection" rows is touched. Idempotent;
 * no parcel, wallet or balance is changed (rider cash-in-hand reads the
 * amounts, not the status).
 *
 * USAGE:   node backend/scripts/reconcile-cash-collection-status.js
 *          RECONCILE_DRY_RUN=true node backend/scripts/reconcile-cash-collection-status.js
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import connectDB from "../app/dbConfig/dbConfig.js";
import Transaction from "../app/models/transaction.js";
import Parcel from "../app/models/parcel.js";

dotenv.config();

const DRY_RUN = String(process.env.RECONCILE_DRY_RUN || "").toLowerCase() === "true";
const PREFIX = "CASH-COL-PCL-";

async function main() {
  await connectDB();

  const rows = await Transaction.find({ type: "Cash Collection", reference: new RegExp(`^${PREFIX}`) })
    .select("reference status")
    .lean();
  const parcelIds = rows.map((r) => r.reference.slice(PREFIX.length));
  const parcels = await Parcel.find({ _id: { $in: parcelIds } })
    .select("codSettlement.status")
    .lean();
  const statusById = new Map(parcels.map((p) => [String(p._id), p.codSettlement?.status]));

  let toSettled = 0;
  let toPending = 0;
  for (const row of rows) {
    const bookingStatus = statusById.get(row.reference.slice(PREFIX.length));
    if (bookingStatus === undefined) continue; // booking gone — leave the row alone
    const want = bookingStatus === "REMITTED_TO_ADMIN" ? "Settled" : "Pending";
    if (row.status === want) continue;
    want === "Settled" ? toSettled++ : toPending++;
    if (!DRY_RUN) await Transaction.updateOne({ _id: row._id }, { $set: { status: want } });
  }

  console.log(`${DRY_RUN ? "[dry run] would set" : "Set"} ${toPending} row(s) to Pending, ${toSettled} to Settled (of ${rows.length}).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
