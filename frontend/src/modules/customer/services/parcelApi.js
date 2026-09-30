import axiosInstance from "@core/api/axios";
import { getWithDedupe } from "@core/api/dedupe";

export const parcelApi = {
  // Customer APIs
  calculateFare: (data) => axiosInstance.post("/parcel/calculate-fare", data),
  getAvailableCoupons: (params) => axiosInstance.get("/parcel/coupons/available", { params }),
  validateCoupon: (data) => axiosInstance.post("/parcel/coupon/validate", data),
  createParcel: (data) => axiosInstance.post("/parcel/create", data),
  verifyParcelPayment: (data) => axiosInstance.post("/parcel/verify-payment", data),
  getBookingConfig: () =>
    getWithDedupe("/parcel/booking-config", {}, { ttl: 15000 }),
  getHistory: () => axiosInstance.get("/parcel/history"),
  trackParcel: (id) => axiosInstance.get(`/parcel/track/${id}`),
  cancelSearch: (parcelId) => axiosInstance.post(`/parcel/cancel/${parcelId}`),
  requestLateRefund: (parcelId, data = {}) =>
    axiosInstance.post(`/parcel/${parcelId}/late-refund-request`, data),
  getReviews: (params) => axiosInstance.get("/parcel/reviews", { params }),
  getMyReview: (parcelId) => axiosInstance.get(`/parcel/review/${parcelId}`),
  submitReview: (data) => axiosInstance.post("/parcel/review", data),

  // Admin APIs
  adminGetParcels: () => axiosInstance.get("/parcel/admin/all"),
  adminGetParcel: (parcelId) => axiosInstance.get(`/parcel/admin/${parcelId}`),
  adminAssignRider: (data) => axiosInstance.post("/parcel/admin/assign-rider", data),
  adminApproveLateRefund: (parcelId, data = {}) =>
    axiosInstance.put(`/parcel/admin/late-refund/${parcelId}/approve`, data),
  adminRejectLateRefund: (parcelId, data = {}) =>
    axiosInstance.put(`/parcel/admin/late-refund/${parcelId}/reject`, data),
  adminGetPricingConfig: () => axiosInstance.get("/parcel/admin/pricing"),
  adminUpdatePricingConfig: (data) => axiosInstance.put("/parcel/admin/pricing", data),
  adminGetReports: () => axiosInstance.get("/parcel/admin/reports"),
  adminGetActiveDeliveries: () => axiosInstance.get("/parcel/admin/active"),
  adminGetRiders: () => axiosInstance.get("/parcel/admin/riders"),
  adminGetCouriers: () => axiosInstance.get("/parcel/admin/couriers"),
  adminCreateCourier: (data) => axiosInstance.post("/parcel/admin/couriers", data),
  adminUpdateCourier: (id, data) => axiosInstance.put(`/parcel/admin/couriers/${id}`, data),
  adminDeleteCourier: (id) => axiosInstance.delete(`/parcel/admin/couriers/${id}`),
  adminGetReviews: (params) => axiosInstance.get("/parcel/admin/reviews", { params }),
  adminUpdateReviewStatus: (id, data) =>
    axiosInstance.put(`/parcel/admin/reviews/${id}`, data),

  // Courier city-to-city rate card (Excel-uploaded)
  adminGetCityRates: () => axiosInstance.get("/parcel/admin/city-rates"),
  adminUploadCityRates: (file) => {
    const formData = new FormData();
    formData.append("file", file);
    return axiosInstance.post("/parcel/admin/city-rates/upload", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
  adminUpsertCityRate: (data) => axiosInstance.post("/parcel/admin/city-rates", data),
  adminDeleteCityRate: (id) => axiosInstance.delete(`/parcel/admin/city-rates/${id}`),
  adminDownloadCityRateTemplate: () =>
    axiosInstance.get("/parcel/admin/city-rates/template", { responseType: "blob" }),

  // Courier company lookup (zone-filtered) — replaces the old nearest-warehouse lookup
  getCouriersForLocation: (lat, lng) =>
    axiosInstance.get("/parcel/couriers/for-location", { params: { lat, lng } }),

  // Destination cities admin has priced for this pickup city + courier
  getCityRateDestinations: (originCity, courierCompanyId) =>
    axiosInstance.get("/parcel/city-rates/destinations", {
      params: { originCity, courierCompanyId },
    }),

  // Rider/Delivery Partner APIs
  riderGetAssigned: (options = {}) =>
    getWithDedupe("/parcel/rider/assigned", {}, {
      ttl: options.ttl ?? 30000,
      forceRefresh: options.forceRefresh ?? false,
    }),
  getParcelRoute: (parcelId, params, config = {}) =>
    axiosInstance.get(`/parcel/rider/route/${parcelId}`, { params, ...config }),
  riderGetAvailable: (options = {}) =>
    getWithDedupe("/parcel/rider/available", {}, {
      ttl: options.ttl ?? 20000,
      forceRefresh: options.forceRefresh ?? false,
    }),
  riderAcceptParcel: (parcelId, idempotencyKey) =>
    axiosInstance.post(
      `/parcel/rider/accept/${parcelId}`,
      {},
      idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : undefined,
    ),
  riderRejectParcel: (parcelId) => axiosInstance.post(`/parcel/rider/reject/${parcelId}`),
  riderUpdateStatus: (data) => axiosInstance.put("/parcel/rider/status", data),
  riderGetEarnings: () => axiosInstance.get("/parcel/rider/earnings"),
};
