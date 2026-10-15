import { approveVehicleChange, rejectVehicleChange } from "../../services/riderVehicleChangeService.js";
import Delivery from "../../models/delivery.js";
import Parcel from "../../models/parcel.js";
import handleResponse from "../../utils/helper.js";
import getPagination from "../../utils/pagination.js";
import { zonesForPoint, smallestZone } from "../../services/deliveryZoneService.js";

export const getDeliveryPartners = async (req, res) => {
  try {
    const { status, verified, applicationStatus, search } = req.query;
    const query = {};

    if (status === "online") {
      query.isOnline = true;
    } else if (status === "offline") {
      query.isOnline = false;
    }

    if (verified === "true") {
      query.isVerified = true;
    } else if (verified === "false") {
      query.isVerified = false;
      // The pending-review queue (verified=false) is for applications still
      // awaiting a decision — a rejected one is unverified too, but it's
      // already been decided and shouldn't clutter that queue. $ne also
      // matches documents from before this field existed, so older pending
      // riders keep showing up unaffected.
      // "draft" = signed up but never passed phone OTP; not a real application.
      query.applicationStatus = { $nin: ["rejected", "draft"] };
    } else {
      query.applicationStatus = { $ne: "draft" };
    }

    if (["pending", "approved", "rejected"].includes(applicationStatus)) {
      query.applicationStatus = applicationStatus;
    }

    if (search && String(search).trim()) {
      const term = String(search).trim();
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { phone: { $regex: escaped, $options: "i" } },
        { email: { $regex: escaped, $options: "i" } },
        { vehicleNumber: { $regex: escaped, $options: "i" } },
        { drivingLicenseNumber: { $regex: escaped, $options: "i" } },
      ];

      // Rider ID: the admin UI shows "RD-" + the last 6 hex chars of the _id,
      // so accept that (or any hex tail / the full 24-char id) as a search.
      const idPart = term.replace(/^rd[-\s]?/i, "");
      if (/^[0-9a-f]{4,24}$/i.test(idPart)) {
        query.$or.push({
          $expr: {
            $regexMatch: {
              input: { $toString: "$_id" },
              regex: `${idPart.toLowerCase()}$`,
            },
          },
        });
      }
    }

    const { page, limit, skip } = getPagination(req, {
      defaultLimit: 25,
      maxLimit: 200,
    });

    const partnerFields = [
      "name",
      "phone",
      "email",
      "address",
      "vehicleType",
      "vehicleNumber",
      "drivingLicenseNumber",
      "aadharNumber",
      "panNumber",
      "accountHolder",
      "accountNumber",
      "ifsc",
      "profileImage",
      "documents",
      "isVerified",
      "applicationStatus",
      "rejectionReason",
      "rejectedAt",
      "reappliedAt",
      "reapplyCount",
      "isActive",
      "isOnline",
      "isBusy",
      "isParcelService",
      "rating",
      "ratingCount",
      "vehicleChange",
      // CAR WASH DISABLED — "isCarWashService",
      "experience",
      "experienceDetails",
      "currentArea",
      "zoneIds",
      "createdAt",
    ].join(" ");

    const [deliveryPartners, total] = await Promise.all([
      Delivery.find(query)
        .select(partnerFields)
        .populate("zoneIds", "name city color")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Delivery.countDocuments(query),
    ]);

    const riderIds = deliveryPartners.map((r) => r._id);
    const deliveryCounts = riderIds.length
      ? await Parcel.aggregate([
          { $match: { deliveryPartnerId: { $in: riderIds }, status: "DELIVERED" } },
          { $group: { _id: "$deliveryPartnerId", count: { $sum: 1 } } },
        ])
      : [];
    const deliveryCountMap = new Map(
      deliveryCounts.map((row) => [String(row._id), row.count]),
    );

    const items = deliveryPartners.map((r) => ({
      ...r,
      totalDeliveries: deliveryCountMap.get(String(r._id)) || 0,
    }));

    return handleResponse(res, 200, "Delivery partners fetched successfully", {
      items,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const getDeliveryPartnerById = async (req, res) => {
  try {
    const rider = await Delivery.findById(req.params.id)
      .select(
        "name phone email address vehicleType vehicleNumber drivingLicenseNumber aadharNumber panNumber accountHolder accountNumber ifsc bankName upiId profileImage documents isVerified applicationStatus rejectionReason rejectedAt reappliedAt reapplyCount isParcelService experience experienceDetails currentArea zoneIds createdAt vehicleChange",
        // CAR WASH DISABLED — removed isCarWashService from select
      )
      .populate("zoneIds", "name city color")
      .lean();
    if (!rider) {
      return handleResponse(res, 404, "Delivery partner not found");
    }
    return handleResponse(res, 200, "Delivery partner fetched successfully", rider);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const updateDeliveryPartnerIdentity = async (req, res) => {
  try {
    const { aadharNumber, panNumber } = req.body || {};
    const rider = await Delivery.findById(req.params.id);
    if (!rider) {
      return handleResponse(res, 404, "Delivery partner not found");
    }

    const updates = {};
    if (aadharNumber !== undefined) {
      const digits = String(aadharNumber).replace(/\D/g, "").slice(0, 12);
      if (digits.length !== 12) {
        return handleResponse(res, 400, "Aadhar number must be exactly 12 digits");
      }
      updates.aadharNumber = digits;
    }
    if (panNumber !== undefined) {
      const pan = String(panNumber).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
      if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) {
        return handleResponse(res, 400, "Invalid PAN format");
      }
      updates.panNumber = pan;
    }

    if (!Object.keys(updates).length) {
      return handleResponse(res, 400, "No identity fields to update");
    }

    Object.assign(rider, updates);
    await rider.save();

    return handleResponse(res, 200, "Identity details updated", rider);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/**
 * The only two things an admin may change on an existing rider: the profile
 * photo and the login phone number. Everything else (name, vehicle, bank,
 * documents…) belongs to the rider.
 *
 * Changing the phone edits the SAME account in place. Orders, wallet, ratings
 * and cash records all point at the rider's _id, so the whole history moves to
 * the new number with no data copying; the old number simply stops matching
 * any account (login is a lookup by phone), and bumping sessionVersion makes
 * every token issued under the old number fail on its next request, which
 * signs the rider out. They log back in with the new number.
 */
export const updateDeliveryPartnerContact = async (req, res) => {
  try {
    const { phone, profileImage } = req.body || {};
    const rider = await Delivery.findById(req.params.id);
    if (!rider) {
      return handleResponse(res, 404, "Delivery partner not found");
    }

    let phoneChanged = false;
    if (phone !== undefined) {
      const digits = String(phone).replace(/\D/g, "");
      // Accept "+91 98765 43210" / "098765…" style input, store the bare 10 digits
      // that the rider login flow looks up.
      const normalized = digits.length > 10 ? digits.slice(-10) : digits;
      if (!/^\d{10}$/.test(normalized)) {
        return handleResponse(res, 400, "Enter a valid 10-digit mobile number");
      }
      if (normalized !== rider.phone) {
        const taken = await Delivery.findOne({ phone: normalized, _id: { $ne: rider._id } })
          .select("_id")
          .lean();
        if (taken) {
          return handleResponse(res, 409, "This number is already registered to another rider");
        }
        rider.phone = normalized;
        phoneChanged = true;
      }
    }

    if (profileImage !== undefined) {
      const url = String(profileImage || "").trim();
      if (!url || !(/^https?:\/\//i.test(url) || url.startsWith("/uploads/"))) {
        return handleResponse(res, 400, "Invalid profile image");
      }
      rider.profileImage = url;
    }

    if (!rider.isModified()) {
      return handleResponse(res, 400, "Nothing to update");
    }

    if (phoneChanged) {
      // Old-number sessions die on their next request; also take them offline
      // so no new-order offers go to a device that is about to be signed out.
      rider.sessionVersion = (rider.sessionVersion || 0) + 1;
      rider.isOnline = false;
    }

    try {
      await rider.save();
    } catch (err) {
      if (err?.code === 11000) {
        return handleResponse(res, 409, "This number is already registered to another rider");
      }
      throw err;
    }

    return handleResponse(
      res,
      200,
      phoneChanged
        ? "Number updated. The rider has been signed out and must log in with the new number."
        : "Profile photo updated",
      { _id: rider._id, phone: rider.phone, profileImage: rider.profileImage, isOnline: rider.isOnline },
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const approveDeliveryPartner = async (req, res) => {
  try {
    const { id } = req.params;

    // A rider waiting on a vehicle change: approving applies the new values
    // and re-activates the account (see riderVehicleChangeService).
    const changed = await approveVehicleChange(id);
    if (changed) {
      return handleResponse(res, 200, "Vehicle change approved. The rider's account is active again.", changed);
    }

    const rider = await Delivery.findByIdAndUpdate(
      id,
      { isVerified: true, applicationStatus: "approved" },
      { new: true },
    );

    if (!rider) {
      return handleResponse(res, 404, "Rider not found");
    }

    return handleResponse(res, 200, "Rider approved successfully", rider);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/**
 * Rejects a pending application. This used to hard-delete the document,
 * which silently orphaned every Order/Transaction row still pointing at that
 * rider's id, and left no trail of why someone stopped appearing. Marking it
 * instead means a resubmission (see signupDelivery) finds this same record
 * and reopens it as pending, rather than colliding on the unique phone number.
 *
 * For an already-approved rider, use setDeliveryPartnerActive instead — that
 * suspends without touching the approval decision this endpoint records.
 */
export const rejectDeliveryPartner = async (req, res) => {
  try {
    const { id } = req.params;
    // The reason is what the rider reads on their waiting screen to know what
    // to fix before resubmitting, so a rejection without one is not allowed.
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 5 || reason.length > 300) {
      return handleResponse(
        res,
        400,
        "Enter a rejection reason (5 to 300 characters) so the rider knows what to fix",
      );
    }

    // A rider waiting on a vehicle change keeps their account: rejecting only
    // discards the request. They are NOT marked as a rejected applicant.
    const reverted = await rejectVehicleChange(id, reason);
    if (reverted) {
      return handleResponse(res, 200, "Vehicle change rejected. The rider's account is active with their previous details.", reverted);
    }

    const rider = await Delivery.findByIdAndUpdate(
      id,
      {
        isVerified: false,
        isOnline: false,
        applicationStatus: "rejected",
        rejectionReason: reason,
        rejectedAt: new Date(),
      },
      { new: true },
    );

    if (!rider) {
      return handleResponse(res, 404, "Rider not found");
    }

    return handleResponse(res, 200, "Rider application rejected", rider);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/**
 * Suspends or restores an already-approved rider without touching their
 * application decision. Deactivating also forces them offline and — via
 * requireActiveDelivery on every delivery/* route — blocks every further
 * authenticated action and a fresh login until an admin flips this back on.
 */
export const setDeliveryPartnerActive = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body || {};

    if (typeof isActive !== "boolean") {
      return handleResponse(res, 400, "isActive must be true or false");
    }

    const update = { isActive };
    if (!isActive) update.isOnline = false;

    const rider = await Delivery.findByIdAndUpdate(id, update, { new: true });

    if (!rider) {
      return handleResponse(res, 404, "Rider not found");
    }

    return handleResponse(
      res,
      200,
      isActive ? "Rider reactivated" : "Rider deactivated",
      rider,
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** A GPS fix older than this is treated as "rider went dark", not "rider is here". */
const LIVE_LOCATION_STALE_MINUTES = parseInt(
  process.env.FLEET_LIVE_LOCATION_STALE_MINUTES || "15",
  10,
);

/**
 * Live rider positions for the admin fleet-zone map.
 *
 * This is the ONLY thing the map page polls. It reads from our own DB
 * (riders already push their position to `POST /delivery/location`, throttled
 * server-side — see `services/delivery/locationThrottleService.js`) and
 * resolves each fix to a zone via `deliveryZoneService.zonesForPoint`, which
 * holds active zones in an in-process 60s cache. None of this ever calls a
 * paid Google Maps API — the client only pays for that once, when the map
 * script itself loads, not on every location refresh.
 */
export const getLiveFleetLocations = async (req, res) => {
  try {
    const staleCutoff = new Date(Date.now() - LIVE_LOCATION_STALE_MINUTES * 60 * 1000);

    const riders = await Delivery.find({
      isOnline: true,
      isVerified: true,
      lastLocationAt: { $gte: staleCutoff },
      // Default/never-set location is the [0,0] null-island coordinate —
      // excluding it filters out riders who have never sent a real GPS fix.
      "location.coordinates.0": { $ne: 0 },
      "location.coordinates.1": { $ne: 0 },
    })
      .select("name phone vehicleType isBusy location lastLocationAt")
      .lean();

    const items = await Promise.all(
      riders.map(async (rider) => {
        const [lng, lat] = rider.location?.coordinates || [0, 0];
        const zone = smallestZone(await zonesForPoint(lat, lng));

        return {
          id: String(rider._id),
          name: rider.name,
          phone: rider.phone,
          vehicleType: rider.vehicleType,
          isBusy: Boolean(rider.isBusy),
          lat,
          lng,
          lastLocationAt: rider.lastLocationAt,
          zone: zone
            ? { id: String(zone._id), name: zone.name, color: zone.color || "#2563EB" }
            : null,
        };
      }),
    );

    return handleResponse(res, 200, "Live fleet locations fetched", {
      items,
      total: items.length,
      unzoned: items.filter((item) => !item.zone).length,
      staleAfterMinutes: LIVE_LOCATION_STALE_MINUTES,
      syncedAt: new Date(),
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
