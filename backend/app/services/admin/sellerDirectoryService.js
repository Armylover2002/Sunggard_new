import Seller from "../../models/seller.js";
import {
  computeMapBounds,
  computeMapCenter,
  escapeRegExp,
  extractSellerCity,
  getSellerDisplayLocation,
  hasValidSellerLocation,
  matchSellerLifecycleFilter,
  normalizeRadiusKm,
  resolveSellerLifecycleStatus,
  sortActiveSellerRows,
} from "./shared/sellerAdminUtils.js";

export async function getSellerLocationsData({
  q = "",
  category = "all",
  city = "all",
  lifecycle = "all",
  mapLimit: rawMapLimit = "500",
  sort = "recent",
  page,
  limit,
  skip,
}) {
  const normalizedLifecycle = String(lifecycle || "all").trim().toLowerCase();
  const normalizedCategory = String(category || "all").trim();
  const normalizedCity = String(city || "all").trim();
  const normalizedSort = String(sort || "orders_desc").trim().toLowerCase();
  const search = String(q || "").trim();
  const requestedMapLimit = Number(rawMapLimit);
  const mapItemLimit = Number.isFinite(requestedMapLimit)
    ? Math.min(Math.max(requestedMapLimit, 0), 2000)
    : 500;

  const filters = [];
  if (normalizedCategory && normalizedCategory !== "all") {
    filters.push({
      category: new RegExp(`^${escapeRegExp(normalizedCategory)}$`, "i"),
    });
  }

  if (search) {
    const searchRegex = new RegExp(escapeRegExp(search), "i");
    filters.push({
      $or: [
        { name: searchRegex },
        { shopName: searchRegex },
        { email: searchRegex },
        { phone: searchRegex },
        { address: searchRegex },
        { category: searchRegex },
      ],
    });
  }

  const baseQuery = filters.length ? { $and: filters } : {};
  const sellers = await Seller.find(baseQuery)
    .select(
      "_id name shopName email phone category address location serviceRadius isActive isVerified applicationStatus reviewedAt createdAt rejectionReason",
    )
    .lean();

  const filteredByStatus = sellers.filter((seller) =>
    matchSellerLifecycleFilter(seller, normalizedLifecycle),
  );

  const sellersWithDerivedFields = filteredByStatus.map((seller) => {
    const coords = Array.isArray(seller.location?.coordinates)
      ? seller.location.coordinates
      : [];
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    const locationValid = hasValidSellerLocation(seller);
    const radiusKm = normalizeRadiusKm(seller.serviceRadius, 5);
    const cityLabel = extractSellerCity(seller);

    return {
      ...seller,
      id: String(seller._id),
      city: cityLabel,
      lifecycle: resolveSellerLifecycleStatus(seller),
      hasValidLocation: locationValid,
      lat: locationValid ? lat : null,
      lng: locationValid ? lng : null,
      serviceRadiusKm: radiusKm,
      locationLabel: seller.address || "Location not set",
    };
  });

  const filteredByCity = sellersWithDerivedFields.filter((seller) => {
    if (!normalizedCity || normalizedCity === "all") {
      return true;
    }

    return seller.city.toLowerCase() === normalizedCity.toLowerCase();
  });

  const rows = filteredByCity.map((seller) => {
    const radiusKm = normalizeRadiusKm(seller.serviceRadiusKm, 5);

    return {
      id: seller.id,
      shopName: seller.shopName || "Unnamed Store",
      ownerName: seller.name || "Unnamed Owner",
      email: seller.email || "",
      phone: seller.phone || "",
      category: seller.category || "General",
      city: seller.city,
      lifecycle: seller.lifecycle,
      hasValidLocation: seller.hasValidLocation,
      location: {
        lat: seller.lat,
        lng: seller.lng,
        label: seller.locationLabel,
      },
      serviceRadiusKm: radiusKm,
      serviceRadiusMeters: Math.round(radiusKm * 1000),
      approvedAt: seller.reviewedAt || null,
      createdAt: seller.createdAt || null,
    };
  });

  const sorters = {
    recent: (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
    name_asc: (a, b) => a.shopName.localeCompare(b.shopName),
    name_desc: (a, b) => b.shopName.localeCompare(a.shopName),
    radius_desc: (a, b) => b.serviceRadiusKm - a.serviceRadiusKm,
    radius_asc: (a, b) => a.serviceRadiusKm - b.serviceRadiusKm,
    city_asc: (a, b) => a.city.localeCompare(b.city),
    city_desc: (a, b) => b.city.localeCompare(a.city),
  };
  const sortedRows = [...rows].sort(sorters[normalizedSort] || sorters.recent);

  const total = sortedRows.length;
  const pagedItems = sortedRows.slice(skip, skip + limit);
  const mapItems = sortedRows.filter((row) => row.hasValidLocation).slice(0, mapItemLimit);

  const allCities = [
    ...new Set(
      sellersWithDerivedFields
        .map((row) => row.city)
        .filter(Boolean)
        .map((value) => String(value).trim()),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const allCategories = [
    ...new Set(
      sellersWithDerivedFields
        .map((row) => row.category || "General")
        .filter(Boolean)
        .map((value) => String(value).trim()),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const mapPoints = mapItems.map((item) => ({
    lat: item.location.lat,
    lng: item.location.lng,
  }));
  const mappedCount = rows.filter((row) => row.hasValidLocation).length;
  const radiusValues = rows
    .filter((row) => row.hasValidLocation)
    .map((row) => row.serviceRadiusKm);

  return {
    items: pagedItems,
    mapItems,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    stats: {
      totalSellers: rows.length,
      mappedSellers: mappedCount,
      unmappedSellers: Math.max(0, rows.length - mappedCount),
      citiesCovered: new Set(rows.map((row) => row.city).filter(Boolean)).size,
      averageRadiusKm: radiusValues.length
        ? Number(
            (
              radiusValues.reduce((accumulator, value) => accumulator + value, 0) /
              radiusValues.length
            ).toFixed(2),
          )
        : 0,
      maxRadiusKm: radiusValues.length ? Math.max(...radiusValues) : 0,
    },
    filters: {
      categories: allCategories,
      cities: allCities,
      lifecycle: ["all", "active", "pending", "rejected", "inactive", "verified", "unverified"],
    },
    map: {
      center: computeMapCenter(mapPoints),
      bounds: computeMapBounds(mapPoints),
      itemLimit: mapItemLimit,
    },
    syncedAt: new Date().toISOString(),
  };
}

export async function getActiveSellersData({
  q = "",
  category = "all",
  sort = "recent",
  page,
  limit,
  skip,
}) {
  const baseQuery = { isVerified: true, isActive: true };
  const filters = [baseQuery];

  if (category && category !== "all") {
    filters.push({
      category: new RegExp(`^${escapeRegExp(category)}$`, "i"),
    });
  }

  const search = String(q || "").trim();
  if (search) {
    const regex = new RegExp(escapeRegExp(search), "i");
    filters.push({
      $or: [
        { name: regex },
        { shopName: regex },
        { email: regex },
        { phone: regex },
        { address: regex },
        { category: regex },
      ],
    });
  }

  const query = filters.length > 1 ? { $and: filters } : baseQuery;

  const [sellers, totalActiveCount, allActiveSellers] = await Promise.all([
    Seller.find(query).lean(),
    Seller.countDocuments(baseQuery),
    Seller.find(baseQuery)
      .select("_id createdAt category")
      .lean(),
  ]);

  const enrichedSellers = sellers.map((seller) => {
    const joinedAt = seller.reviewedAt || seller.createdAt || new Date();

    return {
      id: String(seller._id),
      _id: seller._id,
      shopName: seller.shopName || "Unnamed Store",
      ownerName: seller.name || "Unnamed Owner",
      email: seller.email || "",
      phone: seller.phone || "",
      category: seller.category || "General",
      status: seller.isVerified && seller.isActive ? "active" : "inactive",
      verificationStatus: seller.isVerified ? "verified" : "unverified",
      joinedAt,
      joinedDate: new Date(joinedAt).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }),
      serviceRadius: Number(seller.serviceRadius || 5),
      location: getSellerDisplayLocation(seller),
      city: seller.address || "Location not set",
      latitude: Array.isArray(seller.location?.coordinates)
        ? seller.location.coordinates[1] ?? null
        : null,
      longitude: Array.isArray(seller.location?.coordinates)
        ? seller.location.coordinates[0] ?? null
        : null,
      avatar: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(
        seller.shopName || seller.name || seller.email || "seller",
      )}`,
    };
  });

  const filteredSortedSellers = sortActiveSellerRows(enrichedSellers, sort);
  const total = filteredSortedSellers.length;
  const pagedItems = filteredSortedSellers.slice(skip, skip + limit);

  const newThisMonth = allActiveSellers.filter((seller) => {
    const createdAt = seller.createdAt ? new Date(seller.createdAt) : null;
    if (!createdAt) {
      return false;
    }

    const monthStart = new Date();
    monthStart.setHours(0, 0, 0, 0);
    monthStart.setDate(1);
    return createdAt >= monthStart;
  }).length;

  const uniqueCategories = [
    ...new Set(
      allActiveSellers
        .map((seller) => seller.category)
        .filter(Boolean)
        .map((value) => String(value).trim()),
    ),
  ].sort((a, b) => a.localeCompare(b));

  return {
    items: pagedItems,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    stats: {
      totalActiveSellers: totalActiveCount,
      newThisMonth,
    },
    filters: {
      categories: uniqueCategories,
    },
  };
}

export async function getSellerOptions() {
  return Seller.find({})
    .select("_id shopName name email phone")
    .sort({ shopName: 1 })
    .lean();
}
