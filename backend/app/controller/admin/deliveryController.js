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
      query.applicationStatus = { $ne: "rejected" };
    }

    if (["pending", "approved", "rejected"].includes(applicationStatus)) {
      query.applicationStatus = applicationStatus;
    }

    if (search && String(search).trim()) {
      const term = String(search).trim();
      query.$or = [
        { name: { $regex: term, $options: "i" } },
        { phone: { $regex: term, $options: "i" } },
        { email: { $regex: term, $options: "i" } },
        { vehicleNumber: { $regex: term, $options: "i" } },
        { drivingLicenseNumber: { $regex: term, $options: "i" } },
      ];
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
        "name phone email address vehicleType vehicleNumber drivingLicenseNumber aadharNumber panNumber accountHolder accountNumber ifsc bankName upiId profileImage documents isVerified applicationStatus rejectionReason rejectedAt reappliedAt reapplyCount isParcelService experience experienceDetails currentArea zoneIds createdAt",
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

export const approveDeliveryPartner = async (req, res) => {
  try {
    const { id } = req.params;
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
