import type { InvoiceExtraction } from "./invoice-schema.ts";
import type { PdfLayoutResult } from "./pdf-layout.ts";
import { parseManitouInvoice } from "./manitou-parser.ts";
import { extractStructuredInvoice } from "./openai.ts";

export type ParseResult = {
  parsed: InvoiceExtraction;
  parserVersion: string;
  parserType: "vendor_layout" | "llm_fallback";
};

export async function parseInvoiceWithRouter(
  layout: PdfLayoutResult,
): Promise<ParseResult> {
  const manitou = parseManitouInvoice(layout);
  if (manitou) {
    return {
      parsed: manitou,
      parserVersion: "manitou-v1",
      parserType: "vendor_layout",
    };
  }

  const parsed = await extractStructuredInvoice(layout.plainText);

  return {
    parsed,
    parserVersion: "llm-v1",
    parserType: "llm_fallback",
  };
}