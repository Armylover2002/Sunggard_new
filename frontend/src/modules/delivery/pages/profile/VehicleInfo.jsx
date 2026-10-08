import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Truck,
  ShieldCheck,
  FileText,
  AlertCircle,
  Pencil,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import Button from "@/shared/components/ui/Button";
import Card from "@/shared/components/ui/Card";
import { useAuth } from "@core/context/AuthContext";
import { useSettings } from "@core/context/SettingsContext";
import { deliveryApi } from "../../services/deliveryApi";
import {
  VEHICLE_TYPES,
  VEHICLE_PLATE_REGEX,
  DL_REGEX,
  vehicleTypeLabel,
  formatVehiclePlate,
  normalizeVehiclePlate,
  formatDrivingLicense,
  normalizeDrivingLicense,
  displayPlate,
} from "../../utils/vehicleRules";

const inputClass =
  "w-full rounded-xl border border-gray-200 bg-white px-3.5 py-3 text-sm font-semibold text-gray-900 outline-none focus:border-gray-400";

const VehicleInfo = () => {
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();
  const { settings } = useSettings();
  const appName = settings?.appName || "App";

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ vehicleType: "bike", vehicleNumber: "", drivingLicenseNumber: "" });

  const vehicleDetails = {
    type: vehicleTypeLabel(user?.vehicleType),
    plateNumber: displayPlate(user?.vehicleNumber),
  };

  const documents = [
    {
      title: "Driving License",
      number: user?.drivingLicenseNumber || "Not Available",
      expiry: "N/A",
    },
    {
      title: "RC Book",
      number: user?.vehicleNumber || "Not Assigned",
      expiry: "Valid Forever",
    },
  ];

  const lastRejected = user?.vehicleChange?.status === "rejected" ? user.vehicleChange : null;

  const startEditing = () => {
    setForm({
      // A legacy "cycle" rider is not offered it again — they pick bike or scooter.
      vehicleType: ["bike", "scooter"].includes(user?.vehicleType) ? user.vehicleType : "bike",
      vehicleNumber: formatVehiclePlate(user?.vehicleNumber || ""),
      drivingLicenseNumber: formatDrivingLicense(user?.drivingLicenseNumber || ""),
    });
    setEditing(true);
  };

  const problem = () => {
    if (!VEHICLE_PLATE_REGEX.test(normalizeVehiclePlate(form.vehicleNumber))) {
      return "Vehicle plate must be 2 letters, 2 digits, 2 letters, then 4 digits (e.g. KA 05 MN 8921)";
    }
    if (!DL_REGEX.test(normalizeDrivingLicense(form.drivingLicenseNumber))) {
      return "Driving license must be DL- followed by 13 digits, or the 15-character state format";
    }
    const changed =
      form.vehicleType !== user?.vehicleType ||
      normalizeVehiclePlate(form.vehicleNumber) !== normalizeVehiclePlate(user?.vehicleNumber) ||
      normalizeDrivingLicense(form.drivingLicenseNumber) !== normalizeDrivingLicense(user?.drivingLicenseNumber);
    if (!changed) return "Nothing has changed. Update at least one detail.";
    return null;
  };

  const handleSubmit = async () => {
    const error = problem();
    if (error) return toast.error(error);

    const ok = window.confirm(
      "Your account will be put on hold and you will not receive orders until the admin approves this change. Continue?",
    );
    if (!ok) return;

    setSaving(true);
    try {
      const res = await deliveryApi.requestVehicleChange({
        vehicleType: form.vehicleType,
        vehicleNumber: normalizeVehiclePlate(form.vehicleNumber),
        drivingLicenseNumber: normalizeDrivingLicense(form.drivingLicenseNumber),
      });
      toast.success(res.data?.message || "Sent for admin approval.");
      setEditing(false);
      // The account is now "waiting for approval": refreshing the user is what
      // moves the app to the pending screen.
      await refreshUser();
      navigate("/delivery/pending-approval", { replace: true });
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not send the change request");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* Header */}
      <div className="bg-white shadow-sm sticky top-0 z-10">
        <div className="flex items-center p-4">
          <button
            onClick={() => (editing ? setEditing(false) : navigate(-1))}
            className="p-2 rounded-full hover:bg-gray-100 transition-colors mr-2"
          >
            <ArrowLeft size={20} className="text-gray-600" />
          </button>
          <h1 className="ds-h3 text-gray-900">{editing ? "Change Vehicle Details" : "Vehicle Information"}</h1>
        </div>
      </div>

      <div className="p-4 max-w-lg mx-auto space-y-6">
        {lastRejected && !editing && (
          <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4">
            <ShieldAlert size={20} className="mt-0.5 shrink-0 text-rose-600" />
            <div className="text-sm text-rose-800">
              <p className="font-bold">Your last vehicle change was not approved</p>
              {lastRejected.rejectionReason && <p className="mt-0.5">{lastRejected.rejectionReason}</p>}
              <p className="mt-1 text-xs text-rose-700/80">Your previous vehicle details are unchanged.</p>
            </div>
          </div>
        )}

        {editing ? (
          <Card className="space-y-4 border border-gray-100 p-5">
            <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              Changes need admin approval. Your account will be on hold — no orders — until the admin approves.
            </div>

            <div>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-400">
                Vehicle type
              </label>
              <div className="grid grid-cols-2 gap-2">
                {VEHICLE_TYPES.map((type) => (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, vehicleType: type.value }))}
                    className={`rounded-xl border px-3 py-3 text-sm font-bold transition ${
                      form.vehicleType === type.value
                        ? "border-gray-900 bg-gray-900 text-white"
                        : "border-gray-200 bg-white text-gray-600"
                    }`}
                  >
                    {type.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-400">
                Vehicle plate number
              </label>
              <input
                value={form.vehicleNumber}
                onChange={(e) => setForm((f) => ({ ...f, vehicleNumber: formatVehiclePlate(e.target.value) }))}
                placeholder="KA 05 MN 8921"
                className={`${inputClass} font-mono`}
                autoCapitalize="characters"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-gray-400">
                Driving license number
              </label>
              <input
                value={form.drivingLicenseNumber}
                onChange={(e) =>
                  setForm((f) => ({ ...f, drivingLicenseNumber: formatDrivingLicense(e.target.value) }))
                }
                placeholder="DL-1234567890123"
                className={`${inputClass} font-mono`}
                autoCapitalize="characters"
              />
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
              <Button className="flex-[2]" onClick={handleSubmit} disabled={saving}>
                {saving ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin" /> Sending…
                  </span>
                ) : (
                  "Send for approval"
                )}
              </Button>
            </div>
          </Card>
        ) : (
          <>
            {/* Vehicle Card */}
            <Card className="p-5 bg-gradient-to-br from-gray-900 to-gray-800 text-white border-none shadow-xl">
              <div className="flex justify-between items-start mb-6">
                <div>
                  <p className="text-gray-400 text-xs uppercase tracking-wider font-bold mb-1">Vehicle Details</p>
                  <h3 className="text-2xl font-bold">{vehicleDetails.plateNumber}</h3>
                  <p className="text-gray-300">{vehicleDetails.type}</p>
                </div>
                <div className="bg-white/10 p-2 rounded-full backdrop-blur-sm">
                  <Truck size={24} className="text-white" />
                </div>
              </div>
            </Card>

            <Button variant="outline" className="w-full" onClick={startEditing}>
              <span className="inline-flex items-center gap-2">
                <Pencil size={16} /> Request vehicle change
              </span>
            </Button>

            {/* Documents List */}
            <div>
              <h3 className="ds-h4 text-gray-900 mb-3 px-1">Vehicle Documents</h3>
              <div className="space-y-3">
                {documents.map((doc, index) => (
                  <Card key={index} className="p-4 border border-gray-100">
                    <div className="flex justify-between items-start">
                      <div className="flex items-start">
                        <div className="p-2 rounded-lg mr-3 bg-brand-50 text-brand-600">
                          <FileText size={20} />
                        </div>
                        <div>
                          <h4 className="font-bold text-gray-800 text-sm">{doc.title}</h4>
                          <p className="text-xs text-gray-500 mt-0.5">{doc.number}</p>
                          <p className="text-xs mt-1 text-gray-400">Expires: {doc.expiry}</p>
                        </div>
                      </div>
                      <div className="flex items-center text-brand-600 bg-brand-50 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider">
                        <ShieldCheck size={12} className="mr-1" /> Verified
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>

            <div className="bg-brand-50 p-4 rounded-xl flex items-start">
              <AlertCircle size={20} className="text-brand-600 mr-3 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-brand-800">
                Changing your vehicle type, plate number or licence needs {appName} admin approval. Your account is on
                hold while the change is reviewed, then active again once it is approved.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default VehicleInfo;
