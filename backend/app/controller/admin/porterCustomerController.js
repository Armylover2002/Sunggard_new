import mongoose from "mongoose";
import handleResponse from "../../utils/helper.js";
import getPagination from "../../utils/pagination.js";
import {
  getPorterCustomersData,
  getPorterCustomerByIdData,
  updatePorterCustomerStatusData,
} from "../../services/admin/porterCustomerService.js";

const ALLOWED_SORT = new Set(["totalBookings", "totalSpent", "lastBookingAt", "joinedDate"]);
const ALLOWED_STATUS = new Set(["all", "active", "inactive"]);

export const adminListPorterCustomers = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req, {
      defaultLimit: 25,
      maxLimit: 100,
    });

    const status = ALLOWED_STATUS.has(req.query.status) ? req.query.status : "all";
    const sortBy = ALLOWED_SORT.has(req.query.sortBy) ? req.query.sortBy : "totalBookings";
    const sortDir = req.query.sortDir === "asc" ? "asc" : "desc";

    const data = await getPorterCustomersData({
      page,
      limit,
      skip,
      search: req.query.search,
      status,
      sortBy,
      sortDir,
    });

    return handleResponse(res, 200, "Courier customers fetched successfully", data);
  } catch (error) {
    return handleResponse(res, 500, error.message || "Failed to fetch courier customers");
  }
};

export const adminGetPorterCustomerById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return handleResponse(res, 400, "Invalid customer ID");
    }

    const customer = await getPorterCustomerByIdData(id);
    if (!customer) {
      return handleResponse(res, 404, "Customer not found");
    }

    return handleResponse(res, 200, "Customer details fetched successfully", customer);
  } catch (error) {
    return handleResponse(res, 500, error.message || "Failed to fetch customer details");
  }
};

export const adminUpdatePorterCustomerStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return handleResponse(res, 400, "Invalid customer ID");
    }

    const { isActive } = req.body || {};
    if (typeof isActive !== "boolean") {
      return handleResponse(res, 400, "isActive must be true or false");
    }

    // An admin cannot deactivate their own account by mistake through this desk —
    // this endpoint only ever targets role:"user" documents, so the guard below
    // is about not letting a stale id collide with an admin's own id.
    if (String(req.user?.id) === String(id)) {
      return handleResponse(res, 400, "Cannot change status of your own account");
    }

    const updated = await updatePorterCustomerStatusData(id, isActive);
    if (!updated) {
      return handleResponse(res, 404, "Customer not found");
    }

    return handleResponse(
      res,
      200,
      `Customer marked as ${updated.status}`,
      updated,
    );
  } catch (error) {
    return handleResponse(res, 500, error.message || "Failed to update customer status");
  }
};
