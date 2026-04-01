import type { InvoiceExtraction } from "./invoice-schema.ts";
import type { PdfLayoutResult } from "./pdf-layout.ts";
import { parseKubotaInvoice } from "./kubota-parser.ts";
import { parseManitouInvoice } from "./manitou-parser.ts";
import { parseLandPrideInvoice } from "./land-pride-parser.ts";
import { parseWoodsInvoice } from "./woods-parser.ts";
import { parseBushHogInvoice } from "./bush-hog-parser.ts";
import { extractStructuredInvoice } from "./openai.ts";

export type ParseResult = {
  parsed: InvoiceExtraction;
  parserVersion: string;
  parserType: "vendor_layout" | "llm_fallback" | "vendor_layout_llm_verified";
};

// A vendor parse is considered "good enough" to skip LLM if it has at least
// one extracted line and a non-zero total. If lines are empty the vendor
// parser likely hit a layout variation — fall through to LLM.
function isUsableVendorResult(result: InvoiceExtraction): boolean {
  return (
    Array.isArray(result.lines) &&
    result.lines.filter((l) => l.line_type === "PART").length > 0 &&
    Number(result.total_invoice || 0) > 0
  );
}

export async function parseInvoiceWithRouter(
  layout: PdfLayoutResult,
): Promise<ParseResult> {

  // ── Tier 1: Vendor-specific layout parsers ──────────────────────────────────
  // Fast, free, deterministic. Try each known vendor in order.
  // If the result has extracted lines + a total, use it directly.
  // If the parser matched but extracted nothing (layout variation), fall through
  // to LLM so the invoice doesn't silently fail.

  const vendorAttempts: Array<[() => InvoiceExtraction | null, string]> = [
    [() => parseKubotaInvoice(layout),    "kubota-v2"],
    [() => parseManitouInvoice(layout),   "manitou-v1"],
    [() => parseLandPrideInvoice(layout), "land-pride-v1"],
    [() => parseWoodsInvoice(layout),     "woods-v1"],
    [() => parseBushHogInvoice(layout),   "bush-hog-v1"],
  ];

  for (const [tryParse, version] of vendorAttempts) {
    const result = tryParse();

    if (result && isUsableVendorResult(result)) {
      return {
        parsed: result,
        parserVersion: version,
        parserType: "vendor_layout",
      };
    }

    // Vendor parser matched the invoice but extracted no usable lines —
    // this means a layout variation. Fall through immediately to LLM
    // rather than trying the next vendor parser (wrong vendor would match).
    if (result && !isUsableVendorResult(result)) {
      console.warn(
        `[parser-router] ${version} matched but extracted no usable lines. ` +
        `Falling back to LLM. total=${result.total_invoice}, lines=${result.lines?.length ?? 0}`,
      );

      const llmResult = await extractStructuredInvoice(layout.plainText);
      return {
        parsed: llmResult,
        parserVersion: `${version}+llm-fallback`,
        parserType: "llm_fallback",
      };
    }
  }

  // ── Tier 2: LLM fallback for unrecognized vendors ───────────────────────────
  // No vendor parser matched at all. This is a new/unknown vendor.
  // OpenAI handles this generically from the raw text.
  console.info(
    "[parser-router] No vendor parser matched. Using LLM fallback.",
  );

  const llmResult = await extractStructuredInvoice(layout.plainText);
  return {
    parsed: llmResult,
    parserVersion: "llm-fallback-v1",
    parserType: "llm_fallback",
  };
}
