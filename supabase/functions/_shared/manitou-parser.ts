import type { InvoiceExtraction, InvoiceLine } from "./invoice-schema.ts";
import type { PdfLayoutResult, PdfTextItem } from "./pdf-layout.ts";

type Row = {
  page: number;
  y: number;
  items: PdfTextItem[];
};

const X = {
  line: [0, 60],
  part: [60, 150],
  description: [150, 490],
  qty: [490, 535],
  unitPrice: [535, 590],
  discount: [590, 645],
  netPrice: [645, 700],
  total: [700, 780],
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

function sameRow(a: PdfTextItem, b: PdfTextItem): boolean {
  return a.page === b.page && Math.abs(a.y - b.y) <= 3;
}

function groupRows(items: PdfTextItem[]): Row[] {
  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(b.y - a.y) > 2) return b.y - a.y;
    return a.x - b.x;
  });

  const rows: Row[] = [];

  for (const item of sorted) {
    const existing = rows.find((r) => sameRow(item, { ...item, y: r.y } as PdfTextItem) && r.page === item.page);
    if (existing) {
      existing.items.push(item);
    } else {
      rows.push({
        page: item.page,
        y: item.y,
        items: [item],
      });
    }
  }

  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
  }

  return rows;
}

function textInRange(row: Row, minX: number, maxX: number): string {
  return cleanText(
    row.items
      .filter((i) => i.x >= minX && i.x < maxX)
      .map((i) => i.text)
      .join(" ")
  );
}

function firstMatch(text: string, regex: RegExp): string {
  const match = text.match(regex);
  return match?.[1]?.trim() ?? "";
}

function detectManitou(layout: PdfLayoutResult): boolean {
  const text = layout.plainText.toUpperCase();
  return (
    text.includes("MANITOU NORTH AMERICA") &&
    text.includes("SALES") &&
    text.includes("UNIT PRICE") &&
    text.includes("PRICE TOTAL")
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

  // Page 3 totals
  const subtotalMatch = text.match(/Subtotal\s+Total Invoice Amount to\s+pay.*?\n?([0-9,]+\.[0-9]{2})\s+USD\s+([0-9,]+\.[0-9]{2})/is);
  const subtotal = subtotalMatch ? toNumber(subtotalMatch[1]) : 0;
  const totalInvoice = subtotalMatch ? toNumber(subtotalMatch[2]) : 0;

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

function isHeaderOrNoise(rowText: string): boolean {
  const t = rowText.toUpperCase();
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
    t.includes("ORDER NUMBER") ||
    t.includes("PO NUMBER") ||
    t.includes("ALL CLAIMS AGAINST THIS INVOICE") ||
    t.includes("REMIT PAYMENT TO")
  );
}

function parseSpecialCharge(rowText: string, nextNumberCandidate = ""): InvoiceLine | null {
  const upper = rowText.toUpperCase();
  if (upper.includes("DROP SHIPMENT")) {
    const amount = toNumber(nextNumberCandidate || upper.replace(/.*DROP SHIPMENT/i, "").trim());
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

  if (upper.includes("FREIGHT CHARGE")) {
    const amount = toNumber(nextNumberCandidate || upper.replace(/.*FREIGHT CHARGE/i, "").trim());
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

function parseLines(layout: PdfLayoutResult): {
  lines: InvoiceLine[];
  freightCharge: number;
  dropShipCharge: number;
} {
  const page12Items = layout.items.filter((i) => i.page <= 2);
  const rows = groupRows(page12Items);

  const lines: InvoiceLine[] = [];
  let currentLine: InvoiceLine | null = null;
  let freightCharge = 0;
  let dropShipCharge = 0;

  for (const row of rows) {
    const rowText = cleanText(row.items.map((i) => i.text).join(" "));
    if (isHeaderOrNoise(rowText)) continue;

    // Continuation origin row
    const originMatch = rowText.match(/^Origin\s*:\s*([A-Z]{2})$/i);
    if (originMatch && currentLine) {
      currentLine.origin = originMatch[1].toUpperCase();
      continue;
    }

    // Special charges at page bottom
    if (rowText.toUpperCase().startsWith("DROP SHIPMENT")) {
      const amount = toNumber(textInRange(row, X.total[0], X.total[1]) || rowText.replace(/DROP SHIPMENT/i, ""));
      const charge = parseSpecialCharge("DROP SHIPMENT", String(amount));
      if (charge) {
        dropShipCharge = charge.line_total;
        lines.push(charge);
      }
      currentLine = null;
      continue;
    }

    if (rowText.toUpperCase().startsWith("FREIGHT CHARGE")) {
      const amount = toNumber(textInRange(row, X.total[0], X.total[1]) || rowText.replace(/FREIGHT CHARGE/i, ""));
      const charge = parseSpecialCharge("FREIGHT CHARGE", String(amount));
      if (charge) {
        freightCharge = charge.line_total;
        lines.push(charge);
      }
      currentLine = null;
      continue;
    }

    const lineNumberText = textInRange(row, X.line[0], X.line[1]);
    const partNumber = textInRange(row, X.part[0], X.part[1]);
    const description = textInRange(row, X.description[0], X.description[1]);
    const qtyText = textInRange(row, X.qty[0], X.qty[1]);
    const unitPriceText = textInRange(row, X.unitPrice[0], X.unitPrice[1]);
    const discountText = textInRange(row, X.discount[0], X.discount[1]).replace("%", "");
    const netPriceText = textInRange(row, X.netPrice[0], X.netPrice[1]);
    const totalText = textInRange(row, X.total[0], X.total[1]);

    const lineNumber = Math.trunc(toNumber(lineNumberText));

    // Ignore rows that are not real line rows
    if (!lineNumber || !partNumber) continue;

    const line: InvoiceLine = {
      line_number: lineNumber,
      line_type: "PART",
      part_number: partNumber,
      description,
      origin: "",
      quantity: toNumber(qtyText),
      unit_price: toNumber(unitPriceText),
      discount_percent: toNumber(discountText),
      net_unit_price: toNumber(netPriceText),
      line_total: toNumber(totalText),
    };

    lines.push(line);
    currentLine = line;
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