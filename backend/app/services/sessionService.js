/**
 * Single active session per account, scoped strictly to that one account —
 * never across roles. A customer and a rider can share the same phone
 * number and use both apps at once; logging in to one must never touch the
 * other's session.
 *
 * Bumping sessionVersion on login invalidates any token already issued to
 * THIS SAME account (other devices, old app installs) — verifyToken rejects
 * a token whose `sv` no longer matches. The token minted right after this
 * call carries the new value, so the device that just logged in keeps
 * working.
 */
export async function bumpOwnSession(model, id) {
  const updated = await model.findByIdAndUpdate(
    id,
    { $inc: { sessionVersion: 1 } },
    { new: true },
  );
  return updated?.sessionVersion || 0;
}
