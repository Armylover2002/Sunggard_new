import axiosInstance from '@core/api/axios';

/**
 * Admin porter-desk endpoints: the parcel-side dashboard and delivery zones.
 *
 * Paths carry `/admin/` so the axios interceptor picks the admin token.
 */
export const adminPorterApi = {
    /** Merged pickup + city-parcel figures. `days` clamps to 1..90 server-side. */
    getPorterDashboard: (params) =>
        axiosInstance.get('/porter/admin/dashboard', { params }),

    /**
     * Rider earnings attributable to porter jobs only. Supports kind
     * (parcel), page and limit.
     */
    getRiderPayouts: (params) =>
        axiosInstance.get('/porter/admin/rider-payouts', { params }),

    /**
     * All support tickets — raised by customers (/support) or delivery
     * partners (/delivery/profile/help-support). Reuses the shared ticket
     * endpoints; this is the porter desk's own view of the same inbox the
     * general Help Tickets screen shows.
     */
    getTickets: (params) =>
        axiosInstance.get('/tickets/admin/all', { params }),
    replyTicket: (id, text) =>
        axiosInstance.post(`/tickets/reply/${id}`, { text, isAdmin: true }),
    updateTicketStatus: (id, status) =>
        axiosInstance.patch(`/tickets/admin/status/${id}`, { status }),

    /**
     * Porter Wallet — revenue vs rider earning vs admin margin, plus the
     * rider wallet/withdrawal picture. `getWalletWithdrawals` supports
     * status (pending|settled|all), page and limit.
     */
    getWalletOverview: () => axiosInstance.get('/porter/admin/wallet/overview'),
    getWalletWithdrawals: (params) =>
        axiosInstance.get('/porter/admin/wallet/withdrawals', { params }),


    /**
     * Rider COD cash. `getCashHoldings` is what the fleet is still holding;
     * `getCashDeposits` is the review queue (status PENDING|APPROVED|REJECTED|all).
     * Approving a deposit is the only thing that marks its bookings remitted.
     */
    getCashHoldings: () => axiosInstance.get('/porter/admin/cash-holdings'),
    getCashDeposits: (params) =>
        axiosInstance.get('/porter/admin/cash-deposits', { params }),
    reviewCashDeposit: (id, data) =>
        axiosInstance.patch(`/porter/admin/cash-deposits/${id}/review`, data),

    /**
     * @deprecated Riders now deposit through the gateway, so there is no
     * destination to publish. Kept for the fallback path only.
     */
    getCashPayoutDestination: () =>
        axiosInstance.get('/porter/admin/cash-payout-destination'),
    updateCashPayoutDestination: (data) =>
        axiosInstance.put('/porter/admin/cash-payout-destination', data),

    /* ----------------------------------------------------------------------
       Cash limits
       ----------------------------------------------------------------------
       Every rider with their limit, what they are holding, and what is left.
       Replaces the old balances endpoint, which read a `limit` field that has
       never existed on the rider model — so every rider showed the same
       ₹5,000 that nothing could change and nothing enforced.
       -------------------------------------------------------------------- */
    getCashOverview: (params) =>
        axiosInstance.get('/porter/admin/cash-overview', { params }),
    getCashSettings: () => axiosInstance.get('/porter/admin/cash-settings'),
    updateCashSettings: (data) =>
        axiosInstance.put('/porter/admin/cash-settings', data),
    /** `cashLimit: null` clears the override; `0` means this rider carries no cash. */
    setRiderCashLimit: (riderId, cashLimit) =>
        axiosInstance.patch(`/porter/admin/riders/${riderId}/cash-limit`, { cashLimit }),

    /* ----------------------------------------------------------------------
       GST
       -------------------------------------------------------------------- */
    getGstSettings: () => axiosInstance.get('/porter/admin/gst-settings'),
    updateGstSettings: (data) =>
        axiosInstance.put('/porter/admin/gst-settings', data),
    /** Charged vs collected, split by product, with a monthly series. */
    getGstReport: (params) =>
        axiosInstance.get('/porter/admin/gst-report', { params }),
    /** Line-by-line, for export to an accountant. */
    getGstLedger: (params) =>
        axiosInstance.get('/porter/admin/gst-ledger', { params }),

    /* ----------------------------------------------------------------------
       Invoices
       ----------------------------------------------------------------------
       Not under /admin: a customer downloads the same invoice from the same
       endpoint, and the server scopes the read by role. One code path means
       the money on the invoice cannot differ depending on who printed it.
       `kind` is 'parcel'.
       -------------------------------------------------------------------- */
    getBookingInvoice: (kind, id) =>
        axiosInstance.get(`/porter/invoice/${kind}/${id}`),
    getBookingPayments: (kind, id) =>
        axiosInstance.get(`/porter/payments/${kind}/${id}`),

    /** Supports search, status (active|inactive) and city. */
    getZones: (params) => axiosInstance.get('/porter/admin/zones', { params }),
    getZone: (id) => axiosInstance.get(`/porter/admin/zones/${id}`),
    createZone: (data) => axiosInstance.post('/porter/admin/zones', data),
    updateZone: (id, data) => axiosInstance.put(`/porter/admin/zones/${id}`, data),
    deleteZone: (id) => axiosInstance.delete(`/porter/admin/zones/${id}`),

    /** Porter Banners Management */
    getBanners: (params) => axiosInstance.get('/porter/admin/banners', { params }),
    getBanner: (id) => axiosInstance.get(`/porter/admin/banners/${id}`),
    createBanner: (data) => axiosInstance.post('/porter/admin/banners', data),
    updateBanner: (id, data) => axiosInstance.put(`/porter/admin/banners/${id}`, data),
    toggleBannerStatus: (id) => axiosInstance.patch(`/porter/admin/banners/${id}/status`),
    deleteBanner: (id) => axiosInstance.delete(`/porter/admin/banners/${id}`),

    /**
     * Porter Customers — real booking counts and spend, merged across the
     * pickup and city-parcel flows. Supports search, status (active|inactive)
     * and sortBy (totalBookings|totalSpent|lastBookingAt|joinedDate).
     */
    getCustomers: (params) => axiosInstance.get('/porter/admin/customers', { params }),
    getCustomer: (id) => axiosInstance.get(`/porter/admin/customers/${id}`),
    updateCustomerStatus: (id, isActive) =>
        axiosInstance.patch(`/porter/admin/customers/${id}/status`, { isActive }),
};

export default adminPorterApi;
