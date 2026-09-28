import axiosInstance from '@core/api/axios';

/**
 * Admin content-management endpoints: FAQs and Coupons.
 * Experience Studio, Hero config, Offers, and Offer Sections were QC-only
 * (Quick Commerce storefront content) and were removed along with the pages
 * that used them.
 * Per-domain split (P4.5).
 */
export const adminContentApi = {
    // FAQ Management
    getFAQs: (params) => axiosInstance.get('/admin/faqs', { params }),
    createFAQ: (data) => axiosInstance.post('/admin/faqs', data),
    updateFAQ: (id, data) => axiosInstance.put(`/admin/faqs/${id}`, data),
    deleteFAQ: (id) => axiosInstance.delete(`/admin/faqs/${id}`),
    // Public FAQs (for profile pages, etc.)
    getPublicFAQs: (params) => axiosInstance.get('/public/faqs', { params }),

    // Coupons & Promos (Porter delivery coupons — see CouponManagement.jsx)
    getCoupons: (params) => axiosInstance.get('/admin/coupons', { params }),
    createCoupon: (data) => axiosInstance.post('/admin/coupons', data),
    updateCoupon: (id, data) => axiosInstance.put(`/admin/coupons/${id}`, data),
    deleteCoupon: (id) => axiosInstance.delete(`/admin/coupons/${id}`),
};

export default adminContentApi;
