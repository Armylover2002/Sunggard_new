import axiosInstance from "@core/api/axios";
import { getWithDedupe } from "@core/api/dedupe";

export const deliveryApi = {
  sendLoginOtp: (data) => axiosInstance.post("/delivery/send-login-otp", data),
  sendSignupOtp: (data) =>
    axiosInstance.post("/delivery/send-signup-otp", data),
  verifyOtp: (data) => axiosInstance.post("/delivery/verify-otp", data),
  checkPhone: (phone) =>
    axiosInstance.get(`/delivery/check-phone/${encodeURIComponent(phone)}`),
  getProfile: () => axiosInstance.get("/delivery/profile"),
  updateProfile: (data) => axiosInstance.put("/delivery/profile", data),
  getStats: () => axiosInstance.get("/delivery/stats"),
  getEarnings: () => axiosInstance.get("/delivery/earnings"),
  getWalletSummary: () => axiosInstance.get("/delivery/wallet/summary"),
  postLocation: (body, config = {}) =>
    axiosInstance.post("/delivery/location", body, config),
  getNotifications: (config = {}) => axiosInstance.get("/notifications", config),
  markNotificationRead: (id) => axiosInstance.put(`/notifications/${id}/read`),
  markAllNotificationsRead: () =>
    axiosInstance.put("/notifications/mark-all-read"),
  requestWithdrawal: (data) =>
    axiosInstance.post("/delivery/request-withdrawal", data),

  /** Where withdrawals get paid — bank, UPI or an uploaded QR. */
  updatePayoutDetails: (data) =>
    axiosInstance.put("/delivery/payout-details", data),

  /** Porter COD cash the rider is holding, and handing it back. */
  getCashSummary: () => axiosInstance.get("/delivery/cash/summary"),
  submitCashDeposit: (data) => axiosInstance.post("/delivery/cash/deposit", data),
  getCashDeposits: (params) =>
    axiosInstance.get("/delivery/cash/deposits", { params }),
  /**
   * The cash-limit meter: what the rider holds, what they may hold, what is
   * left, and whether jobs have stopped.
   *
   * Polled alongside the job feed so the number is always live — a rider
   * whose jobs simply stop appearing with no explanation has been failed by
   * the product.
   */
  getCashStatus: () => axiosInstance.get("/delivery/cash/status"),

  /**
   * Depositing online.
   *
   * The amount is decided server-side from the bookings the rider actually
   * holds — never sent from here, or a rider could clear ₹5,000 of jobs by
   * paying ₹1. `startOnlineDeposit` returns a gateway order to launch
   * checkout against; `verifyOnlineDeposit` confirms it and raises the
   * deposit for admin approval.
   */
  startOnlineDeposit: () => axiosInstance.post("/delivery/cash/deposit/online"),
  verifyOnlineDeposit: (receipt) =>
    axiosInstance.post("/delivery/cash/deposit/online/verify", receipt),

  /**
   * @deprecated Superseded by the online deposit above. Kept so an operation
   * whose gateway is unavailable can still fall back to a manual transfer.
   */
  getCashPayoutDestination: () =>
    axiosInstance.get("/delivery/cash/payout-destination"),

  /** Doorstep switch from cash to online. `kind` is parcel. */
  createCodQr: (kind, id) => axiosInstance.post(`/delivery/cod-qr/${kind}/${id}`),
  checkCodQr: (kind, id) => axiosInstance.get(`/delivery/cod-qr/${kind}/${id}`),

  /** Support tickets raised by the rider. Admin sees these in the same inbox as customer complaints. */
  createTicket: (data) => axiosInstance.post("/tickets/create", { ...data, userType: "Delivery" }),
  getMyTickets: () => getWithDedupe("/tickets/my-tickets"),
  replyTicket: (ticketId, text, options = {}) => {
    const { mediaUrl = "", mediaType = "", mimeType = "" } = options || {};
    return axiosInstance.post(`/tickets/reply/${encodeURIComponent(String(ticketId))}`, {
      text,
      isAdmin: false,
      mediaUrl,
      mediaType,
      mimeType,
    });
  },
};
