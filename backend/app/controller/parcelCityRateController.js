import XLSX from "xlsx";
import mongoose from "mongoose";
import ParcelCityRate from "../models/parcelCityRate.js";
import CourierCompany from "../models/courierCompany.js";
import handleResponse from "../utils/helper.js";

/**
 * Excel upload format (row 1 = header):
 *   Origin City | Destination City | <Courier Name 1> | <Courier Name 2> | ... | Other
 * One row per city-to-city route. Each courier column (matched by name,
 * case-insensitive, against existing active CourierCompany documents — the
 * admin-managed "Other" catch-all is just another courier by that name) holds
 * that courier's charge for the route. A blank cell means that courier isn't
 * bookable on that route.
 */
export const adminUploadCityRates = async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return handleResponse(res, 400, "Upload an Excel (.xlsx/.xls) or .csv file");
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch {
      return handleResponse(res, 400, "Could not read the uploaded file — is it a valid Excel/CSV file?");
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) {
      return handleResponse(res, 400, "The uploaded file has no sheets");
    }
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    if (!rows.length) {
      return handleResponse(res, 400, "The uploaded file has no data rows");
    }

    // Map every column header (case-insensitive, trimmed) to a courier _id —
    // so "Blue Dart", "blue dart ", "Other" all resolve regardless of case.
    const couriers = await CourierCompany.find().select("_id name").lean();
    const courierByName = new Map(
      couriers.map((c) => [String(c.name).trim().toLowerCase(), c._id]),
    );

    const headerKeys = Object.keys(rows[0]);
    const originKey = headerKeys.find((k) => /^origin/i.test(k.trim()));
    const destKey = headerKeys.find((k) => /^dest/i.test(k.trim()));
    if (!originKey || !destKey) {
      return handleResponse(
        res,
        400,
        "The file must have 'Origin City' and 'Destination City' columns",
      );
    }
    const courierColumns = headerKeys
      .filter((k) => k !== originKey && k !== destKey)
      .map((k) => ({ key: k, courierId: courierByName.get(k.trim().toLowerCase()) }))
      .filter((c) => c.courierId);

    if (!courierColumns.length) {
      return handleResponse(
        res,
        400,
        "None of the file's columns match an existing courier company name. Column headers must exactly match a courier company's name (see /admin/parcels/couriers), e.g. 'Blue Dart', 'Other'.",
      );
    }

    const ops = [];
    let skippedRows = 0;
    for (const row of rows) {
      const originCity = String(row[originKey] || "").trim();
      const destinationCity = String(row[destKey] || "").trim();
      if (!originCity || !destinationCity) {
        skippedRows += 1;
        continue;
      }
      const originCityKey = ParcelCityRate.normalizeCityKey(originCity);
      const destinationCityKey = ParcelCityRate.normalizeCityKey(destinationCity);

      for (const { key, courierId } of courierColumns) {
        const raw = row[key];
        if (raw === "" || raw === null || raw === undefined) continue;
        const charge = Number(raw);
        if (!Number.isFinite(charge) || charge < 0) continue;

        ops.push({
          updateOne: {
            filter: { originCityKey, destinationCityKey, courierCompanyId: courierId },
            update: {
              $set: {
                originCity,
                destinationCity,
                originCityKey,
                destinationCityKey,
                courierCompanyId: courierId,
                charge,
              },
            },
            upsert: true,
          },
        });
      }
    }

    if (!ops.length) {
      return handleResponse(res, 400, "No valid rate rows found in the file");
    }

    const result = await ParcelCityRate.collection.bulkWrite(ops);
    return handleResponse(res, 200, "City rates uploaded", {
      rowsInFile: rows.length,
      skippedRows,
      ratesUpserted: ops.length,
      inserted: result.upsertedCount || 0,
      updated: result.modifiedCount || 0,
      matchedCouriers: courierColumns.map((c) => c.key),
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/**
 * Customer-facing: which destination cities are actually bookable from a
 * given origin city with a given courier, so the receiver-city field can be
 * a dropdown instead of free text the booking later rejects.
 *
 * Rates are bidirectional (see ParcelCityRate.findRate) — a row priced as
 * B -> A also makes A -> B bookable — so both directions are matched here.
 */
export const listCityRateDestinations = async (req, res) => {
  try {
    const originCity = String(req.query?.originCity || "").trim();
    const courierCompanyId = String(req.query?.courierCompanyId || "").trim();
    if (!originCity || !courierCompanyId) {
      return handleResponse(res, 400, "Origin city and courier company are required");
    }
    if (!mongoose.Types.ObjectId.isValid(courierCompanyId)) {
      return handleResponse(res, 400, "Invalid courier company");
    }

    const originKey = ParcelCityRate.normalizeCityKey(originCity);
    const rows = await ParcelCityRate.find({
      courierCompanyId,
      $or: [{ originCityKey: originKey }, { destinationCityKey: originKey }],
    })
      .select("originCity originCityKey destinationCity destinationCityKey")
      .lean();

    const byKey = new Map();
    for (const row of rows) {
      if (row.originCityKey === originKey && row.destinationCityKey !== originKey) {
        byKey.set(row.destinationCityKey, row.destinationCity);
      }
      if (row.destinationCityKey === originKey && row.originCityKey !== originKey) {
        byKey.set(row.originCityKey, row.originCity);
      }
    }

    const destinations = [...byKey.values()].sort((a, b) => a.localeCompare(b));
    return handleResponse(res, 200, "Destination cities retrieved", destinations);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Flat list, courier populated — admin groups by route client-side. */
export const adminListCityRates = async (req, res) => {
  try {
    const rates = await ParcelCityRate.find()
      .populate("courierCompanyId", "name")
      .sort({ originCity: 1, destinationCity: 1 })
      .lean();
    return handleResponse(res, 200, "City rates retrieved", rates);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/**
 * Manual add/update for ONE route, ALL couriers at once — the same shape as
 * one row of the Excel sheet. `rates` is `[{ courierCompanyId, charge }]`;
 * a courier left out (or with an empty/invalid charge) is simply skipped,
 * not zeroed — so filling in just 2 of 4 couriers doesn't delete the other 2.
 */
export const adminUpsertCityRate = async (req, res) => {
  try {
    const originCity = String(req.body?.originCity || "").trim();
    const destinationCity = String(req.body?.destinationCity || "").trim();
    const ratesInput = Array.isArray(req.body?.rates) ? req.body.rates : [];

    if (!originCity || !destinationCity) {
      return handleResponse(res, 400, "Origin and destination city are required");
    }
    if (!ratesInput.length) {
      return handleResponse(res, 400, "Enter a charge for at least one courier");
    }

    const originCityKey = ParcelCityRate.normalizeCityKey(originCity);
    const destinationCityKey = ParcelCityRate.normalizeCityKey(destinationCity);

    const ops = [];
    for (const entry of ratesInput) {
      const courierCompanyId = String(entry?.courierCompanyId || "").trim();
      const charge = Number(entry?.charge);
      if (!mongoose.Types.ObjectId.isValid(courierCompanyId)) continue;
      if (!Number.isFinite(charge) || charge < 0) continue;

      ops.push({
        updateOne: {
          filter: { originCityKey, destinationCityKey, courierCompanyId },
          update: {
            $set: {
              originCity,
              destinationCity,
              originCityKey,
              destinationCityKey,
              courierCompanyId,
              charge,
            },
          },
          upsert: true,
        },
      });
    }

    if (!ops.length) {
      return handleResponse(res, 400, "Enter a valid charge for at least one courier");
    }

    await ParcelCityRate.collection.bulkWrite(ops);
    const saved = await ParcelCityRate.find({ originCityKey, destinationCityKey })
      .populate("courierCompanyId", "name")
      .lean();

    return handleResponse(res, 200, "City rates saved", saved);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/**
 * A ready-to-fill Excel template: header row with every active courier
 * company as its own column, plus one example data row, so the admin knows
 * the exact format /admin/city-rates/upload expects without guessing.
 */
export const adminDownloadCityRateTemplate = async (req, res) => {
  try {
    const couriers = await CourierCompany.find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select("name")
      .lean();

    const headers = ["Origin City", "Destination City", ...couriers.map((c) => c.name)];
    const exampleRow = {
      "Origin City": "Surat",
      "Destination City": "Surat",
      ...Object.fromEntries(couriers.map((c) => [c.name, ""])),
    };

    const sheet = XLSX.utils.json_to_sheet([exampleRow], { header: headers });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Rate Card");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="courier-city-rate-template.xlsx"',
    );
    return res.send(buffer);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const adminDeleteCityRate = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await ParcelCityRate.findByIdAndDelete(id);
    if (!deleted) {
      return handleResponse(res, 404, "City rate not found");
    }
    return handleResponse(res, 200, "City rate deleted", { id: deleted._id });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
