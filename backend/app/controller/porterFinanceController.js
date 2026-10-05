import handleResponse from "../utils/helper.js";
import getPagination from "../utils/pagination.js";
import ParcelConfig from "../models/parcelConfig.js";
import { normalizeGstConfig } from "../utils/gst.js";
import { getPorterGstReport, getPorterGstLedger } from "../services/porter/gstReportService.js";
import {
  buildPorterInvoice,
  getCustomerPorterTransactions,
} from "../services/porter/porterInvoiceService.js";
import { getBookingPaymentHistory } from "../services/porter/porterPaymentService.js";
import { PORTER_BOOKING_KIND, ALL_PORTER_BOOKING_KINDS } from "../constants/porterPayment.js";

/**
 * The porter desk's money surfaces: GST configuration and reporting, booking
 * invoices, and payment history.
 *
 * Grouped in one controller because they share a single concern — what the
 * platform charged, what it collected, and who it collected it from — and
 * splitting them across four files would mean four places to keep the same
 * authorisation rule in step.
 */

/** Turn a thrown service error into the status it asked for. */
const fail = (res, error, fallback = 500) =>
  handleResponse(res, Number(error?.statusCode) || fallback, error?.message || "Something went wrong");

/** `kind` arrives from the URL, so it is never trusted as a collection name. */
function parseKind(value) {
  const kind = String(value || "").toLowerCase();
  if (!ALL_PORTER_BOOKING_KINDS.includes(kind)) {
    const err = new Error("Unknown booking type");
    err.statusCode = 400;
    throw err;
  }
  return kind;
}

/* ==========================================================================
   GST — configuration
   ========================================================================== */

/**
 * LOCAL CITY PARCEL DISABLED — local-city GST is no longer readable or
 * editable from this endpoint; only the outstation rate card is live.
 * Re-enable by restoring the `local` block from git history.
 */
export const adminGetGstSettings = async (req, res) => {
  try {
    const parcelConfig = await ParcelConfig.getOrCreate();

    return handleResponse(res, 200, "GST settings", {
      outstation: normalizeGstConfig(parcelConfig.gst),
    });
  } catch (error) {
    return fail(res, error);
  }
};

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/**
 * Validate one product's GST block.
 *
 * The GSTIN is checked against the real format rather than accepted as free
 * text: it is printed on every invoice the product issues, and a typo there
 * is not discovered until a customer's accountant rejects the invoice months
 * later. An empty GSTIN is allowed — an unregistered operation is a real
 * thing — but a malformed one is not.
 */
function validateGstPatch(patch, label) {
  const next = {};

  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);

  if (patch.percent !== undefined) {
    const percent = Number(patch.percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      const err = new Error(`${label}: the GST rate must be between 0 and 100`);
      err.statusCode = 400;
      throw err;
    }
    next.percent = Math.round(percent * 100) / 100;
  }

  if (patch.inclusive !== undefined) next.inclusive = Boolean(patch.inclusive);

  if (patch.gstin !== undefined) {
    const gstin = String(patch.gstin || "").trim().toUpperCase();
    if (gstin && !GSTIN_PATTERN.test(gstin)) {
      const err = new Error(`${label}: that does not look like a valid GSTIN`);
      err.statusCode = 400;
      throw err;
    }
    next.gstin = gstin;
  }

  if (patch.placeOfSupply !== undefined) {
    next.placeOfSupply = String(patch.placeOfSupply || "").trim();
  }

  /**
   * Turning GST on with no rate would charge nothing while telling every
   * invoice that tax applies — worse than leaving it off, because the
   * operation would believe it was collecting.
   */
  if (next.enabled && next.percent !== undefined && next.percent <= 0) {
    const err = new Error(`${label}: set a GST rate above zero before enabling it`);
    err.statusCode = 400;
    throw err;
  }

  return next;
}

