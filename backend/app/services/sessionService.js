import Customer from "../models/customer.js";
import Delivery from "../models/delivery.js";

const lastTenDigits = (phone) => String(phone || "").replace(/\D/g, "").slice(-10);

/**
 * One phone number, one role at a time. Logging in as a role signs out the
 * other role on the same number, on every device: the other role's tokens
 * carry an older sessionVersion, which verifyToken rejects with SESSION_REPLACED.
 * The role logging in keeps its own sessions, so a second device of the same
 * role is not affected.
 */
export async function claimRoleSession(role, phone) {
  const digits = lastTenDigits(phone);
  if (digits.length !== 10) return;

  const Other = role === "delivery" ? Customer : Delivery;
  await Other.updateMany(
    { phone: { $regex: `${digits}$` } },
    { $inc: { sessionVersion: 1 } },
  );
}
