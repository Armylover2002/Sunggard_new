import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Card from '@shared/components/ui/Card';
import Badge from '@shared/components/ui/Badge';
import {
    Search,
    Filter,
    CheckCircle,
    XCircle,
    FileSearch,
    Phone,
    Mail,
    Truck,
    MapPin,
    MapPinned,
    Calendar,
    IdCard,
    RotateCw,
    Check,
    X,
    User,
    Building2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { adminApi } from '../services/adminApi';
import { formatZoneLabel } from '@shared/utils/zoneGeometry';

const DEFAULT_AVATAR = "https://cdn-icons-png.flaticon.com/512/149/149071.png";

const formatServiceTypes = (rider) => {
    const services = [];
    if (rider.isParcelService) services.push("Parcel");
    // CAR WASH DISABLED
    // if (rider.isCarWashService) services.push("Car Wash");
    return services.length ? services.join(" · ") : "Not specified";
};

const DOC_LABELS = {
    aadhar: "AADHAR",
    aadharFront: "AADHAR FRONT",
    aadharBack: "AADHAR BACK",
    pan: "PAN",
    drivingLicense: "DRIVING LICENSE",
};

const formatPanDisplay = (value) => {
    const pan = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!pan) return "Not provided";
    return pan;
};

const formatAadharDisplay = (value) => {
    const digits = String(value || "").replace(/\D/g, "");
    if (!digits) return "Not provided";
    return digits.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
};

const formatPlateDisplay = (value) => {
    const plate = String(value || "").replace(/\s/g, "").toUpperCase();
    if (!plate || plate === "N/A") return value || "Not provided";
    if (plate.length === 10) {
        return `${plate.slice(0, 2)} ${plate.slice(2, 4)} ${plate.slice(4, 6)} ${plate.slice(6)}`;
    }
    return value;
};

const formatLicenseDisplay = (value) => {
    const raw = String(value || "").replace(/[\s-]/g, "").toUpperCase();
    if (!raw || raw === "N/A") return value || "Not provided";
    if (raw.startsWith("DL") && raw.length >= 15) {
        return `DL-${raw.slice(2)}`;
    }
    return value;
};

const mapDeliveryPartner = (r) => ({
    id: r._id || r.id,
    name: r.name,
    phone: r.phone,
    email: r.email || "Not provided",
    appliedDate: r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "—",
    appliedAt: r.createdAt,
    address: r.address || "Not provided",
    location: r.address || r.currentArea || 'Unknown',
    vehicle: r.vehicleType || "Not provided",
    vehicleNumber: formatPlateDisplay(r.vehicleNumber),
    drivingLicenseNumber: formatLicenseDisplay(r.drivingLicenseNumber),
    aadharNumber: formatAadharDisplay(r.aadharNumber),
    panNumber: formatPanDisplay(r.panNumber),
    aadharNumberRaw: String(r.aadharNumber || "").replace(/\D/g, ""),
    panNumberRaw: String(r.panNumber || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
    accountHolder: r.accountHolder || "Not provided",
    accountNumber: r.accountNumber || "Not provided",
    ifsc: r.ifsc || "Not provided",
    profileImage: r.profileImage || "",
    documents: Object.keys(r.documents || {}).filter((key) => r.documents[key]),
    documentsRaw: r.documents || {},
    status: r.isVerified ? 'approved' : 'pending_review',
    experience: r.experience || 'Not Specified',
    experienceDetails: r.experienceDetails || '',
    preferredArea: r.address || r.currentArea || 'Not Specified',
    zoneName: r.zoneIds?.[0]?.name || '',
    zoneCity: r.zoneIds?.[0]?.city || '',
    // CAR WASH DISABLED — isCarWashService: r.isCarWashService,
    isParcelService: r.isParcelService,
    serviceLabel: formatServiceTypes({
        isParcelService: r.isParcelService,
        // CAR WASH DISABLED — isCarWashService: r.isCarWashService,
    }),
});

const DetailField = ({ label, value, mono = false }) => (
    <div className="space-y-1">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}</p>
        <p className={cn("text-sm font-bold text-slate-900 break-all", mono && "font-mono")}>
            {value || "Not provided"}
        </p>
    </div>
);

