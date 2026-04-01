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

function detectWoods(layout: PdfLayoutResult): boolean {
  const text = layout.plainText.toUpperCase();
  return (
    text.includes("WOODS EQUIPMENT") &&
    text.includes("INVOICE DETAILS") &&
    text.includes("PACKING LIST NO")
  );
}

function extractHeader(layout: PdfLayoutResult): Partial<InvoiceExtraction> {
  const text = layout.plainText;

  const invoiceNumber = firstMatch(text, /Invoice No:\s*([0-9]+)/i);
  const invoiceDate = firstMatch(text, /Billing Date:\s*([0-9/]+)/i);
  const poNumber = firstMatch(text, /P\.O\.No:\s*([^\n]+)/i);
  const packingListNo = firstMatch(text, /Packing List No:\s*([0-9]+)/i);
  const shipmentNumber = firstMatch(text, /Shipment Number:\s*([0-9]+)/i);
  const orderNumber = firstMatch(text, /Sales Order No:\s*([0-9]+)/i);
  const terms = firstMatch(text, /Payment Terms:\s*([^\n]+)/i);
  const subtotal = firstMatch(text, /Total Product Value\s+([0-9,]+\.[0-9]{2})/i);
  const freight = firstMatch(text, /Inland Frt\/Ship&Hndl\s+([0-9,]+\.[0-9]{2})/i);
  const total = firstMatch(text, /Total Amount\s+([0-9,]+\.[0-9]{2})/i);

  return {
    vendor: "Woods Equipment",
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    po_number: poNumber,
    order_number: orderNumber || packingListNo,
    shipment_number: shipmentNumber,
    terms,
    currency: "USD",
    subtotal: num(subtotal),
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
    t.includes("WOODS EQUIPMENT") ||
    t.includes("INVOICE") ||
    t.includes("INVOICE DETAILS") ||
    t.includes("BILL-TO ADDRESS") ||
    t.includes("SHIP-TO ADDRESS") ||
    t.includes("REMIT-TO ADDRESS") ||
    t.includes("INFORMATION") ||
    t.includes("BILLING DATE") ||
    t.includes("PAYMENT TERMS") ||
    t.includes("PACKING LIST NO") ||
    t.includes("SHIPMENT NUMBER") ||
    t.includes("SALES ORDER NO") ||
    t.includes("FORWARDING AGENT") ||
    t.includes("ITEM MATERIAL DESCRIPTION") ||
    t.includes("QUANTITY SHIPPED OPEN QUANTITY") ||
    t.includes("WE WILL NEVER ASK YOU TO CHANGE REMITTANCE INFORMATION") ||
    t.includes("THIS INVOICE IS DUE WHEN SOLD") ||
    t.startsWith("TOTAL PRODUCT VALUE") ||
    t.startsWith("INLAND FRT/SHIP&HNDL") ||
    t.startsWith("TOTAL AMOUNT") ||
    t.startsWith("--------------------") ||
    t.startsWith("PAGE:")
  );
}

// ── Full single-row match (all 7 fields on one line) ─────────────────────────
function parseItemRow(text: string, lineNumber: number): InvoiceLine | null {
  const normalized = clean(text);

  const match = normalized.match(
    /^(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)EA\s+(\d+(?:\.\d+)?)\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})$/i,
  );

  if (!match) return null;

  const itemNo    = num(match[1]);
  const partNumber = match[2] || "";
  const quantity  = num(match[3]);
  const openQty   = num(match[4]);
  const listPrice = num(match[5]);
  const netPrice  = num(match[6]);
  const amount    = num(match[7]);

  if (!partNumber || quantity <= 0) return null;

  return {
    line_number:      itemNo || lineNumber,
    line_type:        "PART",
    part_number:      partNumber,
    description:      openQty > 0 ? `(Open Qty ${openQty})` : "",
    origin:           "",
    quantity,
    unit_price:       listPrice,
    discount_percent: listPrice > 0
      ? Number((((listPrice - netPrice) / listPrice) * 100).toFixed(2))
      : 0,
    net_unit_price: netPrice,
    line_total:     amount,
  };
}

// ── Partial row: item# partno qtyEA openqty listprice (no net/amount yet) ────
// Woods PDFs stack List Price above Net Price in the same column, so they often
// land at different y-coordinates and appear as separate PDF rows.
type PartialItemRow = {
  itemNo:      number;
  partNumber:  string;
  quantity:    number;
  openQty:     number;
  listPrice:   number;
  pendingDesc: string;
};

