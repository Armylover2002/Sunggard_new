import Setting from "./setting.js";

/**
 * Atomic ticket-number sequence, stored as a field on the existing Setting
 * singleton rather than its own collection — see the comment on
 * `ticketSequence` in models/setting.js for why. `name` is accepted for a
 * readable call site and so a second sequence has an obvious place to add
 * its own field later, but only "ticket" is wired up today.
 */
export async function nextSequence(name) {
  if (name !== "ticket") {
    throw new Error(`nextSequence: unknown sequence "${name}"`);
  }
  const doc = await Setting.findOneAndUpdate(
    {},
    { $inc: { ticketSequence: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return doc.ticketSequence;
}
