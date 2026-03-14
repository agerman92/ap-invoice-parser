import type { InvoiceExtraction, InvoiceLine } from "./invoice-schema.ts";
import type { PdfLayoutResult, PdfTextItem } from "./pdf-layout.ts";

type Row = {
  page: number;
  y: number;
  items: PdfTextItem[];
};

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function num(value: string): number {
  if (!value) return 0;
  const normalized = value.replace(/,/g, "").replace(/\$/g, "").trim();
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function firstMatch(text: string, regex: RegExp): string {
  const match = text.match(regex);
  return match?.[1]?.trim() ?? "";
}

function groupRows(items: PdfTextItem[]): Row[] {
  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(b.y - a.y) > 2) return b.y - a.y;
    return a.x - b.x;
  });

  const rows: Row[] = [];

  for (const item of sorted) {
    let matched = rows.find(
      (r) => r.page === item.page && Math.abs(r.y - item.y) <= 3,
    );

    if (!matched) {
      matched = {
        page: item.page,
        y: item.y,
        items: [],
      };
      rows.push(matched);
    }

    matched.items.push(item);
  }

  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
  }

  return rows;
}

function rowText(row: Row): string {
  return clean(row.items.map((i) => i.text).join(" "));
}

function detectKubota(layout: PdfLayoutResult): boolean {
  const t = layout.plainText.toUpperCase();

  const hasVendor =
    t.includes("KUBOTA") &&
    (t.includes("TRACTOR") || t.includes("CORPORATION"));

  const hasTableSignals =
    t.includes("ORDERED PART") ||
    t.includes("SHIPPED PART") ||
    t.includes("DEALER NET") ||
    t.includes("EXT NET") ||
    t.includes("DEALER PO");

  return hasVendor && hasTableSignals;
}

function extractHeader(layout: PdfLayoutResult): Partial<InvoiceExtraction> {
  const text = layout.plainText;

  const invoiceNumber = firstMatch(
    text,
    /INVOICE\s+NO\s*:?\s*([A-Z0-9-]+)/i,
  );

  const invoiceDate = firstMatch(
    text,
    /INVOICE\s+DATE\s*:?\s*([0-9/]+)/i,
  );

  const poNumber = firstMatch(
    text,
    /DEALER\s+PO\s+NO\s*:?\s*([A-Z0-9-]+)/i,
  );

  const shipNo = firstMatch(
    text,
    /SHIP\s+NO\s*:?\s*([A-Z0-9-]+)/i,
  );

  const terms = firstMatch(
    text,
    /TERMS\s*:?\s*([A-Z0-9-]+)/i,
  );

  const totalGross = firstMatch(
    text,
    /TOTAL\s+GROSS\s+([0-9,]+\.[0-9]{2})/i,
  );

  const freight = firstMatch(
    text,
    /FREIGHT\s+CHARGES\s+([0-9,]+\.[0-9]{2})/i,
  );

  const total = firstMatch(
    text,
    /(?:^|\n)\s*TOTAL\s+([0-9,]+\.[0-9]{2})(?:\s|$)/im,
  );

  return {
    vendor: "Kubota Tractor Corporation",
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    po_number: poNumber,
    order_number: "",
    shipment_number: shipNo,
    terms,
    currency: "USD",
    subtotal: num(totalGross),
    freight_charge: num(freight),
    drop_ship_charge: 0,
    misc_charges: 0,
    total_invoice: num(total),
  };
}

function isNoiseRow(text: string): boolean {
  const t = text.toUpperCase();

  return (
    !t ||
    t.includes("KUBOTA TRACTOR CORPORATION") ||
    t.includes("KUBOTA CREDIT") ||
    t.includes("ORDERED PART NO") ||
    t.includes("SHIPPED PART NO") ||
    t.includes("ORD QTY") ||
    t.includes("SHIP QTY") ||
    t.includes("DEALER GROSS") ||
    t.includes("DEALER NET") ||
    t.includes("EXT GROSS") ||
    t.includes("EXT NET") ||
    t.includes("DEALER PO NO") ||
    t.includes("INVOICE DATE") ||
    t.includes("INVOICE NO") ||
    t.includes("SHIP NO") ||
    t.includes("ORDER TYPE") ||
    t.includes("DUE DATE") ||
    t.includes("DATE SHIPPED") ||
    t.includes("SHIPPED FROM") ||
    t.includes("TERMS") ||
    t.includes("TOTAL GROSS") ||
    t === "TOTAL" ||
    t.startsWith("FREIGHT CHARGES") ||
    t.startsWith("PAGE ")
  );
}

