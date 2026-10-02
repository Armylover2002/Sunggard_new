import React, { useEffect } from "react";
import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import DashboardLayout from "@shared/layout/DashboardLayout";
import NotFoundPage from "@shared/components/NotFoundPage";
import { useSupportUnread } from "@core/context/SupportUnreadContext";
import { setActiveRole, ROLES } from "@core/auth/activeRoleStore";
import {
  Tag,
  Building2,
  Truck,
  Wallet,
  Banknote,
  Receipt,
  CircleDollarSign,
  Users,
  HelpCircle,
  RotateCcw,
  Settings,
  Terminal,
  Sparkles,
  User,
  Package,
  Layers,
  Boxes,
  LifeBuoy,
} from "lucide-react";

const ActiveSellers = React.lazy(() => import("../pages/ActiveSellers"));
const PendingSellers = React.lazy(() => import("../pages/PendingSellers"));
const SellerLocations = React.lazy(() => import("../pages/SellerLocations"));
const ActiveDeliveryBoys = React.lazy(
  () => import("../pages/ActiveDeliveryBoys"),
);
const PendingDeliveryBoys = React.lazy(
  () => import("../pages/PendingDeliveryBoys"),
);
const AdminParcelDashboard = React.lazy(
  () => import("../pages/AdminParcelDashboard"),
);
const PorterDashboard = React.lazy(() => import("../pages/porter/PorterDashboard"));
const PorterBanners = React.lazy(() => import("../pages/porter/PorterBanners"));
const DeliveryZones = React.lazy(() => import("../pages/porter/DeliveryZones"));
const PorterRiderPayouts = React.lazy(
  () => import("../pages/porter/PorterRiderPayouts"),
);
const PorterTickets = React.lazy(() => import("../pages/porter/PorterTickets"));
const PorterCustomers = React.lazy(() => import("../pages/porter/PorterCustomers"));
const PorterCustomerDetail = React.lazy(() => import("../pages/porter/PorterCustomerDetail"));
const FleetZoneMap = React.lazy(() => import("../pages/porter/FleetZoneMap"));
const PorterWallet = React.lazy(() => import("../pages/porter/PorterWallet"));
const PorterGst = React.lazy(() => import("../pages/porter/PorterGst"));
const PorterCashDeposits = React.lazy(
  () => import("../pages/porter/PorterCashDeposits"),
);
const DeliveryFunds = React.lazy(() => import("../pages/DeliveryFunds"));
const AdminWallet = React.lazy(() => import("../pages/AdminWallet"));
const WithdrawalRequests = React.lazy(
  () => import("../pages/WithdrawalRequests"),
);
const SellerTransactions = React.lazy(
  () => import("../pages/SellerTransactions"),
);
const CashCollection = React.lazy(() => import("../pages/CashCollection"));
const UserManagement = React.lazy(() => import("../pages/UserManagement"));
const Profile = React.lazy(() => import("@/pages/Profile"));
const FAQManagement = React.lazy(() => import("../pages/FAQManagement"));
const SupportTickets = React.lazy(() => import("../pages/SupportTickets"));
const CouponManagement = React.lazy(() => import("../pages/CouponManagement"));
const NotificationComposer = React.lazy(
  () => import("../pages/NotificationComposer"),
);
const AdminSettings = React.lazy(() => import("../pages/AdminSettings"));
const EnvSettings = React.lazy(() => import("../pages/EnvSettings"));
const AdminProfile = React.lazy(() => import("../pages/AdminProfile"));

