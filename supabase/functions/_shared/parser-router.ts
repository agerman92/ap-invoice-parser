import type { InvoiceExtraction } from "./invoice-schema.ts";
import type { PdfLayoutResult } from "./pdf-layout.ts";
import { parseKubotaInvoice } from "./kubota-parser.ts";
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
    "No vendor parser matched invoice before fallback. Kubota detection did not match."
  );

  // Leave this disabled until Kubota is confirmed:
  // const parsed = await extractStructuredInvoice(layout.plainText);
  // return {
  //   parsed,
  //   parserVersion: "llm-v1",
  //   parserType: "llm_fallback",
  // };
}