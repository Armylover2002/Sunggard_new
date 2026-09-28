import Wallet from "../../models/wallet.js";
import User from "../../models/customer.js";
import {
  LEDGER_DIRECTION,
  OWNER_TYPE,
  WALLET_STATUS,
} from "../../constants/finance.js";
import { addMoney, clampMoney, roundCurrency } from "../../utils/money.js";
import { createLedgerEntry } from "./ledgerService.js";

function normalizeOwnerId(ownerType, ownerId) {
  if (ownerType === OWNER_TYPE.ADMIN) return null;
  return ownerId || null;
}

function assertPositiveAmount(amount) {
  const normalized = roundCurrency(amount);
  if (normalized <= 0) {
    throw new Error("Amount must be greater than 0");
  }
  return normalized;
}

/**
 * Phase 4 P4-3 — keep the legacy `User.walletBalance` field in sync with
 * the canonical `Wallet({ownerType:"CUSTOMER"})` document whenever the
 * wallet is mutated for a customer.
 *
 * Old code paths that directly mutate `User.walletBalance` (e.g.
 * `orderPlacementService` line ~445 — wallet redemption at checkout) are
 * NOT affected by this helper; they continue to update the User document
 * themselves. Phase 4b will migrate those call sites to walletService and
 * the User-side write will then be the only authority.
 *
 * Callers that already mutate User.walletBalance can opt out by passing
 * `syncUserWalletBalance: false` to avoid double-counting.
 */
async function maybeSyncUserWalletBalance({
  ownerType,
  ownerId,
  signedDelta,
  syncUserWalletBalance,
  session,
}) {
  if (syncUserWalletBalance === false) return;
  if (ownerType !== OWNER_TYPE.CUSTOMER) return;
  if (!ownerId) return;
  if (!signedDelta || !Number.isFinite(signedDelta)) return;

  const inc = roundCurrency(signedDelta);
  if (inc === 0) return;

  // Use $inc so concurrent wallet movements compose correctly without
  // a read-modify-write race. We deliberately do NOT throw if the user
  // doesn't exist — the canonical Wallet write has already succeeded
  // and a missing user row is a pre-existing data anomaly that should
  // not abort the money flow.
  try {
    await User.updateOne(
      { _id: ownerId },
      { $inc: { walletBalance: inc } },
      session ? { session } : {},
    );
  } catch (error) {
    // Surface as a soft log only — the wallet (canonical) is already
    // correct. Drift will be caught by the P2-9 verifier.
    if (typeof console !== "undefined" && console.warn) {
      console.warn(
        "[walletService] User.walletBalance sync failed; canonical Wallet is authoritative",
        { userId: String(ownerId), inc, error: error.message },
      );
    }
  }
}

/**
 * Phase 2 P2-1: helper that creates a paired LedgerEntry for a wallet
 * movement. Callers can opt-in by passing `ledgerType`. When `ledgerType`
 * is omitted the helper is a no-op so legacy callers (e.g. porter services
 * that write their own ledger row right after the wallet save) keep working.
 *
 * Every field after `ledgerType` is optional and only forwarded if present.
 */
async function maybeWriteLedgerEntry({
  wallet,
  ownerType,
  ownerId,
  before,
  after,
  amount,
  direction,
  ledgerType,
  ledgerStatus,
  ledgerReference,
  ledgerDescription,
  orderId,
  payoutId,
  paymentMode,
  metadata,
  idempotencyKey,
  correlationId,
  session,
}) {
  if (!ledgerType) return null;
  return createLedgerEntry(
    {
      orderId: orderId || null,
      payoutId: payoutId || null,
      walletId: wallet?._id || null,
      actorType: ownerType,
      actorId: ownerId || null,
      type: ledgerType,
      direction,
      amount,
      ...(ledgerStatus ? { status: ledgerStatus } : {}),
      paymentMode: paymentMode || null,
      metadata: metadata || {},
      description: ledgerDescription || "",
      reference: ledgerReference || "",
      balanceBefore: before,
      balanceAfter: after,
      idempotencyKey: idempotencyKey || null,
      correlationId: correlationId || null,
    },
    { session },
  );
}

export async function getOrCreateWallet(ownerType, ownerId, { session } = {}) {
  const normalizedOwnerId = normalizeOwnerId(ownerType, ownerId);
  const query = {
    ownerType,
    ownerId: normalizedOwnerId,
  };
  const options = {};
  if (session) options.session = session;

  let wallet = await Wallet.findOne(query, null, options);
  if (!wallet) {
    wallet = await Wallet.create(
      [
        {
          ownerType,
          ownerId: normalizedOwnerId,
          availableBalance: 0,
          pendingBalance: 0,
          cashInHand: 0,
          totalCredited: 0,
          totalDebited: 0,
          status: WALLET_STATUS.ACTIVE,
        },
      ],
      options,
    );
    wallet = wallet[0];
  }
  return wallet;
}

