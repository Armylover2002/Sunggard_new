import axiosInstance from '@core/api/axios';

/**
 * Admin notification-bell endpoints. Support ticket handling lives in
 * adminPorterApi (Porter Support) — it's the same shared ticket inbox.
 * Per-domain split (P4.5).
 */
export const adminSupportApi = {
    // Notifications
    getNotifications: () => axiosInstance.get('/notifications'),
    markNotificationRead: (id) =>
        axiosInstance.put(`/notifications/${id}/read`),
    markAllNotificationsRead: () =>
        axiosInstance.put('/notifications/mark-all-read'),
};

export default adminSupportApi;
