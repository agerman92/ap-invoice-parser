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
You are extracting structured AP invoice data for financial review at an equipment dealership.

Rules:
- Extract only what is present in the invoice text.
- Do not invent values.
- If a field is missing, return an empty string for text or 0 for numbers.
- Preserve line order.
- Return PART lines for merchandise/parts.
- Return FREIGHT for shipping charges.
- Return DROP_SHIPMENT for drop-ship fees.
- Return MISC for other non-part charges.
- If invoice spans multiple pages, include all lines.
- Output must match the schema exactly.

Field rules:
- "invoice_number" is the vendor's invoice number, NOT the PO number.
- "invoice_date" should be the date as shown in the document (do not reformat).
- "currency" is USD unless another currency is explicitly shown.
- "subtotal" is the sum of part line totals before freight/charges.
- "total_invoice" is the final amount due including all charges.

Line item rules:
- "quantity" must be the shipped/billed quantity as a number.
- "unit_price" is the gross/list unit price before any discount.
- "discount_percent" — some vendors show a dollar discount (e.g. "13.69-") rather than a
  percentage. Convert any dollar discount to a percentage:
  discount_percent = round((dollar_discount / unit_price) * 100, 2)
  If no discount is present, use 0.
- "net_unit_price" is the effective unit price after discount. If not shown, derive it:
  net_unit_price = unit_price * (1 - discount_percent / 100)
- "line_total" is the extended total for the line (net_unit_price * quantity).
- "origin" is the country of origin or origin code if shown on the line, otherwise empty string.

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