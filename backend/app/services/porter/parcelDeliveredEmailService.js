import Parcel from "../../models/parcel.js";
import { buildPorterInvoice } from "./porterInvoiceService.js";
import { renderPorterInvoicePdfBuffer, invoiceFileName } from "../../utils/porterInvoicePdf.js";
import { sendEmail } from "../emailService.js";
import { PORTER_BOOKING_KIND } from "../../constants/porterPayment.js";
import logger from "../logger.js";

/**
 * "Your courier was delivered" — emailed to the customer with the full bill
 * in the message and the invoice PDF attached.
 *
 * Purely additive and best-effort. It is started in the background AFTER a
 * delivery has already been saved, paid out and notified, and nothing it does
 * can change that: every failure is caught and recorded, never thrown. A mail
 * server being down must not be able to fail a delivery.
 *
 * Sent at most once per booking. `invoiceEmail.claimedAt` is claimed
 * atomically before anything is built, so a double-tap on the rider's app, a
 * retried request or two API instances can never email the customer twice.
 *
 * Reuses buildPorterInvoice — the same document the app's "Download invoice"
 * button renders — so the bill in the email, the PDF attached and the
 * invoice in the app can never disagree.
 */

const DELIVERED_EMAIL_ENABLED = () =>
  String(process.env.DELIVERY_INVOICE_EMAIL_ENABLED ?? "true").toLowerCase() !== "false";

const IST = "Asia/Kolkata";

const money = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatDateTime = (value) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: IST,
  });
};

/** Customer-supplied text goes into an HTML email, so it is always escaped. */
const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** When the parcel was delivered, read off the timeline. */
function deliveredAtFrom(invoice) {
  const event = [...(invoice.timeline || [])].reverse().find((e) => e.status === "DELIVERED");
  return event?.at || null;
}

/**
 * The subject, plain-text body and HTML body. Pure — no I/O — so it can be
 * tested and previewed without a mail server.
 */
export function buildDeliveredEmail(invoice) {
  const customerName = invoice.parties?.billedTo?.name || "there";
  const deliveredAt = formatDateTime(deliveredAtFrom(invoice) || invoice.issuedAt);
  const subject = `Your courier is delivered — Invoice ${invoice.invoiceNo}`;
  const brand = invoice.issuer?.tradingName || invoice.issuer?.name || "CourierGo";

  const chargeRows = (invoice.charges || []).map((row) => ({
    label: row.label + (row.note ? ` (${row.note})` : ""),
    amount: row.amount,
  }));
  const totalsRows = [{ label: "Subtotal", amount: invoice.subtotal }];
  (invoice.tax?.lines || []).forEach((row) => totalsRows.push({ label: row.label, amount: row.amount }));
  if (invoice.roundOff) totalsRows.push({ label: "Round off", amount: invoice.roundOff });

  const payment = invoice.payment || {};
  const paymentText = [payment.method, payment.instrument].filter(Boolean).join(" · ") || "—";
  const route = invoice.route || {};

  const text = [
    `Hi ${customerName},`,
    "",
    `Your courier ${invoice.invoiceNo} was delivered${deliveredAt ? ` on ${deliveredAt}` : ""}.`,
    "",
    "BILL",
    ...chargeRows.map((r) => `  ${r.label}: ${money(r.amount)}`),
    ...totalsRows.map((r) => `  ${r.label}: ${money(r.amount)}`),
    `  Total paid: ${money(invoice.total)}`,
    "",
    `Payment: ${paymentText} (${payment.paid ? "Paid" : "Unpaid"})`,
    `From: ${route.pickup || "—"}`,
    `To: ${route.drop || "—"}`,
    "",
    "Your invoice is attached as a PDF. You can also download it any time from the app.",
    "",
    `— ${brand}`,
  ].join("\n");

  const row = (label, amount, { bold = false, muted = false } = {}) => `
    <tr>
      <td style="padding:6px 0;${bold ? "font-weight:700;color:#111827;" : muted ? "color:#6b7280;" : "color:#374151;"}">${esc(label)}</td>
      <td style="padding:6px 0;text-align:right;white-space:nowrap;${bold ? "font-weight:700;color:#111827;font-size:16px;" : "color:#374151;"}">${money(amount)}</td>
    </tr>`;

  const html = `
  <div style="background:#f3f4f6;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
      <div style="background:#111827;color:#ffffff;padding:22px 24px;">
        <div style="font-size:13px;opacity:.7;letter-spacing:.5px;">${esc(brand)}</div>
        <div style="font-size:22px;font-weight:700;margin-top:6px;">Your courier is delivered ✅</div>
      </div>

      <div style="padding:24px;">
        <p style="margin:0 0 6px;color:#111827;font-size:15px;">Hi ${esc(customerName)},</p>
        <p style="margin:0 0 18px;color:#4b5563;font-size:14px;line-height:1.5;">
          Your courier <strong>${esc(invoice.invoiceNo)}</strong> was delivered${deliveredAt ? ` on <strong>${esc(deliveredAt)}</strong>` : ""}.
          Here is your bill. The invoice is attached as a PDF.
        </p>

        <div style="background:#f9fafb;border-radius:10px;padding:14px 16px;margin-bottom:18px;font-size:13px;color:#374151;line-height:1.5;">
          <div><span style="color:#6b7280;">From</span><br>${esc(route.pickup || "—")}</div>
          <div style="margin-top:8px;"><span style="color:#6b7280;">To</span><br>${esc(route.drop || "—")}</div>
          ${route.courier ? `<div style="margin-top:8px;"><span style="color:#6b7280;">Courier</span><br>${esc(route.courier)}${route.destinationCity ? ` → ${esc(route.destinationCity)}` : ""}</div>` : ""}
        </div>

        <div style="font-size:12px;font-weight:700;color:#6b7280;letter-spacing:.6px;margin-bottom:4px;">BILL</div>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${chargeRows.map((r) => row(r.label, r.amount)).join("")}
          <tr><td colspan="2" style="border-top:1px solid #e5e7eb;padding:0;"></td></tr>
          ${totalsRows.map((r) => row(r.label, r.amount, { muted: true })).join("")}
          <tr><td colspan="2" style="border-top:2px solid #111827;padding:0;"></td></tr>
          ${row("Total paid", invoice.total, { bold: true })}
        </table>
        ${invoice.amountInWords ? `<p style="margin:6px 0 0;font-size:12px;color:#6b7280;font-style:italic;">${esc(invoice.amountInWords)}</p>` : ""}

        <div style="margin-top:18px;padding:12px 14px;border-radius:10px;background:${payment.paid ? "#f0fdf4" : "#fffbeb"};font-size:13px;color:#374151;">
          <strong>Payment:</strong> ${esc(paymentText)} —
          <strong style="color:${payment.paid ? "#166534" : "#b45309"};">${payment.paid ? "Paid" : "Unpaid"}</strong>
          ${payment.reference ? `<div style="color:#6b7280;font-size:12px;margin-top:4px;">Ref ${esc(payment.reference)}</div>` : ""}
        </div>

        <p style="margin:20px 0 0;font-size:13px;color:#6b7280;line-height:1.5;">
          You can also download this invoice any time from the app, under your courier history.
        </p>
      </div>

      <div style="padding:14px 24px;background:#f9fafb;color:#9ca3af;font-size:11px;text-align:center;">
        This is an automated email for booking ${esc(invoice.invoiceNo)}.
      </div>
    </div>
  </div>`;

  return { subject, text, html };
}

