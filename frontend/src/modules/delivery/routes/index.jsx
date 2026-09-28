import React, { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import DeliveryLayout from "../layout/DeliveryLayout";
import { setActiveRole, ROLES } from "@core/auth/activeRoleStore";
import Splash from "../pages/Splash";
import DeliveryAuth from "../pages/DeliveryAuth";
// CAR WASH DISABLED
// import CarWashPartnerAuth from "../pages/CarWashPartnerAuth";
import Dashboard from "../pages/Dashboard";
import EarningsPage from "../pages/EarningsPage";
import PorterCash from "../pages/PorterCash";
import Profile from "../pages/Profile";
import PersonalDetails from "../pages/profile/PersonalDetails";
import VehicleInfo from "../pages/profile/VehicleInfo";
import BankAccount from "../pages/profile/BankAccount";
import Documents from "../pages/profile/Documents";
import SafetyPrivacy from "../pages/profile/SafetyPrivacy";
import Settings from "../pages/profile/Settings";
import HelpSupport from "../pages/profile/HelpSupport";
import HelpSupportChat from "../pages/profile/HelpSupportChat";
import Withdrawals from "../pages/profile/Withdrawals";
import Wallet from "../pages/profile/Wallet";
import Notifications from "../pages/Notifications";
import ParcelTaskPage from "../pages/ParcelTaskPage";
import NotFoundPage from "@shared/components/NotFoundPage";
// Legal / informational pages for delivery partners
import DeliveryPrivacyPage from "../pages/DeliveryPrivacyPage";
import DeliveryTermsPage from "../pages/DeliveryTermsPage";
import DeliveryAboutPage from "../pages/DeliveryAboutPage";

const DeliveryRoutes = () => {
  useEffect(() => {
    setActiveRole(ROLES.DELIVERY);
  }, []);

  return (
    <Routes>
      <Route element={<DeliveryLayout />}>
        <Route path="splash" element={<Splash />} />

        <Route path="auth" element={<DeliveryAuth />} />
        {/* CAR WASH DISABLED */}
        {/* <Route path="car-wash-auth" element={<CarWashPartnerAuth />} /> */}
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="earnings" element={<EarningsPage />} />
        {/* Parcel COD cash the rider holds, and the deposit-for-approval flow. */}
        <Route path="porter-cash" element={<PorterCash />} />
        <Route path="profile" element={<Profile />} />
        <Route path="profile/personal-details" element={<PersonalDetails />} />
        <Route path="profile/vehicle-info" element={<VehicleInfo />} />
        <Route path="profile/bank-account" element={<BankAccount />} />
        <Route path="profile/documents" element={<Documents />} />
        <Route path="profile/safety-privacy" element={<SafetyPrivacy />} />
        <Route path="profile/settings" element={<Settings />} />
        <Route path="profile/help-support" element={<HelpSupport />} />
        <Route path="profile/help-support/chat" element={<HelpSupportChat />} />
        <Route path="profile/withdrawals" element={<Withdrawals />} />
        <Route path="profile/wallet" element={<Wallet />} />
        {/* Legal / Informational pages for delivery partners */}
        <Route path="profile/privacy" element={<DeliveryPrivacyPage />} />
        <Route path="profile/terms" element={<DeliveryTermsPage />} />
        <Route path="profile/about" element={<DeliveryAboutPage />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="parcel-task/:parcelId" element={<ParcelTaskPage />} />
        <Route path="/" element={<Navigate to="dashboard" replace />} />
      </Route>
      <Route path="*" element={<NotFoundPage homePath="/delivery/dashboard" />} />
    </Routes>
  );
};

export default DeliveryRoutes;
