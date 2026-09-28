import axiosInstance from "@core/api/axios";
import { getWithDedupe } from "@core/api/dedupe";

export const customerApi = {
  sendLoginOtp: (data) => axiosInstance.post("/customer/send-login-otp", data),
  sendSignupOtp: (data) =>
    axiosInstance.post("/customer/send-signup-otp", data),
  verifyOtp: (data) => axiosInstance.post("/customer/verify-otp", data),
  getProfile: () => getWithDedupe("/customer/profile", {}, { ttl: 5000 }), // Short cache for profile
  updateProfile: (data) => axiosInstance.put("/customer/profile", data),
  uploadMedia: (formData) =>
    axiosInstance.post("/media/upload", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    }),
  getWalletTransactions: (params) =>
    getWithDedupe("/customer/transactions", params),

  // Sellers & Location
  getNearbySellers: (params) => getWithDedupe("/seller/nearby", params),

  // Payments
  createPaymentOrder: (data) =>
    axiosInstance.post("/payments/create-order", data),
  /** Hands the gateway's signed receipt back for server-side verification. */
  verifyCheckoutPayment: (receipt) =>
    axiosInstance.post("/payments/verify", receipt),
  verifyPaymentStatus: (id) => axiosInstance.get(`/payments/status/${id}`),

  // Support
  createTicket: (data) => axiosInstance.post("/tickets/create", data),
  getMyTickets: () => getWithDedupe("/tickets/my-tickets"),
  replyTicket: (ticketId, text, options = {}) => {
    const {
      mediaUrl = "",
      mediaType = "",
      mimeType = "",
    } = options || {};

    return axiosInstance.post(`/tickets/reply/${encodeURIComponent(String(ticketId))}`, {
      text,
      isAdmin: false,
      mediaUrl,
      mediaType,
      mimeType,
    });
  },

  // Coupons
  getActiveCoupons: () => getWithDedupe("/coupons", { status: "active" }),

  // Maps (server-side geocoding)
  geocodeAddress: (address, params = {}) =>
    axiosInstance.get("/maps/geocode", { params: { address, ...params } }),
  geocodePlaceId: (placeId, params = {}) =>
    axiosInstance.get("/maps/geocode", { params: { placeId, ...params } }),

  // Push (FCM) test
  testPushNotification: () => axiosInstance.post("/push/test"),
  getTestPushNotificationStatus: (orderId) =>
    axiosInstance.get(`/push/test-status/${encodeURIComponent(String(orderId || "").trim())}`),
};
