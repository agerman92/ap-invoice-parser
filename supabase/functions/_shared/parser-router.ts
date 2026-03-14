import type { InvoiceExtraction } from "./invoice-schema.ts";
import type { PdfLayoutResult } from "./pdf-layout.ts";
import { parseKubotaInvoice } from "./kubota-parser.ts";
import { parseManitouInvoice } from "./manitou-parser.ts";

export type ParseResult = {
  parsed: InvoiceExtraction;
  parserVersion: string;
  parserType: "vendor_layout" | "llm_fallback";
};

export async function parseInvoiceWithRouter(
  layout: PdfLayoutResult,
): Promise<ParseResult> {
  const kubota = parseKubotaInvoice(layout);
  if (kubota) {
    return {
      parsed: kubota,
      parserVersion: "kubota-v1",
      parserType: "vendor_layout",
    };
  }

  const manitou = parseManitouInvoice(layout);
  if (manitou) {
    return {
      parsed: manitou,
      parserVersion: "manitou-v1",
      parserType: "vendor_layout",
    };
  }

  throw new Error(
    "No vendor parser matched invoice. Kubota and Manitou both returned null."
  );
}