const PendingDeliveryBoys = () => {
    const [pendingRiders, setPendingRiders] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [filterStatus, setFilterStatus] = useState('all');
    const [serviceFilter, setServiceFilter] = useState('all'); // 'all', 'rider' — CAR WASH DISABLED: 'washer'
    const [viewingRider, setViewingRider] = useState(null);
    const [identityDraft, setIdentityDraft] = useState({ aadhar: "", pan: "" });
    const [isSavingIdentity, setIsSavingIdentity] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isLoadingDetails, setIsLoadingDetails] = useState(false);

    useEffect(() => {
        if (!viewingRider) return undefined;

        const scrollY = window.scrollY;
        const { overflow: prevBodyOverflow, position: prevBodyPosition, top: prevBodyTop, width: prevBodyWidth } = document.body.style;
        const prevHtmlOverflow = document.documentElement.style.overflow;

        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.top = `-${scrollY}px`;
        document.body.style.width = '100%';
        document.documentElement.style.overflow = 'hidden';

        return () => {
            document.body.style.overflow = prevBodyOverflow;
            document.body.style.position = prevBodyPosition;
            document.body.style.top = prevBodyTop;
            document.body.style.width = prevBodyWidth;
            document.documentElement.style.overflow = prevHtmlOverflow;
            window.scrollTo(0, scrollY);
        };
    }, [viewingRider]);

    const openApplication = async (rider) => {
        setIsLoadingDetails(true);
        try {
            const response = await adminApi.getDeliveryPartnerById(rider.id);
            const partner = response.data?.result;
            if (partner) {
                const mapped = mapDeliveryPartner(partner);
                setIdentityDraft({
                    aadhar: mapped.aadharNumberRaw || "",
                    pan: mapped.panNumberRaw || "",
                });
                setViewingRider(mapped);
                return;
            }
        } catch (error) {
            console.error('Fetch rider details error:', error);
            toast.error('Could not refresh application details');
        } finally {
            setIsLoadingDetails(false);
        }
        setIdentityDraft({
            aadhar: rider.aadharNumberRaw || "",
            pan: rider.panNumberRaw || "",
        });
        setViewingRider(rider);
    };

    const handleSaveIdentity = async () => {
        if (!viewingRider?.id) return;
        setIsSavingIdentity(true);
        try {
            const payload = {};
            if (identityDraft.aadhar) payload.aadharNumber = identityDraft.aadhar.replace(/\D/g, "").slice(0, 12);
            if (identityDraft.pan) payload.panNumber = identityDraft.pan.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);

            const response = await adminApi.updateDeliveryPartnerIdentity(viewingRider.id, payload);
            const partner = response.data?.result;
            if (partner) {
                const mapped = mapDeliveryPartner(partner);
                setIdentityDraft({
                    aadhar: mapped.aadharNumberRaw || "",
                    pan: mapped.panNumberRaw || "",
                });
                setViewingRider(mapped);
                setPendingRiders((prev) =>
                    prev.map((r) => (r.id === mapped.id ? { ...r, ...mapped } : r)),
                );
                toast.success("Identity details saved");
            }
        } catch (error) {
            toast.error(error.response?.data?.message || "Failed to save identity details");
        } finally {
            setIsSavingIdentity(false);
        }
    };

    // Fetch Pending Riders
    const fetchPendingRiders = async () => {
        setIsLoading(true);
        try {
            const params = { verified: 'false' };
            if (searchTerm.trim()) params.search = searchTerm.trim();
            const response = await adminApi.getDeliveryPartners(params);
            const payload = response.data.result || {};
            const list = Array.isArray(payload.items) ? payload.items : (response.data.results || []);

            setPendingRiders(list.map(mapDeliveryPartner));
        } catch (error) {
            console.error('Fetch Pending Riders Error:', error);
            toast.error('Failed to load applications');
        } finally {
            setIsLoading(false);
        }
    };


