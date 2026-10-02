import axiosInstance from '@core/api/axios';

/**
 * Admin content-management endpoints: Coupons.
 * Experience Studio, Hero config, Offers, Offer Sections, and FAQ
 * Management were QC-only (Quick Commerce storefront content) and were
 * removed along with the pages that used them.
 * Per-domain split (P4.5).
 */
export const adminContentApi = {
    // Coupons & Promos (Porter delivery coupons — see CouponManagement.jsx)
    getCoupons: (params) => axiosInstance.get('/admin/coupons', { params }),
    createCoupon: (data) => axiosInstance.post('/admin/coupons', data),
    updateCoupon: (id, data) => axiosInstance.put(`/admin/coupons/${id}`, data),
    deleteCoupon: (id) => axiosInstance.delete(`/admin/coupons/${id}`),
};

export default adminContentApi;
