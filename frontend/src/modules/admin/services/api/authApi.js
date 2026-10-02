import axiosInstance from '@core/api/axios';

/**
 * Admin authentication and profile endpoints.
 *
 * Part of the per-domain split introduced in refactor P4.5. The aggregate
 * `adminApi` object continues to expose these via re-export at
 * `../adminApi.js`, so existing imports continue to work unchanged.
 */
export const adminAuthApi = {
    login: (data) => axiosInstance.post('/admin/login', data),
    getProfile: () => axiosInstance.get('/admin/profile'),
    updateProfile: (data) => axiosInstance.put('/admin/profile', data),
    updatePassword: (data) => axiosInstance.put('/admin/profile/password', data),
    forgotPasswordSendOtp: (data) => axiosInstance.post('/admin/forgot-password/send-otp', data),
    forgotPasswordVerifyOtp: (data) => axiosInstance.post('/admin/forgot-password/verify-otp', data),
    resetPassword: (data) => axiosInstance.post('/admin/forgot-password/reset', data),
};

export default adminAuthApi;
