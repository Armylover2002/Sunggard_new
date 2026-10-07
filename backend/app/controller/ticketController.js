import Ticket from "../models/ticket.js";
import Admin from "../models/admin.js";
import handleResponse from "../utils/helper.js";
import getPagination from "../utils/pagination.js";
import { nextSequence } from "../models/counter.js";
import {
    emitTicketCreated,
    emitTicketMessage,
    emitTicketStatus,
} from "../services/ticketSocketEmitter.js";
import { emitNotificationEvent } from "../modules/notifications/notification.emitter.js";
import { NOTIFICATION_EVENTS } from "../modules/notifications/notification.constants.js";
import { canonicalUserModelName } from "../constants/refModels.js";

const ALLOWED_CATEGORIES = [
    "order",
    "parcel",
    "payment",
    "delivery",
    "product",
    "refund",
    "app",
    "earnings",
    "account",
    "vehicle",
    "safety",
    "other",
];

const TICKET_STATUSES = ["open", "processing", "closed"];

async function getAdminIds() {
    const admins = await Admin.find().select("_id").lean();
    return (admins || []).map((a) => a?._id).filter(Boolean);
}

/** True when `ticket.userId` belongs to the requester — admins bypass this. */
function isTicketOwner(ticket, req) {
    return String(ticket.userId) === String(req.user.id);
}

/** `TKT-000123`, generated once per ticket from the atomic counter. */
async function generateTicketNumber() {
    const seq = await nextSequence("ticket");
    return `TKT-${String(seq).padStart(6, "0")}`;
}

/** Messages this ticket's owner hasn't seen yet — admin replies since the last read. */
function countUnread(ticket) {
    const since = ticket.lastReadByUserAt
        ? new Date(ticket.lastReadByUserAt).getTime()
        : new Date(ticket.createdAt).getTime() - 1;
    return (ticket.messages || []).filter(
        (m) => m.isAdmin && new Date(m.createdAt).getTime() > since,
    ).length;
}

