import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  User,
  Phone,
  Truck,
  CreditCard,
  FileText,
  HelpCircle,
  LogOut,
  ChevronRight,
  Bell,
  IndianRupee,
  ChevronDown,
  ChevronUp,
  Wallet,
  Banknote,
  Globe,
} from "lucide-react";
import { motion } from "framer-motion";
import Button from "@/shared/components/ui/Button";
import { useAuth } from "@core/context/AuthContext";
import { useSettings } from "@core/context/SettingsContext";
import { useSupportUnread } from "@core/context/SupportUnreadContext";
import axiosInstance from '@core/api/axios';
import { useEffect } from 'react';
import { toast } from "sonner";
import LanguagePicker from "@shared/components/LanguagePicker";
import { languageLabel, DEFAULT_LANGUAGE_CODE } from "@shared/constants/languages";
import { getPushLanguage } from "@shared/services/pushLanguageApi";
import { deliveryApi } from "../services/deliveryApi";
import RiderRatingsCard from "../components/RiderRatingsCard";

const Profile = () => {
  const [notificationLanguage, setNotificationLanguage] = useState(DEFAULT_LANGUAGE_CODE);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  useEffect(() => {
    getPushLanguage().then(setNotificationLanguage).catch(() => {});
  }, []);
  const navigate = useNavigate();
  const { logout, user, refreshUser } = useAuth();
  const { settings } = useSettings();
  const { totalUnread } = useSupportUnread();
  const appName = settings?.appName || "App";
  const [faqs, setFaqs] = useState([]);
  const [stats, setStats] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [earningsTotal, setEarningsTotal] = useState(0);

  const formatDate = (value) => {
    if (!value) return "N/A";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "N/A";
    return date.toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
  };

  const formatPhone = (phone) => {
    if (!phone) return "N/A";
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
    return phone;
  };

  const profileImage = useMemo(() => {
    if (user?.profileImage) return user.profileImage;
    const seed = encodeURIComponent(user?.name || user?.phone || "delivery");
    return `https://api.dicebear.com/7.x/avataaars/svg?seed=${seed}`;
  }, [user?.profileImage, user?.name, user?.phone]);

  const partnerIdShort = useMemo(
    () => String(user?._id || user?.id || "").slice(-6).toUpperCase() || "N/A",
    [user?._id, user?.id],
  );

  useEffect(() => {
    const fetchFaqs = async () => {
      try {
        const response = await axiosInstance.get('/public/faqs', { params: { category: 'Delivery', status: 'published' } });
        setFaqs(response.data.results || []);
      } catch (error) {
        console.error("Error fetching FAQs:", error);
      }
    };
    fetchFaqs();
  }, []);

  useEffect(() => {
    refreshUser?.().catch(() => {});
    deliveryApi.getStats()
      .then((res) => {
        if (res.data?.success) {
          setStats(res.data.result || null);
        }
      })
      .catch(() => {
        setStats(null);
      });
    deliveryApi.getEarnings()
      .then((res) => {
        if (res.data?.success) {
          const result = res.data.result || {};
          setEarningsTotal(Number(result.totalEarnings || 0));
          setWallet({
            availableBalance: Number(
              result.availableBalance ??
                Math.max(
                  0,
                  Number(result.totalEarnings || 0) -
                    Number(result.withdrawnTotal || 0) -
                    Number(result.pendingWithdrawals || 0),
                ),
            ),
            totalDebited: Number(result.withdrawnTotal || 0),
            cashInHand: Number(result.cashCollected || 0),
            pendingBalance: Number(result.pendingWithdrawals || 0),
          });
        }
      })
      .catch(() => {
        setEarningsTotal(0);
        setWallet(null);
      });
  }, [refreshUser]);

  const menuItems = [
    {
      icon: Globe,
      label: "Notification language",
      sub: languageLabel(notificationLanguage),
      color: "text-sky-600 bg-sky-50",
      onSelect: () => setLanguagePickerOpen(true),
    },
    {
      icon: Wallet,
      label: "Wallet",
      sub: earningsTotal > 0 || wallet
        ? `Available ₹${Number(wallet?.availableBalance ?? earningsTotal ?? 0).toLocaleString("en-IN")}`
        : "Balance, COD cash & withdrawals",
      color: "text-emerald-600 bg-emerald-50",
      path: "/delivery/profile/wallet",
    },
    {
      icon: User,
      label: "Personal Details",
      sub: "Name, Address, Email",
      color: "text-brand-600 bg-brand-50",
      path: "/delivery/profile/personal-details",
    },
    {
      icon: Truck,
      label: "Vehicle Information",
      sub: "Bike, License, Insurance",
      color: "text-orange-600 bg-orange-50",
      path: "/delivery/profile/vehicle-info",
    },
    {
      icon: CreditCard,
      label: "Bank Account",
      sub:
        user?.accountNumber
          ? `${user?.ifsc || "Bank"} **** ${String(user.accountNumber).slice(-4)}`
          : "Add bank account details",
      color: "text-brand-600 bg-brand-50",
      path: "/delivery/profile/bank-account",
    },
    {
      icon: Banknote,
      label: "Courier Cash Deposit",
      sub: "Hand back COD cash you collected",
      color: "text-amber-600 bg-amber-50",
      path: "/delivery/porter-cash",
    },
    {
      icon: IndianRupee,
      label: "Money Request",
      sub: "Withdraw your earnings",
      color: "text-brand-600 bg-brand-50",
      path: "/delivery/profile/withdrawals",
    },
    {
      icon: FileText,
      label: "Documents",
      sub: user?.documents?.aadhar || user?.documents?.aadharFront || user?.documents?.pan || user?.documents?.drivingLicense
        ? "Aadhar, PAN, DL uploaded"
        : "Upload Aadhar, PAN, DL",
      color: "text-purple-600 bg-purple-50",
      path: "/delivery/profile/documents",
    },
    {
      icon: HelpCircle,
      label: "Help & Support",
      sub: "FAQs, Chat support",
      color: "text-teal-600 bg-teal-50",
      path: "/delivery/profile/help-support",
    },
  ];

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.05 },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, x: -20 },
    visible: { opacity: 1, x: 0 },
  };

  return (
    <div className="bg-gray-50/50 min-h-screen pb-24">
      <LanguagePicker open={languagePickerOpen} value={notificationLanguage} onClose={() => setLanguagePickerOpen(false)} onChange={setNotificationLanguage} />
      {/* Header */}
      <div className="bg-primary pt-12 pb-24 px-6 rounded-b-[2.5rem] relative shadow-lg">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-white text-2xl font-bold">My Profile</h1>
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/20"
            onClick={() => toast.info("No new notifications")}>
            <Bell size={24} />
          </Button>
        </div>

        <div className="flex items-center space-x-4">
          <div className="relative">
            <div className="w-20 h-20 bg-white rounded-full p-1 shadow-lg">
              <img
                src={profileImage}
                alt="Profile"
                className="w-full h-full rounded-full object-cover bg-gray-100"
              />
            </div>
            <div className="absolute bottom-0 right-0 w-6 h-6 bg-brand-500 border-2 border-white rounded-full"></div>
          </div>
          <div className="text-white">
            <h2 className="font-bold text-xl">{user?.name || "Delivery Partner"}</h2>
            <p className="text-white/80 text-sm flex items-center mb-1">
              <Phone size={14} className="mr-1" /> {formatPhone(user?.phone)}
            </p>
            <div className="flex items-center space-x-2">
              <span className="bg-white/20 px-2 py-0.5 rounded text-xs font-medium backdrop-blur-sm">
                ID: {partnerIdShort}
              </span>
              {user?.isVerified ? (
                <span className="bg-brand-500 text-primary-foreground px-2 py-0.5 rounded text-xs font-bold shadow-sm">
                  VERIFIED
                </span>
              ) : (
                <span className="bg-amber-500 text-white px-2 py-0.5 rounded text-xs font-bold shadow-sm">
                  PENDING
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stats Card */}
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="mx-6 -mt-12 bg-white rounded-2xl p-4 shadow-xl mb-6 flex justify-between text-center relative z-10">
        <div className="flex-1">
          <p className="text-gray-400 text-[10px] uppercase font-bold tracking-wider">
            Joined
          </p>
          <p className="font-bold text-gray-900 text-lg">{formatDate(user?.createdAt)}</p>
        </div>
        <div className="w-px bg-gray-100"></div>
        <div className="flex-1">
          <p className="text-gray-400 text-[10px] uppercase font-bold tracking-wider">
            Trips
          </p>
          <p className="font-bold text-gray-900 text-lg">
            {Number(stats?.deliveries ?? stats?.totalDeliveries ?? 0).toLocaleString("en-IN")}
          </p>
        </div>
        <div className="w-px bg-gray-100"></div>
        <div className="flex-1">
          <p className="text-gray-400 text-[10px] uppercase font-bold tracking-wider">
            Rating
          </p>
          <p className="font-bold text-gray-900 text-lg flex justify-center items-center">
            {user?.rating || stats?.rating ? (
              <>
                {Number(user?.rating ?? stats?.rating).toFixed(1)}{" "}
                <span className="text-yellow-400 text-sm ml-1">★</span>
              </>
            ) : (
              <span className="text-gray-400 text-sm">New</span>
            )}
          </p>
        </div>
      </motion.div>

      {/* What customers think of this rider */}
      <div className="mx-6 mb-6">
        <RiderRatingsCard />
      </div>

      {/* Wallet Section */}
      <motion.button
        type="button"
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.25 }}
        onClick={() => navigate("/delivery/profile/wallet")}
        className="mx-6 mb-6 block w-auto max-w-lg text-left rounded-2xl p-4 shadow-lg relative z-10 overflow-hidden"
        style={{
          background:
            "linear-gradient(to bottom right, var(--brand-900), var(--brand-600))",
        }}
      >
        <div className="absolute top-0 right-0 w-28 h-28 bg-white/10 rounded-full blur-2xl -translate-y-1/3 translate-x-1/4" />
        <div className="relative z-10 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Wallet size={16} className="text-white/90" />
              <p className="text-[10px] font-bold uppercase tracking-wider text-white/80">
                Available Balance
              </p>
            </div>
            <p className="text-2xl font-extrabold text-white tracking-tight">
              ₹{Number(wallet?.availableBalance ?? earningsTotal ?? 0).toLocaleString("en-IN")}
            </p>
            <p className="text-[11px] text-white/75 mt-1">
              Earned ₹{Number(earningsTotal || 0).toLocaleString("en-IN")}
              {" · "}
              Withdrawn ₹{Number(wallet?.totalDebited || 0).toLocaleString("en-IN")}
            </p>
          </div>
          <div className="shrink-0 flex items-center gap-1 bg-white/15 text-white px-3 py-2 rounded-full text-xs font-bold border border-white/20">
            Open
            <ChevronRight size={14} />
          </div>
        </div>
      </motion.button>

      {/* Menu Options */}
      <motion.div
        className="px-6 space-y-3 max-w-lg mx-auto"
        variants={containerVariants}
        initial="hidden"
        animate="visible">
        {menuItems.map((item, index) => (
          <motion.button
            key={index}
            variants={itemVariants}
            className="w-full bg-white p-4 rounded-xl shadow-sm flex items-center justify-between hover:bg-gray-50 hover:shadow-md transition-all group"
            whileTap={{ scale: 0.98 }}
            onClick={() => (item.onSelect ? item.onSelect() : navigate(item.path))}>
            <div className="flex items-center">
              <div
                className={`p-3 rounded-full mr-4 transition-colors relative ${item.color}`}>
                <item.icon size={20} />
                {item.path === "/delivery/profile/help-support" && totalUnread > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-black flex items-center justify-center ring-2 ring-white">
                    {totalUnread > 99 ? "99+" : totalUnread}
                  </span>
                )}
              </div>
              <div className="text-left">
                <p className="font-bold text-gray-900 group-hover:text-primary transition-colors">
                  {item.label}
                </p>
                <p className="text-xs text-gray-400">{item.sub}</p>
              </div>
            </div>
            <ChevronRight
              size={20}
              className="text-gray-300 group-hover:text-primary transition-colors"
            />
          </motion.button>
        ))}

        {/* FAQ Section */}
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 overflow-hidden">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-4 px-2">Delivery Partner FAQs</p>
          <div className="divide-y divide-gray-50">
            {faqs.length > 0 ? (
              faqs.map((faq) => (
                <DeliveryFAQItem
                  key={faq._id}
                  question={faq.question}
                  answer={faq.answer}
                />
              ))
            ) : (
              <div className="py-4 text-center text-xs text-gray-400">No FAQs available</div>
            )}
          </div>
        </div>

        <motion.div variants={itemVariants} className="pt-4">
          <Button
            onClick={logout}
            variant="outline"
            className="w-full border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 py-6">
            <LogOut size={20} className="mr-2" /> Logout
          </Button>
        </motion.div>
      </motion.div>

      <div className="text-center text-gray-400 text-xs mt-8 pb-4">
        {appName} Delivery Partner App
        <br />
        Version 1.2.0 (Build 450)
      </div>
    </div>
  );
};

const DeliveryFAQItem = ({ question, answer }) => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="py-4 px-2 cursor-pointer hover:bg-gray-50 transition-colors" onClick={() => setIsOpen(!isOpen)}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-700">{question}</h3>
        {isOpen ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
      </div>
      {isOpen && (
        <motion.p
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="mt-2 text-xs text-gray-500 font-medium leading-relaxed"
        >
          {answer}
        </motion.p>
      )}
    </div>
  );
};

export default Profile;
