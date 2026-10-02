/**
 * Renders a porter booking invoice to a PDF.
 *
 * Takes the invoice document the server builds (GET /porter/invoice/:kind/:id)
 * and does nothing but lay it out. That split is deliberate: the numbers, the
 * tax split and the wording all come from one server-side builder, so a
 * customer's copy and an admin's copy of the same booking are byte-for-byte
 * the same invoice. A PDF assembled from whatever a React page happened to
 * have in state would differ between the two screens and could not be
 * reproduced later.
 *
 * jsPDF is imported dynamically. It is roughly 400 KB and only a handful of
 * users ever press Download, so bundling it into the main chunk would slow
 * every page load for everyone to serve a rare action.
 */

const MARGIN = 15;
const PAGE_W = 210; // A4 width in mm
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;

/** Currency, formatted the way the rest of the product does. */
const money = (value) =>
  `Rs. ${Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatDate = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatDateOnly = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

/**
 * A tiny cursor over the page.
 *
 * jsPDF has no flow layout — every draw call takes absolute coordinates — so
 * without something tracking the vertical position, adding a line anywhere
 * means hand-adjusting every y below it. This also owns the page break, so no
 * section has to remember to check whether it still fits.
 */
function createLayout(doc) {
  let y = MARGIN;

  const ensure = (needed) => {
    if (y + needed > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN;
      return true;
    }
    return false;
  };

  return {
    get y() {
      return y;
    },
    set y(value) {
      y = value;
    },
    ensure,
    advance(by) {
      y += by;
    },
  };
}

/** Wraps long text and returns how far down the page it pushed. */
function wrapped(doc, text, x, y, maxWidth, lineHeight = 4.2) {
  const lines = doc.splitTextToSize(String(text || "—"), maxWidth);
  doc.text(lines, x, y);
  return lines.length * lineHeight;
}

function drawHeader(doc, layout, invoice) {
  const { issuer } = invoice;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.setTextColor(17, 24, 39);
  doc.text(issuer.name || "Invoice", MARGIN, layout.y + 4);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(107, 114, 128);
  let subY = layout.y + 9;
  if (issuer.address) {
    subY += wrapped(doc, issuer.address, MARGIN, subY, 90, 3.6);
  }
  const contact = [issuer.phone, issuer.email].filter(Boolean).join("  ·  ");
  if (contact) {
    doc.text(contact, MARGIN, subY);
    subY += 4;
  }
  if (issuer.taxId) {
    doc.setFont("helvetica", "bold");
    doc.text(`GSTIN: ${issuer.taxId}`, MARGIN, subY);
    subY += 4;
  }

  // Right-hand block: what this document is and which booking it is for.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(17, 24, 39);
  doc.text("TAX INVOICE", PAGE_W - MARGIN, layout.y + 4, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(55, 65, 81);
  doc.text(invoice.invoiceNo, PAGE_W - MARGIN, layout.y + 10, { align: "right" });
  doc.setTextColor(107, 114, 128);
  doc.setFontSize(8);
  doc.text(
    `Issued ${formatDateOnly(invoice.issuedAt)}`,
    PAGE_W - MARGIN,
    layout.y + 15,
    { align: "right" },
  );

  layout.y = Math.max(subY, layout.y + 25) + 3;

  doc.setDrawColor(229, 231, 235);
  doc.setLineWidth(0.4);
  doc.line(MARGIN, layout.y, PAGE_W - MARGIN, layout.y);
  layout.advance(7);
}

/**
 * A cancellation or a refund is stated at the top, in colour.
 *
 * An invoice for a booking that did not happen, or whose money went back, is
 * a receipt for something untrue unless it says so on its face — and it has
 * to say so where someone glancing at it will look.
 */
function drawNotice(doc, layout, invoice) {
  if (!invoice.notice) return;

  layout.ensure(12);
  doc.setFillColor(254, 242, 242);
  doc.setDrawColor(252, 165, 165);
  doc.roundedRect(MARGIN, layout.y, CONTENT_W, 9, 1.5, 1.5, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(153, 27, 27);
  doc.text(invoice.notice, MARGIN + 3, layout.y + 5.8);
  layout.advance(14);
}

/** Two columns of "who" — billed to on the left, delivery parties on the right. */
function drawParties(doc, layout, invoice) {
  const { parties } = invoice;
  const colW = CONTENT_W / 2 - 3;
  const rightX = MARGIN + CONTENT_W / 2 + 3;
  const startY = layout.y;

  const label = (text, x, y) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(107, 114, 128);
    doc.text(text.toUpperCase(), x, y);
  };
  const value = (text, x, y, width = colW) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(31, 41, 55);
    return wrapped(doc, text, x, y, width);
  };

  let leftY = startY;
  label("Billed to", MARGIN, leftY);
  leftY += 4.5;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(17, 24, 39);
  doc.text(parties.billedTo?.name || "Customer", MARGIN, leftY);
  leftY += 4.5;
  leftY += value(
    [parties.billedTo?.phone, parties.billedTo?.email].filter(Boolean).join("\n") || "—",
    MARGIN,
    leftY,
  );

  let rightY = startY;
  label("Sender", rightX, rightY);
  rightY += 4.5;
  rightY += value(
    `${parties.sender?.name || "—"}${parties.sender?.phone ? `\n${parties.sender.phone}` : ""}`,
    rightX,
    rightY,
  );
  rightY += 2;
  label("Receiver", rightX, rightY);
  rightY += 4.5;
  const receiverLines = [parties.receiver?.name, parties.receiver?.phone].filter(Boolean);
  // Who actually took the parcel, when it was not the named receiver — the
  // single most-disputed fact on any delivery.
  if (parties.receiver?.receivedBy) {
    receiverLines.push(
      `Received by ${parties.receiver.receivedBy}${
        parties.receiver.relation ? ` (${parties.receiver.relation})` : ""
      }`,
    );
  }
  rightY += value(receiverLines.join("\n") || "—", rightX, rightY);

  layout.y = Math.max(leftY, rightY) + 5;
}

/** The route, the package, and the dates — the operational facts. */
function drawShipment(doc, layout, invoice) {
  layout.ensure(40);

  const { route, shipment, dates } = invoice;

  const rows = [
    ["Pickup", route?.pickup || "—"],
    ["Drop", route?.drop || "—"],
  ];
  if (route?.destinationCity) rows.push(["Destination city", route.destinationCity]);
  if (route?.courier) rows.push(["Courier", route.courier]);
  if (route?.courierCompany) rows.push(["Handed to", route.courierCompany]);

  const meta = [
    ["Distance", route?.distanceKm != null ? `${route.distanceKm} km` : "—"],
    ["Service", route?.speed === "express" ? "Express" : "Standard"],
    ["Package", shipment?.type || "—"],
    ["Weight", shipment?.weightKg != null ? `${shipment.weightKg} kg` : "—"],
    ["Booked", formatDate(dates?.bookedAt)],
    [
      dates?.deliveredAt ? "Delivered" : "Status",
      dates?.deliveredAt ? formatDate(dates.deliveredAt) : invoice.status || "—",
    ],
  ];

  const boxTop = layout.y;
  const half = Math.ceil(meta.length / 2);

  /**
   * The box has to be filled BEFORE the text is drawn — jsPDF paints in call
   * order with no z-index, so a rectangle drawn afterwards would cover the
   * content. But its height depends on how many lines the addresses wrap to.
   * So the wrapped line counts are measured first, without drawing anything.
   */
  doc.setFontSize(8.5);
  const wrappedRows = rows.map(([key, val]) => ({
    key,
    lines: doc.splitTextToSize(String(val || "—"), CONTENT_W - 40),
  }));
  const rowsHeight = wrappedRows.reduce((sum, row) => sum + row.lines.length * 4.2 + 1.5, 0);
  const boxHeight = 6 + rowsHeight + 1 + half * 5 + 1;

  doc.setFillColor(249, 250, 251);
  doc.roundedRect(MARGIN, boxTop, CONTENT_W, boxHeight, 2, 2, "F");

  let innerY = boxTop + 6;
  wrappedRows.forEach(({ key, lines }) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(107, 114, 128);
    doc.text(key.toUpperCase(), MARGIN + 4, innerY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(31, 41, 55);
    doc.text(lines, MARGIN + 34, innerY);
    innerY += lines.length * 4.2 + 1.5;
  });

  // The short facts go two-up, so the box does not run down the page.
  innerY += 1;
  meta.forEach(([key, val], index) => {
    const isLeft = index < half;
    const x = isLeft ? MARGIN + 4 : MARGIN + CONTENT_W / 2;
    const rowY = innerY + (isLeft ? index : index - half) * 5;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(107, 114, 128);
    doc.text(key.toUpperCase(), x, rowY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(31, 41, 55);
    doc.text(String(val), x + 30, rowY);
  });

  layout.y = boxTop + boxHeight + 7;
}

/** The money: every charge line, the tax split, and the total. */
function drawCharges(doc, layout, invoice) {
  layout.ensure(60);

  const rightEdge = PAGE_W - MARGIN;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(107, 114, 128);
  doc.text("DESCRIPTION", MARGIN, layout.y);
  doc.text("AMOUNT", rightEdge, layout.y, { align: "right" });
  layout.advance(2.5);
  doc.setDrawColor(209, 213, 219);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, layout.y, rightEdge, layout.y);
  layout.advance(5.5);

  doc.setFontSize(9);
  (invoice.charges || []).forEach((row) => {
    layout.ensure(8);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(31, 41, 55);
    doc.text(row.label, MARGIN, layout.y);
    if (row.note) {
      doc.setFontSize(7.5);
      doc.setTextColor(107, 114, 128);
      doc.text(row.note, MARGIN + doc.getTextWidth(row.label) + 3, layout.y);
      doc.setFontSize(9);
      doc.setTextColor(31, 41, 55);
    }
    doc.text(money(row.amount), rightEdge, layout.y, { align: "right" });
    layout.advance(5.5);
  });

  layout.advance(1);
  doc.setDrawColor(229, 231, 235);
  doc.line(MARGIN + CONTENT_W / 2, layout.y, rightEdge, layout.y);
  layout.advance(5);

  const totalLine = (label, amount, opts = {}) => {
    layout.ensure(8);
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(opts.bold ? 10.5 : 9);
    doc.setTextColor(opts.bold ? 17 : 55, opts.bold ? 24 : 65, opts.bold ? 39 : 81);
    doc.text(label, MARGIN + CONTENT_W / 2, layout.y);
    doc.text(money(amount), rightEdge, layout.y, { align: "right" });
    layout.advance(opts.bold ? 7 : 5.2);
  };

  totalLine("Subtotal", invoice.subtotal);

  if (invoice.tax) {
    invoice.tax.lines.forEach((row) => totalLine(row.label, row.amount));
    if (invoice.tax.inclusive) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(7.5);
      doc.setTextColor(107, 114, 128);
      doc.text(
        "Tax is included in the quoted fare.",
        MARGIN + CONTENT_W / 2,
        layout.y,
      );
      layout.advance(4.5);
    }
  }

  if (invoice.roundOff) {
    totalLine("Round off", invoice.roundOff);
  }

  layout.advance(1);
  doc.setDrawColor(17, 24, 39);
  doc.setLineWidth(0.5);
  doc.line(MARGIN + CONTENT_W / 2, layout.y, rightEdge, layout.y);
  layout.advance(6);
  totalLine("Total paid", invoice.total, { bold: true });

  if (invoice.amountInWords) {
    layout.ensure(10);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8);
    doc.setTextColor(107, 114, 128);
    layout.advance(wrapped(doc, invoice.amountInWords, MARGIN, layout.y, CONTENT_W));
    layout.advance(3);
  }
}

/** How it was paid — the block support reaches for on any dispute. */
function drawPayment(doc, layout, invoice) {
  const { payment } = invoice;
  if (!payment) return;

  layout.ensure(22);

  doc.setFillColor(payment.paid ? 240 : 254, payment.paid ? 253 : 252, payment.paid ? 244 : 232);
  doc.roundedRect(MARGIN, layout.y, CONTENT_W, 16, 2, 2, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(107, 114, 128);
  doc.text("PAYMENT", MARGIN + 4, layout.y + 5);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(17, 24, 39);
  const method = [payment.method, payment.instrument].filter(Boolean).join("  ·  ");
  doc.text(method || "—", MARGIN + 4, layout.y + 10.5);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(75, 85, 99);
  if (payment.reference) {
    doc.text(`Ref ${payment.reference}`, MARGIN + 4, layout.y + 14.5);
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(payment.paid ? 22 : 180, payment.paid ? 101 : 83, payment.paid ? 52 : 9);
  doc.text(payment.paid ? "PAID" : "UNPAID", PAGE_W - MARGIN - 4, layout.y + 6.5, {
    align: "right",
  });
  if (payment.paidAt) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(107, 114, 128);
    doc.text(formatDate(payment.paidAt), PAGE_W - MARGIN - 4, layout.y + 11.5, {
      align: "right",
    });
  }

  layout.advance(21);
}

/**
 * The delivery timeline — what turns the invoice into proof of service.
 *
 * Capped at the most recent dozen entries. A parcel with three failed
 * attempts and a return leg can carry thirty events, and a second page of
 * status rows is not what anybody downloads an invoice for.
 */
function drawTimeline(doc, layout, invoice) {
  const events = (invoice.timeline || []).slice(-12);
  if (!events.length) return;

  layout.ensure(20);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(107, 114, 128);
  doc.text("DELIVERY TIMELINE", MARGIN, layout.y);
  layout.advance(5);

  events.forEach((event) => {
    layout.ensure(6);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(31, 41, 55);
    doc.text(String(event.status || "").replace(/_/g, " "), MARGIN + 2, layout.y);
    doc.setTextColor(107, 114, 128);
    doc.text(formatDate(event.at), MARGIN + 55, layout.y);
    if (event.note) {
      doc.setFontSize(7.5);
      wrapped(doc, event.note, MARGIN + 105, layout.y, CONTENT_W - 105, 3.5);
    }
    layout.advance(4.8);
  });

  layout.advance(3);
}

/** Page numbers and the closing note, stamped on every page at the end. */
function drawFooters(doc, invoice) {
  const pageCount = doc.getNumberOfPages();

  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(229, 231, 235);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, PAGE_H - 14, PAGE_W - MARGIN, PAGE_H - 14);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(156, 163, 175);
    doc.text(
      "Computer-generated invoice. No signature required.",
      MARGIN,
      PAGE_H - 9.5,
    );
    doc.text(
      `${invoice.invoiceNo}  ·  Page ${page} of ${pageCount}`,
      PAGE_W - MARGIN,
      PAGE_H - 9.5,
      { align: "right" },
    );
  }
}

/**
 * Build the PDF and hand it back.
 *
 * Returns the jsPDF instance rather than saving it, so a caller can save,
 * open in a tab, or attach it to a share sheet without this having to know
 * which.
 */
export async function buildPorterInvoicePdf(invoice) {
  if (!invoice) throw new Error("No invoice to render");

  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });
  const layout = createLayout(doc);

  drawHeader(doc, layout, invoice);
  drawNotice(doc, layout, invoice);
  drawParties(doc, layout, invoice);
  drawShipment(doc, layout, invoice);
  drawCharges(doc, layout, invoice);
  drawPayment(doc, layout, invoice);
  drawTimeline(doc, layout, invoice);
  drawFooters(doc, invoice);

  return doc;
}

/** The filename a customer sees in their downloads folder. */
export function invoiceFileName(invoice) {
  const safe = String(invoice?.invoiceNo || "invoice").replace(/[^A-Za-z0-9_-]/g, "-");
  return `Invoice-${safe}.pdf`;
}

/**
 * Fetch, render and download in one call — what a Download button binds to.
 *
 * `fetchInvoice` is injected rather than imported so the same helper serves
 * the customer app and the admin panel, which authenticate through different
 * axios instances.
 */
export async function downloadPorterInvoice(fetchInvoice) {
  const response = await fetchInvoice();
  const invoice = response?.data?.result ?? response?.data?.results ?? response?.data;

  if (!invoice?.invoiceNo) {
    throw new Error("Could not load the invoice for this booking");
  }

  const doc = await buildPorterInvoicePdf(invoice);
  doc.save(invoiceFileName(invoice));
  return invoice;
}
