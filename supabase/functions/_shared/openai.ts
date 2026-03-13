import OpenAI from "npm:openai@4.86.1";
import {
  invoiceJsonSchema,
  type InvoiceExtraction,
} from "./invoice-schema.ts";

const openai = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY"),
});

function buildPrompt(rawText: string): string {
  return `
You are extracting structured AP invoice data for financial review.

Rules:
- Extract only what is present in the invoice text.
- Do not invent values.
- If a field is missing, return an empty string for text or 0 for numbers.
- Preserve line order.
- Return PART lines for merchandise.
- Return FREIGHT, DROP_SHIPMENT, or MISC for non-merchandise charges when applicable.
- If invoice spans multiple pages, include all lines.
- Output must match the schema exactly.

Special handling:
- "invoice_number" should be the vendor invoice number, not PO number.
- "invoice_date" should remain as found in the document.
- "currency" should usually be USD unless another currency is explicitly shown.
- For each line:
  - quantity must be numeric
  - unit_price must be the gross unit price if shown
  - discount_percent should be 0 if absent
  - net_unit_price should be the effective unit price after discount if shown, otherwise unit_price
  - line_total should be the extended line amount

Invoice text:
${rawText}
  `.trim();
}

export async function extractStructuredInvoice(
  rawText: string,
): Promise<InvoiceExtraction> {
  const response = await openai.responses.create({
    model: "gpt-5",
    input: buildPrompt(rawText),
    text: {
      format: {
        type: "json_schema",
        ...invoiceJsonSchema,
      },
    },
  });

  const content = response.output_text?.trim();
  if (!content) {
    throw new Error("OpenAI returned empty structured output.");
  }

  return JSON.parse(content) as InvoiceExtraction;
}