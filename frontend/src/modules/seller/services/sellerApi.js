import axiosInstance from '@core/api/axios';

export const sellerApi = {
    login: (data) => axiosInstance.post('/seller/login', data),
    signup: (data) => axiosInstance.post('/seller/signup', data),
    sendVerificationOtp: (data) => axiosInstance.post('/seller/verification/send-otp', data),
    verifyVerificationOtp: (data) => axiosInstance.post('/seller/verification/verify-otp', data),

    // Parcels (Porter hub)
    getParcels: () => axiosInstance.get('/parcel/seller/parcels'),
    confirmParcelCodReceived: (parcelId) =>
      axiosInstance.post('/parcel/seller/cod/confirm', { parcelId }),
    createParcelCodRemit: (parcelId) =>
      axiosInstance.post('/parcel/seller/cod/remit/create', { parcelId }),
    verifyParcelCodRemit: (data) =>
      axiosInstance.post('/parcel/seller/cod/remit/verify', data),

    // Profile & financials
    getEarnings: () => axiosInstance.get('/seller/earnings'),
    getWalletSummary: () => axiosInstance.get('/seller/wallet/summary'),
    getProfile: () => axiosInstance.get('/seller/profile'),
    updateProfile: (data) => axiosInstance.put('/seller/profile', data),

    // Notifications
    getNotifications: () => axiosInstance.get('/notifications'),
    markNotificationRead: (id) => axiosInstance.put(`/notifications/${id}/read`),
    markAllNotificationsRead: () => axiosInstance.put('/notifications/mark-all-read'),

    // Money Requests
    requestWithdrawal: (data) => axiosInstance.post('/seller/request-withdrawal', data),
};
