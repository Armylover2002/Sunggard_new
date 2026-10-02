import mongoose from "mongoose";
import LedgerEntry from "../../models/ledgerEntry.js";
import {
  LEDGER_DIRECTION,
  LEDGER_STATUS,
} from "../../constants/finance.js";
import { roundCurrency } from "../../utils/money.js";

function buildTransactionId(prefix = "LEDGER") {
  const now = Date.now();
  const rand = Math.floor(Math.random() * 1000000)
    .toString()
    .padStart(6, "0");
  return `${prefix}-${now}-${rand}`;
}

export async function createLedgerEntry(
  {
    transactionId,
    orderId = null,
    payoutId = null,
    walletId = null,
    actorType,
    actorId = null,
    type,
    direction = LEDGER_DIRECTION.CREDIT,
    amount,
    status = LEDGER_STATUS.COMPLETED,
    paymentMode = null,
    metadata = {},
    description = "",
    reference = "",
    balanceBefore = null,
    balanceAfter = null,
    // Phase 2 P2-3 additions. Both are optional and ignored by older
    // call sites that don't pass them.
    idempotencyKey = null,
    correlationId = null,
  },
  { session } = {},
) {
  const normalizedAmount = roundCurrency(amount || 0);
  if (normalizedAmount < 0) {
    throw new Error("Ledger amount cannot be negative");
  }

  const payload = {
    transactionId: transactionId || buildTransactionId(type || "LEDGER"),
    orderId:
      orderId && mongoose.Types.ObjectId.isValid(orderId)
        ? new mongoose.Types.ObjectId(orderId)
        : orderId,
    payoutId:
      payoutId && mongoose.Types.ObjectId.isValid(payoutId)
        ? new mongoose.Types.ObjectId(payoutId)
        : payoutId,
    walletId:
      walletId && mongoose.Types.ObjectId.isValid(walletId)
        ? new mongoose.Types.ObjectId(walletId)
        : walletId,
    actorType,
    actorId:
      actorId && mongoose.Types.ObjectId.isValid(actorId)
        ? new mongoose.Types.ObjectId(actorId)
        : actorId,
    type,
    direction,
    amount: normalizedAmount,
    status,
    paymentMode,
    metadata,
    description,
    reference,
    balanceBefore: balanceBefore == null ? null : roundCurrency(balanceBefore),
    balanceAfter: balanceAfter == null ? null : roundCurrency(balanceAfter),
    // Only assign when truthy; the partial unique index requires a string
    // type for `idempotencyKey` and skips `undefined`.
    ...(idempotencyKey ? { idempotencyKey: String(idempotencyKey) } : {}),
    correlationId: correlationId || null,
  };

  const entry = new LedgerEntry(payload);
  try {
    await entry.save(session ? { session } : {});
    return entry;
  } catch (error) {
    // Idempotency replay: another worker already inserted the same logical
    // movement. Return the existing row so the caller treats it as a
    // success. Without this, queue-driven retries would surface as 500s.
    if (error?.code === 11000 && idempotencyKey) {
      const existing = await LedgerEntry.findOne(
        { idempotencyKey: String(idempotencyKey) },
        null,
        session ? { session } : {},
      );
      if (existing) return existing;
    }
    throw error;
  }
}

