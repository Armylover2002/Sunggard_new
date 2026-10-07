import Customer from "../models/customer.js";
import Transaction from "../models/transaction.js";
import LedgerEntry from "../models/ledgerEntry.js";
import jwt from "jsonwebtoken";
import handleResponse from "../utils/helper.js";
import {
    issueCustomerOtp,
    sanitizeCustomer,
    verifyCustomerOtpCode,
    normalizeAndValidatePhone,
} from "../services/otpAuthService.js";
import {
    sendLoginOtpSchema,
    sendSignupOtpSchema,
    validateSchema,
    verifyOtpSchema,
} from "../validation/customerAuthValidation.js";
import {
    LEDGER_DIRECTION,
    LEDGER_STATUS,
    OWNER_TYPE,
} from "../constants/finance.js";
import { getCustomerBalance } from "../services/finance/walletService.js";
import { bumpOwnSession } from "../services/sessionService.js";

const generateToken = (customer) =>
    jwt.sign(
        { id: customer._id, role: "customer", sv: customer.sessionVersion || 0 },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );

function ledgerTitle(entry) {
    const type = String(entry?.type || "");
    const desc = String(entry?.description || "").trim();
    if (desc) return desc;
    switch (type) {
        case "WALLET_REFUND":
            return "Wallet refund";
        case "WALLET_PAYMENT":
            return "Order payment (wallet)";
        case "CANCELLATION_REVERSAL":
            return "Cancel refund";
        case "ADJUSTMENT":
            return "Wallet adjustment";
        default:
            return type.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) || "Wallet transaction";
    }
}

/* ===============================
   SIGNUP – Send OTP
================================ */
export const signupCustomer = async (req, res) => {
    try {
        const payload = validateSchema(sendSignupOtpSchema, req.body || {});

        // The mirror of the login case: signing up on a number that already
        // has an account should send someone to log in, not quietly hand them
        // an OTP that signs them into the account they forgot they had.
        const existing = await Customer.findOne({
            phone: normalizeAndValidatePhone(payload.phone),
        }).select("isVerified").lean();

        if (existing?.isVerified) {
            return handleResponse(res, 409, "This number is already registered", {
                code: "ALREADY_REGISTERED",
            });
        }

        await issueCustomerOtp({
            name: payload.name,
            rawPhone: payload.phone,
            flow: "signup",
            ipAddress: req.ip,
        });

        return handleResponse(res, 200, "OTP sent", { otpSent: true });
    } catch (error) {
        return handleResponse(res, error.statusCode || 500, error.message, {
            code: error.code || undefined,
        });
    }
};

/* ===============================
   LOGIN – Send OTP
================================ */
export const loginCustomer = async (req, res) => {
    try {
        const payload = validateSchema(sendLoginOtpSchema, req.body || {});

        await issueCustomerOtp({
            rawPhone: payload.phone,
            flow: "login",
            ipAddress: req.ip,
        });

        return handleResponse(res, 200, "OTP sent", { otpSent: true });
    } catch (error) {
        // The app needs to tell "no account here" apart from every other
        // failure, so it can offer to sign the person up instead of showing
        // them an OTP box that will never be filled.
        return handleResponse(res, error.statusCode || 500, error.message, {
            code: error.code || undefined,
        });
    }
};

/* ===============================
   VERIFY OTP – Login / Signup
================================ */
export const verifyCustomerOTP = async (req, res) => {
    try {
        const payload = validateSchema(verifyOtpSchema, req.body || {});
        const customer = await verifyCustomerOtpCode({
            rawPhone: payload.phone,
            otp: payload.otp,
            ipAddress: req.ip,
        });
        // Single active session for THIS account only — never touches a
        // rider account that happens to share the same phone number.
        customer.sessionVersion = await bumpOwnSession(Customer, customer._id);
        const token = generateToken(customer);

        return handleResponse(
            res,
            200,
            "Login successful",
            {
                token,
                customer: sanitizeCustomer(customer),
            }
        );
    } catch (error) {
        return handleResponse(res, error.statusCode || 500, error.message);
    }
};