export async function creditWallet({
  ownerType,
  ownerId,
  amount,
  bucket = "available",
  session,
  // Phase 2 P2-1: opt-in ledger metadata. When `ledgerType` is provided
  // we emit a LedgerEntry inside the same session so the wallet save
  // and the ledger row commit (or roll back) together.
  ledgerType = null,
  ledgerStatus = null,
  ledgerReference = "",
  ledgerDescription = "",
  orderId = null,
  payoutId = null,
  paymentMode = null,
  metadata = null,
  idempotencyKey = null,
  correlationId = null,
  // Phase 4 P4-3: dual-write to legacy `User.walletBalance`. Default ON
  // (additive — no caller relied on the old behaviour); flip to `false`
  // if the caller already writes User.walletBalance directly.
  syncUserWalletBalance = true,
}) {
  const normalizedAmount = assertPositiveAmount(amount);
  const wallet = await getOrCreateWallet(ownerType, ownerId, { session });

  if (wallet.status !== WALLET_STATUS.ACTIVE) {
    throw new Error("Wallet is not active");
  }

  const before = wallet[`${bucket}Balance`];
  wallet[`${bucket}Balance`] = addMoney(before, normalizedAmount);
  wallet.totalCredited = addMoney(wallet.totalCredited, normalizedAmount);

  await wallet.save({ session });

  const beforeRounded = roundCurrency(before);
  const afterRounded = roundCurrency(wallet[`${bucket}Balance`]);

  const ledgerEntry = await maybeWriteLedgerEntry({
    wallet,
    ownerType,
    ownerId,
    before: beforeRounded,
    after: afterRounded,
    amount: normalizedAmount,
    direction: LEDGER_DIRECTION.CREDIT,
    ledgerType,
    ledgerStatus,
    ledgerReference,
    ledgerDescription,
    orderId,
    payoutId,
    paymentMode,
    metadata,
    idempotencyKey,
    correlationId,
    session,
  });

  // Phase 4 P4-3: legacy mirror. Only applies for the `available` bucket
  // since User.walletBalance only ever represented the available balance.
  if (bucket === "available") {
    await maybeSyncUserWalletBalance({
      ownerType,
      ownerId,
      signedDelta: normalizedAmount,
      syncUserWalletBalance,
      session,
    });
  }

  return {
    wallet,
    amount: normalizedAmount,
    before: beforeRounded,
    after: afterRounded,
    bucket,
    ledgerEntry,
  };
}

export async function debitWallet({
  ownerType,
  ownerId,
  amount,
  bucket = "available",
  session,
  ledgerType = null,
  ledgerStatus = null,
  ledgerReference = "",
  ledgerDescription = "",
  orderId = null,
  payoutId = null,
  paymentMode = null,
  metadata = null,
  idempotencyKey = null,
  correlationId = null,
  // Phase 4 P4-3: dual-write to legacy `User.walletBalance`. See creditWallet.
  syncUserWalletBalance = true,
}) {
  const normalizedAmount = assertPositiveAmount(amount);
  const wallet = await getOrCreateWallet(ownerType, ownerId, { session });

  if (wallet.status !== WALLET_STATUS.ACTIVE) {
    throw new Error("Wallet is not active");
  }

  const field = `${bucket}Balance`;
  const before = roundCurrency(wallet[field] || 0);
  if (before < normalizedAmount) {
    throw new Error(`Insufficient ${bucket} balance`);
  }

  wallet[field] = roundCurrency(before - normalizedAmount);
  wallet.totalDebited = addMoney(wallet.totalDebited, normalizedAmount);
  await wallet.save({ session });

  const afterRounded = roundCurrency(wallet[field]);

  const ledgerEntry = await maybeWriteLedgerEntry({
    wallet,
    ownerType,
    ownerId,
    before,
    after: afterRounded,
    amount: normalizedAmount,
    direction: LEDGER_DIRECTION.DEBIT,
    ledgerType,
    ledgerStatus,
    ledgerReference,
    ledgerDescription,
    orderId,
    payoutId,
    paymentMode,
    metadata,
    idempotencyKey,
    correlationId,
    session,
  });

  if (bucket === "available") {
    await maybeSyncUserWalletBalance({
      ownerType,
      ownerId,
      signedDelta: -normalizedAmount,
      syncUserWalletBalance,
      session,
    });
  }

  return {
    wallet,
    amount: normalizedAmount,
    before,
    after: afterRounded,
    bucket,
    ledgerEntry,
  };
}