function parsePartRow(text: string, lineNumber: number): InvoiceLine | null {
  const normalized = clean(text);

  // Expected pattern:
  // ORDERED_PART SHIPPED_PART ORD_QTY SHIP_QTY DESCRIPTION DEALER_GROSS DISC DEALER_NET EXT_GROSS EXT_NET
  const match = normalized.match(
    /^(\S+)\s+(\S+)\s+([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)\s+(.+?)\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})$/i,
  );

  if (!match) return null;

  const orderedPart = match[1] || "";
  const shippedPart = match[2] || "";
  const shipQty = num(match[4]);
  const description = clean(match[5] || "");
  const dealerGross = num(match[6]);
  const disc = num(match[7]);
  const dealerNet = num(match[8]);
  const extNet = num(match[10]);

  return {
    line_number: lineNumber,
    line_type: "PART",
    part_number: shippedPart || orderedPart,
    description,
    origin: "",
    quantity: shipQty,
    unit_price: dealerGross,
    discount_percent: disc,
    net_unit_price: dealerNet,
    line_total: extNet,
  };
}

function parseLines(layout: PdfLayoutResult): {
  lines: InvoiceLine[];
  freightCharge: number;
} {
  const rows = groupRows(layout.items);
  const lines: InvoiceLine[] = [];
  let freightCharge = 0;
  let nextLineNumber = 1;
  let currentLine: InvoiceLine | null = null;

  for (const row of rows) {
    const text = rowText(row);
    if (!text) continue;

    const upper = text.toUpperCase();

    if (upper.startsWith("ADDITIONAL INFO")) {
      if (currentLine) {
        currentLine.origin = clean(
          text.replace(/^Additional Info\s*:?\s*/i, ""),
        );
      }
      continue;
    }

    if (upper.startsWith("FREIGHT CHARGES")) {
      const amount = num(
        clean(text.replace(/^Freight Charges/i, "")),
      );
      freightCharge = amount;
      currentLine = null;
      continue;
    }

    if (upper.startsWith("TOTAL GROSS") || upper === "TOTAL") {
      currentLine = null;
      continue;
    }

    if (isNoiseRow(text)) continue;

    const parsed = parsePartRow(text, nextLineNumber);
    if (parsed) {
      lines.push(parsed);
      currentLine = parsed;
      nextLineNumber += 1;
    }
  }

  return { lines, freightCharge };
}

export function parseKubotaInvoice(
  layout: PdfLayoutResult,
): InvoiceExtraction | null {
  if (!detectKubota(layout)) return null;

  const header = extractHeader(layout);
  const { lines, freightCharge } = parseLines(layout);

  const subtotal =
    Number(header.subtotal || 0) > 0
      ? Number(header.subtotal || 0)
      : lines.reduce((sum, line) => sum + Number(line.line_total || 0), 0);

  const finalFreight =
    Number(header.freight_charge || 0) > 0
      ? Number(header.freight_charge || 0)
      : freightCharge;

  const totalInvoice =
    Number(header.total_invoice || 0) > 0
      ? Number(header.total_invoice || 0)
      : subtotal + finalFreight;

  const finalLines = [...lines];

  if (finalFreight > 0) {
    finalLines.push({
      line_number: 9001,
      line_type: "FREIGHT",
      part_number: "",
      description: "Freight Charges",
      origin: "",
      quantity: 1,
      unit_price: finalFreight,
      discount_percent: 0,
      net_unit_price: finalFreight,
      line_total: finalFreight,
    });
  }

  return {
    vendor: String(header.vendor || "Kubota Tractor Corporation"),
    invoice_number: String(header.invoice_number || ""),
    invoice_date: String(header.invoice_date || ""),
    po_number: String(header.po_number || ""),
    order_number: String(header.order_number || ""),
    shipment_number: String(header.shipment_number || ""),
    terms: String(header.terms || ""),
    currency: "USD",
    subtotal,
    freight_charge: finalFreight,
    drop_ship_charge: 0,
    misc_charges: 0,
    total_invoice: totalInvoice,
    lines: finalLines,
  };
}