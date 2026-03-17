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

function detectBushHog(layout: PdfLayoutResult): boolean {
  const text = layout.plainText.toUpperCase();
  return (
    text.includes("BUSH HOG") &&
    text.includes("ALAMO GROUP AG AMERICAS LLC") &&
    text.includes("FREIGHT & HANDLING")
  );
}

function extractHeader(layout: PdfLayoutResult): Partial<InvoiceExtraction> {
  const text = layout.plainText;

  const invoiceNumber = firstMatch(text, /(?:^|\n)\s*(\d{7,})\s+\d{6}\s*(?:\n|\s+16-MAR-26)/m) ||
    firstMatch(text, /INVOICE NO\s+(\d{7,})/i);
  const poNumber = firstMatch(text, /INVOICE NO\s+\d{7,}\s+(\d+)/i) ||
    firstMatch(text, /CUSTOMER PO\s+(\d+)/i);
  const invoiceDate = firstMatch(text, /INVOICE DATE\s*(?:\n|\s)+([0-9/\-A-Z]+)/i);
  const orderNumber = firstMatch(text, /SALES ORDER\s*(?:\n|\s)+([0-9A-Z- ]+)/i)
    .replace(/\s+/g, " ");
  const terms = firstMatch(text, /PAYMENT TERMS\s*(?:\n|\s)+(.+?)\s+(?:\d{5}\s+\d{7,}|SOLD TO:)/is);
  const subtotal = firstMatch(text, /SUB-TOTAL\s+([0-9,]+\.[0-9]{2})/i);
  const freight = firstMatch(text, /FREIGHT & HANDLING\s+([0-9,]+\.[0-9]{2})/i);
  const salesTax = firstMatch(text, /SALES TAX\s+([0-9,]+\.[0-9]{2})/i);
  const total = firstMatch(text, /TOTAL \(USD\)\s+([0-9,]+\.[0-9]{2})/i);

  return {
    vendor: "Bush Hog",
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    po_number: poNumber,
    order_number: orderNumber,
    shipment_number: "",
    terms,
    currency: "USD",
    subtotal: num(subtotal),
    freight_charge: num(freight),
    drop_ship_charge: 0,
    misc_charges: num(salesTax),
    total_invoice: num(total),
  };
}

function isNoiseRow(text: string): boolean {
  const t = text.toUpperCase();
  return (
    !t ||
    t.includes("BUSH HOG") ||
    t.includes("ALAMO GROUP AG AMERICAS") ||
    t.includes("ORIGINAL INVOICE") ||
    t.includes("PLEASE DETACH AND RETURN") ||
    t.includes("MAKE CHECK PAYABLE") ||
    t.includes("THANKS FOR YOUR ORDER") ||
    t.includes("IMPORTANT:") ||
    t.includes("CUSTOMER NO") ||
    t.includes("INVOICE NO") ||
    t.includes("INVOICE DATE") ||
    t.includes("SALES ORDER") ||
    t.includes("ORDER DATE") ||
    t.includes("PAYMENT TERMS") ||
    t.includes("REQUESTED SHIP DATE") ||
    t.includes("ITEM NUMBER BRANCH DESCRIPTION") ||
    t.includes("PICKSLIP #") ||
    t.includes("QUANTITY SHPPED") ||
    t.includes("FREIGHT TERMS") ||
    t.includes("DELIVERY & INSTRUCTIONS") ||
    t.startsWith("NET DUE") ||
    t.startsWith("CASH DISC.") ||
    t.startsWith("IF PAID BY") ||
    t.startsWith("SUB-TOTAL") ||
    t.startsWith("FREIGHT & HANDLING") ||
    t.startsWith("SALES TAX") ||
    t.startsWith("TOTAL (USD)") ||
    t.startsWith("PAY ONLINE")
  );
}

