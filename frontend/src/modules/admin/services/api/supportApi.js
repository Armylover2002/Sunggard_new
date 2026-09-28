import axiosInstance from '@core/api/axios';

/**
 * Admin support tickets, notifications, and reviews moderation endpoints.
 * Per-domain split (P4.5).
 */
export const adminSupportApi = {
    // Support Tickets
    getTickets: (params) => axiosInstance.get('/tickets/admin/all', { params }),
    updateTicketStatus: (id, status) =>
        axiosInstance.patch(`/tickets/admin/status/${id}`, { status }),
    replyTicket: (id, text, options = {}) => {
        const { mediaUrl = '', mediaType = '', mimeType = '' } = options || {};
        return axiosInstance.post(`/tickets/reply/${id}`, {
            text,
            isAdmin: true,
            mediaUrl,
            mediaType,
            mimeType,
        });
    },

    // Notifications
    getNotifications: () => axiosInstance.get('/notifications'),
    markNotificationRead: (id) =>
        axiosInstance.put(`/notifications/${id}/read`),
    markAllNotificationsRead: () =>
        axiosInstance.put('/notifications/mark-all-read'),
    broadcastNotification: (data) =>
        axiosInstance.post('/notifications/broadcast', data),
    getBroadcastAudienceStats: () =>
        axiosInstance.get('/notifications/broadcast/audience-stats'),
};

export default adminSupportApi;