React.useEffect(() => {
    const timer = setTimeout(() => {
        fetchPendingRiders();
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [searchTerm, filterStatus, serviceFilter]);

const filteredRiders = useMemo(() => {
    return pendingRiders.filter(r => {
        const matchesSearch = r.name.toLowerCase().includes(searchTerm.toLowerCase()) || r.phone.includes(searchTerm);
        const matchesStatus = 
            filterStatus === 'all' || 
            r.status === filterStatus ||
            (filterStatus === 'pending' && r.status === 'pending_review');
        const matchesService = serviceFilter === 'all' ||
            (serviceFilter === 'rider' && r.isParcelService);
            // CAR WASH DISABLED — (serviceFilter === 'washer' && r.isCarWashService);
        return matchesSearch && matchesStatus && matchesService;
    });
}, [pendingRiders, searchTerm, filterStatus, serviceFilter]);

const handleApprove = async (id) => {
    setIsProcessing(true);
    try {
        await adminApi.approveDeliveryPartner(id);
        toast.success('Partner Approved & Activated!');
        setPendingRiders(pendingRiders.filter(r => r.id !== id));
        setViewingRider(null);
    } catch (error) {
        console.error('Approval Error:', error);
        toast.error('Failed to approve partner');
    } finally {
        setIsProcessing(false);
    }
};

const handleReject = async (id) => {
    if (window.confirm('Are you sure you want to reject this application?')) {
        setIsProcessing(true);
        try {
            await adminApi.rejectDeliveryPartner(id);
            toast.success('Application Rejected');
            setPendingRiders(pendingRiders.filter(r => r.id !== id));
            setViewingRider(null);
        } catch (error) {
            console.error('Rejection Error:', error);
            toast.error('Failed to reject application');
        } finally {
            setIsProcessing(false);
        }
    }
};

return (
    <div className="ds-section-spacing animate-in fade-in duration-700">
        {/* Header Section */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div>
                <h1 className="ds-h1 flex items-center gap-3">
                    Rider Applications
                    <Badge variant="primary" className="text-[10px] px-2 py-0.5 uppercase">Pending Review</Badge>
                </h1>
                <p className="ds-description mt-1">Review documents for new delivery partners.</p>
            </div>
            <div className="flex items-center gap-3">
                <button
                    onClick={fetchPendingRiders}
                    className="p-3 bg-white ring-1 ring-slate-200 rounded-2xl text-slate-400 hover:text-primary transition-all shadow-sm active:rotate-180 duration-500"
                >
                    <RotateCw className="h-5 w-5" />
                </button>
                <div className="h-10 w-[1px] bg-slate-200 mx-2" />
                <div className="flex flex-col items-end">
                    <p className="ds-label">Total Pending</p>
                    <h4 className="ds-h2">{pendingRiders.filter(r => r.status === 'pending_review').length}</h4>
                </div>
            </div>
        </div>

        {/* Utility Bar */}
        <Card className="p-4 border-none shadow-sm ring-1 ring-slate-100 bg-white/50 backdrop-blur-xl">
            <div className="flex flex-col lg:flex-row gap-4">
                <div className="flex-1 relative group">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4.5 w-4.5 text-slate-400 group-focus-within:text-primary transition-colors" />
                    <input
                        type="text"
                        placeholder="Search by name or mobile..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-12 pr-4 py-3.5 bg-slate-100/50 border-none rounded-2xl text-xs font-semibold outline-none focus:ring-2 focus:ring-primary/10 transition-all"
                    />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <div className="bg-slate-100/50 p-1 rounded-2xl flex items-center">
                        {['all', 'pending', 'missing_info'].map((status) => (
                            <button
                                key={status}
                                onClick={() => setFilterStatus(status)}
                                className={cn(
                                    "px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all",
                                    filterStatus === status
                                        ? "bg-white text-slate-900 shadow-sm"
                                        : "text-slate-400 hover:text-slate-600"
                                )}
                            >
                                {status === 'pending' ? 'PENDING' : status.replace('_', ' ')}
                            </button>
                        ))}
                    </div>

                    <div className="bg-slate-100/50 p-1 rounded-2xl flex items-center">
                        {[
                            { value: 'all', label: 'All Services' },
                            { value: 'rider', label: 'Riders' },
                            // CAR WASH DISABLED — { value: 'washer', label: 'Washers' }
                        ].map((srv) => (
                            <button
                                key={srv.value}
                                onClick={() => setServiceFilter(srv.value)}
                                className={cn(
                                    "px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all",
                                    serviceFilter === srv.value
                                        ? "bg-white text-slate-900 shadow-sm"
                                        : "text-slate-400 hover:text-slate-600"
                                )}
                            >
                                {srv.label}
                            </button>
                        ))}
                    </div>

                    <button className="p-3.5 bg-white ring-1 ring-slate-200 rounded-2xl text-slate-600 hover:text-primary transition-all">
                        <Filter className="h-5 w-5" />
                    </button>
                </div>
            </div>
        </Card>

        {/* Applications Table View */}
        <Card className="border-none shadow-2xl ring-1 ring-slate-100 overflow-hidden bg-white rounded-xl relative min-h-[400px]">
            {isLoading && (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/50 backdrop-blur-sm">
                    <div className="flex flex-col items-center gap-3">
                        <div className="h-10 w-10 border-4 border-slate-200 border-t-primary rounded-full animate-spin" />
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Loading Applications...</p>
                    </div>
                </div>
            )}
            <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-slate-50/50 border-b border-slate-100">
                            <th className="ds-table-header-cell px-4">Applicant Details</th>
                            <th className="ds-table-header-cell px-4">Operational Intel</th>
                            <th className="ds-table-header-cell px-4">Submission Status</th>
                            <th className="ds-table-header-cell px-4">
                                <div className="flex justify-center">Action</div>
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {!isLoading && filteredRiders.length === 0 ? (
                            <tr>
                                <td colSpan="4" className="py-20 text-center">
                                    <FileSearch className="h-10 w-10 text-slate-300 mx-auto mb-4" />
                                    <p className="text-sm font-bold text-slate-500">No pending applications found.</p>
                                </td>
                            </tr>
                        ) : (
                            filteredRiders.map((rider) => (
                                <tr key={rider.id} className="group hover:bg-slate-50/50 transition-colors">
                                    <td className="px-8 py-6">
                                        <div className="flex items-center gap-4">
                                            <img 
                                               src={rider.profileImage || DEFAULT_AVATAR} 
                                               alt="" 
                                               className="h-12 w-12 rounded-lg bg-gray-100 ring-2 ring-white shadow-sm object-cover group-hover:scale-110 transition-all" 
                                            />
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <p className="text-sm font-black text-slate-900">{rider.name}</p>
                                                    {/* CAR WASH DISABLED
                                                    {rider.isCarWashService && (
                                                        <Badge variant="info" className="text-[8px] font-black uppercase px-1.5 py-0.5">Washer</Badge>
                                                    )}
                                                    */}
                                                    {rider.isParcelService && (
                                                        <Badge variant="primary" className="text-[8px] font-black uppercase px-1.5 py-0.5">Parcel</Badge>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2 mt-1">
                                                    <Phone className="h-3 w-3 text-slate-400" />
                                                    <span className="text-[10px] font-bold text-slate-500">{rider.phone}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-8 py-6">
                                        <div className="space-y-1.5">
                                            <div className="flex items-center gap-2 text-slate-600">
                                                <Truck className="h-3.5 w-3.5" />
                                                <span className="text-[10px] font-bold">{rider.vehicle}</span>
                                            </div>
                                            <div className="flex items-center gap-2 text-slate-400">
                                                <MapPin className="h-3.5 w-3.5" />
                                                <span className="text-[10px] font-bold">{rider.location}</span>
                                            </div>
                                            {rider.vehicleNumber && rider.vehicleNumber !== "Not provided" && (
                                                <div className="flex items-center gap-2 text-slate-400">
                                                    <IdCard className="h-3.5 w-3.5" />
                                                    <span className="text-[10px] font-bold font-mono">{rider.vehicleNumber}</span>
                                                </div>
                                            )}
                                            <div className="flex items-center gap-2">
                                                <MapPinned className="h-3.5 w-3.5 text-orange-400" />
                                                {rider.zoneName ? (
                                                    <span className="text-[10px] font-bold text-orange-600">
                                                        {formatZoneLabel(rider.zoneName, rider.zoneCity)}
                                                    </span>
                                                ) : (
                                                    <span className="text-[10px] font-bold text-amber-500">No zone selected</span>
                                                )}
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-8 py-6">
                                        <div className="flex flex-col gap-2">
                                            <Badge variant={rider.status === 'pending_review' ? 'primary' : 'warning'} className="w-fit text-[8px] font-black uppercase">
                                                {rider.status.replace('_', ' ')}
                                            </Badge>
                                            <div className="flex gap-1">
                                                {rider.documents.slice(0, 2).map((doc, i) => (
                                                    <div key={i} className="h-5 px-2 bg-slate-100 rounded-md text-[8px] font-bold text-slate-500 flex items-center">
                                                        {doc}
                                                    </div>
                                                ))}
                                                {rider.documents.length > 2 && (
                                                    <div className="h-5 px-2 bg-slate-100 rounded-md text-[8px] font-bold text-slate-400 flex items-center">
                                                        +{rider.documents.length - 2} More
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-8 py-6">
                                        <div className="flex justify-center">
                                            <button
                                                onClick={() => openApplication(rider)}
                                                disabled={isLoadingDetails}
                                                className="px-5 py-2.5 bg-[color:var(--primary)] text-white rounded-xl text-[10px] font-bold shadow-xl shadow-slate-200 hover:opacity-90 transition-all active:scale-95 disabled:opacity-60"
                                            >
                                                {isLoadingDetails ? 'LOADING...' : 'VIEW APPLICATION'}
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </Card>

        {/* Application Review Modal — portaled so backdrop scroll cannot leak through layout */}
        {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
            {viewingRider && (
                <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4 lg:p-8 overflow-hidden">
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-slate-900/60 backdrop-blur-xl"
                        onClick={() => setViewingRider(null)}
                    />
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 30 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 30 }}
                        className="relative z-10 w-full max-w-5xl max-h-[min(90vh,calc(100dvh-2rem))] flex flex-col overflow-hidden bg-white rounded-[48px] shadow-3xl"
                        role="dialog"
                        aria-modal="true"
                    >
                        <div
                            className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y"
                            onWheel={(e) => e.stopPropagation()}
                            onTouchMove={(e) => e.stopPropagation()}
                        >
                        <div className="flex flex-col lg:flex-row min-h-0">
                        {/* Left: Applicant Profile Info */}
                        <div className="lg:w-80 shrink-0 bg-slate-50 p-5 border-r border-slate-100">
                            <div className="text-center mb-8">
                                <img 
                                   src={viewingRider.profileImage || DEFAULT_AVATAR} 
                                   alt="" 
                                   className="h-24 w-24 rounded-2xl bg-white shadow-xl object-cover ring-4 ring-white mx-auto" 
                                />
                                <h3 className="ds-h2 mt-4">{viewingRider.name}</h3>
                                <p className="ds-label text-primary mt-1">Applicant Node</p>
                                <p className="text-[10px] font-bold text-slate-400 mt-2 flex items-center justify-center gap-1.5">
                                    <Calendar className="h-3.5 w-3.5" />
                                    Applied {viewingRider.appliedDate}
                                </p>
                            </div>

                            <div className="space-y-5">
                                <div className="space-y-1">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Permanent Address</p>
                                    <div className="flex items-start gap-2 text-slate-700">
                                        <MapPin className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
                                        <span className="text-xs font-bold leading-relaxed">{viewingRider.address}</span>
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Services Selected</p>
                                    <p className="text-xs font-bold text-slate-700">{viewingRider.serviceLabel}</p>
                                    <div className="flex flex-wrap gap-1.5 mt-2">
                                        {viewingRider.isParcelService && (
                                            <Badge variant="primary" className="text-[9px] font-black uppercase">Parcel Delivery</Badge>
                                        )}
                                        {/* CAR WASH DISABLED
                                        {viewingRider.isCarWashService && (
                                            <Badge variant="info" className="text-[9px] font-black uppercase">Car Wash Service</Badge>
                                        )}
                                        */}
                                    </div>
                                </div>
                                {/* CAR WASH DISABLED
                                {viewingRider.isCarWashService && (
                                    <div className="space-y-1 pt-4 border-t border-slate-100">
                                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Detailing Experience</p>
                                        <div className="bg-slate-50 rounded-xl p-3 border border-slate-100 mt-1">
                                            <p className="text-xs font-black text-slate-800">{viewingRider.experience || "Not Specified"}</p>
                                            {viewingRider.experienceDetails && (
                                                <p className="text-[10px] font-bold text-slate-500 mt-1 leading-relaxed">
                                                    {viewingRider.experienceDetails}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                )}
                                */}
                                <div className="space-y-1 pt-4 border-t border-slate-100">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Identity Numbers</p>
                                    <div className="bg-white rounded-xl p-3 border border-slate-100 mt-1 space-y-3">
                                        <div>
                                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Aadhar</p>
                                            <p className="text-sm font-bold text-slate-900 font-mono mt-0.5">{viewingRider.aadharNumber}</p>
                                        </div>
                                        <div>
                                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">PAN</p>
                                            <p className="text-sm font-bold text-slate-900 font-mono mt-0.5">{viewingRider.panNumber}</p>
                                        </div>
                                    </div>
                                </div>
                                <div className="pt-6 border-t border-slate-200">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">System Confidence</p>
                                    <div className="h-2 w-full bg-slate-200 rounded-full overflow-hidden">
                                        <div className="h-full bg-brand-500 w-[85%]" />
                                    </div>
                                    <p className="text-[9px] font-bold text-brand-600 mt-2">85% Verification Score</p>
                                </div>
                            </div>
                        </div>

                        {/* Right: Document & Action Section */}
                        <div className="flex-1 min-w-0 p-5 lg:p-10 bg-white pb-8">
                            <div className="flex justify-between items-start mb-8">
                                <div>
                                    <h2 className="ds-h1">Verification Protocol</h2>
                                    <p className="ds-description mt-1">Review all registration details submitted by the applicant.</p>
                                </div>
                                <button onClick={() => setViewingRider(null)} className="p-3 hover:bg-slate-50 rounded-2xl transition-all">
                                    <X className="h-6 w-6 text-slate-400" />
                                </button>
                            </div>

                            <div className="space-y-8 mb-10">
                                <div className="space-y-4">
                                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                                        <User className="h-4 w-4" /> Personal Information
                                    </h4>
                                    <div className="p-5 bg-slate-50 rounded-2xl grid grid-cols-1 md:grid-cols-2 gap-5">
                                        <DetailField label="Full Name" value={viewingRider.name} />
                                        <DetailField label="Phone Number" value={viewingRider.phone} mono />
                                        <DetailField label="Email Address" value={viewingRider.email} />
                                        <DetailField label="Permanent Address" value={viewingRider.address} />
                                        <DetailField
                                            label="Work Zone"
                                            value={
                                                viewingRider.zoneName
                                                    ? formatZoneLabel(viewingRider.zoneName, viewingRider.zoneCity)
                                                    : "Not selected"
                                            }
                                        />
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                                        <Truck className="h-4 w-4" /> Vehicle Details
                                    </h4>
                                    <div className="p-5 bg-slate-50 rounded-2xl grid grid-cols-1 md:grid-cols-3 gap-5">
                                        <DetailField label="Vehicle Type" value={viewingRider.vehicle} />
                                        <DetailField label="Plate Number" value={viewingRider.vehicleNumber} mono />
                                        <DetailField label="Driving License" value={viewingRider.drivingLicenseNumber} mono />
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                                        <IdCard className="h-4 w-4" /> Identity Details
                                    </h4>
                                    <div className="p-5 bg-slate-50 rounded-2xl space-y-4">
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div className="p-4 bg-white rounded-xl border border-slate-100 space-y-2">
                                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Aadhar Number</p>
                                                <input
                                                    type="text"
                                                    inputMode="numeric"
                                                    value={identityDraft.aadhar}
                                                    onChange={(e) =>
                                                        setIdentityDraft((prev) => ({
                                                            ...prev,
                                                            aadhar: e.target.value.replace(/\D/g, "").slice(0, 12),
                                                        }))
                                                    }
                                                    placeholder="0000 0000 0000"
                                                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold font-mono text-slate-900"
                                                />
                                                <p className="text-[10px] text-slate-500 font-medium">
                                                    {viewingRider.aadharNumber !== "Not provided"
                                                        ? `On file: ${viewingRider.aadharNumber}`
                                                        : "Not saved during registration — enter from Aadhar document"}
                                                </p>
                                            </div>
                                            <div className="p-4 bg-white rounded-xl border border-slate-100 space-y-2">
                                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">PAN Number</p>
                                                <input
                                                    type="text"
                                                    value={identityDraft.pan}
                                                    onChange={(e) =>
                                                        setIdentityDraft((prev) => ({
                                                            ...prev,
                                                            pan: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10),
                                                        }))
                                                    }
                                                    placeholder="ABCDE1234F"
                                                    className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold font-mono uppercase text-slate-900"
                                                />
                                                <p className="text-[10px] text-slate-500 font-medium">
                                                    {viewingRider.panNumber !== "Not provided"
                                                        ? `On file: ${viewingRider.panNumber}`
                                                        : "Not saved during registration — enter from PAN document"}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={handleSaveIdentity}
                                            disabled={isSavingIdentity || (!identityDraft.aadhar && !identityDraft.pan)}
                                            className="px-4 py-2.5 bg-[color:var(--primary)] text-white rounded-xl text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                                        >
                                            {isSavingIdentity ? "Saving..." : "Save Identity Numbers"}
                                        </button>
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                                        <Building2 className="h-4 w-4" /> Bank Details
                                    </h4>
                                    <div className="p-5 bg-slate-50 rounded-2xl grid grid-cols-1 md:grid-cols-3 gap-5">
                                        <DetailField label="Account Holder" value={viewingRider.accountHolder} />
                                        <DetailField label="Account Number" value={viewingRider.accountNumber} mono />
                                        <DetailField label="IFSC Code" value={viewingRider.ifsc} mono />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-4">
                                        <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Contact Records</h4>
                                        <div className="p-5 bg-slate-50 rounded-2xl space-y-4">
                                            <div className="flex items-center gap-4">
                                                <div className="h-10 w-10 rounded-xl bg-white shadow-sm flex items-center justify-center text-primary">
                                                    <Phone className="h-5 w-5" />
                                                </div>
                                                <span className="text-sm font-bold text-slate-900 font-mono">{viewingRider.phone}</span>
                                            </div>
                                            <div className="flex items-center gap-4">
                                                <div className="h-10 w-10 rounded-xl bg-white shadow-sm flex items-center justify-center text-primary">
                                                    <Mail className="h-5 w-5" />
                                                </div>
                                                <span className="text-sm font-bold text-slate-900 break-all">{viewingRider.email}</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="space-y-4">
                                        <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Services Selected</h4>
                                        <div className="p-5 bg-slate-50 rounded-2xl border-2 border-brand-500/10 h-full flex items-center">
                                            <p className="text-sm font-black text-slate-900">{viewingRider.serviceLabel}</p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-4 mb-10">
                                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Submitted Documents ({viewingRider.documents.length})</h4>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                    {viewingRider.documents.map((doc, idx) => {
                                        const isObj = doc && typeof doc === 'object';
                                        const docKey = isObj ? (doc.name || '') : doc;
                                        const docUrl = isObj ? doc.url : (viewingRider.documentsRaw?.[docKey] || '');
                                        const docName = DOC_LABELS[docKey] || docKey.toUpperCase();
                                        return (
                                            <a 
                                                key={idx} 
                                                href={docUrl} 
                                                target="_blank" 
                                                rel="noreferrer" 
                                                className="group relative aspect-[4/3] bg-slate-50 rounded-[24px] border border-slate-100 overflow-hidden cursor-pointer hover:border-primary transition-all flex flex-col items-center justify-center"
                                            >
                                                {docUrl ? (
                                                    <img 
                                                        src={docUrl} 
                                                        alt={docName} 
                                                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                                    />
                                                ) : (
                                                    <FileSearch className="h-8 w-8 text-slate-400 group-hover:text-primary transition-colors" />
                                                )}
                                                <div className="absolute inset-x-0 bottom-0 bg-slate-900/60 backdrop-blur-sm py-1.5 px-3 flex items-center justify-between">
                                                    <span className="text-[9px] font-black text-white uppercase tracking-wider">{docName}</span>
                                                    <span className="text-[8px] font-bold text-primary-light uppercase">Click to Zoom</span>
                                                </div>
                                            </a>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="flex flex-col sm:flex-row gap-4">
                                <button
                                    disabled={isProcessing}
                                    onClick={() => handleApprove(viewingRider.id)}
                                    className="flex-1 py-5 bg-[color:var(--primary)] text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-2xl active:scale-95 transition-all flex items-center justify-center gap-3 disabled:opacity-50"
                                >
                                    {isProcessing ? (
                                        <>
                                            <div className="h-4 w-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                                            Processing Vetting...
                                        </>
                                    ) : (
                                        <>
                                            <Check className="h-4 w-4" />
                                            APPROVE & ACTIVATE RIDER
                                        </>
                                    )}
                                </button>
                                <button
                                    onClick={() => handleReject(viewingRider.id)}
                                    className="py-5 px-5 bg-rose-50 text-rose-600 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-rose-100 transition-all active:scale-95"
                                >
                                    REJECT APPLICATION
                                </button>
                            </div>
                        </div>
                        </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>,
        document.body
        )}
    </div>
);
};

export default PendingDeliveryBoys;
