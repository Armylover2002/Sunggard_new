import axiosInstance from '@core/api/axios';

/**
 * Admin delivery-partner endpoints (lifecycle, active fleet).
 * Per-domain split (P4.5).
 */
export const adminDeliveryApi = {
    getDeliveryPartners: (params) =>
        axiosInstance.get('/admin/delivery-partners', { params }),
    getDeliveryPartnerById: (id) =>
        axiosInstance.get(`/admin/delivery-partners/${id}`),
    /** A rider's overall rating, its 5-to-1 breakdown and customer feedback. */
    getRiderRatings: (id, params) =>
        axiosInstance.get(`/admin/delivery-partners/${id}/ratings`, { params }),
    updateDeliveryPartnerIdentity: (id, data) =>
        axiosInstance.patch(`/admin/delivery-partners/${id}/identity`, data),
    approveDeliveryPartner: (id) =>
        axiosInstance.patch(`/admin/delivery-partners/approve/${id}`),
    rejectDeliveryPartner: (id, reason) =>
        axiosInstance.delete(`/admin/delivery-partners/reject/${id}`, { data: { reason } }),
    setDeliveryPartnerActive: (id, isActive) =>
        axiosInstance.patch(`/admin/delivery-partners/${id}/active`, { isActive }),
    /**
     * Live rider lat/lng + resolved zone, from our own DB. Safe to poll on a
     * timer — this never touches the Google Maps billing surface, only the
     * one-time map script load does.
     */
    getLiveFleetLocations: () =>
        axiosInstance.get('/admin/delivery-partners/live-locations'),
};

export default adminDeliveryApi;