const navItems = [
  {
    label: "Send Notifications",
    path: "/admin/notifications",
    icon: Sparkles,
    color: "amber",
  },
  {
    label: "Customer Support",
    icon: Receipt,
    color: "emerald",
    children: [
      { label: "Help Tickets", path: "/admin/support-tickets" },
    ],
  },
  {
    label: "Sellers",
    icon: Building2,
    color: "blue",
    children: [
      { label: "Active Sellers", path: "/admin/sellers/active" },
      { label: "Waiting for Review", path: "/admin/sellers/pending" },
      { label: "Seller Locations", path: "/admin/seller-locations" },
    ],
  },
  {
    label: "Porter Dashboard",
    path: "/admin/porter",
    icon: Boxes,
    color: "cyan",
    group: "porter",
    end: true,
  },
  {
    label: "App Banners",
    path: "/admin/porter/banners",
    icon: Sparkles,
    color: "amber",
    group: "porter",
  },
  {
    label: "Delivery Zones",
    path: "/admin/porter/zones",
    icon: Layers,
    color: "violet",
    group: "porter",
  },
  {
    label: "Porter Wallet",
    path: "/admin/porter/wallet",
    icon: Wallet,
    color: "purple",
    group: "porter",
  },
  {
    label: "Cash Deposits",
    path: "/admin/porter/cash-deposits",
    icon: Banknote,
    color: "amber",
    group: "porter",
  },
  {
    label: "GST",
    path: "/admin/porter/gst",
    icon: Receipt,
    color: "emerald",
    group: "porter",
  },
  {
    label: "Rider Payouts",
    path: "/admin/porter/rider-payouts",
    icon: Receipt,
    color: "orange",
    group: "porter",
  },
  {
    label: "Porter Support",
    path: "/admin/porter/support",
    icon: LifeBuoy,
    color: "rose",
    group: "porter",
  },
  {
    label: "Porter Customers",
    path: "/admin/porter/customers",
    icon: Users,
    color: "sky",
    group: "porter",
  },
  {
    label: "Delivery Drivers",
    icon: Truck,
    color: "emerald",
    group: "porter",
    children: [
      { label: "Active Drivers", path: "/admin/delivery-boys/active" },
      { label: "Waiting for Review", path: "/admin/delivery-boys/pending" },
      { label: "Live Fleet Map", path: "/admin/delivery-boys/live-map" },
      { label: "Send Money", path: "/admin/delivery-funds" },
    ],
  },
  {
    label: "Parcel Delivery",
    icon: Package,
    color: "cyan",
    group: "porter",
    children: [
      { label: "All Bookings", path: "/admin/parcels/all" },
      { label: "Active Deliveries", path: "/admin/parcels/active" },
      { label: "Parcel Settings", path: "/admin/parcels/pricing" },
      { label: "Couriers", path: "/admin/parcels/couriers" },
      { label: "City Rates", path: "/admin/parcels/cityRates" },
      { label: "Reviews", path: "/admin/parcels/reviews" },
      { label: "Revenue Reports", path: "/admin/parcels/reports" },
    ],
  },
  {
    // Same page/route as the "Coupons & Promos" entry under Marketing Tools
    // below — that whole group is hidden while the sidebar runs porter-only
    // (SHOW_QUICK_TAB is false in Sidebar.jsx), so coupons need their own
    // porter-tagged entry point to stay reachable for local/outstation
    // delivery coupons, not just product-order ones.
    label: "Coupons",
    path: "/admin/coupons",
    icon: Tag,
    color: "rose",
    group: "porter",
  },
  { label: "Wallet", path: "/admin/wallet", icon: Wallet, color: "violet" },
  {
    label: "Money Requests",
    path: "/admin/withdrawals",
    icon: Banknote,
    color: "cyan",
  },
  {
    label: "Seller Payments",
    path: "/admin/seller-transactions",
    icon: Receipt,
    color: "orange",
  },
  {
    label: "Collect Cash",
    path: "/admin/cash-collection",
    icon: CircleDollarSign,
    color: "green",
    group: "porter",
  },
  { label: "FAQs", path: "/admin/faqs", icon: HelpCircle, color: "pink" },
  {
    label: "Fees & Charges",
    path: "/admin/billing",
    icon: RotateCcw,
    color: "red",
  },
  {
    label: "Settings",
    path: "/admin/settings",
    icon: Settings,
    color: "slate",
    // Branding tab here sets appName/logoUrl/faviconUrl — the one place
    // that drives the name and icon shown across admin, customer, and
    // delivery. Tagged porter so it stays reachable while Quick is hidden.
    group: "porter",
  },
  { label: "My Profile", path: "/admin/profile", icon: User, color: "indigo" },
  { label: "System Settings", path: "/admin/env", icon: Terminal, color: "dark" },
];