function parsePartRow(text: string, lineNumber: number): InvoiceLine | null {
  const normalized = clean(text);

  const match = normalized.match(
    /^(\d+)\s+(\d+)\s+(.+?)\s+(\d+)\s+([0-9,]+\.[0-9]{2})\s+(-?[0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})$/,
  );

  if (!match) return null;

  const partNumber = match[1] || "";
  const branch = match[2] || "";
  const description = clean(match[3] || "");
  const quantity = num(match[4]);
  const listPrice = num(match[5]);
  const discPercent = Math.abs(num(match[6]));
  const lineTotal = num(match[7]);
  const netUnitPrice = quantity > 0 ? Number((lineTotal / quantity).toFixed(2)) : 0;

  return {
    line_number: lineNumber,
    line_type: "PART",
    part_number: partNumber,
    description,
    origin: branch,
    quantity,
    unit_price: listPrice,
    discount_percent: discPercent,
    net_unit_price: netUnitPrice,
    line_total: lineTotal,
  };
}

function parseFreightRow(text: string): InvoiceLine | null {
  const normalized = clean(text);
  const match = normalized.match(/^(\d+)\s+(1Z[0-9A-Z]+)\s+([0-9,]+\.[0-9]{2})$/i);
  if (!match) return null;

  const branch = match[1] || "";
  const tracking = match[2] || "";
  const amount = num(match[3]);

  return {
    line_number: 9001,
    line_type: "FREIGHT",
    part_number: tracking,
    description: "Freight & Handling",
    origin: branch,
    quantity: 1,
    unit_price: amount,
    discount_percent: 0,
    net_unit_price: amount,
    line_total: amount,
  };
}

function parseLines(layout: PdfLayoutResult): InvoiceLine[] {
  const rows = groupRows(layout.items.filter((i) => i.page === 1));
  const lines: InvoiceLine[] = [];
  let nextLineNumber = 1;
  let currentLine: InvoiceLine | null = null;

  for (const row of rows) {
    const text = rowText(row);
    if (isNoiseRow(text)) continue;

    const freight = parseFreightRow(text);
    if (freight) {
      lines.push(freight);
      currentLine = null;
      continue;
    }

    const part = parsePartRow(text, nextLineNumber);
    if (part) {
      lines.push(part);
      currentLine = part;
      nextLineNumber += 1;
      continue;
    }

    if (currentLine) {
      if (/^HS Code:/i.test(text)) {
        currentLine.description = clean(`${currentLine.description} ${text}`);
        continue;
      }

      const cooMatch = text.match(/^COO:\s*([A-Z]{2})$/i);
      if (cooMatch) {
        currentLine.origin = cooMatch[1].toUpperCase();
      }
    }
  }

  return lines;
}

export function parseBushHogInvoice(
  layout: PdfLayoutResult,
): InvoiceExtraction | null {
  if (!detectBushHog(layout)) return null;

  const header = extractHeader(layout);
  const lines = parseLines(layout);

  const freightLine = lines.find((line) => line.line_type === "FREIGHT");
  const partSubtotal = lines
    .filter((line) => line.line_type === "PART")
    .reduce((sum, line) => sum + Number(line.line_total || 0), 0);

  const subtotal = Number(header.subtotal || 0) > 0
    ? Number(header.subtotal || 0)
    : partSubtotal;

  const freightCharge = Number(header.freight_charge || 0) > 0
    ? Number(header.freight_charge || 0)
    : Number(freightLine?.line_total || 0);

  const miscCharges = Number(header.misc_charges || 0);

  const totalInvoice = Number(header.total_invoice || 0) > 0
    ? Number(header.total_invoice || 0)
    : subtotal + freightCharge + miscCharges;

  return {
    vendor: String(header.vendor || "Bush Hog"),
    invoice_number: String(header.invoice_number || ""),
    invoice_date: String(header.invoice_date || ""),
    po_number: String(header.po_number || ""),
    order_number: String(header.order_number || ""),
    shipment_number: String(header.shipment_number || ""),
    terms: String(header.terms || ""),
    currency: "USD",
    subtotal,
    freight_charge: freightCharge,
    drop_ship_charge: 0,
    misc_charges: miscCharges,
    total_invoice: totalInvoice,
    lines,
  };
}
