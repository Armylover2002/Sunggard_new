import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockFindById = jest.fn();
const mockFind = jest.fn();
const mockFindByIdAndUpdate = jest.fn();
const mockCountDocuments = jest.fn().mockResolvedValue(0);
const mockNextSequence = jest.fn().mockResolvedValue(1);
const mockAdminFind = jest.fn();
const mockEmitTicketCreated = jest.fn();
const mockEmitTicketMessage = jest.fn();
const mockEmitTicketStatus = jest.fn();
const mockEmitNotificationEvent = jest.fn();

// `new Ticket(...)` needs a constructor; static finders hang off the same fn.
function TicketCtor(doc) {
  Object.assign(this, doc);
  this.messages = doc.messages || [];
  this.save = jest.fn(async () => this);
}
TicketCtor.findById = mockFindById;
TicketCtor.find = mockFind;
TicketCtor.findByIdAndUpdate = mockFindByIdAndUpdate;
TicketCtor.countDocuments = mockCountDocuments;

jest.unstable_mockModule("../app/models/ticket.js", () => ({ default: TicketCtor }));

jest.unstable_mockModule("../app/models/admin.js", () => ({
  default: { find: mockAdminFind },
}));

jest.unstable_mockModule("../app/models/counter.js", () => ({
  nextSequence: mockNextSequence,
}));

jest.unstable_mockModule("../app/services/ticketSocketEmitter.js", () => ({
  emitTicketCreated: mockEmitTicketCreated,
  emitTicketMessage: mockEmitTicketMessage,
  emitTicketStatus: mockEmitTicketStatus,
}));

jest.unstable_mockModule("../app/modules/notifications/notification.emitter.js", () => ({
  emitNotificationEvent: mockEmitNotificationEvent,
}));

const {
  createTicket,
  replyToTicket,
  updateTicketStatus,
  reopenTicket,
  markTicketRead,
  rateTicket,
} = await import("../app/controller/ticketController.js");

const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const OWNER = new mongoose.Types.ObjectId();
const OTHER = new mongoose.Types.ObjectId();

describe("ticket controller", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });
  });

  describe("createTicket (A4)", () => {
    it("rejects an empty subject/description with 400, not a 500", async () => {
      const req = { body: { subject: "  ", description: "" }, user: { id: OWNER, name: "A" } };
      const res = makeRes();
      await createTicket(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("generates a ticketNumber and stores the trimmed description", async () => {
      const req = {
        body: { subject: " Help ", description: "  My parcel is late  " },
        user: { id: OWNER, name: "Riya" },
      };
      const res = makeRes();
      await createTicket(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const saved = res.json.mock.calls[0][0].result;
      expect(saved.ticketNumber).toBe("TKT-000001");
      expect(saved.messages[0].text).toBe("My parcel is late");
    });
  });

  describe("replyToTicket (A1, A2)", () => {
    it("refuses a reply from someone who doesn't own the ticket", async () => {
      mockFindById.mockResolvedValue(
        new TicketCtor({ _id: "t1", userId: OWNER, status: "open", messages: [] }),
      );
      const req = {
        params: { id: "t1" },
        body: { text: "hi" },
        user: { id: OTHER, role: "customer", name: "Intruder" },
      };
      const res = makeRes();
      await replyToTicket(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("ignores a client-sent isAdmin:true and posts the message as the customer", async () => {
      const ticket = new TicketCtor({ _id: "t1", userId: OWNER, status: "open", messages: [] });
      mockFindById.mockResolvedValue(ticket);
      const req = {
        params: { id: "t1" },
        body: { text: "I am totally admin", isAdmin: true },
        user: { id: OWNER, role: "customer", name: "Riya" },
      };
      const res = makeRes();
      await replyToTicket(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(ticket.messages[0].isAdmin).toBe(false);
      expect(ticket.messages[0].sender).toBe("Riya");
      expect(ticket.status).toBe("open");
    });

    it("reopens a closed ticket when the owner replies, and tells admin to reopen it", async () => {
      const ticket = new TicketCtor({ _id: "t1", userId: OWNER, status: "closed", messages: [] });
      mockFindById.mockResolvedValue(ticket);
      const req = {
        params: { id: "t1" },
        body: { text: "still broken" },
        user: { id: OWNER, role: "customer", name: "Riya" },
      };
      const res = makeRes();
      await replyToTicket(req, res);

      expect(ticket.status).toBe("open");
      expect(mockEmitTicketStatus).toHaveBeenCalledWith(
        expect.objectContaining({ status: "open" }),
      );
    });
  });

  describe("updateTicketStatus (A3)", () => {
    it("rejects a status outside the allowed set", async () => {
      const req = { params: { id: "t1" }, body: { status: "resolved-ish" } };
      const res = makeRes();
      await updateTicketStatus(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe("reopenTicket (B1)", () => {
    it("refuses to reopen an already-open ticket", async () => {
      mockFindById.mockResolvedValue(new TicketCtor({ _id: "t1", userId: OWNER, status: "open" }));
      const req = { params: { id: "t1" }, user: { id: OWNER } };
      const res = makeRes();
      await reopenTicket(req, res);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it("reopens a closed ticket for its owner", async () => {
      const ticket = new TicketCtor({ _id: "t1", userId: OWNER, status: "closed" });
      mockFindById.mockResolvedValue(ticket);
      const req = { params: { id: "t1" }, user: { id: OWNER } };
      const res = makeRes();
      await reopenTicket(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(ticket.status).toBe("open");
    });
  });

  describe("markTicketRead (B3)", () => {
    it("sets lastReadByUserAt and returns unreadCount 0", async () => {
      const ticket = new TicketCtor({ _id: "t1", userId: OWNER, status: "open" });
      mockFindById.mockResolvedValue(ticket);
      const req = { params: { id: "t1" }, user: { id: OWNER } };
      const res = makeRes();
      await markTicketRead(req, res);
      expect(ticket.lastReadByUserAt).toBeInstanceOf(Date);
      expect(res.json.mock.calls[0][0].result.unreadCount).toBe(0);
    });
  });

  describe("rateTicket (B4)", () => {
    it("refuses a rating before the ticket is closed", async () => {
      mockFindById.mockResolvedValue(
        new TicketCtor({ _id: "t1", userId: OWNER, status: "open", rating: null }),
      );
      const req = { params: { id: "t1" }, body: { rating: 5 }, user: { id: OWNER } };
      const res = makeRes();
      await rateTicket(req, res);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it("refuses a second rating on the same ticket", async () => {
      mockFindById.mockResolvedValue(
        new TicketCtor({ _id: "t1", userId: OWNER, status: "closed", rating: 4 }),
      );
      const req = { params: { id: "t1" }, body: { rating: 5 }, user: { id: OWNER } };
      const res = makeRes();
      await rateTicket(req, res);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it("accepts a 1-5 rating once, for the owner, on a closed ticket", async () => {
      const ticket = new TicketCtor({ _id: "t1", userId: OWNER, status: "closed", rating: null });
      mockFindById.mockResolvedValue(ticket);
      const req = {
        params: { id: "t1" },
        body: { rating: 5, comment: "Fast resolution" },
        user: { id: OWNER },
      };
      const res = makeRes();
      await rateTicket(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(ticket.rating).toBe(5);
      expect(ticket.ratingComment).toBe("Fast resolution");
    });
  });
});
