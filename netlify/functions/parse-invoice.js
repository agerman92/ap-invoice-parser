import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async (request) => {
  try {
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        {
          status: 405,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!file) {
      return new Response(
        JSON.stringify({ error: "No file uploaded" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    if (file.type !== "application/pdf") {
      return new Response(
        JSON.stringify({ error: "Only PDF files are supported" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString("base64");

    const prompt = `
You are extracting structured AP invoice data from a PDF.

Return ONLY valid JSON matching this schema exactly:

{
  "vendor": "string",
  "invoice_number": "string",
  "invoice_date": "YYYY-MM-DD or empty string",
  "po_number": "string",
  "order_number": "string",
  "shipment_number": "string",
  "terms": "string",
  "currency": "string",
  "subtotal": 0,
  "freight_charge": 0,
  "drop_ship_charge": 0,
  "misc_charges": 0,
  "total_invoice": 0,
  "lines": [
    {
      "line_number": 0,
      "line_type": "PART | FREIGHT | DROP_SHIPMENT | MISC",
      "part_number": "string",
      "description": "string",
      "origin": "string",
      "quantity": 0,
      "unit_price": 0,
      "discount_percent": 0,
      "net_unit_price": 0,
      "line_total": 0
    }
  ]
}

Rules:
- Return numbers as numbers, not strings.
- If a value is missing, use empty string for text fields and 0 for numeric fields.
- Put surcharge rows like FREIGHT CHARGE and DROP SHIPMENT into the lines array too.
- For normal item rows use "PART" as line_type.
- Do not wrap JSON in markdown.
`;

    const response = await client.responses.create({
      model: "gpt-4.1",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: prompt
            },
            {
              type: "input_file",
              filename: file.name,
              file_data: `data:application/pdf;base64,${base64}`
            }
          ]
        }
      ]
    });

    const raw = response.output_text;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Response(
        JSON.stringify({
          error: "Model did not return valid JSON",
          raw_output: raw
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response(JSON.stringify(parsed, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error.message || "Unexpected server error"
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
};