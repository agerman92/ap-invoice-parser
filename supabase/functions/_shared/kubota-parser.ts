import type { InvoiceExtraction, InvoiceLine } from "./invoice-schema.ts";
import type { PdfLayoutResult } from "./pdf-layout.ts";

function clean(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function num(v: string) {
  if (!v) return 0;
  const n = Number(v.replace(/,/g, "").replace(/\$/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function match(text: string, r: RegExp) {
  const m = text.match(r);
  return m?.[1]?.trim() ?? "";
}

function detectKubota(layout: PdfLayoutResult) {
  const t = layout.plainText.toUpperCase();

  const vendorMatch = t.includes("KUBOTA TRACTOR");
  const tableMatch =
    t.includes("ORDERED PART") ||
    t.includes("DEALER NET") ||
    t.includes("EXT NET");

  return vendorMatch && tableMatch;
}

function extractHeader(layout: PdfLayoutResult) {
  const text = layout.plainText;

  const invoiceNumber = match(text, /INVOICE\s+NO\s*:\s*([0-9]+)/i);
  const invoiceDate = match(text, /INVOICE\s+DATE\s*:\s*([0-9/]+)/i);
  const poNumber = match(text, /DEALER\s+PO\s+NO\s*:\s*([A-Z0-9-]+)/i);
  const shipNo = match(text, /SHIP\s+NO\s*:\s*([A-Z0-9-]+)/i);
  const terms = match(text, /TERMS\s*:\s*([A-Z0-9]+)/i);

  const gross = match(text, /TOTAL\s+GROSS\s+([0-9,]+\.[0-9]{2})/i);
  const freight = match(text, /FREIGHT\s+CHARGES\s+([0-9,]+\.[0-9]{2})/i);
  const total = match(text, /\nTOTAL\s+([0-9,]+\.[0-9]{2})/i);

  return {
    vendor: "Kubota Tractor Corporation",
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    po_number: poNumber,
    shipment_number: shipNo,
    terms,
    subtotal: num(gross),
    freight_charge: num(freight),
    total_invoice: num(total),
  };
}

function parseLines(layout: PdfLayoutResult) {
  const lines: InvoiceLine[] = [];

  const rows = layout.plainText.split("\n");

  let lineNumber = 1;
  let lastLine: InvoiceLine | null = null;

  for (const raw of rows) {
    const text = clean(raw);

    if (!text) continue;

    if (text.startsWith("Additional Info")) {
      if (lastLine) {
        lastLine.origin = text.replace("Additional Info:", "").trim();
      }
      continue;
    }

    const tokens = text.split(" ");

    if (tokens.length < 8) continue;

    const partNo = tokens[1];

    if (!/[A-Z0-9]/.test(partNo)) continue;

    const qty = num(tokens[3]);
    const gross = num(tokens[tokens.length - 5]);
    const disc = num(tokens[tokens.length - 4]);
    const net = num(tokens[tokens.length - 3]);
    const extNet = num(tokens[tokens.length - 1]);

    const description = tokens.slice(4, tokens.length - 5).join(" ");

    const line: InvoiceLine = {
      line_number: lineNumber++,
      line_type: "PART",
      part_number: partNo,
      description,
      origin: "",
      quantity: qty,
      unit_price: gross,
      discount_percent: disc,
      net_unit_price: net,
      line_total: extNet,
    };

    lines.push(line);
    lastLine = line;
  }

  return lines;
}

export function parseKubotaInvoice(
  layout: PdfLayoutResult,
): InvoiceExtraction | null {
  if (!detectKubota(layout)) return null;

  const header = extractHeader(layout);
  const lines = parseLines(layout);

  const subtotal =
    header.subtotal ||
    lines.reduce((s, l) => s + Number(l.line_total || 0), 0);

  const total =
    header.total_invoice ||
    subtotal + Number(header.freight_charge || 0);

  return {
    vendor: header.vendor,
    invoice_number: header.invoice_number,
    invoice_date: header.invoice_date,
    po_number: header.po_number,
    order_number: "",
    shipment_number: header.shipment_number,
    terms: header.terms,
    currency: "USD",
    subtotal,
    freight_charge: header.freight_charge,
    drop_ship_charge: 0,
    misc_charges: 0,
    total_invoice: total,
    lines,
  };
}