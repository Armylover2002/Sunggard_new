import handleResponse from "../utils/helper.js";
import {
  submitVehicleChange,
  cancelVehicleChange,
} from "../services/riderVehicleChangeService.js";

/** What the rider app needs back: the open request (if any) and account state. */
const toPayload = (rider) => ({
  isVerified: rider.isVerified,
  applicationStatus: rider.applicationStatus,
  vehicleChange: rider.vehicleChange,
});

/**
 * Rider asks to change vehicle type / plate / licence.
 * The account goes back to "waiting for approval" until an admin decides.
 */
export const riderRequestVehicleChange = async (req, res) => {
  try {
    const rider = await submitVehicleChange(req.user.id, req.body || {});
    return handleResponse(
      res,
      200,
      "Vehicle change sent for admin approval. Your account is on hold until it is reviewed.",
      toPayload(rider),
    );
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};

/** Rider withdraws their own pending request. */
export const riderCancelVehicleChange = async (req, res) => {
  try {
    const rider = await cancelVehicleChange(req.user.id);
    return handleResponse(res, 200, "Vehicle change cancelled. Your account is active again.", toPayload(rider));
  } catch (error) {
    return handleResponse(res, error.statusCode || 500, error.message);
  }
};
