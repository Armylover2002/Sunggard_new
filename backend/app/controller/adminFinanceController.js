import Wallet from "../models/wallet.js";
import handleResponse from "../utils/helper.js";
import { getLedgerEntries } from "../services/finance/ledgerService.js";
import { exportFinanceStatement } from "../services/finance/statementService.js";
import { financeLedgerQuerySchema } from "../validation/financeValidation.js";
import { validateBodySafe as validateWithJoi } from "../middleware/validate.js";

export const getAdminFinanceLedgerController = async (req, res) => {
  try {
    const validated = validateWithJoi(financeLedgerQuerySchema, req.query || {});
    if (!validated.isValid) {
      return handleResponse(res, 400, validated.message);
    }
    const ledger = await getLedgerEntries(validated.value);
    return handleResponse(res, 200, "Finance ledger fetched", ledger);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const exportAdminFinanceStatementController = async (req, res) => {
  try {
    const statement = await exportFinanceStatement(req.query || {});
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${statement.fileName}"`,
    );
    return res.status(200).send(statement.csv);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const getSellerWalletSummaryController = async (req, res) => {
  try {
    const sellerId = req.user?.id;
    const wallet = await Wallet.findOne({ ownerType: "SELLER", ownerId: sellerId }).lean();
    return handleResponse(res, 200, "Seller wallet summary fetched", {
      availableBalance: wallet?.availableBalance || 0,
      pendingBalance: wallet?.pendingBalance || 0,
      totalCredited: wallet?.totalCredited || 0,
      totalDebited: wallet?.totalDebited || 0,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const getRiderWalletSummaryController = async (req, res) => {
  try {
    const riderId = req.user?.id;
    const wallet = await Wallet.findOne({
      ownerType: "DELIVERY_PARTNER",
      ownerId: riderId,
    }).lean();
    return handleResponse(res, 200, "Rider wallet summary fetched", {
      availableBalance: wallet?.availableBalance || 0,
      pendingBalance: wallet?.pendingBalance || 0,
      cashInHand: wallet?.cashInHand || 0,
      totalCredited: wallet?.totalCredited || 0,
      totalDebited: wallet?.totalDebited || 0,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
