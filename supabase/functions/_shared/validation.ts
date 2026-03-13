import type { InvoiceExtraction } from "./invoice-schema.ts";

export type ValidationWarning = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
};

function round2(n: number): number {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

export function validateInvoiceExtraction(
  data: InvoiceExtraction,
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  if (!data.vendor?.trim()) {
    warnings.push({
      code: "MISSING_VENDOR",
      message: "Vendor name was not extracted.",
      severity: "error",
    });
  }

  if (!data.invoice_number?.trim()) {
    warnings.push({
      code: "MISSING_INVOICE_NUMBER",
      message: "Invoice number was not extracted.",
      severity: "error",
    });
  }

  if (!Array.isArray(data.lines) || data.lines.length === 0) {
    warnings.push({
      code: "NO_LINES",
      message: "No invoice line items were extracted.",
      severity: "error",
    });
  }

  const partLines = (data.lines || []).filter((l) => l.line_type === "PART");

  const partLineSum = round2(
    partLines.reduce((sum, line) => sum + Number(line.line_total || 0), 0),
  );

  const subtotal = round2(Number(data.subtotal || 0));
  const totalInvoice = round2(Number(data.total_invoice || 0));
  const expectedTotal = round2(
    subtotal +
      Number(data.freight_charge || 0) +
      Number(data.drop_ship_charge || 0) +
      Number(data.misc_charges || 0),
  );

  if (Math.abs(partLineSum - subtotal) > 0.05) {
    warnings.push({
      code: "LINE_SUBTOTAL_MISMATCH",
      message: `Part line total ${partLineSum} does not reconcile to subtotal ${subtotal}.`,
      severity: "warning",
    });
  }

  if (Math.abs(expectedTotal - totalInvoice) > 0.05) {
    warnings.push({
      code: "HEADER_TOTAL_MISMATCH",
      message: `Subtotal + charges ${expectedTotal} does not reconcile to total invoice ${totalInvoice}.`,
      severity: "warning",
    });
  }

  let suspiciousQtyPriceSwaps = 0;

  for (const line of partLines) {
    const qty = Number(line.quantity || 0);
    const unitPrice = Number(line.unit_price || 0);
    const netUnitPrice = Number(line.net_unit_price || 0);
    const lineTotal = Number(line.line_total || 0);
    const discount = Number(line.discount_percent || 0);

    if (!line.part_number?.trim()) {
      warnings.push({
        code: "PART_LINE_MISSING_PART_NUMBER",
        message: `Line ${line.line_number} is missing part number.`,
        severity: "warning",
      });
    }

    // Expected total from net price
    if (qty > 0 && netUnitPrice > 0) {
      const expectedLine = round2(qty * netUnitPrice);
      if (Math.abs(expectedLine - lineTotal) > 0.06) {
        warnings.push({
          code: "LINE_TOTAL_MISMATCH",
          message: `Line ${line.line_number} total ${round2(lineTotal)} does not match qty × net price ${expectedLine}.`,
          severity: "warning",
        });
      }
    }

    // Heuristic for qty/unit-price swap:
    // qty shouldn't usually look like 25.48 while unit price is 1
    if (qty > 20 && unitPrice > 0 && unitPrice <= 10 && lineTotal > 0) {
      suspiciousQtyPriceSwaps += 1;
    }

    // Another heuristic:
    if (qty > 0 && unitPrice > 0 && discount >= 0 && netUnitPrice > 0) {
      const discountFactor = round2(unitPrice * (1 - discount / 100));
      if (Math.abs(discountFactor - netUnitPrice) > 0.15 && unitPrice !== netUnitPrice) {
        warnings.push({
          code: "DISCOUNT_NET_PRICE_MISMATCH",
          message: `Line ${line.line_number} net unit price does not align with unit price and discount.`,
          severity: "info",
        });
      }
    }
  }

  if (suspiciousQtyPriceSwaps >= 3) {
    warnings.push({
      code: "POSSIBLE_QTY_UNIT_PRICE_SWAP",
      message: "Several lines appear to have quantity and unit price swapped.",
      severity: "error",
    });
  }

  return warnings;
}