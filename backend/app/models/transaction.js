import mongoose from "mongoose";

/**
 * @deprecated Phase 4 (P4-7). Use the canonical `LedgerEntry` collection
 * instead. The `Transaction` collection remains as a legacy parallel
 * ledger that is dual-written by some flows (return refund, COD
 * settlement, withdrawals) for frontend backwards compatibility.
 *
 * Migration plan (post-Phase 4):
 *   1. Phase 4 P4-5 backfills `LedgerEntry` from historical `Transaction`
 *      rows (deterministic `transactionId: "LEGACY-TX-<txId>"`).
 *   2. Phase 6 migrates the read sites (`walletAdminService.*`) to
 *      `LedgerEntry`.
 *   3. Phase 7 stops writing to `Transaction` entirely and removes the
 *      collection (after a 30-day burn-in).
 *
 * NEW finance flows should use `ledgerService.createLedgerEntry` or
 * pass `ledgerType` to `walletService.creditWallet` / `debitWallet`,
 * NOT write to this collection directly.
 */
const transactionSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            refPath: "userModel",
        },
        userModel: {
            type: String,
            required: true,
            enum: ["Seller", "Delivery", "Admin", "User"],
        },
        order: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Order",
        },
        type: {
            type: String,
            // "Wallet Payment" / "Wallet Refund" added in Phase 1 to fix
            // audit-plan critical finding C-2: orderPlacementService and
            // refund flows were writing these literals, but the schema
            // enum rejected them, aborting wallet-redemption checkouts.
            // The Transaction model is the legacy ledger; Phase 4 migrates
            // these writes onto LedgerEntry. Until then this enum must
            // accept what callers already emit.
            enum: [
                "Order Payment",
                "Delivery Earning",
                "Withdrawal",
                "Refund",
                "Incentive",
                "Bonus",
                "Cash Collection",
                "Cash Settlement",
                "Wallet Payment",
                "Wallet Refund",
                // Porter desk (local City Parcel + outstation Parcel). These
                // flows had no ledger row at all — a porter booking paid
                // online left money in the Razorpay account and nothing in
                // any ledger the admin could read, so porter revenue was
                // invisible next to marketplace revenue. Written by
                // services/porter/customerLedgerService.js.
                "Courier Payment",
                "Courier Refund",
            ],
            required: true,
        },
        amount: {
            type: Number, // Positive for earnings, negative for withdrawals/refunds
            required: true,
        },
        status: {
            type: String,
            enum: ["Pending", "Processing", "Settled", "Failed"],
            default: "Pending",
        },
        reference: {
            type: String, // TXN ID or Order ID
            unique: true,
            required: true,
        },
        date: {
            type: Date,
            default: Date.now,
        },
        meta: {
            type: Object,
        },
    },
    { timestamps: true }
);

transactionSchema.index({ user: 1, userModel: 1, createdAt: -1 });
transactionSchema.index({ user: 1, userModel: 1, status: 1, createdAt: -1 });
transactionSchema.index({ order: 1 });
transactionSchema.index({ status: 1, type: 1 });

export default mongoose.model("Transaction", transactionSchema);
