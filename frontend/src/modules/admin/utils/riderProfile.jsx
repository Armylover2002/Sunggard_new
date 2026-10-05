import React from "react";
import { cn } from "@/lib/utils";

export const formatServiceTypes = (rider) => {
    const services = [];
    if (rider.isParcelService) services.push("Courier");
    // CAR WASH DISABLED
    // if (rider.isCarWashService) services.push("Car Wash");
    return services.length ? services.join(" · ") : "Not specified";
};

export const DOC_LABELS = {
    aadhar: "AADHAR",
    aadharFront: "AADHAR FRONT",
    aadharBack: "AADHAR BACK",
    pan: "PAN",
    drivingLicense: "DRIVING LICENSE",
};

export const formatPanDisplay = (value) => {
    const pan = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!pan) return "Not provided";
    return pan;
};

export const formatAadharDisplay = (value) => {
    const digits = String(value || "").replace(/\D/g, "");
    if (!digits) return "Not provided";
    return digits.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
};

export const formatPlateDisplay = (value) => {
    const plate = String(value || "").replace(/\s/g, "").toUpperCase();
    if (!plate || plate === "N/A") return value || "Not provided";
    if (plate.length === 10) {
        return `${plate.slice(0, 2)} ${plate.slice(2, 4)} ${plate.slice(4, 6)} ${plate.slice(6)}`;
    }
    return value;
};

export const formatLicenseDisplay = (value) => {
    const raw = String(value || "").replace(/[\s-]/g, "").toUpperCase();
    if (!raw || raw === "N/A") return value || "Not provided";
    if (raw.startsWith("DL") && raw.length >= 15) {
        return `DL-${raw.slice(2)}`;
    }
    return value;
};

export const mapDeliveryPartner = (r) => ({
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

export const DetailField = ({ label, value, mono = false }) => (
    <div className="space-y-1">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}</p>
        <p className={cn("text-sm font-bold text-slate-900 break-all", mono && "font-mono")}>
            {value || "Not provided"}
        </p>
    </div>
);
