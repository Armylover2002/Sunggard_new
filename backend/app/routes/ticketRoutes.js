import express from "express";
import {
    createTicket,
    getMyTickets,
    getAllTickets,
    replyToTicket,
    updateTicketStatus,
    reopenTicket,
    markTicketRead,
    rateTicket,
} from "../controller/ticketController.js";
import { verifyToken, allowRoles } from "../middleware/authMiddleware.js";

const router = express.Router();

// Mixed/Shared routes (Need login)
router.post("/create", verifyToken, createTicket);
router.get("/my-tickets", verifyToken, getMyTickets);
router.post("/reply/:id", verifyToken, replyToTicket);
router.patch("/:id/reopen", verifyToken, reopenTicket);
router.patch("/:id/read", verifyToken, markTicketRead);
router.patch("/:id/rate", verifyToken, rateTicket);

// Admin only routes
router.get("/admin/all", verifyToken, allowRoles("admin"), getAllTickets);
router.patch("/admin/status/:id", verifyToken, allowRoles("admin"), updateTicketStatus);

export default router;
