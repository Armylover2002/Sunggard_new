import React, { lazy, useMemo, useEffect, Suspense } from 'react';
import { createBrowserRouter, RouterProvider, Outlet, Navigate } from 'react-router-dom';
import ProtectedRoute from '../guards/ProtectedRoute';
import RoleGuard from '../guards/RoleGuard';
import { UserRole } from '../constants/roles';
import RootErrorBoundary from '../../shared/components/RootErrorBoundary';
import { setActiveRole, ROLES } from '../auth/activeRoleStore';

// Providers for Customer Module
import { LocationProvider } from '../../modules/customer/context/LocationContext';
import ScrollToTop from '../../modules/customer/components/shared/ScrollToTop';
import NotFoundPage from '../../shared/components/NotFoundPage';

// Public Pages
import Auth from '../../modules/seller/pages/Auth';
import ApplicationPending from '../../modules/seller/pages/ApplicationPending';
import AdminAuth from '../../modules/admin/pages/AdminAuth';
import DeliveryAuth from '../../modules/delivery/pages/DeliveryAuth';
import DeliveryApplicationPending from '../../modules/delivery/pages/ApplicationPending';
// CAR WASH DISABLED
// import CarWashPartnerAuth from '../../modules/delivery/pages/CarWashPartnerAuth';
// import CarWashPartnerDashboard from '../../modules/delivery/pages/CarWashPartnerDashboard';
import CustomerAuth from '../../modules/customer/pages/CustomerAuth';

const ProfilePage = lazy(() => import('../../modules/customer/pages/ProfilePage'));
const AddressesPage = lazy(() => import('../../modules/customer/pages/AddressesPage'));
const SettingsPage = lazy(() => import('../../modules/customer/pages/SettingsPage'));
const SupportPage = lazy(() => import('../../modules/customer/pages/SupportPage'));
const ChatPage = lazy(() => import('../../modules/customer/pages/ChatPage'));
const TermsPage = lazy(() => import('../../modules/customer/pages/TermsPage'));
const PrivacyPage = lazy(() => import('../../modules/customer/pages/PrivacyPage'));
const AboutPage = lazy(() => import('../../modules/customer/pages/AboutPage'));
const EditProfilePage = lazy(() => import('../../modules/customer/pages/EditProfilePage'));
const PaymentStatusPage = lazy(() => import('../../modules/customer/pages/PaymentStatusPage'));
const WalletPage = lazy(() => import('../../modules/customer/pages/WalletPage'));
const ParcelHome = lazy(() => import('../../modules/customer/pages/ParcelHome'));
const WaybillHistory = lazy(() => import('../../modules/customer/pages/WaybillHistory'));
const ParcelDeliveryPage = lazy(() => import('../../modules/customer/pages/ParcelDeliveryPage'));
const ParcelSearchTrackingPage = lazy(() => import('../../modules/customer/pages/ParcelSearchTrackingPage'));
const ParcelDetail = lazy(() => import('../../modules/customer/pages/ParcelDetail'));
// CAR WASH DISABLED
// const CarWashBookingPage = lazy(() => import('../../modules/customer/pages/CarWashBookingPage'));
// const CarWashTrackingPage = lazy(() => import('../../modules/customer/pages/CarWashTrackingPage'));


// Lazy load heavy modules
const SellerModule = lazy(() => import('../../modules/seller/routes/index'));
const AdminModule = lazy(() => import('../../modules/admin/routes/index'));
const DeliveryModule = lazy(() => import('../../modules/delivery/routes/index'));

import CustomerLayout from '../../modules/customer/components/layout/CustomerLayout';

const CustomerLayoutWrapper = () => {
    useEffect(() => {
        setActiveRole(ROLES.CUSTOMER);
    }, []);

    return (
        <LocationProvider>
            <ScrollToTop />
            <CustomerLayout>
                <Suspense fallback={<div className="flex h-screen items-center justify-center font-outfit">Loading...</div>}>
                    <Outlet />
                </Suspense>
            </CustomerLayout>
        </LocationProvider>
    );
};