export const adminUpdateGstSettings = async (req, res) => {
  try {
    const { local, outstation } = req.body || {};

    // LOCAL CITY PARCEL DISABLED — local-city GST can no longer be changed
    // from here; reject explicitly instead of silently dropping the patch.
    if (local) {
      return handleResponse(res, 400, "Local delivery GST is disabled and cannot be edited");
    }

    if (!outstation) {
      return handleResponse(res, 400, "Nothing to update");
    }

    const results = {};

    if (outstation) {
      const config = await ParcelConfig.getOrCreate();
      const patch = validateGstPatch(outstation, "Outstation courier");
      const merged = { ...normalizeGstConfig(config.gst), ...patch };
      if (merged.enabled && !(merged.percent > 0)) {
        return handleResponse(res, 400, "Outstation courier: set a GST rate above zero before enabling it");
      }
      config.gst = merged;
      await config.save();
      results.outstation = normalizeGstConfig(config.gst);
    }

    return handleResponse(res, 200, "GST settings updated", results);
  } catch (error) {
    return fail(res, error);
  }
};

/* ==========================================================================
   GST — reporting
   ========================================================================== */

export const adminGetGstReport = async (req, res) => {
  try {
    const report = await getPorterGstReport({
      from: req.query.from || null,
      to: req.query.to || null,
    });
    return handleResponse(res, 200, "GST report", report);
  } catch (error) {
    return fail(res, error);
  }
};

export const adminGetGstLedger = async (req, res) => {
  try {
    const { page, limit } = getPagination(req, { defaultLimit: 50, maxLimit: 200 });
    const data = await getPorterGstLedger({
      from: req.query.from || null,
      to: req.query.to || null,
      source: req.query.source || "all",
      // Defaults to settled-only, matching the headline number. An admin
      // wanting everything charged has to ask for it, so the two views cannot
      // be confused by accident.
      settledOnly: String(req.query.settledOnly ?? "true") !== "false",
      page,
      limit,
    });
    return handleResponse(res, 200, "GST ledger", data);
  } catch (error) {
    return fail(res, error);
  }
};

/* ==========================================================================
   Invoices
   ========================================================================== */

/**
 * One booking's invoice, for whoever is entitled to see it.
 *
 * A customer is scoped to their own bookings by the service; an admin sees
 * any. Both receive the identical document — the money on an invoice must not
 * depend on who printed it.
 */
export const getBookingInvoice = async (req, res) => {
  try {
    const kind = parseKind(req.params.kind);
    const isAdmin = req.user?.role === "admin" || req.user?.role === "parcel_admin";

    const invoice = await buildPorterInvoice({
      kind,
      bookingId: req.params.id,
      requesterId: req.user?.id,
      isAdmin,
    });

    return handleResponse(res, 200, "Invoice", invoice);
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Every payment attempt against a booking, newest first.
 *
 * Customers see this on their booking detail screen so a failed attempt they
 * remember making is visible rather than silently absent; admins see it when
 * answering "did this customer pay". Both are scoped by the same ownership
 * check the invoice uses.
 */
export const getBookingPayments = async (req, res) => {
  try {
    const kind = parseKind(req.params.kind);
    const isAdmin = req.user?.role === "admin" || req.user?.role === "parcel_admin";

    // Reuses the invoice builder's ownership check rather than repeating it:
    // if the caller may not see the invoice, they may not see the payments.
    await buildPorterInvoice({
      kind,
      bookingId: req.params.id,
      requesterId: req.user?.id,
      isAdmin,
    });

    const payments = await getBookingPaymentHistory(kind, req.params.id);
    return handleResponse(res, 200, "Payment history", { payments });
  } catch (error) {
    return fail(res, error);
  }
};

/** The signed-in customer's own recent money movements. */
export const getMyTransactions = async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 25));
    const transactions = await getCustomerPorterTransactions(req.user.id, limit);
    return handleResponse(res, 200, "Transactions", { transactions });
  } catch (error) {
    return fail(res, error);
  }
};

export { PORTER_BOOKING_KIND };
