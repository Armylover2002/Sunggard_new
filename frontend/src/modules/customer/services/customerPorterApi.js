import axiosInstance from "@core/api/axios";
import { getWithDedupe } from "@core/api/dedupe";

/**
 * Customer Porter API - Banners & Porter services
 */
export const customerPorterApi = {
  /**
   * Fetch currently active porter banners.
   * Cached client-side with deduplication and short TTL.
   */
  getActiveBanners: (serviceType = "all", options = {}) =>
    getWithDedupe(
      "/porter/banners/active",
      { serviceType },
      {
        ttl: options.ttl ?? 5000, // 5s client cache for instant fresh updates
        forceRefresh: options.forceRefresh ?? false,
      }
    ),

  /**
   * Track banner click
   */
  trackClick: (id) =>
    axiosInstance.post(`/porter/banners/${id}/click`).catch(() => {}),

  /**
   * The full invoice for one booking — parties, route, every fare line, the
   * tax split, how it was paid and the delivery timeline.
   *
   * Built server-side deliberately. A PDF generated from whatever a page
   * happened to have in state shows a subset, sometimes stale, and different
   * on the customer screen from the admin screen — the same booking would
   * produce two different invoices. `kind` is 'parcel'.
   */
  getBookingInvoice: (kind, id) =>
    axiosInstance.get(`/porter/invoice/${kind}/${id}`),

  /** Every payment attempt against a booking, newest first. */
  getBookingPayments: (kind, id) =>
    axiosInstance.get(`/porter/payments/${kind}/${id}`),

  /** The signed-in customer's own recent money movements. */
  getMyTransactions: (params) =>
    axiosInstance.get("/porter/my-transactions", { params }),
};

export default customerPorterApi;