const AppRouter = () => {
    const router = useMemo(() => createBrowserRouter([
        {
            path: '/',
            element: <Outlet />,
            errorElement: <RootErrorBoundary />,
            children: [
                {
                    path: 'login',
                    element: <CustomerAuth />,
                },
                {
                    path: 'signup',
                    element: <CustomerAuth />,
                },
                {
                    path: 'seller/auth',
                    element: <Auth />,
                },
                {
                    path: 'seller/pending-approval',
                    element: <ApplicationPending />,
                },
                {
                    path: 'admin/auth',
                    element: <AdminAuth />,
                },
                {
                    path: 'delivery/auth',
                    element: <DeliveryAuth />,
                },
                {
                    path: 'delivery/pending-approval',
                    element: (
                        <ProtectedRoute>
                            <DeliveryApplicationPending />
                        </ProtectedRoute>
                    ),
                },
                // CAR WASH DISABLED — partner auth / dashboard routes
                // {
                //     path: 'delivery/car-wash-auth',
                //     element: <CarWashPartnerAuth />,
                // },
                // {
                //     path: 'car-wash/partner/auth',
                //     element: <CarWashPartnerAuth />,
                // },
                // {
                //     path: 'car-wash/partner/dashboard',
                //     element: (
                //         <ProtectedRoute>
                //             <RoleGuard allowedRoles={[UserRole.DELIVERY]}>
                //                 <CarWashPartnerDashboard />
                //             </RoleGuard>
                //         </ProtectedRoute>
                //     ),
                // },
                {
                    path: 'seller/*',
                    element: (
                        <ProtectedRoute>
                            <RoleGuard allowedRoles={[UserRole.SELLER]}>
                                <SellerModule />
                            </RoleGuard>
                        </ProtectedRoute>
                    ),
                },
                {
                    path: 'admin/*',
                    element: (
                        <ProtectedRoute>
                            <RoleGuard allowedRoles={[UserRole.ADMIN]}>
                                <AdminModule />
                            </RoleGuard>
                        </ProtectedRoute>
                    ),
                },
                {
                    path: 'delivery/*',
                    element: (
                        <ProtectedRoute>
                            <RoleGuard allowedRoles={[UserRole.DELIVERY]}>
                                <DeliveryModule />
                            </RoleGuard>
                        </ProtectedRoute>
                    ),
                },
                {
                    path: 'unauthorized',
                    element: <div className="flex h-screen items-center justify-center font-outfit">Unauthorized Access</div>,
                },
                {
                    element: <CustomerLayoutWrapper />,
                    children: [
                        { index: true, element: <ProtectedRoute><ParcelHome /></ProtectedRoute> },

                        { path: 'terms', element: <TermsPage /> },
                        { path: 'privacy', element: <PrivacyPage /> },
                        { path: 'about', element: <AboutPage /> },
                        { path: 'addresses', element: <ProtectedRoute><AddressesPage /></ProtectedRoute> },
                        { path: 'settings', element: <ProtectedRoute><SettingsPage /></ProtectedRoute> },
                        { path: 'support', element: <ProtectedRoute><SupportPage /></ProtectedRoute> },
                        { path: 'chat', element: <ProtectedRoute><ChatPage /></ProtectedRoute> },
                        { path: 'payment-status', element: <PaymentStatusPage /> },
                        { path: 'profile', element: <ProtectedRoute><ProfilePage /></ProtectedRoute> },
                        { path: 'profile/edit', element: <ProtectedRoute><EditProfilePage /></ProtectedRoute> },
                        { path: 'profile/parcel-history', element: <ProtectedRoute><WaybillHistory /></ProtectedRoute> },
                        { path: 'wallet', element: <ProtectedRoute><WalletPage /></ProtectedRoute> },
                        { path: 'parcel', element: <ProtectedRoute><ParcelHome /></ProtectedRoute> },
                        { path: 'parcel/outstation', element: <ProtectedRoute><ParcelDeliveryPage /></ProtectedRoute> },
                        { path: 'parcel/search/:id', element: <ProtectedRoute><ParcelSearchTrackingPage /></ProtectedRoute> },
                        { path: 'parcel/outstation/:parcelId', element: <ProtectedRoute><ParcelDetail /></ProtectedRoute> },
                        // CAR WASH DISABLED — customer booking / tracking
                        // { path: 'car-wash', element: <ProtectedRoute><CarWashBookingPage /></ProtectedRoute> },
                        // { path: 'car-wash/track/:id', element: <ProtectedRoute><CarWashTrackingPage /></ProtectedRoute> },
                    ]
                },
                {
                    path: '*',
                    element: <NotFoundPage homePath="/" />,
                }
            ]
        }
    ]), []);

    return <RouterProvider router={router} />;
};

export default AppRouter;
