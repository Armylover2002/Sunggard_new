import axiosInstance from '@core/api/axios';

/**
 * Admin finance, wallet, payouts, and cash-collection endpoints.
 * Per-domain split (P4.5).
 */
export const adminFinanceApi = {
    // Delivery payouts / funds
    getDeliveryTransactions: (params) =>
        axiosInstance.get('/admin/delivery-transactions', { params }),
    settleTransaction: (id) =>
        axiosInstance.put(`/admin/transactions/${id}/settle`),
    bulkSettleDelivery: () =>
        axiosInstance.put('/admin/transactions/bulk-settle-delivery'),

    // Delivery withdrawals
    getDeliveryWithdrawals: (params) =>
        axiosInstance.get('/admin/delivery-withdrawals', { params }),
    updateWithdrawalStatus: (id, data) =>
        axiosInstance.put(`/admin/withdrawals/${id}`, data),

    // Cash Collection Hub
    getDeliveryCashBalances: (params) =>
        axiosInstance.get('/admin/delivery-cash', { params }),
    getRiderCashDetails: (id) =>
        axiosInstance.get(`/admin/rider-cash-details/${id}`),
    settleRiderCash: (data) => axiosInstance.post('/admin/settle-cash', data),
    getCashSettlementHistory: (params) =>
        axiosInstance.get('/admin/cash-history', { params }),
};

export default adminFinanceApi;