function parsePartialItemRow(text: string): PartialItemRow | null {
  const normalized = clean(text);

  // Must have exactly 5 tokens: item# partno qtyEA openqty listprice
  const match = normalized.match(
    /^(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)EA\s+(\d+(?:\.\d+)?)\s+([0-9,]+\.[0-9]{2})$/i,
  );
  if (!match) return null;

  const partNumber = match[2] || "";
  const quantity   = num(match[3]);
  if (!partNumber || quantity <= 0) return null;

  return {
    itemNo:    num(match[1]),
    partNumber,
    quantity,
    openQty:   num(match[4]),
    listPrice: num(match[5]),
  };
}

// ── Completion row: netPrice amount (the lower stacked price row) ─────────────
function parseNetAmountRow(text: string): { netPrice: number; amount: number } | null {
  const normalized = clean(text);
  // Two prices: net_unit_price  line_total
  const match = normalized.match(
    /^([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})$/,
  );
  if (!match) return null;
  return { netPrice: num(match[1]), amount: num(match[2]) };
}

function parseLines(layout: PdfLayoutResult): InvoiceLine[] {
  const rows = groupRows(layout.items);
  const lines: InvoiceLine[] = [];
  let currentLine: InvoiceLine | null = null;
  let pendingPartial: PartialItemRow | null = null;
  let fallbackLineNumber = 1;

  for (const row of rows) {
    const text = rowText(row);
    if (isNoiseRow(text)) continue;

    // ── Try full single-row match first ──────────────────────────────────────
    const parsed = parseItemRow(text, fallbackLineNumber);
    if (parsed) {
      lines.push(parsed);
      currentLine  = parsed;
      pendingPartial = null;
      fallbackLineNumber += 10;
      continue;
    }

    // ── Net+amount completion row — completes a pending partial ───────────────
    const netAmount = parseNetAmountRow(text);
    if (netAmount && pendingPartial) {
      const { netPrice, amount } = netAmount;
      const p = pendingPartial;
      const line: InvoiceLine = {
        line_number:      p.itemNo || fallbackLineNumber,
        line_type:        "PART",
        part_number:      p.partNumber,
        description:      p.pendingDesc || (p.openQty > 0 ? `(Open Qty ${p.openQty})` : ""),
        origin:           "",
        quantity:         p.quantity,
        unit_price:       p.listPrice,
        discount_percent: p.listPrice > 0
          ? Number((((p.listPrice - netPrice) / p.listPrice) * 100).toFixed(2))
          : 0,
        net_unit_price: netPrice,
        line_total:     amount,
      };
      lines.push(line);
      currentLine    = line;
      pendingPartial = null;
      fallbackLineNumber += 10;
      continue;
    }

// ── Partial item row — buffer it, wait for net+amount ────────────────────
    const partial = parsePartialItemRow(text);
    if (partial) {
      pendingPartial = { ...partial, pendingDesc: "" };
      currentLine    = null;
      continue;
    }

    // ── Description / continuation row ───────────────────────────────────────
    const isPrice     = /^[0-9,]+\.[0-9]{2}$/.test(text);
    const startsDigit = /^\d/.test(text);
    const isAddress   = text.toUpperCase().includes("USA");

    if (!isPrice && !startsDigit && !isAddress) {
      if (currentLine) {
        currentLine.description = currentLine.description
          ? clean(`${currentLine.description} ${text}`)
          : text;
      } else if (pendingPartial) {
        // Description arrived before the net+amount row — store it on the pending buffer
        pendingPartial.pendingDesc = pendingPartial.pendingDesc
          ? clean(`${pendingPartial.pendingDesc} ${text}`)
          : text;
      }
    }
  }

  return lines.map((line) => ({
    ...line,
    description: clean(line.description || ""),
  }));
}

export function parseWoodsInvoice(
  layout: PdfLayoutResult,
): InvoiceExtraction | null {
  if (!detectWoods(layout)) return null;

  const header = extractHeader(layout);
  const lines = parseLines(layout);

  const subtotal = Number(header.subtotal || 0) > 0
    ? Number(header.subtotal || 0)
    : lines.reduce((sum, line) => sum + Number(line.line_total || 0), 0);

  const freightCharge = Number(header.freight_charge || 0);
  const totalInvoice = Number(header.total_invoice || 0) > 0
    ? Number(header.total_invoice || 0)
    : subtotal + freightCharge;

  return {
    vendor: String(header.vendor || "Woods Equipment"),
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
    misc_charges: 0,
    total_invoice: totalInvoice,
    lines,
  };
}
