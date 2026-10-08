import { jest } from "@jest/globals";

const findOneAndUpdate = jest.fn();
const updateOne = jest.fn().mockResolvedValue({});
const sendEmail = jest.fn().mockResolvedValue({});
const buildPorterInvoice = jest.fn();

jest.unstable_mockModule("../app/models/parcel.js", () => ({
  default: {
    findOneAndUpdate: (...args) => ({ select: () => findOneAndUpdate(...args) }),
    updateOne,
  },
}));
jest.unstable_mockModule("../app/services/porter/porterInvoiceService.js", () => ({
  buildPorterInvoice,
}));
jest.unstable_mockModule("../app/services/emailService.js", () => ({ sendEmail }));
jest.unstable_mockModule("../app/services/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { buildDeliveredEmail, sendDeliveredInvoiceEmail } = await import(
  "../app/services/porter/parcelDeliveredEmailService.js"
);
const { renderPorterInvoicePdfBuffer, invoiceFileName } = await import(
  "../app/utils/porterInvoicePdf.js"
);

const invoice = (extra = {}) => ({
  invoiceNo: "PCL-40CB82",
  issuedAt: "2026-10-07T16:29:00.000Z",
  issuer: { name: "CourierGo", tradingName: "CourierGo", address: "Indore", taxId: "" },
  parties: {
    billedTo: { name: "Vishu", phone: "7999267233", email: "vishu@example.com" },
    sender: { name: "Vishu", phone: "7999267233" },
    receiver: { name: "Maruti", phone: "9898989898" },
  },
  route: { pickup: "Pipliya Rao, Indore", drop: "Maruti", courier: "Maruti", destinationCity: "Delhi", speed: "express", distanceKm: 4 },
  shipment: { type: "Parcel", weightKg: 0.2 },
  dates: { bookedAt: "2026-10-07T16:00:00.000Z" },
  status: "DELIVERED",
  charges: [
    { label: "Base fare", amount: 50 },
    { label: "Courier handling", amount: 210 },
  ],
  subtotal: 260,
  tax: { inclusive: false, lines: [{ label: "CGST @ 9%", amount: 23.4 }, { label: "SGST @ 9%", amount: 23.4 }] },
  roundOff: null,
  total: 306.8,
  amountInWords: "Three Hundred Six Rupees Eighty Paise Only",
  payment: { method: "UPI", instrument: "vishu@upi", paid: true, reference: "pay_123" },
  timeline: [{ status: "DELIVERED", at: "2026-10-07T16:29:00.000Z", note: "" }],
  ...extra,
});

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env.EMAIL_HOST = "smtp.example.com";
  delete process.env.DELIVERY_INVOICE_EMAIL_ENABLED;
});
afterAll(() => {
  process.env = ENV;
});

describe("the delivered email's content", () => {
  it("shows every bill line, the tax split and the total", () => {
    const { subject, text, html } = buildDeliveredEmail(invoice());
    expect(subject).toContain("PCL-40CB82");
    for (const part of ["Base fare", "Courier handling", "CGST @ 9%", "SGST @ 9%", "₹306.80", "UPI"]) {
      expect(html).toContain(part);
      expect(text).toContain(part);
    }
  });

  it("escapes customer-supplied text so it cannot inject HTML", () => {
    const { html } = buildDeliveredEmail(
      invoice({
        parties: {
          billedTo: { name: "<script>alert(1)</script>", email: "a@b.co" },
          sender: {},
          receiver: {},
        },
        route: { pickup: "<img src=x onerror=alert(1)>", drop: "x" },
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says Unpaid when the booking is not paid", () => {
    const { html } = buildDeliveredEmail(invoice({ payment: { method: "Cash on pickup", paid: false } }));
    expect(html).toContain("Unpaid");
  });
});

describe("the invoice PDF", () => {
  it("renders a real PDF, named after the invoice", async () => {
    const pdf = await renderPorterInvoicePdfBuffer(invoice());
    expect(pdf.slice(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2000);
    expect(invoiceFileName(invoice())).toBe("Invoice-PCL-40CB82.pdf");
  });
});

describe("sending it", () => {
  it("emails the customer the bill with the PDF attached, once", async () => {
    findOneAndUpdate.mockResolvedValueOnce({ _id: "p1" });
    buildPorterInvoice.mockResolvedValueOnce(invoice());

    const result = await sendDeliveredInvoiceEmail("p1");

    expect(result).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("vishu@example.com");
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0].filename).toBe("Invoice-PCL-40CB82.pdf");
    expect(mail.attachments[0].content.slice(0, 5).toString()).toBe("%PDF-");
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "p1" },
      { $set: expect.objectContaining({ "invoiceEmail.to": "vishu@example.com" }) },
    );
  });

  it("does not email twice — losing the claim sends nothing", async () => {
    findOneAndUpdate.mockResolvedValueOnce(null);

    const result = await sendDeliveredInvoiceEmail("p1");

    expect(result).toMatchObject({ sent: false, reason: "already_handled" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(buildPorterInvoice).not.toHaveBeenCalled();
  });

  it("skips quietly when the customer has no email on their profile", async () => {
    findOneAndUpdate.mockResolvedValueOnce({ _id: "p1" });
    buildPorterInvoice.mockResolvedValueOnce(
      invoice({ parties: { billedTo: { name: "Vishu", email: "" }, sender: {}, receiver: {} } }),
    );

    const result = await sendDeliveredInvoiceEmail("p1");

    expect(result).toMatchObject({ sent: false, reason: "no_email" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never throws when the mail server fails — it records the reason", async () => {
    findOneAndUpdate.mockResolvedValueOnce({ _id: "p1" });
    buildPorterInvoice.mockResolvedValueOnce(invoice());
    sendEmail.mockRejectedValueOnce(new Error("SMTP down"));

    const result = await sendDeliveredInvoiceEmail("p1");

    expect(result).toMatchObject({ sent: false, error: "SMTP down" });
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "p1" },
      { $set: { "invoiceEmail.error": "SMTP down" } },
    );
  });

  it("never throws when the invoice itself cannot be built", async () => {
    findOneAndUpdate.mockResolvedValueOnce({ _id: "p1" });
    buildPorterInvoice.mockRejectedValueOnce(new Error("Booking not found"));

    await expect(sendDeliveredInvoiceEmail("p1")).resolves.toMatchObject({ sent: false });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does nothing when email is not configured", async () => {
    delete process.env.EMAIL_HOST;

    const result = await sendDeliveredInvoiceEmail("p1");

    expect(result).toMatchObject({ skipped: true, reason: "email_not_configured" });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("can be switched off with DELIVERY_INVOICE_EMAIL_ENABLED=false", async () => {
    process.env.DELIVERY_INVOICE_EMAIL_ENABLED = "false";

    const result = await sendDeliveredInvoiceEmail("p1");

    expect(result).toMatchObject({ skipped: true, reason: "disabled" });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