/**
 * Email the delivered-invoice for one booking. Never throws.
 *
 * Returns what happened, for logs and tests: { sent, skipped?, reason? }.
 */
export async function sendDeliveredInvoiceEmail(parcelId) {
  try {
    if (!DELIVERED_EMAIL_ENABLED()) return { sent: false, skipped: true, reason: "disabled" };
    if (!process.env.EMAIL_HOST) return { sent: false, skipped: true, reason: "email_not_configured" };

    // Exactly-once: whoever wins this claim sends; everyone else stops here.
    const claimed = await Parcel.findOneAndUpdate(
      {
        _id: parcelId,
        status: "DELIVERED",
        "invoiceEmail.claimedAt": null,
        "invoiceEmail.sentAt": null,
      },
      { $set: { "invoiceEmail.claimedAt": new Date() } },
      { new: true },
    ).select("_id customerId");
    if (!claimed) return { sent: false, skipped: true, reason: "already_handled" };

    const invoice = await buildPorterInvoice({
      kind: PORTER_BOOKING_KIND.PARCEL,
      bookingId: parcelId,
      isAdmin: true,
    });

    const to = String(invoice.parties?.billedTo?.email || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
      // No usable email on the customer's profile — nothing to send, and not
      // an error. Recorded so it is not retried.
      await Parcel.updateOne({ _id: parcelId }, { $set: { "invoiceEmail.skippedReason": "no_email" } });
      return { sent: false, skipped: true, reason: "no_email" };
    }

    const { subject, text, html } = buildDeliveredEmail(invoice);
    const pdf = await renderPorterInvoicePdfBuffer(invoice);

    await sendEmail({
      to,
      subject,
      text,
      html,
      attachments: [
        { filename: invoiceFileName(invoice), content: pdf, contentType: "application/pdf" },
      ],
    });

    await Parcel.updateOne(
      { _id: parcelId },
      { $set: { "invoiceEmail.sentAt": new Date(), "invoiceEmail.to": to, "invoiceEmail.error": "" } },
    );
    logger.info("parcel_delivered_invoice_email_sent", { parcelId: String(parcelId), invoiceNo: invoice.invoiceNo });
    return { sent: true };
  } catch (error) {
    logger.error("parcel_delivered_invoice_email_failed", {
      parcelId: String(parcelId),
      message: error?.message,
    });
    // Keep the reason on the booking so an admin can see why it never went.
    await Parcel.updateOne(
      { _id: parcelId },
      { $set: { "invoiceEmail.error": String(error?.message || "send failed").slice(0, 300) } },
    ).catch(() => {});
    return { sent: false, error: error?.message || "send failed" };
  }
}
