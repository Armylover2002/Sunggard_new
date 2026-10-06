import { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import axiosInstance from '@core/api/axios';
import { getWithDedupe } from '@core/api/dedupe';
import { getStoredAuthToken } from '@core/utils/authStorage';
import {
    getActiveRole,
    subscribeActiveRole,
} from '@core/auth/activeRoleStore';
import {
    rawGet,
    rawSet,
    rawRemove,
    clearOnLogout,
    STORAGE_KEYS,
} from '@core/utils/storage';

const AuthContext = createContext(undefined);

const ROLE_STORAGE_KEYS = {
    customer: STORAGE_KEYS.AUTH_CUSTOMER,
    seller: STORAGE_KEYS.AUTH_SELLER,
    admin: STORAGE_KEYS.AUTH_ADMIN,
    delivery: STORAGE_KEYS.AUTH_DELIVERY,
};

const LEGACY_TOKEN_KEY = STORAGE_KEYS.AUTH_LEGACY;

/** Prefer the URL portal when fetching profile so HMR / role-store races cannot load the wrong role. */
function inferProfileRole(fallbackRole) {
    if (typeof window === 'undefined') return fallbackRole;
    const path = window.location.pathname;
    if (path.startsWith('/delivery')) return 'delivery';
    if (path.startsWith('/seller')) return 'seller';
    if (path.startsWith('/admin')) return 'admin';
    return fallbackRole;
}

export const AuthProvider = ({ children }) => {
    const getSafeToken = (key) => getStoredAuthToken(ROLE_STORAGE_KEYS[key]);

    const [authData, setAuthData] = useState({
        customer: getSafeToken('customer'),
        seller: getSafeToken('seller'),
        admin: getSafeToken('admin'),
        delivery: getSafeToken('delivery'),
    });

    // Subscribe to the activeRoleStore so this context re-renders whenever the
    // router flips the active portal. The store also falls back to URL
    // inference on first read, so behavior matches the previous implementation
    // before any router has explicitly set a role.
    const [currentRole, setCurrentRole] = useState(getActiveRole());
    useEffect(() => {
        const unsub = subscribeActiveRole((next) => setCurrentRole(next));
        return unsub;
    }, []);

    const [user, setUser] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const token = authData[currentRole];
    const isAuthenticated = !!token;
    const profileRole = inferProfileRole(currentRole);
    const profileToken = authData[profileRole];

    useEffect(() => {
        const syncStoredTokens = () => {
            setAuthData({
                customer: getSafeToken('customer'),
                seller: getSafeToken('seller'),
                admin: getSafeToken('admin'),
                delivery: getSafeToken('delivery'),
            });
        };

        window.addEventListener('focus', syncStoredTokens);
        window.addEventListener('storage', syncStoredTokens);
        document.addEventListener('visibilitychange', syncStoredTokens);

        return () => {
            window.removeEventListener('focus', syncStoredTokens);
            window.removeEventListener('storage', syncStoredTokens);
            document.removeEventListener('visibilitychange', syncStoredTokens);
        };
    }, []);

    // Register FCM token after login (non-blocking).
    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        let cleanupDeferredRegistration = null;

        // Fire-and-forget; never block auth/profile load.
        setTimeout(() => {
            import('@core/firebase/pushClient')
                .then(async ({
                    ensureFcmTokenRegistered,
                    hasRegisteredFcmToken,
                    startForegroundPushListener,
                    scheduleFcmRegistrationOnUserGesture
                }) => {
                    if (cancelled) return;
                    await startForegroundPushListener();
                    if (hasRegisteredFcmToken(currentRole)) return;

                    const permission = typeof Notification !== 'undefined' ? Notification.permission : 'default';
                    if (permission === 'granted') {
                        await ensureFcmTokenRegistered({
                            role: currentRole,
                            platform: 'web'
                        });
                        return;
                    }

                    cleanupDeferredRegistration = scheduleFcmRegistrationOnUserGesture({
                        role: currentRole,
                        platform: 'web',
                        onError: (error) => {
                            console.warn('[push] Deferred registration failed:', error?.message || error);
                        },
                    });
                })
                .catch((error) => {
                    // Permission denied / unsupported / any error: user can retry later from push-enabled actions.
                    console.warn('[push] Auto-registration skipped:', error?.message || error);
                });
        }, 0);

        return () => {
            cancelled = true;
            if (typeof cleanupDeferredRegistration === 'function') {
                cleanupDeferredRegistration();
            }
        };
    }, [token, currentRole]);

    // Fetch user profile on mount or token change
    useEffect(() => {
        const fetchProfile = async () => {
            if (profileToken) {
                try {
                    setIsLoading(true);
                    // Use deduplicated fetch to avoid multiple simultaneous profile calls
                    const endpoint = `/${profileRole}/profile`;
                    const response = await getWithDedupe(endpoint, {}, { ttl: 5000 });
                    setUser(response.data.result);
                    // A deactivated rider's own profile still loads (see
                    // deliveryAuth.js — GET /profile is deliberately left off
                    // requireActiveDelivery) so this is where it's caught and
                    // the session is ended, instead of every other endpoint
                    // failing with an unexplained 403 one at a time.
                    if (profileRole === 'delivery' && response.data.result?.isActive === false) {
                        logout();
                        return;
                    }
                } catch (error) {
                    console.error('Failed to fetch profile:', error);
                    // Preserve stored tokens and the last known profile on transient failures
                    // (e.g. Vite HMR) so approval gates do not bounce verified riders.
                } finally {
                    setIsLoading(false);
                }
            } else {
                setUser(null);
                setIsLoading(false);
            }
        };

        fetchProfile();
    }, [profileToken, profileRole]);

    const login = (userData) => {
        const role = userData.role?.toLowerCase() || 'customer';
        const storageKey = ROLE_STORAGE_KEYS[role];

        if (storageKey && userData.token) {
            // Persist only the raw JWT string; everything else lives in memory
            // until the next profile fetch.
            rawSet(storageKey, userData.token);

            // Guard against state leaking from a previous account on the same
            // browser (e.g. abandoned guest cart, leftover recent searches).
            // Backend cart will replace it as soon as fetchCart resolves.
            rawRemove(STORAGE_KEYS.CART);
            rawRemove(STORAGE_KEYS.WISHLIST);

            setAuthData(prev => ({ ...prev, [role]: userData.token }));
            setUser(userData); // Set full data initially
        } else {
            console.error('Invalid role or missing token for login:', role);
        }
    };

    // Sign out when another login on this number replaced this role's session.
    useEffect(() => {
        const onReplaced = (event) => {
            const message = event.detail || 'You were signed out because this number logged in to another account.';
            logout();
            import('sonner').then(({ toast }) => toast.error(message)).catch(() => {});
        };
        window.addEventListener('auth:session-replaced', onReplaced);
        return () => window.removeEventListener('auth:session-replaced', onReplaced);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const logout = async () => {
        const storageKey = ROLE_STORAGE_KEYS[currentRole];
        const previousUserId = user?._id || user?.id || '';

        try {
            const { removeStoredFcmToken } = await import('@core/firebase/pushClient');
            await removeStoredFcmToken({ role: currentRole });
        } catch (error) {
            console.warn('Failed to remove push token during logout:', error);
        }

        if (storageKey) {
            rawRemove(storageKey);
        }

        // Remove the legacy shared token only when it belongs to the current role session.
        if (token && rawGet(LEGACY_TOKEN_KEY) === token) {
            rawRemove(LEGACY_TOKEN_KEY);
        }

        // Centralized sensitive-data cleanup: push tokens, recipient PII,
        // recent searches, support-unread counts, guest cart/wishlist and (for
        // delivery role) the rider's last-known GPS.
        clearOnLogout({
            role: currentRole,
            userId: previousUserId,
        });

        setAuthData((prev) => ({
            ...prev,
            [currentRole]: null,
        }));

        // Clear the current user profile from memory
        setUser(null);

        // Final fallback: redirect based on current path if needed
        // (ProtectedRoute usually handles this, but explicit navigation is safer for some UI edge cases)
        const path = window.location.pathname;
        if (path.startsWith('/admin')) window.location.href = '/admin/auth';
        else if (path.startsWith('/seller')) window.location.href = '/seller/auth';
        else if (path.startsWith('/delivery')) window.location.href = '/delivery/auth';
        else window.location.href = '/login';
    };

    const refreshUser = useCallback(async () => {
        if (profileToken) {
            try {
                const endpoint = `/${profileRole}/profile`;
                const response = await axiosInstance.get(endpoint);
                setUser(response.data.result);
                if (profileRole === 'delivery' && response.data.result?.isActive === false) {
                    logout();
                    return response.data.result;
                }
                return response.data.result;
            } catch (error) {
                console.error('Failed to refresh profile:', error);
            }
        }
    }, [profileToken, profileRole]);

    const value = useMemo(() => ({
        user,
        token,
        role: currentRole,
        isAuthenticated,
        isLoading,
        authData,
        login,
        logout,
        refreshUser
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [user, token, currentRole, isAuthenticated, isLoading, authData, refreshUser]);

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};