// Create a new ticket (Customer/Seller/Rider)
export const createTicket = async (req, res) => {
    try {
        const {
            subject,
            description,
            priority,
            userType,
            category,
            relatedOrderId,
            relatedParcelId,
            mediaUrl,
            mediaType,
            mimeType,
        } = req.body;
        const userId = req.user.id; // From verifyToken middleware

        const safeSubject = String(subject || "").trim();
        const safeDescription = String(description || "").trim();
        if (!safeSubject || !safeDescription) {
            return handleResponse(res, 400, "Subject and description are required");
        }

        const safeMediaUrl = String(mediaUrl || "").trim();
        const safeMediaType = String(mediaType || "").trim();
        const safeMimeType = String(mimeType || "").trim();
        const safeCategory = ALLOWED_CATEGORIES.includes(String(category || "").toLowerCase())
            ? String(category).toLowerCase()
            : "other";

        // Must resolve to a real model name ("User" / "Delivery" / "Seller" / "Admin")
        // so `userId` populates correctly — the schema's refPath is "userType".
        const rawType = String(userType || "User").trim();
        const normalizedUserType = canonicalUserModelName(rawType) || "User";

        const newTicket = new Ticket({
            userId,
            userType: normalizedUserType,
            ticketNumber: await generateTicketNumber(),
            subject: safeSubject,
            description: safeDescription,
            category: safeCategory,
            relatedOrderId: String(relatedOrderId || "").trim(),
            relatedParcelId: String(relatedParcelId || "").trim(),
            priority: ["low", "medium", "high"].includes(priority) ? priority : "medium",
            messages: [
                {
                    sender: req.user.name || "User",
                    senderId: userId,
                    senderType: "User",
                    text: safeDescription,
                    mediaUrl: safeMediaUrl,
                    mediaType: safeMediaUrl ? (safeMediaType || "image") : "",
                    mimeType: safeMediaUrl ? safeMimeType : "",
                    isAdmin: false,
                },
            ],
        });

        await newTicket.save();
        emitTicketCreated(newTicket);

        try {
            const savedMessage = newTicket.messages?.[newTicket.messages.length - 1];
            const adminIds = await getAdminIds();
            emitNotificationEvent(NOTIFICATION_EVENTS.SUPPORT_TICKET_MESSAGE, {
                fromRole: "customer",
                ticketId: newTicket._id,
                messageId: savedMessage?._id,
                messageCreatedAt: savedMessage?.createdAt,
                userId,
                userName: req.user.name || "User",
                adminIds,
                messageText: safeDescription || (safeMediaUrl ? "Sent an image" : ""),
                data: {
                    subject: safeSubject,
                    category: safeCategory,
                },
            });
        } catch {
            // Push notifications are best-effort; never block ticket creation.
        }

        return handleResponse(res, 201, "Complaint submitted successfully", newTicket);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

// Get all tickets for current user
export const getMyTickets = async (req, res) => {
    try {
        // No page/limit given -> every ticket, exactly as before, so old app
        // versions that don't send these keep working unchanged (B6).
        const hasPaging = req.query?.page != null || req.query?.limit != null;
        const filter = { userId: req.user.id };

        if (!hasPaging) {
            const tickets = await Ticket.find(filter).sort({ createdAt: -1 }).lean();
            const withUnread = tickets.map((t) => ({ ...t, unreadCount: countUnread(t) }));
            return handleResponse(res, 200, "Tickets fetched successfully", withUnread);
        }

        const { page, limit, skip } = getPagination(req, { defaultLimit: 20, maxLimit: 100 });
        const [tickets, total] = await Promise.all([
            Ticket.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            Ticket.countDocuments(filter),
        ]);
        const withUnread = tickets.map((t) => ({ ...t, unreadCount: countUnread(t) }));

        // handleResponse has no room for a sibling key next to `results`, and
        // the spec wants `results` (array, for old app versions) with
        // `pagination` beside it rather than everything nested under
        // `result` — built directly here to match that envelope.
        return res.status(200).json({
            success: true,
            error: false,
            message: "Tickets fetched successfully",
            results: withUnread,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

// Admin: Get all tickets
export const getAllTickets = async (req, res) => {
    try {
        const { page, limit, skip } = getPagination(req, { defaultLimit: 25, maxLimit: 200 });

        /**
         * Optional `?category=` narrowing. Omitting it returns every ticket,
         * exactly as before, so the general support queue is unchanged — the
         * porter desk passes `parcel` to see only its own.
         */
        const filter = {};
        const category = String(req.query?.category || "").trim();
        if (category) filter.category = category;

        const [tickets, total] = await Promise.all([
            Ticket.find(filter).populate("userId", "name email").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            Ticket.countDocuments(filter)
        ]);

        return handleResponse(res, 200, "All tickets fetched successfully", {
            items: tickets,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
        });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

// Admin/User: Reply to a ticket
export const replyToTicket = async (req, res) => {
    try {
        const { text, mediaUrl, mediaType, mimeType } = req.body;
        const { id } = req.params;

        const ticket = await Ticket.findById(id);
        if (!ticket) return handleResponse(res, 404, "Ticket not found");

        // Never trust the client on who's replying (A2) — a customer could
        // otherwise send isAdmin: true and post as "Admin".
        const isAdmin = req.user.role === "admin";

        // A non-admin may only reply to their own ticket (A1).
        if (!isAdmin && !isTicketOwner(ticket, req)) {
            return handleResponse(res, 403, "Not your ticket");
        }

        const safeText = String(text || "").trim();
        const safeMediaUrl = String(mediaUrl || "").trim();
        const safeMediaType = String(mediaType || "").trim();
        const safeMimeType = String(mimeType || "").trim();

        if (!safeText && !safeMediaUrl) {
            return handleResponse(res, 400, "Message text or mediaUrl is required");
        }

        const wasClosed = ticket.status === "closed";
        // A customer replying to a closed ticket reopens it rather than being
        // turned away — the alternative (reject with 409) would just make
        // them tap a separate "Reopen" button first for no real benefit.
        const reopened = wasClosed && !isAdmin;

        const newMessage = {
            sender: isAdmin ? "Admin" : (req.user.name || "User"),
            senderId: req.user.id,
            senderType: isAdmin ? "Admin" : "User",
            text: safeText,
            mediaUrl: safeMediaUrl,
            mediaType: safeMediaUrl ? (safeMediaType || "image") : "",
            mimeType: safeMediaUrl ? safeMimeType : "",
            isAdmin,
        };

        ticket.messages.push(newMessage);
        if (isAdmin) {
            ticket.status = "processing";
        } else if (reopened) {
            ticket.status = "open";
        }

        await ticket.save();

        const savedMessage = ticket.messages[ticket.messages.length - 1];
        emitTicketMessage({
            ticketId: ticket._id,
            userId: ticket.userId,
            message: typeof savedMessage?.toObject === "function" ? savedMessage.toObject() : savedMessage,
        });

        if (isAdmin || reopened) {
            emitTicketStatus({ ticketId: ticket._id, userId: ticket.userId, status: ticket.status });
        }

        try {
            const fromRole = isAdmin ? "admin" : "customer";
            const payload = {
                fromRole,
                ticketId: ticket._id,
                messageId: savedMessage?._id,
                messageCreatedAt: savedMessage?.createdAt,
                userId: ticket.userId,
                userName: req.user.name || "User",
                messageText: safeText || (safeMediaUrl ? "Sent an image" : ""),
                data: {
                    subject: ticket.subject,
                },
            };

            if (!isAdmin) {
                payload.adminIds = await getAdminIds();
            }

            emitNotificationEvent(NOTIFICATION_EVENTS.SUPPORT_TICKET_MESSAGE, payload);
        } catch {
            // Best-effort; chat must work even if push is misconfigured.
        }

        return handleResponse(res, 200, "Reply sent successfully", ticket);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

// Admin: Update status
export const updateTicketStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const { id } = req.params;

        if (!TICKET_STATUSES.includes(status)) {
            return handleResponse(res, 400, "Invalid status");
        }

        const ticket = await Ticket.findByIdAndUpdate(id, { status }, { new: true });
        if (!ticket) return handleResponse(res, 404, "Ticket not found");

        emitTicketStatus({ ticketId: ticket._id, userId: ticket.userId, status: ticket.status });

        return handleResponse(res, 200, `Ticket status updated to ${status}`, ticket);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

// Owner: Reopen a closed ticket (B1)
export const reopenTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const ticket = await Ticket.findById(id);
        if (!ticket) return handleResponse(res, 404, "Ticket not found");

        if (!isTicketOwner(ticket, req)) {
            return handleResponse(res, 403, "Not your ticket");
        }
        if (ticket.status !== "closed") {
            return handleResponse(res, 409, "Ticket is not closed");
        }

        ticket.status = "open";
        await ticket.save();

        emitTicketStatus({ ticketId: ticket._id, userId: ticket.userId, status: ticket.status });

        return handleResponse(res, 200, "Ticket reopened", ticket);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

// Owner: Mark a ticket's admin replies as read (B3)
export const markTicketRead = async (req, res) => {
    try {
        const { id } = req.params;
        const ticket = await Ticket.findById(id);
        if (!ticket) return handleResponse(res, 404, "Ticket not found");

        if (!isTicketOwner(ticket, req)) {
            return handleResponse(res, 403, "Not your ticket");
        }

        ticket.lastReadByUserAt = new Date();
        await ticket.save();

        return handleResponse(res, 200, "Marked as read", { unreadCount: 0 });
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};

// Owner: Rate a resolved ticket (B4)
export const rateTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { rating, comment } = req.body;

        const numericRating = Number(rating);
        if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
            return handleResponse(res, 400, "rating must be an integer from 1 to 5");
        }

        const ticket = await Ticket.findById(id);
        if (!ticket) return handleResponse(res, 404, "Ticket not found");

        if (!isTicketOwner(ticket, req)) {
            return handleResponse(res, 403, "Not your ticket");
        }
        if (ticket.status !== "closed") {
            return handleResponse(res, 409, "Ticket is not closed yet");
        }
        if (ticket.rating != null) {
            return handleResponse(res, 409, "Already rated");
        }

        ticket.rating = numericRating;
        ticket.ratingComment = String(comment || "").trim();
        ticket.ratedAt = new Date();
        await ticket.save();

        return handleResponse(res, 200, "Thanks for your feedback", ticket);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};
