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
  // Handle trailing minus (Kubota formats discounts as "13.69-")
  const normalized = value.replace(/,/g, "").replace(/\$/g, "").trim();
  const trailingMinus = normalized.endsWith("-");
  const cleaned = trailingMinus ? normalized.slice(0, -1) : normalized;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  return trailingMinus ? -n : n;
}

// Kubota's discount column is a DOLLAR amount, not a percentage.
// Derive the equivalent percentage from gross and net prices for schema consistency.
function deriveDiscountPercent(grossPrice: number, netPrice: number): number {
  if (grossPrice <= 0 || netPrice >= grossPrice) return 0;
  return Math.round((1 - netPrice / grossPrice) * 10000) / 100;
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
  const plain = layout.plainText.toUpperCase();
  const itemText = layout.items.map((i) => i.text.toUpperCase()).join(" ");
  const rows = groupRows(layout.items);
  const topRowsText = rows
    .filter((r) => r.page === 1)
    .slice(0, 40)
    .map((r) => rowText(r).toUpperCase())
    .join(" ");

  const combined = `${plain} ${itemText} ${topRowsText}`;

  const hasKubota = combined.includes("KUBOTA");
  const hasTractorOrCorp =
    combined.includes("TRACTOR") || combined.includes("CORPORATION");

  const hasTableSignals =
    combined.includes("ORDERED PART") ||
    combined.includes("ORDERED PART NO") ||
    combined.includes("SHIPPED PART") ||
    combined.includes("SHIPPED PART NO") ||
    combined.includes("DEALER NET") ||
    combined.includes("EXT NET") ||
    combined.includes("DEALER PO") ||
    combined.includes("DEALER PO NO");

  return hasKubota && hasTractorOrCorp && hasTableSignals;
}

function extractHeader(layout: PdfLayoutResult): Partial<InvoiceExtraction> {
  const rows = groupRows(layout.items)
    .filter((r) => r.page === 1)
    .map((r) => ({
      y: r.y,
      text: rowText(r),
      items: r.items,
    }));

  let invoiceDate = "";
  let invoiceNumber = "";
  let poNumber = "";
  let shipNo = "";
  let terms = "";

  for (let i = 0; i < rows.length - 1; i++) {
    const labelRow = rows[i].text.toUpperCase();
    const valueRow = rows[i + 1].text;

    if (
      labelRow.includes("ORDER DATE") &&
      labelRow.includes("DEALER PO NO") &&
      labelRow.includes("TERMS") &&
      labelRow.includes("INVOICE DATE") &&
      labelRow.includes("INVOICE NO")
    ) {
      const valueTokens = valueRow.split(/\s+/);

      if (valueTokens.length >= 6) {
        invoiceDate = valueTokens[valueTokens.length - 2] || "";
        invoiceNumber = valueTokens[valueTokens.length - 1] || "";
        poNumber = valueTokens[1] || "";

        const middle = valueTokens.slice(3, valueTokens.length - 2);
        terms = middle.join(" ").trim();
      }
    }

    if (
      labelRow.includes("DATE SHIPPED") &&
      labelRow.includes("SHIPPED FROM") &&
      labelRow.includes("SHIP NO") &&
      labelRow.includes("ORDER TYPE")
    ) {
      const valueTokens = valueRow.split(/\s+/);
      const numericToken = valueTokens.find((t) => /^[0-9]{6,}$/.test(t));
      if (numericToken) {
        shipNo = numericToken;
      }
    }
  }

  const text = layout.plainText;

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
    /(?:^|\n)\s*TOTAL\s+\$?\s*([0-9,]+\.[0-9]{2})(?:\s|$)/im,
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
    discount_percent: deriveDiscountPercent(dealerGross, dealerNet),
    net_unit_price: dealerNet,
    line_total: extNet,
  };
}

// Matches a row that has part numbers + qty + description but NO pricing columns.
// Handles the common Kubota layout where description wraps and prices land on the next row.
type PartialPartRow = {
  orderedPart: string;
  shippedPart: string;
  ordQty: number;
  shipQty: number;
  description: string;
};

