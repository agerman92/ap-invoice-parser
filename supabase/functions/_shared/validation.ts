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

  if (!data.invoice_date?.trim()) {
    warnings.push({
      code: "MISSING_INVOICE_DATE",
      message: "Invoice date was not extracted.",
      severity: "warning",
    });
  }

  if (!Array.isArray(data.lines) || data.lines.length === 0) {
    warnings.push({
      code: "NO_LINES",
      message: "No invoice line items were extracted.",
      severity: "error",
    });
  }

  const lineSum = round2(
    (data.lines || []).reduce((sum, line) => sum + Number(line.line_total || 0), 0),
  );

  const expectedTotal = round2(
    Number(data.subtotal || 0) +
      Number(data.freight_charge || 0) +
      Number(data.drop_ship_charge || 0) +
      Number(data.misc_charges || 0),
  );

  const totalInvoice = round2(Number(data.total_invoice || 0));

  if (Math.abs(expectedTotal - totalInvoice) > 0.05) {
    warnings.push({
      code: "HEADER_TOTAL_MISMATCH",
      message: `Header totals do not reconcile. subtotal+charges=${expectedTotal}, total_invoice=${totalInvoice}`,
      severity: "warning",
    });
  }

  if (Math.abs(lineSum - Number(data.subtotal || 0)) > 0.05) {
    warnings.push({
      code: "LINE_SUBTOTAL_MISMATCH",
      message: `Line totals do not reconcile to subtotal. line_sum=${lineSum}, subtotal=${round2(Number(data.subtotal || 0))}`,
      severity: "warning",
    });
  }

  for (const line of data.lines || []) {
    if (line.line_type === "PART" && !line.part_number?.trim()) {
      warnings.push({
        code: "PART_LINE_MISSING_PART_NUMBER",
        message: `Line ${line.line_number} is a PART line with no part number.`,
        severity: "warning",
      });
    }

    if (line.line_type === "PART" && Number(line.quantity || 0) === 0) {
      warnings.push({
        code: "PART_LINE_ZERO_QTY",
        message: `Line ${line.line_number} has zero quantity.`,
        severity: "warning",
      });
    }
  }

  return warnings;
}