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
      matched = { page: item.page, y: item.y, items: [] };
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

function detectLandPride(layout: PdfLayoutResult): boolean {
  const text = layout.plainText.toUpperCase();
  return (
    text.includes("LAND PRIDE") &&
    text.includes("DIVISION OF GREAT PLAINS") &&
    text.includes("ACKNOWLEDGEMENT NO")
  );
}

function extractHeader(layout: PdfLayoutResult): Partial<InvoiceExtraction> {
  const text = layout.plainText;

  const invoiceNumber = firstMatch(text, /(?:^|\n)\s*(00\d{8,})\s*(?:\n|\s+111172\b)/m);
  const customerNo = firstMatch(text, /(?:^|\n)\s*(\d{5,})\s*(?:\n|\s+LPI\d+)/m);
  const poNumber = firstMatch(text, /(?:^|\n)\s*(\d+\/[A-Z])\s+(\d+-\d{2})\s+(\d{1,2}-\d{1,2}-\d{2})\s+(\d{1,2}-\d{1,2}-\d{2})/m) ||
    firstMatch(text, /(?:^|\n)\s*(\d+\/[A-Z])/m);

  const ackMatch = text.match(/(?:^|\n)\s*\d+\/[A-Z]\s+([0-9-]+)\s+(\d{1,2}-\d{1,2}-\d{2})\s+(\d{1,2}-\d{1,2}-\d{2})/m);
  const acknowledgementNo = ackMatch?.[1]?.trim() ?? "";
  const shipDate = ackMatch?.[2]?.trim() ?? "";
  const invoiceDate = ackMatch?.[3]?.trim() ?? "";

  const shipVia = firstMatch(text, /\bLPI\d+\s+(.+?)\s+GERMAN-BLISS EQUIP/is)
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");

  const terms = firstMatch(text, /TERMS\s+(.+?)\s+\*\s+DEALER NET/is);
  const dealerNet = firstMatch(text, /\*\s*DEALER NET\s+([0-9,]+\.[0-9]{2})/i);
  const totalInvoice = firstMatch(text, /INVOICE TOTAL\s+([0-9,]+\.[0-9]{2})/i);

  return {
    vendor: "Land Pride",
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate || shipDate,
    po_number: poNumber,
    order_number: acknowledgementNo,
    shipment_number: "",
    terms,
    currency: "USD",
    subtotal: num(dealerNet),
    freight_charge: 0,
    drop_ship_charge: 0,
    misc_charges: 0,
    total_invoice: num(totalInvoice),
  };
}

function isNoiseRow(text: string): boolean {
  const t = text.toUpperCase();
  return (
    !t ||
    t.includes("LAND PRIDE") ||
    t.includes("DIVISION OF GREAT PLAINS") ||
    t.includes("INVOICE") ||
    t.includes("REMIT TO") ||
    t.includes("CUSTOMER NO") ||
    t.includes("ACKNOWLEDGEMENT NO") ||
    t.includes("SHIP DATE") ||
    t.includes("INVOICE DATE") ||
    t.includes("SALESMAN / TERRITORY") ||
    t.includes("SHIP VIA") ||
    t.includes("ITEM NO. PART / MODEL NO.") ||
    t.includes("ORDERED BACK") ||
    t.includes("ORDERED SHIPPED LIST PRICE") ||
    t.includes("DEALER NET") ||
    t.includes("STANDARD TRADE DISCOUNT") ||
    t.includes("FREIGHT/HANDLING") ||
    t.includes("CASH DISCOUNTS") ||
    t.includes("PLEASE REMIT") ||
    t.startsWith("FAX ") ||
    t.startsWith("DEALER FAX") ||
    t === "- -"
  );
}

function parseItemRow(text: string, lineNumber: number): InvoiceLine | null {
  const normalized = clean(text);

  const match = normalized.match(
    /^(\S+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})$/,
  );

  if (!match) return null;

  const partNumber = match[1] || "";
  const description = clean(match[2] || "");
  const ordered = num(match[3]);
  const backOrdered = num(match[4]);
  const shipped = num(match[5]);
  const listPrice = num(match[6]);
  const extendedPrice = num(match[7]);
  const dealerNet = num(match[8]);

  if (!partNumber || !description || shipped <= 0) return null;

  const discountPercent = listPrice > 0
    ? Number((((listPrice - dealerNet) / listPrice) * 100).toFixed(2))
    : 0;

  return {
    line_number: lineNumber,
    line_type: "PART",
    part_number: partNumber,
    description: backOrdered > 0
      ? `${description} (Ordered ${ordered}, Backordered ${backOrdered})`
      : description,
    origin: "",
    quantity: shipped,
    unit_price: listPrice,
    discount_percent: discountPercent,
    net_unit_price: dealerNet,
    line_total: extendedPrice,
  };
}

function parseLines(layout: PdfLayoutResult): InvoiceLine[] {
  const rows = groupRows(layout.items.filter((i) => i.page === 1));
  const lines: InvoiceLine[] = [];
  let nextLineNumber = 1;

  for (const row of rows) {
    const text = rowText(row);
    if (isNoiseRow(text)) continue;

    const parsed = parseItemRow(text, nextLineNumber);
    if (parsed) {
      lines.push(parsed);
      nextLineNumber += 1;
    }
  }

  return lines;
}

export function parseLandPrideInvoice(
  layout: PdfLayoutResult,
): InvoiceExtraction | null {
  if (!detectLandPride(layout)) return null;

  const header = extractHeader(layout);
  const lines = parseLines(layout);

  const subtotal = Number(header.subtotal || 0) > 0
    ? Number(header.subtotal || 0)
    : lines.reduce((sum, line) => sum + Number(line.net_unit_price || 0) * Number(line.quantity || 0), 0);

  const totalInvoice = Number(header.total_invoice || 0) > 0
    ? Number(header.total_invoice || 0)
    : subtotal;

  return {
    vendor: String(header.vendor || "Land Pride"),
    invoice_number: String(header.invoice_number || ""),
    invoice_date: String(header.invoice_date || ""),
    po_number: String(header.po_number || ""),
    order_number: String(header.order_number || ""),
    shipment_number: String(header.shipment_number || ""),
    terms: String(header.terms || ""),
    currency: "USD",
    subtotal,
    freight_charge: 0,
    drop_ship_charge: 0,
    misc_charges: 0,
    total_invoice: totalInvoice,
    lines,
  };
}