export async function movePendingToAvailable({
  ownerType,
  ownerId,
  amount,
  session,
  ledgerType = null,
  ledgerStatus = null,
  ledgerReference = "",
  ledgerDescription = "",
  orderId = null,
  payoutId = null,
  paymentMode = null,
  metadata = null,
  idempotencyKey = null,
  correlationId = null,
  // Phase 4 P4-3: dual-write to legacy `User.walletBalance`. See creditWallet.
  syncUserWalletBalance = true,
}) {
  const normalizedAmount = assertPositiveAmount(amount);
  const wallet = await getOrCreateWallet(ownerType, ownerId, { session });

  if (wallet.pendingBalance < normalizedAmount) {
    throw new Error("Insufficient pending balance");
  }

  const pendingBefore = roundCurrency(wallet.pendingBalance);
  const availableBefore = roundCurrency(wallet.availableBalance);

  wallet.pendingBalance = roundCurrency(wallet.pendingBalance - normalizedAmount);
  wallet.availableBalance = roundCurrency(wallet.availableBalance + normalizedAmount);
  await wallet.save({ session });

  // Phase 4 P4-3: legacy mirror — pending→available is a net increase
  // to the available bucket which is what `User.walletBalance` tracks.
  await maybeSyncUserWalletBalance({
    ownerType,
    ownerId,
    signedDelta: normalizedAmount,
    syncUserWalletBalance,
    session,
  });

  const ledgerEntry = await maybeWriteLedgerEntry({
    wallet,
    ownerType,
    ownerId,
    // For a pending-to-available move we report the available-bucket
    // before/after — that's the bucket the customer/admin actually sees.
    before: availableBefore,
    after: roundCurrency(wallet.availableBalance),
    amount: normalizedAmount,
    direction: LEDGER_DIRECTION.CREDIT,
    ledgerType,
    ledgerStatus,
    ledgerReference,
    ledgerDescription,
    orderId,
    payoutId,
    paymentMode,
    metadata: {
      ...(metadata || {}),
      bucket: "pending->available",
      pendingBefore,
      pendingAfter: roundCurrency(wallet.pendingBalance),
    },
    idempotencyKey,
    correlationId,
    session,
  });

  return {
    wallet,
    amount: normalizedAmount,
    pendingBefore,
    pendingAfter: roundCurrency(wallet.pendingBalance),
    availableBefore,
    availableAfter: roundCurrency(wallet.availableBalance),
    ledgerEntry,
  };
}

export async function updateCashInHand({
  ownerType,
  ownerId,
  deltaAmount,
  session,
  ledgerType = null,
  ledgerStatus = null,
  ledgerReference = "",
  ledgerDescription = "",
  orderId = null,
  payoutId = null,
  paymentMode = null,
  metadata = null,
  idempotencyKey = null,
  correlationId = null,
}) {
  const wallet = await getOrCreateWallet(ownerType, ownerId, { session });
  const delta = roundCurrency(deltaAmount || 0);
  if (delta === 0) {
    return {
      wallet,
      before: roundCurrency(wallet.cashInHand || 0),
      after: roundCurrency(wallet.cashInHand || 0),
      delta: 0,
      ledgerEntry: null,
    };
  }

  const before = roundCurrency(wallet.cashInHand || 0);
  wallet.cashInHand = clampMoney(before + delta, 0);
  await wallet.save({ session });

  const afterRounded = roundCurrency(wallet.cashInHand);

  const ledgerEntry = await maybeWriteLedgerEntry({
    wallet,
    ownerType,
    ownerId,
    before,
    after: afterRounded,
    amount: Math.abs(delta),
    direction: delta >= 0 ? LEDGER_DIRECTION.CREDIT : LEDGER_DIRECTION.DEBIT,
    ledgerType,
    ledgerStatus,
    ledgerReference,
    ledgerDescription,
    orderId,
    payoutId,
    paymentMode,
    metadata: { ...(metadata || {}), bucket: "cashInHand", delta },
    idempotencyKey,
    correlationId,
    session,
  });

  return {
    wallet,
    before,
    after: afterRounded,
    delta,
    ledgerEntry,
  };
}

/**
 * Phase 4 P4-2 — canonical reader for "what's the customer's wallet
 * balance". Reads from the Wallet collection first (authoritative); if
 * no Wallet row exists yet for this user (legacy customers from before
 * the Wallet refactor), falls back to `User.walletBalance`.
 *
 * Returns 0 if neither source has a record. Never throws.
 *
 * Callers that previously read `user.walletBalance` directly can switch
 * to this helper; once every caller has migrated, the User.walletBalance
 * field can be removed (Phase 7).
 */
export async function getCustomerBalance(userId, { session } = {}) {
  if (!userId) return 0;
  try {
    const wallet = await Wallet.findOne(
      { ownerType: OWNER_TYPE.CUSTOMER, ownerId: userId },
      { availableBalance: 1 },
      session ? { session } : {},
    ).lean();
    if (wallet) return roundCurrency(wallet.availableBalance || 0);
  } catch {
    // fall through to legacy
  }

  try {
    const user = await User.findById(
      userId,
      { walletBalance: 1 },
      session ? { session } : {},
    ).lean();
    return roundCurrency(user?.walletBalance || 0);
  } catch {
    return 0;
  }
}
