import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import Card from '@shared/components/ui/Card';
import Badge from '@shared/components/ui/Badge';
import PageHeader from '@shared/components/ui/PageHeader';
import StatCard from '@shared/components/ui/StatCard';
import EmptyState from '@shared/components/ui/EmptyState';
import {
    Users,
    UserCheck,
    Activity,
    Trophy,
    Search,
    Filter,
    Plus,
    MoreVertical,
    Phone,
    MapPin,
    MapPinned,
    Truck,
    User,
    ShieldCheck,
    XCircle,
    Pencil,
    Power,
    PowerOff,
    Eye,
    X
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import Pagination from '@shared/components/ui/Pagination';
import { adminApi } from '../services/adminApi';
import { formatZoneLabel } from '@shared/utils/zoneGeometry';
import { mapDeliveryPartner, DetailField, DOC_LABELS } from '../utils/riderProfile';

/** Mongo's 24-char hex id isn't something anyone reads at a glance — show
 *  the last 6 characters, which is plenty to tell riders apart on screen. */
const shortRiderId = (id) => `RD-${String(id || '').slice(-6).toUpperCase()}`;

const ActiveDeliveryBoys = () => {
    const [riders, setRiders] = useState([]);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(25);
    const [total, setTotal] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [selectedRider, setSelectedRider] = useState(null);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [isOnboardModalOpen, setIsOnboardModalOpen] = useState(false);
    const [viewingRider, setViewingRider] = useState(null);

    // Form states
    const [formState, setFormState] = useState({
        name: '', phone: '', email: '', vehicle: '', vehicleNum: '', location: ''
    });

    // Fetch Riders — only approved/verified partners belong on the active fleet screen.
    const fetchRiders = async (requestedPage = 1) => {
        setIsLoading(true);
        try {
            const params = { page: requestedPage, limit: pageSize, verified: 'true' };
            if (searchTerm.trim()) params.search = searchTerm.trim();
            // Backend only understands online/offline; "available" and "busy" are
            // both online, so narrow to online there and split the two client-side.
            if (statusFilter === 'offline') params.status = 'offline';
            else if (statusFilter === 'available' || statusFilter === 'busy') params.status = 'online';

            const response = await adminApi.getDeliveryPartners(params);
            const payload = response.data.result || {};
            const data = Array.isArray(payload.items) ? payload.items : (response.data.results || response.data.result || []);

            const mappedRiders = data.map(r => ({
                id: r._id,
                name: r.name,
                phone: r.phone,
                email: r.email,
                avatar: r.profileImage || '',
                isActive: r.isActive !== false,
                status: r.isBusy ? 'busy' : (r.isOnline ? 'available' : 'offline'),
                vehicle: r.vehicleType,
                vehicleNum: r.vehicleNumber || 'N/A',
                totalOrders: r.totalDeliveries || 0,
                // Onboarding address is what the rider actually typed in; currentArea
                // only fills in once they've sent a live GPS ping, so it's a fallback.
                location: r.address || r.currentArea || 'Unknown',
                zoneName: r.zoneIds?.[0]?.name || '',
                zoneCity: r.zoneIds?.[0]?.city || '',
                joinDate: new Date(r.createdAt).toLocaleDateString()
            }));

            setRiders(mappedRiders);
            setTotal(typeof payload.total === 'number' ? payload.total : mappedRiders.length);
            setPage(typeof payload.page === 'number' ? payload.page : requestedPage);
        } catch (error) {
            console.error('Fetch Riders Error:', error);
            toast.error('Failed to fetch delivery partners');
        } finally {
            setIsLoading(false);
        }
    };

React.useEffect(() => {
    const timer = setTimeout(() => {
        fetchRiders(1);
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [pageSize, searchTerm, statusFilter]);

// Filtering logic
const filteredRiders = useMemo(() => {
    return riders.filter(r => {
        const matchesSearch = r.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            r.phone.includes(searchTerm);
        const matchesStatus = statusFilter === 'all' || r.status === statusFilter;
        return matchesSearch && matchesStatus;
    });
}, [riders, searchTerm, statusFilter]);

const handleAction = async (type, rider) => {
    if (type === 'view') {
        // The list row only carries summary fields; the full onboarding record
        // comes from the same by-id endpoint the Pending screen uses.
        try {
            const response = await adminApi.getDeliveryPartnerById(rider.id);
            const partner = response.data?.result;
            if (!partner) throw new Error('Rider not found');
            const mapped = mapDeliveryPartner(partner);
            setViewingRider({
                ...mapped,
                id: rider.id,
                avatar: rider.avatar,
                isActive: rider.isActive,
                status: rider.status,
                totalOrders: rider.totalOrders,
                joinDate: rider.joinDate,
                vehicle: mapped.vehicle,
                vehicleNum: mapped.vehicleNumber,
                location: mapped.address || rider.location,
                zoneName: rider.zoneName,
                zoneCity: rider.zoneCity,
            });
        } catch (error) {
            console.error('Fetch rider details error:', error);
            toast.error('Could not load rider details');
        }
    } else if (type === 'edit') {
        setFormState(rider);
        setSelectedRider(rider);
        setIsEditModalOpen(true);
    } else if (type === 'toggle-active') {
        const nextActive = !rider.isActive;
        const confirmMsg = nextActive
            ? `Reactivate ${rider.name}? They will be able to log back in immediately.`
            : `Deactivate ${rider.name}? They will be logged out and can't log in again until reactivated.`;
        if (!window.confirm(confirmMsg)) {
            return;
        }
        try {
            const response = await adminApi.setDeliveryPartnerActive(rider.id, nextActive);
            if (response.data?.success) {
                setRiders((prev) =>
                    prev.map((r) =>
                        r.id === rider.id
                            ? { ...r, isActive: nextActive, status: nextActive ? r.status : 'offline' }
                            : r,
                    ),
                );
                setViewingRider((prev) =>
                    prev?.id === rider.id
                        ? { ...prev, isActive: nextActive, status: nextActive ? prev.status : 'offline' }
                        : prev,
                );
                toast.success(nextActive ? 'Rider reactivated' : 'Rider deactivated');
            } else {
                toast.error(response.data?.message || 'Failed to update rider status');
            }
        } catch (error) {
            console.error('Toggle active error:', error);
            toast.error(error.response?.data?.message || 'Failed to update rider status');
        }
    }
};

const handleOnboardSubmit = (e) => {
    e.preventDefault();
    const newRider = {
        ...formState,
        id: 'r' + (riders.length + 1),
        status: 'offline',
        totalOrders: 0,
        joinDate: new Date().toLocaleDateString()
    };
    setRiders([newRider, ...riders]);
    setIsOnboardModalOpen(false);
    setFormState({ name: '', phone: '', email: '', vehicle: '', vehicleNum: '', location: '' });
};

const handleEditSubmit = (e) => {
    e.preventDefault();
    setRiders(riders.map(r => r.id === selectedRider.id ? { ...r, ...formState } : r));
    setIsEditModalOpen(false);
    setSelectedRider(null);
};

const stats = [
    { label: 'Total Riders', value: riders.length, color: 'indigo', icon: Users, description: 'Total fleet size' },
    { label: 'Available', value: riders.filter(r => r.status === 'available').length, color: 'emerald', icon: UserCheck, description: 'Ready for orders' },
    { label: 'Busy (On Task)', value: riders.filter(r => r.status === 'busy').length, color: 'amber', icon: Activity, description: 'Currently delivering' },
    { label: 'Deliveries Done', value: riders.reduce((sum, r) => sum + (r.totalOrders || 0), 0), color: 'rose', icon: Trophy, description: 'Completed on this page' },
];

return (
    <div className="ds-section-spacing animate-in fade-in duration-700">
        {/* Header Section */}
        <PageHeader
            title="Delivery Boys"
            description="Manage all your active delivery partners here."
            badge={<div className="h-2 w-2 rounded-full bg-brand-500 animate-pulse" />}
            actions={
                <button
                    onClick={() => setIsOnboardModalOpen(true)}
                    className="ds-btn ds-btn-md bg-[color:var(--primary)] text-white hover:opacity-90 shadow-xl hover:shadow-slate-200 group"
                >
                    <Plus className="h-4 w-4 group-hover:rotate-90 transition-transform" />
                    <span>ADD NEW RIDER</span>
                </button>
            }
        />

        {/* Quick Stats Grid */}
        <div className="ds-grid-cards-4">
            {stats.map((stat, idx) => (
                <StatCard
                    key={idx}
                    label={stat.label}
                    value={stat.value}
                    icon={stat.icon}
                    description={stat.description}
                    color={
                        stat.color === 'amber' ? 'text-amber-600' :
                            stat.color === 'rose' ? 'text-rose-600' : 'text-brand-600'
                    }
                    bg={
                        stat.color === 'amber' ? 'bg-amber-50' :
                            stat.color === 'rose' ? 'bg-rose-50' : 'bg-brand-50'
                    }
                />
            ))}
        </div>

        {/* Filters & Search Section */}
        <Card className="p-4 border-none shadow-sm ring-1 ring-slate-100 bg-white/50 backdrop-blur-xl">
            <div className="flex flex-col lg:flex-row gap-4">
                <div className="flex-1 relative group">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4.5 w-4.5 text-slate-400 group-focus-within:text-primary transition-colors" />
                    <input
                        type="text"
                        placeholder="Search by name or phone number..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-12 pr-4 py-3.5 bg-slate-100/50 border-none rounded-2xl text-xs font-semibold outline-none focus:ring-2 focus:ring-primary/10 transition-all"
                    />
                </div>
                <div className="flex items-center gap-3">
                    <div className="bg-slate-100/50 p-1 rounded-2xl flex items-center">
                        {['all', 'available', 'busy', 'offline'].map((status) => (
                            <button
                                key={status}
                                onClick={() => setStatusFilter(status)}
                                className={cn(
                                    "px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all",
                                    statusFilter === status
                                        ? "bg-white text-slate-900 shadow-sm"
                                        : "text-slate-400 hover:text-slate-600"
                                )}
                            >
                                {status}
                            </button>
                        ))}
                    </div>
                    <button className="p-3.5 bg-white ring-1 ring-slate-200 rounded-2xl text-slate-600 hover:text-primary hover:ring-primary/30 transition-all shadow-sm">
                        <Filter className="h-5 w-5" />
                    </button>
                </div>
            </div>
        </Card>

        {/* Riders Grid View */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 relative min-h-[300px]">
            {isLoading && (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/50 backdrop-blur-sm rounded-3xl">
                    <div className="flex flex-col items-center gap-3">
                        <div className="h-10 w-10 border-4 border-slate-200 border-t-primary rounded-full animate-spin" />
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Fetching fleet...</p>
                    </div>
                </div>
            )}
            <AnimatePresence mode='popLayout'>
                {!isLoading && filteredRiders.length === 0 ?
                    <div className="col-span-full">
                        <EmptyState
                            icon={User}
                            title="No delivery partners found"
                            description="No delivery partners match your current search or filters."
                        />
                    </div>
                    :
                    filteredRiders.map((rider) => (
                        <motion.div
                            layout
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            key={rider.id}
                        >
                            <Card className="group border-none shadow-xl ring-1 ring-slate-100 hover:ring-primary/20 transition-all overflow-hidden bg-white">
                                <div className="p-6 space-y-5">
                                    {/* Rider Top Header */}
                                    <div className="flex justify-between items-start">
                                        <div className="flex gap-4">
                                            <div className="relative">
                                                <img 
                                                   src={rider.avatar && !rider.avatar.includes('emoji') && !rider.avatar.includes('avatar') ? rider.avatar : "https://cdn-icons-png.flaticon.com/512/149/149071.png"} 
                                                   alt="" 
                                                   className="h-14 w-14 rounded-lg bg-gray-100 ring-2 ring-white shadow-sm object-cover group-hover:scale-105 transition-transform" 
                                                />
                                                <div className={cn(
                                                    "absolute -bottom-1 -right-1 h-5 w-5 rounded-full border-4 border-white shadow-sm",
                                                    rider.status === 'available' ? 'bg-brand-500' :
                                                        rider.status === 'busy' ? 'bg-amber-500' : 'bg-slate-300'
                                                )} />
                                            </div>
                                            <div>
                                                <h4 className="text-sm font-black text-slate-900 group-hover:text-primary transition-colors">{rider.name}</h4>
                                                <div className="flex items-center gap-1.5 mt-1 text-slate-500">
                                                    <Phone className="h-3 w-3" />
                                                    <span className="text-[10px] font-bold">{rider.phone}</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className={cn(
                                            "flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase",
                                            !rider.isActive ? 'bg-rose-50 text-rose-600' :
                                                rider.status === 'available' ? 'bg-brand-50 text-brand-600' :
                                                rider.status === 'busy' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500'
                                        )}>
                                            {rider.isActive ? rider.status : 'deactivated'}
                                        </div>
                                    </div>

                                    {/* Metrics Row */}
                                    <div className="bg-slate-50 p-3 rounded-2xl">
                                        <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1.5">Deliveries Completed</p>
                                        <div className="flex items-center gap-1.5">
                                            <ShieldCheck className="h-3.5 w-3.5 text-brand-500" />
                                            <span className="text-xs font-black text-slate-900">{rider.totalOrders} Deliv.</span>
                                        </div>
                                    </div>

                                    {/* Location & Vehicle */}
                                    <div className="space-y-2">
                                        <div className="flex items-center gap-2 text-slate-500">
                                            <MapPin className="h-3.5 w-3.5 shrink-0" />
                                            <span className="text-[10px] font-semibold truncate">{rider.location}</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-slate-500">
                                            <Truck className="h-3.5 w-3.5 shrink-0" />
                                            <span className="text-[10px] font-semibold truncate">{rider.vehicle} • <span className="text-slate-900 font-bold">{rider.vehicleNum}</span></span>
                                        </div>
                                        <div className="flex items-center gap-2 text-orange-500">
                                            <MapPinned className="h-3.5 w-3.5 shrink-0" />
                                            {rider.zoneName ? (
                                                <span className="text-[10px] font-bold truncate">
                                                    {formatZoneLabel(rider.zoneName, rider.zoneCity)}
                                                </span>
                                            ) : (
                                                <span className="text-[10px] font-bold text-amber-500 truncate">No zone selected</span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Action Footer */}
                                    <div className="pt-2 flex items-center gap-2">
                                        <button
                                            onClick={() => handleAction('view', rider)}
                                            className="flex-1 py-2.5 bg-[color:var(--primary)] text-white rounded-xl text-[10px] font-bold shadow-lg shadow-slate-200 hover:opacity-90 transition-all active:scale-95 flex items-center justify-center gap-2"
                                        >
                                            <Eye className="h-3.5 w-3.5" />
                                            VIEW PROFILE
                                        </button>
                                        <button
                                            onClick={() => handleAction('edit', rider)}
                                            className="p-2.5 bg-slate-100 text-slate-600 rounded-xl hover:bg-brand-50 hover:text-brand-600 transition-all"
                                        >
                                            <Pencil className="h-4 w-4" />
                                        </button>
                                        <button
                                            onClick={() => handleAction('toggle-active', rider)}
                                            title={rider.isActive ? 'Deactivate rider' : 'Reactivate rider'}
                                            className={cn(
                                                "p-2.5 rounded-xl transition-all",
                                                rider.isActive
                                                    ? "bg-slate-100 text-slate-600 hover:bg-rose-50 hover:text-rose-600"
                                                    : "bg-brand-50 text-brand-600 hover:bg-brand-100"
                                            )}
                                        >
                                            {rider.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                                        </button>
                                    </div>
                                </div>
                            </Card>
                        </motion.div>
                    ))
                }
            </AnimatePresence>
        </div>
        <div className="mt-6 flex justify-center">
            <Pagination
                page={page}
                totalPages={Math.ceil(total / pageSize) || 1}
                total={total}
                pageSize={pageSize}
                onPageChange={(p) => fetchRiders(p)}
                onPageSizeChange={(newSize) => {
                    setPageSize(newSize);
                    setPage(1);
                }}
                loading={isLoading}
            />
        </div>

        {/* Profile Detail Modal — portaled to body so the page behind cannot take the scroll */}
        {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
            {viewingRider && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-slate-900/40 backdrop-blur-md"
                        onClick={() => setViewingRider(null)}
                    />
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        className="w-full max-w-2xl relative z-10 bg-white rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto overscroll-contain"
                    >
                        <div className="p-10">
                            <div className="flex justify-between items-start mb-10">
                                <div className="flex gap-6">
                                    <img 
                                       src={viewingRider.avatar && !viewingRider.avatar.includes('emoji') && !viewingRider.avatar.includes('avatar') ? viewingRider.avatar : "https://cdn-icons-png.flaticon.com/512/149/149071.png"} 
                                       alt="" 
                                       className="h-24 w-24 rounded-xl bg-gray-100 ring-4 ring-slate-50 shadow-2xl object-cover" 
                                    />
                                    <div>
                                        <h2 className="ds-h1">{viewingRider.name}</h2>
                                        <div className="flex items-center gap-3 mt-2">
                                            <Badge
                                                variant={!viewingRider.isActive ? 'error' : viewingRider.status === 'available' ? 'success' : viewingRider.status === 'busy' ? 'warning' : 'gray'}
                                                className="uppercase font-black text-[9px] px-3"
                                            >
                                                {viewingRider.isActive ? viewingRider.status : 'deactivated'}
                                            </Badge>
                                            <span className="text-xs font-bold text-slate-400">Rider ID: {shortRiderId(viewingRider.id)}</span>
                                        </div>
                                    </div>
                                </div>
                                <button onClick={() => setViewingRider(null)} className="p-3 bg-slate-50 hover:bg-slate-100 rounded-2xl transition-all">
                                    <XCircle className="h-6 w-6 text-slate-400" />
                                </button>
                            </div>

                            <div className="grid grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
                                <div className="space-y-1">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Contact Number</p>
                                    <p className="text-sm font-bold text-slate-900">{viewingRider.phone}</p>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Email Address</p>
                                    <p className="text-sm font-bold text-slate-900">{viewingRider.email}</p>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Fleet Partner Since</p>
                                    <p className="text-sm font-bold text-slate-900">{viewingRider.joinDate}</p>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Vehicle Assigned</p>
                                    <p className="text-sm font-bold text-slate-900">{viewingRider.vehicle}</p>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Registration No.</p>
                                    <p className="text-sm font-bold text-slate-900">{viewingRider.vehicleNum}</p>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Last Synced Area</p>
                                    <p className="text-sm font-bold text-slate-900">{viewingRider.location}</p>
                                </div>
                                <div className="space-y-1">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Work Zone</p>
                                    <p className="text-sm font-bold text-slate-900">
                                        {viewingRider.zoneName
                                            ? formatZoneLabel(viewingRider.zoneName, viewingRider.zoneCity)
                                            : "Not selected"}
                                    </p>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4 p-6 bg-slate-50 rounded-xl">
                                <div className="text-center">
                                    <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Total Deliveries</p>
                                    <span className="text-lg font-black text-slate-900 text-brand-600">{viewingRider.totalOrders}</span>
                                </div>
                                <div className="text-center border-l border-slate-200">
                                    <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Fleet Status</p>
                                    <span className="text-lg font-black text-slate-900 capitalize">{viewingRider.isActive ? viewingRider.status : 'Deactivated'}</span>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
                                <DetailField label="Permanent Address" value={viewingRider.address} />
                                <DetailField label="Service" value={viewingRider.serviceLabel} />
                                <DetailField label="Experience" value={viewingRider.experience} />
                                <DetailField label="Plate Number" value={viewingRider.vehicleNumber} mono />
                                <DetailField label="Driving License" value={viewingRider.drivingLicenseNumber} mono />
                                <DetailField label="Aadhar" value={viewingRider.aadharNumber} mono />
                                <DetailField label="PAN" value={viewingRider.panNumber} mono />
                                <DetailField label="Account Holder" value={viewingRider.accountHolder} />
                                <DetailField label="Account Number" value={viewingRider.accountNumber} mono />
                                <DetailField label="IFSC Code" value={viewingRider.ifsc} mono />
                            </div>

                            {viewingRider.documents?.length > 0 && (
                                <div className="space-y-4 mb-10">
                                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Submitted Documents ({viewingRider.documents.length})</h4>
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                        {viewingRider.documents.map((doc) => {
                                            const docUrl = viewingRider.documentsRaw?.[doc] || '';
                                            return (
                                                <a key={doc} href={docUrl} target="_blank" rel="noreferrer" className="relative aspect-[4/3] bg-slate-50 rounded-2xl border border-slate-100 overflow-hidden">
                                                    {docUrl && <img src={docUrl} alt={DOC_LABELS[doc] || doc} className="w-full h-full object-cover" />}
                                                    <span className="absolute inset-x-0 bottom-0 bg-slate-900/60 py-1.5 px-3 text-[9px] font-black text-white uppercase">
                                                        {DOC_LABELS[doc] || doc.toUpperCase()}
                                                    </span>
                                                </a>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            <button
                                onClick={() => handleAction('toggle-active', viewingRider)}
                                className={cn(
                                    "mt-6 w-full py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl active:scale-95 transition-all flex items-center justify-center gap-2",
                                    viewingRider.isActive
                                        ? "bg-rose-50 text-rose-600 hover:bg-rose-100"
                                        : "bg-[color:var(--primary)] text-white hover:opacity-90"
                                )}
                            >
                                {viewingRider.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                                {viewingRider.isActive ? 'Deactivate Rider' : 'Reactivate Rider'}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>,
        document.body
        )}

        {/* Onboard / Edit Modal */}
        <AnimatePresence>
            {(isOnboardModalOpen || isEditModalOpen) && (
                <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-slate-900/60 backdrop-blur-lg"
                        onClick={() => {
                            setIsOnboardModalOpen(false);
                            setIsEditModalOpen(false);
                        }}
                    />
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 30 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 30 }}
                        className="w-full max-w-lg relative z-[120] bg-white rounded-2xl p-5 shadow-3xl"
                    >
                        <h3 className="ds-h2 mb-2">
                            {isEditModalOpen ? 'Edit Rider' : 'Add New Rider'}
                        </h3>
                        <p className="ds-label mt-1 text-slate-500">
                            {isEditModalOpen ? 'Update rider details below.' : 'Enter details to register a new delivery partner.'}
                        </p>

                        <form onSubmit={isEditModalOpen ? handleEditSubmit : handleOnboardSubmit} className="space-y-5">
                            <div className="grid grid-cols-1 gap-5">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Full Identity Name</label>
                                    <input
                                        required
                                        type="text"
                                        value={formState.name}
                                        onChange={(e) => setFormState({ ...formState, name: e.target.value })}
                                        className="w-full px-5 py-3.5 bg-slate-50 border-none rounded-2xl text-xs font-bold outline-none focus:ring-2 focus:ring-primary/10 transition-all"
                                        placeholder="e.g. Rahul Sharma"
                                    />
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Secure Contact</label>
                                        <input
                                            required
                                            type="text"
                                            value={formState.phone}
                                            onChange={(e) => setFormState({ ...formState, phone: e.target.value })}
                                            className="w-full px-5 py-3.5 bg-slate-50 border-none rounded-2xl text-xs font-bold outline-none focus:ring-2 focus:ring-primary/10 transition-all"
                                            placeholder="+91..."
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Work Vehicle</label>
                                        <select
                                            required
                                            value={formState.vehicle}
                                            onChange={(e) => setFormState({ ...formState, vehicle: e.target.value })}
                                            className="w-full px-5 py-3.5 bg-slate-50 border-none rounded-2xl text-xs font-bold outline-none focus:ring-2 focus:ring-primary/10 transition-all appearance-none"
                                        >
                                            <option value="">Select Vehicle</option>
                                            <option>Two Wheeler</option>
                                            <option>Electric Scooter</option>
                                            <option>Cycle</option>
                                            <option>Three Wheeler</option>
                                        </select>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Registration Vehicle No.</label>
                                    <input
                                        required
                                        type="text"
                                        value={formState.vehicleNum}
                                        onChange={(e) => setFormState({ ...formState, vehicleNum: e.target.value })}
                                        className="w-full px-5 py-3.5 bg-slate-50 border-none rounded-2xl text-xs font-bold outline-none focus:ring-2 focus:ring-primary/10 transition-all"
                                        placeholder="e.g. MH-12-AB-0000"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Assigned Operational Area</label>
                                    <input
                                        required
                                        type="text"
                                        value={formState.location}
                                        onChange={(e) => setFormState({ ...formState, location: e.target.value })}
                                        className="w-full px-5 py-3.5 bg-slate-50 border-none rounded-2xl text-xs font-bold outline-none focus:ring-2 focus:ring-primary/10 transition-all"
                                        placeholder="e.g. Bandra West, Mumbai"
                                    />
                                </div>
                            </div>

                            <button type="submit" className="w-full py-4.5 bg-[color:var(--primary)] text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-2xl hover:opacity-90 transition-all transform active:scale-[0.98] mt-4">
                                {isEditModalOpen ? 'SAVE CHANGES' : 'ADD RIDER'}
                            </button>
                        </form>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    </div>
);
};

export default ActiveDeliveryBoys;
