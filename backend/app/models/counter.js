import mongoose from "mongoose";

/**
 * Generic atomic counter collection, one document per sequence name
 * (`_id` is the sequence's name, e.g. "ticket"). `nextSequence()` below is
 * the only way callers should touch this — it's what keeps the increment
 * race-free under concurrent requests.
 *
 * This used to live as a field on the Setting singleton instead of its own
 * collection, because the database was briefly on a shared Atlas cluster at
 * its hard 500-collection cap and creating a new collection there failed
 * ticket creation outright. Now on a dedicated cluster with no such cap, so
 * back to its own collection — the cleaner design.
 */
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model("Counter", counterSchema);

/** Atomically returns the next number in the named sequence, starting at 1. */
export async function nextSequence(name) {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return doc.seq;
}

export default Counter;
