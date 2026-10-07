import handleResponse from "../utils/helper.js";
import {
  openWalletTopup,
  verifyWalletTopupReceipt,
  WALLET_TOPUP_MIN_RUPEES,
  WALLET_TOPUP_MAX_RUPEES,
} from "../services/porter/walletTopupService.js";
import { getCustomerBalance } from "../services/finance/walletService.js";

/**
 * The customer's own wallet: adding money through the gateway.
 *
 * Paying for a booking from the wallet, and the refund back into it on
 * cancellation, live with the booking flow (parcelController). The balance
 * itself is read through the profile endpoint as before.
 */

/** Limits and balance, so the app can validate before it ever calls out. */
export const getWalletSummary = async (req, res) => {
  try {
    return handleResponse(res, 200, "Wallet", {
      balance: await getCustomerBalance(req.user.id),
      topup: {
        min: WALLET_TOPUP_MIN_RUPEES(),
        max: WALLET_TOPUP_MAX_RUPEES(),
      },
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Open a gateway order for the amount. Nothing is credited yet. */
export const createWalletTopup = async (req, res) => {
  try {
    const { payment, checkout, amount } = await openWalletTopup({
      customerId: req.user.id,
      amountRupees: req.body?.amount,
      correlationId: req.correlationId || null,
    });

    return handleResponse(res, 201, "Complete the payment to add money", {
      paymentId: String(payment._id),
      amount,
      razorpay: {
        keyId: checkout.keyId,
        orderId: checkout.orderId,
        amount: checkout.amount,
        currency: checkout.currency,
      },
    });
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message, {
      code: error.code || undefined,
    });
  }
};

/** The gateway's signed receipt. The wallet is credited only if it checks out. */
export const verifyWalletTopup = async (req, res) => {
  try {
    const {
      razorpay_order_id: gatewayOrderId,
      razorpay_payment_id: gatewayPaymentId,
      razorpay_signature: signature,
    } = req.body || {};

    if (!gatewayOrderId || !gatewayPaymentId || !signature) {
      return handleResponse(res, 400, "Payment details are missing");
    }

    const result = await verifyWalletTopupReceipt({
      customerId: req.user.id,
      gatewayOrderId,
      gatewayPaymentId,
      signature,
      correlationId: req.correlationId || null,
    });

    return handleResponse(res, 200, "Money added to your wallet", {
      balance: result.balance,
      amount: result.amount ?? Number((result.payment.amount / 100).toFixed(2)),
      duplicate: Boolean(result.duplicate),
    });
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message, {
      code: error.code || undefined,
    });
  }
};