const BillingCharges = React.lazy(() => import("../pages/BillingCharges"));

const AdminRoutes = () => {
  useEffect(() => {
    setActiveRole(ROLES.ADMIN);
  }, []);

  const { totalUnread } = useSupportUnread();

  const navItemsWithBadges = React.useMemo(() => {
    const count = Number.isFinite(totalUnread) ? totalUnread : 0;
    if (count <= 0) return navItems;
    return navItems.map((item) => {
      if (item?.label !== "Customer Support") return item;
      return { ...item, badgeCount: count };
    });
  }, [totalUnread]);

  return (
    <Routes>
      <Route
        element={
          <DashboardLayout navItems={navItemsWithBadges} title="Admin Center">
            <Outlet />
          </DashboardLayout>
        }
      >
        {/* This deployment is Porter-only; the operations desk lands on the
            Porter dashboard instead of a QC-only landing page. */}
        <Route path="/" element={<Navigate to="/admin/porter" replace />} />
        <Route path="/users" element={<UserManagement />} />
        <Route path="/profile" element={<AdminProfile />} />
        <Route path="/sellers/active" element={<ActiveSellers />} />
        <Route path="/support-tickets" element={<SupportTickets />} />
        <Route path="/notifications" element={<NotificationComposer />} />
        <Route path="/coupons" element={<CouponManagement />} />
        <Route path="/sellers/pending" element={<PendingSellers />} />
        <Route path="/seller-locations" element={<SellerLocations />} />
        <Route path="/delivery-boys/active" element={<ActiveDeliveryBoys />} />
        <Route
          path="/delivery-boys/pending"
          element={<PendingDeliveryBoys />}
        />
        <Route path="/parcels" element={<AdminParcelDashboard />} />
        <Route path="/parcels/:tab" element={<AdminParcelDashboard />} />
        <Route path="/porter" element={<PorterDashboard />} />
        <Route path="/porter/banners" element={<PorterBanners />} />
        <Route path="/porter/zones" element={<DeliveryZones />} />
        <Route path="/porter/wallet" element={<PorterWallet />} />
        <Route path="/porter/cash-deposits" element={<PorterCashDeposits />} />
        <Route path="/porter/gst" element={<PorterGst />} />
        <Route path="/porter/rider-payouts" element={<PorterRiderPayouts />} />
        <Route path="/porter/support" element={<PorterTickets />} />
        <Route path="/porter/customers" element={<PorterCustomers />} />
        <Route path="/porter/customers/:id" element={<PorterCustomerDetail />} />
        <Route path="/delivery-boys/live-map" element={<FleetZoneMap />} />
        <Route path="/delivery-funds" element={<DeliveryFunds />} />
        <Route path="/wallet" element={<AdminWallet />} />
        <Route path="/withdrawals" element={<WithdrawalRequests />} />
        <Route path="/seller-transactions" element={<SellerTransactions />} />
        <Route path="/cash-collection" element={<CashCollection />} />
        <Route path="/faqs" element={<FAQManagement />} />
        <Route path="/billing" element={<BillingCharges />} />
        <Route path="/settings" element={<AdminSettings />} />
        <Route path="/env" element={<EnvSettings />} />
      </Route>
      <Route path="*" element={<NotFoundPage homePath="/admin" />} />
    </Routes>
  );
};

export default AdminRoutes;
