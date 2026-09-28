import React, { useEffect } from "react";
import { Routes, Route, Outlet } from "react-router-dom";
import DashboardLayout from "@shared/layout/DashboardLayout";
import NotFoundPage from "@shared/components/NotFoundPage";
import { setActiveRole, ROLES } from "@core/auth/activeRoleStore";
import {
  HiOutlineSquares2X2,
  HiOutlineUser,
  HiOutlineMapPin,
  HiOutlineChartBarSquare,
  HiOutlineCurrencyDollar,
  HiOutlineCreditCard,
} from "react-icons/hi2";

const SellerParcelDashboard = React.lazy(() => import("../pages/SellerParcelDashboard"));
const SellerParcels = React.lazy(() => import("../pages/SellerParcels"));
const SellerParcelTracking = React.lazy(() => import("../pages/SellerParcelTracking"));
const SellerParcelReports = React.lazy(() => import("../pages/SellerParcelReports"));
const Earnings = React.lazy(() => import("../pages/Earnings"));
const Transactions = React.lazy(() => import("../pages/Transactions"));
const Profile = React.lazy(() => import("../pages/Profile"));
const Withdrawals = React.lazy(() => import("../pages/Withdrawals"));

// Seller is Porter (parcel hub) only — the Quick Commerce seller flow
// (products/orders/stock/returns) was removed with the backend QC domain.
const NAV_ITEMS = [
  { label: "Dashboard", path: "/seller", icon: HiOutlineSquares2X2, end: true },
  { label: "Orders", path: "/seller/orders", icon: HiOutlineMapPin },
  { label: "Track Orders", path: "/seller/tracking", icon: HiOutlineMapPin },
  { label: "Reports", path: "/seller/analytics", icon: HiOutlineChartBarSquare },
  { label: "Money Request", path: "/seller/withdrawals", icon: HiOutlineCurrencyDollar },
  { label: "Payment History", path: "/seller/transactions", icon: HiOutlineCreditCard },
  { label: "Earnings", path: "/seller/earnings", icon: HiOutlineCurrencyDollar },
  { label: "Profile", path: "/seller/profile", icon: HiOutlineUser },
];

const SellerRoutes = () => {
  useEffect(() => {
    setActiveRole(ROLES.SELLER);
  }, []);

  const defaultPath = "/seller";

  return (
    <Routes>
      <Route
        element={
          <DashboardLayout navItems={NAV_ITEMS} title="Seller Panel">
            <Outlet />
          </DashboardLayout>
        }
      >
        <Route path="/" element={<SellerParcelDashboard />} />
        <Route path="/orders" element={<SellerParcels />} />
        <Route path="/tracking" element={<SellerParcelTracking />} />
        <Route path="/analytics" element={<SellerParcelReports />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/earnings" element={<Earnings />} />
        <Route path="/withdrawals" element={<Withdrawals />} />
        <Route path="/profile" element={<Profile />} />
      </Route>
      <Route path="*" element={<NotFoundPage homePath={defaultPath} />} />
    </Routes>
  );
};

export default SellerRoutes;