function parsePartialRow(text: string): PartialPartRow | null {
  const normalized = clean(text);
  // Must start with two part-number tokens (alphanumeric + hyphens), followed by two integers,
  // followed by a description — but NO trailing price block.
  const match = normalized.match(
    /^([A-Z0-9][A-Z0-9\-\.]+)\s+([A-Z0-9][A-Z0-9\-\.]+)\s+([0-9]+)\s+([0-9]+)\s+(.+)$/i,
  );
  if (!match) return null;

  // Reject if the last token(s) look like prices — that means the full row is on one line.
  const lastToken = normalized.split(/\s+/).pop() || "";
  if (/^[0-9,]+\.[0-9]{2}$/.test(lastToken)) return null;

  return {
    orderedPart: match[1],
    shippedPart: match[2],
    ordQty: num(match[3]),
    shipQty: num(match[4]),
    description: clean(match[5]),
  };
}

// Matches a row that is purely pricing columns: gross, disc (may have trailing -), net, extGross, extNet
type PricingRow = {
  dealerGross: number;
  disc: number;
  dealerNet: number;
  extGross: number;
  extNet: number;
};

function parsePricingRow(text: string): PricingRow | null {
  const normalized = clean(text);
  // 5 price tokens; second may have trailing minus
  const match = normalized.match(
    /^([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2}-?)\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})$/,
  );
  if (!match) return null;
  return {
    dealerGross: num(match[1]),
    disc:        num(match[2]),  // num() handles trailing minus
    dealerNet:   num(match[3]),
    extGross:    num(match[4]),
    extNet:      num(match[5]),
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

  // Buffer for a partial row (part/qty/description present, pricing not yet seen)
  let pendingPartial: PartialPartRow | null = null;

  for (const row of rows) {
    const text = rowText(row);
    if (!text) continue;

    const upper = text.toUpperCase();

    // ── Additional Info continuation ──────────────────────────────────────────
    if (upper.startsWith("ADDITIONAL INFO")) {
      const originValue = clean(text.replace(/^Additional Info\s*:?\s*/i, ""));
      if (currentLine) {
        currentLine.origin = originValue;
        // Remove bracket notation we may have added to description
        currentLine.description = currentLine.description
          .replace(/\s*\[[^\]]+\]$/, "").trim();
      }
      pendingPartial = null;
      continue;
    }

    // ── Freight ───────────────────────────────────────────────────────────────
    if (upper.startsWith("FREIGHT CHARGES")) {
      const amount = num(clean(text.replace(/^Freight Charges/i, "")));
      freightCharge = amount;
      currentLine = null;
      pendingPartial = null;
      continue;
    }

    // ── Totals / noise ────────────────────────────────────────────────────────
    if (upper.startsWith("TOTAL GROSS") || upper === "TOTAL") {
      currentLine = null;
      pendingPartial = null;
      continue;
    }

    if (isNoiseRow(text)) continue;

    // ── Full single-row line (legacy — still handle these) ────────────────────
    const fullParsed = parsePartRow(text, nextLineNumber);
    if (fullParsed) {
      lines.push(fullParsed);
      currentLine = fullParsed;
      pendingPartial = null;
      nextLineNumber += 1;
      continue;
    }

    // ── Pricing-only row — completes a pending partial ────────────────────────
    const pricing = parsePricingRow(text);
    if (pricing && pendingPartial) {
      const line: InvoiceLine = {
        line_number:    nextLineNumber,
        line_type:      "PART",
        part_number:    pendingPartial.shippedPart || pendingPartial.orderedPart,
        description:    pendingPartial.description,
        origin:         "",
        quantity:       pendingPartial.shipQty,
        unit_price:     pricing.dealerGross,
        discount_percent: deriveDiscountPercent(pricing.dealerGross, pricing.dealerNet),
        net_unit_price: pricing.dealerNet,
        line_total:     pricing.extNet,
      };
      lines.push(line);
      currentLine = line;
      pendingPartial = null;
      nextLineNumber += 1;
      continue;
    }

    // ── Partial row (part/qty/description, no prices yet) ────────────────────
    const partial = parsePartialRow(text);
    if (partial) {
      pendingPartial = partial;
      currentLine = null;
      continue;
    }

    // ── Origin continuation for a pending partial (e.g. "16N-03" alone) ──────
    if (pendingPartial && /^[A-Z0-9][-A-Z0-9]*$/i.test(text.trim()) && text.trim().length <= 20) {
      // Small standalone token after a partial row is likely the additional info / origin
      // Store it and wait for the pricing row
      pendingPartial.description += ` [${text.trim()}]`;
      continue;
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