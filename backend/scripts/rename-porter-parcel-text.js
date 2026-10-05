// One-off: rewrite stored display text "Porter"/"Parcel" -> "Courier".
// Only human-readable fields are touched. Enum keys ("parcel", "porter"),
// ids, routes and model names are logic and stay as they are.
// Dry run by default. Pass --apply to write.
//   node scripts/rename-porter-parcel-text.js
//   node scripts/rename-porter-parcel-text.js --apply
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');

const CASE_MAP = { Parcel: 'Courier', Porter: 'Courier', PARCEL: 'COURIER', PORTER: 'COURIER', parcel: 'courier', porter: 'courier' };
const rewrite = (s) => (typeof s === 'string' ? s.replace(/\b(Parcel|Porter|PARCEL|PORTER|parcel|porter)(s?)\b/g, (m, w, plural) => CASE_MAP[w] + plural) : s);

// Exact-value enum renames for the legacy transactions collection (validated by its schema).
const TRANSACTION_TYPE_MAP = { 'Parcel Payment': 'Courier Payment', 'Parcel Refund': 'Courier Refund' };

const TEXT_COLLECTIONS = [
  { name: 'settings', fields: ['appName'] },
  { name: 'porterbanners', fields: ['title', 'subtitle'] },
  { name: 'notifications', fields: ['title', 'message', 'body'] },
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  let changed = 0;

  for (const [from, to] of Object.entries(TRANSACTION_TYPE_MAP)) {
    const n = await db.collection('transactions').countDocuments({ type: from });
    console.log(`transactions.type "${from}" -> "${to}": ${n} docs`);
    changed += n;
    if (APPLY && n) await db.collection('transactions').updateMany({ type: from }, { $set: { type: to } });
  }

  for (const { name, fields } of TEXT_COLLECTIONS) {
    const col = db.collection(name);
    const or = fields.map((f) => ({ [f]: { $regex: /\b(Parcel|Porter|PARCEL|PORTER|parcel|porter)s?\b/ } }));
    const docs = await col.find({ $or: or }).toArray();
    console.log(`${name}: ${docs.length} docs with text to rewrite`);
    for (const doc of docs) {
      const set = {};
      for (const f of fields) {
        const next = rewrite(doc[f]);
        if (next !== doc[f]) set[f] = next;
      }
      if (!Object.keys(set).length) continue;
      changed++;
      console.log(`  ${doc._id}: ${Object.entries(set).map(([k, v]) => `${k}="${v}"`).join(' ')}`);
      if (APPLY) await col.updateOne({ _id: doc._id }, { $set: set });
    }
  }

  console.log(`\n${changed} ${APPLY ? 'updated' : 'would update (dry run, pass --apply to write)'}`);
  await mongoose.disconnect();
}

run().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
