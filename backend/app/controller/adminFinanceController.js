import Wallet from "../models/wallet.js";
import handleResponse from "../utils/helper.js";

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
