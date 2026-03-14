import type { InvoiceExtraction } from "./invoice-schema.ts";

export type ExceptionSeverity = "low" | "medium" | "high" | "critical";

export type ExceptionFlag = {
  code: string;
  severity: ExceptionSeverity;
  message: string;
};

function pushUniqueFlag(flags: ExceptionFlag[], next: ExceptionFlag) {
  const exists = flags.some((flag) => flag.code === next.code && flag.message === next.message);
  if (!exists) flags.push(next);
}

export function buildInvoiceExceptionFlags(
  parsed: InvoiceExtraction,
  warnings: unknown[] = [],
): ExceptionFlag[] {
  const flags: ExceptionFlag[] = [];

  if (!parsed.vendor?.trim()) {
    pushUniqueFlag(flags, {
      code: "MISSING_VENDOR",
      severity: "high",
      message: "Vendor is missing.",
    });
  }

  if (!parsed.invoice_number?.trim()) {
    pushUniqueFlag(flags, {
      code: "MISSING_INVOICE_NUMBER",
      severity: "high",
      message: "Invoice number is missing.",
    });
  }

  if (!parsed.invoice_date?.trim()) {
    pushUniqueFlag(flags, {
      code: "MISSING_INVOICE_DATE",
      severity: "medium",
      message: "Invoice date is missing.",
    });
  }

  if (!parsed.po_number?.trim()) {
    pushUniqueFlag(flags, {
      code: "MISSING_PO_NUMBER",
      severity: "high",
      message: "PO number is missing.",
    });
  }

  if (parsed.total_invoice == null) {
    pushUniqueFlag(flags, {
      code: "MISSING_TOTAL",
      severity: "high",
      message: "Invoice total is missing.",
    });
  } else if (Number(parsed.total_invoice) === 0) {
    pushUniqueFlag(flags, {
      code: "ZERO_TOTAL",
      severity: "high",
      message: "Invoice total is zero.",
    });
  }

  if ((parsed.lines?.length ?? 0) >= 40) {
    pushUniqueFlag(flags, {
      code: "HIGH_LINE_COUNT",
      severity: "low",
      message: "Invoice has a high number of line items.",
    });
  }

  if (Array.isArray(warnings) && warnings.length > 0) {
    pushUniqueFlag(flags, {
      code: "PARSER_WARNINGS_PRESENT",
      severity: "medium",
      message: `Parser returned ${warnings.length} warning(s).`,
    });
  }

  for (const line of parsed.lines || []) {
    if (line.line_type === "PART") {
      if ((line.quantity ?? 0) === 0) {
        pushUniqueFlag(flags, {
          code: "ZERO_QTY_PART_LINE",
          severity: "medium",
          message: `Line ${line.line_number}: part line has zero quantity.`,
        });
      }

      if ((line.unit_price ?? 0) === 0 && (line.net_unit_price ?? 0) === 0) {
        pushUniqueFlag(flags, {
          code: "ZERO_PRICE_PART_LINE",
          severity: "medium",
          message: `Line ${line.line_number}: part line has zero unit price.`,
        });
      }
    }

    const qty = Number(line.quantity ?? 0);
    const net = Number(line.net_unit_price ?? 0);
    const total = Number(line.line_total ?? 0);
    const expected = qty * net;

    if (qty > 0 && Math.abs(expected - total) > 0.05) {
      pushUniqueFlag(flags, {
        code: "LINE_MATH_MISMATCH",
        severity: "medium",
        message: `Line ${line.line_number}: qty × net unit price does not match line total.`,
      });
    }
  }

  return flags;
}

export function appendDuplicateFlag(
  flags: ExceptionFlag[],
  duplicateStatus: string | null | undefined,
): ExceptionFlag[] {
  const next = [...flags];

  if (duplicateStatus === "suspected") {
    pushUniqueFlag(next, {
      code: "SUSPECTED_DUPLICATE",
      severity: "critical",
      message: "Invoice appears to be a suspected duplicate.",
    });
  }

  return next;
}

export function buildFailedParseFlags(errorMessage: string): ExceptionFlag[] {
  return [
    {
      code: "FAILED_PARSE",
      severity: "critical",
      message: errorMessage || "Invoice parsing failed.",
    },
  ];
}

export function calculateReviewPriority(flags: ExceptionFlag[]): number {
  let score = 0;

  for (const flag of flags) {
    switch (flag.code) {
      case "FAILED_PARSE":
        score += 100;
        break;
      case "SUSPECTED_DUPLICATE":
        score += 80;
        break;
      case "MISSING_PO_NUMBER":
        score += 70;
        break;
      case "MISSING_INVOICE_NUMBER":
        score += 60;
        break;
      case "MISSING_TOTAL":
      case "ZERO_TOTAL":
        score += 60;
        break;
      case "LINE_MATH_MISMATCH":
        score += 50;
        break;
      case "MISSING_VENDOR":
        score += 50;
        break;
      case "MISSING_INVOICE_DATE":
        score += 30;
        break;
      case "PARSER_WARNINGS_PRESENT":
        score += 30;
        break;
      case "ZERO_QTY_PART_LINE":
      case "ZERO_PRICE_PART_LINE":
        score += 25;
        break;
      case "HIGH_LINE_COUNT":
        score += 15;
        break;
      default:
        score += 20;
        break;
    }
  }

  return score;
}