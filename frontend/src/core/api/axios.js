import axios from 'axios';
import { resolveApiBaseUrl } from './resolveApiBaseUrl';
import { getStoredAuthToken } from '@core/utils/authStorage';
import { getActiveRole, ROLES } from '@core/auth/activeRoleStore';
import { rawGet, STORAGE_KEYS } from '@core/utils/storage';

const ROLE_STORAGE_KEYS = [
    STORAGE_KEYS.AUTH_SELLER,
    STORAGE_KEYS.AUTH_ADMIN,
    STORAGE_KEYS.AUTH_DELIVERY,
    STORAGE_KEYS.AUTH_CUSTOMER,
];

const ROLE_TO_STORAGE_KEY = {
    [ROLES.SELLER]: STORAGE_KEYS.AUTH_SELLER,
    [ROLES.ADMIN]: STORAGE_KEYS.AUTH_ADMIN,
    [ROLES.DELIVERY]: STORAGE_KEYS.AUTH_DELIVERY,
    [ROLES.CUSTOMER]: STORAGE_KEYS.AUTH_CUSTOMER,
};

// URL-prefix → storage-key map used as a *fallback* for the few call sites
// (e.g. an admin page that calls a /products endpoint) where the request URL
// itself encodes the intended role. The primary source is the activeRoleStore.
function tokenForRequestUrl(url) {
    if (!url) return null;
    if (url.startsWith('/seller')) return getStoredAuthToken(STORAGE_KEYS.AUTH_SELLER);
    if (url.startsWith('/admin') || url.includes('/admin/')) return getStoredAuthToken(STORAGE_KEYS.AUTH_ADMIN);
    if (url.startsWith('/delivery') || url.includes('/rider/') || url.startsWith('/media')) {
        return getStoredAuthToken(STORAGE_KEYS.AUTH_DELIVERY);
    }
    if (
        url.startsWith('/customer') ||
        url.startsWith('/cart') ||
        url.startsWith('/wishlist') ||
        url.startsWith('/categories') ||
        url.startsWith('/products') ||
        url.startsWith('/payments') ||
        url.startsWith('/parcel')
    ) {
        return getStoredAuthToken(STORAGE_KEYS.AUTH_CUSTOMER);
    }
    return null;
}

const axiosInstance = axios.create({
    baseURL: resolveApiBaseUrl(),
    /**
     * Without a timeout a stalled request hangs until the browser or the host
     * gives up, and the app receives no response at all — which is
     * indistinguishable from a server error and gets reported as a generic
     * failure nobody can act on.
     *
     * 45s is generous enough for a multi-photo upload on mobile data while
     * still failing in a human timeframe. Individual calls can override it.
     */
    timeout: Number(import.meta.env.VITE_API_TIMEOUT_MS) || 45000,
});

axiosInstance.interceptors.request.use(
    (config) => {
        const url = config.url || '';
        const isMultipartRequest =
            typeof FormData !== 'undefined' && config.data instanceof FormData;

        if (isMultipartRequest) {
            if (typeof config.headers?.delete === 'function') {
                config.headers.delete('Content-Type');
            } else if (config.headers) {
                delete config.headers['Content-Type'];
            }
        }

        // Primary: pick token from the active role (set by the router on mount).
        const activeRole = getActiveRole();
        const primaryStorageKey = ROLE_TO_STORAGE_KEY[activeRole];
        let token = primaryStorageKey ? getStoredAuthToken(primaryStorageKey) : null;

        // Fallback 1: URL-derived token (cross-portal calls, e.g. admin → /products).
        // For /media, prefer the active role token first (already set above).
        if (!token) {
            token = tokenForRequestUrl(url);
            // /media URL fallback above returns delivery token; if admin/seller
            // is active without primary token somehow, keep previous behavior.
            if (
                url.startsWith('/media') &&
                activeRole === ROLES.ADMIN
            ) {
                token = getStoredAuthToken(STORAGE_KEYS.AUTH_ADMIN) || token;
            }
            if (
                url.startsWith('/media') &&
                activeRole === ROLES.SELLER
            ) {
                token = getStoredAuthToken(STORAGE_KEYS.AUTH_SELLER) || token;
            }
            if (
                url.startsWith('/media') &&
                activeRole === ROLES.CUSTOMER
            ) {
                token = getStoredAuthToken(STORAGE_KEYS.AUTH_CUSTOMER) || token;
            }
        }

        // Fallback 2: customer token for un-prefixed/public-ish endpoints while
        // the user is not currently inside a privileged portal.
        if (
            !token &&
            activeRole !== ROLES.ADMIN &&
            activeRole !== ROLES.SELLER &&
            activeRole !== ROLES.DELIVERY
        ) {
            token = getStoredAuthToken(STORAGE_KEYS.AUTH_CUSTOMER);
        }

        // Fallback 3: legacy shared 'token' key.
        if (!token) {
            token = getStoredAuthToken(STORAGE_KEYS.AUTH_LEGACY);
        }

        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

// Response interceptor for API calls
axiosInstance.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;

        // Render/Heroku-style free hosting puts the backend to sleep when idle;
        // the first request after a gap either gets no response at all or a
        // 502/503/504 while the instance cold-starts. One retry after a short
        // wait covers that without masking real outages (still fails after).
        const isColdStartError =
            !error.response || [502, 503, 504].includes(error.response.status);
        if (isColdStartError && originalRequest && !originalRequest._coldStartRetry) {
            originalRequest._coldStartRetry = true;
            await new Promise((resolve) => setTimeout(resolve, 3000));
            return axiosInstance(originalRequest);
        }

        if (error.response?.status === 401 && !originalRequest._retry) {
            originalRequest._retry = true;
            const hasStoredRoleToken = ROLE_STORAGE_KEYS.some((key) => Boolean(rawGet(key)));
            if (hasStoredRoleToken) {
                console.warn(
                    '[axios] Received 401 response. Preserving stored auth tokens; session data is only cleared by explicit logout.',
                    {
                        url: originalRequest?.url,
                        method: originalRequest?.method,
                    }
                );
            }
        }
        return Promise.reject(error);
    }
);

export default axiosInstance;
