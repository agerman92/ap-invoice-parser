import type { InvoiceExtraction, InvoiceLine } from "./invoice-schema.ts";
import type { PdfLayoutResult, PdfTextItem } from "./pdf-layout.ts";

type Row = {
  page: number;
  y: number;
  items: PdfTextItem[];
};

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toNumber(value: string): number {
  if (!value) return 0;
  const normalized = value.replace(/,/g, "").replace(/\$/g, "").trim();
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function firstMatch(text: string, regex: RegExp): string {
  const match = text.match(regex);
  return match?.[1]?.trim() ?? "";
}

function detectManitou(layout: PdfLayoutResult): boolean {
  const text = layout.plainText.toUpperCase();
  return (
    text.includes("MANITOU NORTH AMERICA") &&
    text.includes("UNIT PRICE") &&
    text.includes("PRICE TOTAL")
  );
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
  return cleanText(row.items.map((i) => i.text).join(" "));
}

function isNoiseRow(text: string): boolean {
  const t = text.toUpperCase();
  return (
    !t ||
    t.includes("MANITOU NORTH AMERICA") ||
    t.includes("INVOICE") ||
    t.includes("ORIGINAL") ||
    t.includes("LINE PART NUMBER DESCRIPTION") ||
    t.includes("SALES QTY") ||
    t.includes("UNIT PRICE") ||
    t.includes("NET PRICE") ||
    t.includes("PRICE TOTAL") ||
    t.includes("ALL CLAIMS AGAINST THIS INVOICE") ||
    t.includes("REMIT PAYMENT TO") ||
    t.includes("TERMS OF PAYMENT") ||
    t.includes("SHIP VIA") ||
    t.includes("FORWARD AGENT")
  );
}

function extractHeader(layout: PdfLayoutResult): Partial<InvoiceExtraction> {
  const text = layout.plainText;

  const invoiceNumber = firstMatch(text, /INVOICE\s+([0-9]+)/i);
  const invoiceDate = firstMatch(text, /Date:\s*([0-9/]+)/i);
  const shipmentNumber = firstMatch(text, /\*\*SHIPMENT\s*:\s*([0-9]+)\s*\*\*/i);
  const orderNumber = firstMatch(text, /Order Number\s*:\s*([A-Z0-9-]+)/i);
  const poNumber = firstMatch(text, /PO Number\s*:\s*([A-Z0-9-]+)/i);
  const terms = firstMatch(text, /Terms of payment\s*:\s*([A-Za-z0-9 ]+)/i);

  const totals = text.match(
    /Subtotal\s+Total Invoice Amount to\s+pay.*?([0-9,]+\.[0-9]{2})\s+USD\s+([0-9,]+\.[0-9]{2})/is,
  );

  const subtotal = totals ? toNumber(totals[1]) : 0;
  const totalInvoice = totals ? toNumber(totals[2]) : 0;

  return {
    vendor: "MANITOU NORTH AMERICA, LLC",
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    shipment_number: shipmentNumber,
    order_number: orderNumber,
    po_number: poNumber,
    terms,
    currency: "USD",
    subtotal,
    total_invoice: totalInvoice,
  };
}

function parseSpecialCharge(text: string): InvoiceLine | null {
  const upper = text.toUpperCase();

  if (upper.startsWith("DROP SHIPMENT")) {
    const amount = toNumber(upper.replace("DROP SHIPMENT", "").trim());
    return {
      line_number: 9001,
      line_type: "DROP_SHIPMENT",
      part_number: "",
      description: "DROP SHIPMENT",
      origin: "",
      quantity: 1,
      unit_price: amount,
      discount_percent: 0,
      net_unit_price: amount,
      line_total: amount,
    };
  }

  if (upper.startsWith("FREIGHT CHARGE")) {
    const amount = toNumber(upper.replace("FREIGHT CHARGE", "").trim());
    return {
      line_number: 9002,
      line_type: "FREIGHT",
      part_number: "",
      description: "FREIGHT CHARGE",
      origin: "",
      quantity: 1,
      unit_price: amount,
      discount_percent: 0,
      net_unit_price: amount,
      line_total: amount,
    };
  }

  return null;
}

/**
 * Parse a true item row by reading the stable numeric tokens from right to left.
 *
 * Example:
 * 1 L500804 SEAL RING 2 41.62 24 % 31.63 63.26
 *
 * tokens become:
 * [1, L500804, SEAL, RING, 2, 41.62, 24, %, 31.63, 63.26]
 */
function parseItemRow(text: string): InvoiceLine | null {
  const tokens = cleanText(text).split(" ");
  if (tokens.length < 9) return null;

  const lineNumber = Math.trunc(toNumber(tokens[0]));
  const partNumber = tokens[1] || "";

  if (!lineNumber || !partNumber) return null;

  const lineTotal = toNumber(tokens[tokens.length - 1]);
  const netUnitPrice = toNumber(tokens[tokens.length - 2]);

  let discountPercent = 0;
  let unitPrice = 0;
  let quantity = 0;
  let descEndIndex = tokens.length - 2;

  // Handle "... 24 % 31.63 63.26"
  if (tokens[tokens.length - 3] === "%") {
    discountPercent = toNumber(tokens[tokens.length - 4]);
    unitPrice = toNumber(tokens[tokens.length - 5]);
    quantity = toNumber(tokens[tokens.length - 6]);
    descEndIndex = tokens.length - 6;
  } else {
    // fallback if % sign not broken out
    discountPercent = toNumber(tokens[tokens.length - 3].replace("%", ""));
    unitPrice = toNumber(tokens[tokens.length - 4]);
    quantity = toNumber(tokens[tokens.length - 5]);
    descEndIndex = tokens.length - 5;
  }

  const description = cleanText(tokens.slice(2, descEndIndex).join(" "));

  return {
    line_number: lineNumber,
    line_type: "PART",
    part_number: partNumber,
    description,
    origin: "",
    quantity,
    unit_price: unitPrice,
    discount_percent: discountPercent,
    net_unit_price: netUnitPrice,
    line_total: lineTotal,
  };
}

function parseLines(layout: PdfLayoutResult): {
  lines: InvoiceLine[];
  freightCharge: number;
  dropShipCharge: number;
} {
  const rows = groupRows(layout.items.filter((i) => i.page <= 2));

  const lines: InvoiceLine[] = [];
  let currentLine: InvoiceLine | null = null;
  let freightCharge = 0;
  let dropShipCharge = 0;

  for (const row of rows) {
    const text = rowText(row);
    if (isNoiseRow(text)) continue;

    const originMatch = text.match(/^Origin\s*:\s*([A-Z]{2})$/i);
    if (originMatch && currentLine) {
      currentLine.origin = originMatch[1].toUpperCase();
      continue;
    }

    const special = parseSpecialCharge(text);
    if (special) {
      lines.push(special);
      if (special.line_type === "FREIGHT") freightCharge = special.line_total;
      if (special.line_type === "DROP_SHIPMENT") dropShipCharge = special.line_total;
      currentLine = null;
      continue;
    }

    const parsed = parseItemRow(text);
    if (parsed) {
      lines.push(parsed);
      currentLine = parsed;
    }
  }

  return { lines, freightCharge, dropShipCharge };
}

export function parseManitouInvoice(layout: PdfLayoutResult): InvoiceExtraction | null {
  if (!detectManitou(layout)) return null;

  const header = extractHeader(layout);
  const { lines, freightCharge, dropShipCharge } = parseLines(layout);

  const subtotal =
    header.subtotal && header.subtotal > 0
      ? header.subtotal
      : lines
          .filter((l) => l.line_type === "PART")
          .reduce((sum, l) => sum + Number(l.line_total || 0), 0);

  const totalInvoice =
    header.total_invoice && header.total_invoice > 0
      ? header.total_invoice
      : subtotal + freightCharge + dropShipCharge;

  return {
    vendor: header.vendor || "",
    invoice_number: header.invoice_number || "",
    invoice_date: header.invoice_date || "",
    po_number: header.po_number || "",
    order_number: header.order_number || "",
    shipment_number: header.shipment_number || "",
    terms: header.terms || "",
    currency: "USD",
    subtotal,
    freight_charge: freightCharge,
    drop_ship_charge: dropShipCharge,
    misc_charges: 0,
    total_invoice: totalInvoice,
    lines,
  };
}