/* ===============================
   GET PROFILE
================================ */
export const getCustomerProfile = async (req, res) => {
    try {
        const customer = await Customer.findById(req.user.id);
        if (!customer) {
            return handleResponse(res, 404, "Customer not found");
        }
        let walletBalance = Number(customer.walletBalance) || 0;
        try {
            walletBalance = await getCustomerBalance(req.user.id);
        } catch {
            // keep Customer.walletBalance fallback
        }
        const payload = customer.toObject ? customer.toObject() : { ...customer };
        payload.walletBalance = walletBalance;
        return handleResponse(res, 200, "Profile fetched successfully", payload);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   UPDATE PROFILE
================================ */
const NAME_MAX_LENGTH = 50;
const NAME_MIN_LENGTH = 2;
/* Deliberately permissive: one @, something either side, a dotted TLD. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const updateCustomerProfile = async (req, res) => {
    try {
        const { name, email, addresses, avatar } = req.body;

        const customer = await Customer.findById(req.user.id);
        if (!customer) {
            return handleResponse(res, 404, "Customer not found");
        }

        if (name !== undefined) {
            const trimmed = String(name).trim();
            if (trimmed.length < NAME_MIN_LENGTH) {
                return handleResponse(
                    res,
                    400,
                    `Name must be at least ${NAME_MIN_LENGTH} characters`,
                );
            }
            if (trimmed.length > NAME_MAX_LENGTH) {
                return handleResponse(
                    res,
                    400,
                    `Name cannot exceed ${NAME_MAX_LENGTH} characters`,
                );
            }
            customer.name = trimmed;
        }

        if (email !== undefined) {
            const trimmed = String(email).trim().toLowerCase();
            // Clearing the address is allowed; a malformed one is not.
            if (trimmed && !EMAIL_PATTERN.test(trimmed)) {
                return handleResponse(res, 400, "Enter a valid email address");
            }
            // `unique: true` is sparse, so store undefined rather than "" when cleared.
            customer.email = trimmed || undefined;
        }

        if (avatar !== undefined) {
            customer.avatar = String(avatar).trim();
        }

        if (addresses) customer.addresses = addresses;

        await customer.save();

        return handleResponse(res, 200, "Profile updated successfully", customer);
    } catch (error) {
        // A second account already holding this address surfaces as a duplicate key.
        if (error?.code === 11000 && error?.keyPattern?.email) {
            return handleResponse(res, 409, "That email is already in use");
        }
        if (error?.name === "ValidationError") {
            return handleResponse(res, 400, error.message);
        }
        return handleResponse(res, 500, error.message);
    }
};

/* ===============================
   GET WALLET TRANSACTIONS
================================ */
export const getCustomerTransactions = async (req, res) => {
    try {
        const customerId = req.user.id;
        const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
        const perPage = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 40));

        const [ledgerRows, legacyRows] = await Promise.all([
            LedgerEntry.find({
                actorType: OWNER_TYPE.CUSTOMER,
                actorId: customerId,
                status: { $ne: LEDGER_STATUS.FAILED },
            })
                .sort({ createdAt: -1 })
                .limit(100)
                .lean(),
            Transaction.find({ user: customerId, userModel: "User" })
                .sort({ createdAt: -1 })
                .limit(100)
                .lean(),
        ]);

        const ledgerItems = (ledgerRows || []).map((t) => ({
            _id: String(t._id),
            type: t.direction === LEDGER_DIRECTION.DEBIT ? "debit" : "credit",
            title: ledgerTitle(t),
            amount: Math.abs(Number(t.amount) || 0),
            date: t.createdAt,
            reference: t.reference || t.transactionId || "",
            orderId: null,
            source: "ledger",
            ledgerType: t.type,
        }));

        const legacyItems = (legacyRows || []).map((t) => {
            const typeStr = String(t.type || "").toLowerCase();
            const isCredit =
                typeStr === "refund" ||
                typeStr.includes("refund") ||
                typeStr.includes("credit");
            return {
                _id: `legacy-${String(t._id)}`,
                type: isCredit ? "credit" : "debit",
                title: t.type === "Refund" ? "Refund" : t.type || "Transaction",
                amount: Math.abs(Number(t.amount) || 0),
                date: t.createdAt,
                reference: t.reference || "",
                orderId: null,
                source: "legacy",
            };
        });

        // Prefer ledger; drop legacy rows that share the same reference as a ledger entry.
        const ledgerRefs = new Set(
            ledgerItems.map((i) => String(i.reference || "")).filter(Boolean),
        );
        const merged = [
            ...ledgerItems,
            ...legacyItems.filter((i) => !i.reference || !ledgerRefs.has(String(i.reference))),
        ].sort((a, b) => new Date(b.date) - new Date(a.date));

        const total = merged.length;
        const skip = (pageNum - 1) * perPage;
        const items = merged.slice(skip, skip + perPage);

        return handleResponse(res, 200, "Transactions fetched", {
            items,
            total,
            page: pageNum,
            totalPages: Math.ceil(total / perPage) || 1,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};
