import type { InvoiceExtraction } from "./invoice-schema.ts";
import type { PdfLayoutResult } from "./pdf-layout.ts";
import { parseKubotaInvoice } from "./kubota-parser.ts";
import { parseManitouInvoice } from "./manitou-parser.ts";
import { parseLandPrideInvoice } from "./land-pride-parser.ts";
import { parseWoodsInvoice } from "./woods-parser.ts";
import { parseBushHogInvoice } from "./bush-hog-parser.ts";

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

  const landPride = parseLandPrideInvoice(layout);
  if (landPride) {
    return {
      parsed: landPride,
      parserVersion: "land-pride-v1",
      parserType: "vendor_layout",
    };
  }

  const woods = parseWoodsInvoice(layout);
  if (woods) {
    return {
      parsed: woods,
      parserVersion: "woods-v1",
      parserType: "vendor_layout",
    };
  }

  const bushHog = parseBushHogInvoice(layout);
  if (bushHog) {
    return {
      parsed: bushHog,
      parserVersion: "bush-hog-v1",
      parserType: "vendor_layout",
    };
  }

  throw new Error(
    "No vendor parser matched invoice. Kubota, Manitou, Land Pride, Woods, and Bush Hog all returned null."
  );
}