import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4.104.0";
import pdf from "npm:@cedrugs/pdf-parse";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

function getResponseText(responseJson: any) {
  if (
    typeof responseJson.output_text === "string" &&
    responseJson.output_text.trim()
  ) {
    return responseJson.output_text;
  }

  if (Array.isArray(responseJson.output)) {
    for (const item of responseJson.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const contentItem of item.content) {
          if (
            contentItem.type === "output_text" &&
            typeof contentItem.text === "string"
          ) {
            return contentItem.text;
          }
        }
      }
    }
  }

  return "";
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  let invoiceId: string | null = null;

  try {
    const openAiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openAiKey) {
      throw new Error("OPENAI_API_KEY is missing in Supabase secrets.");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Supabase server environment variables are missing.");
    }

    const openai = new OpenAI({
      apiKey: openAiKey,
    });

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json();
    invoiceId = body?.invoiceId ?? null;
    const storagePath = body?.storagePath ?? null;

    if (!invoiceId || !storagePath) {
      return json(
        { success: false, error: "Missing invoiceId or storagePath." },
        400
      );
    }

    const { error: statusError } = await supabase
      .from("ap_invoices")
      .update({
        status: "processing",
        parse_error: null,
      })
      .eq("id", invoiceId);

    if (statusError) {
      throw new Error(`Failed to update invoice status: ${statusError.message}`);
    }

    const { data: fileData, error: downloadError } = await supabase.storage
      .from("ap-invoices")
      .download(storagePath);

    if (downloadError || !fileData) {
      throw new Error(
        `Failed to download file: ${downloadError?.message || "Unknown error"}`
      );
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const pdfBuffer = new Uint8Array(arrayBuffer);

    const pdfData = await pdf(Buffer.from(pdfBuffer));
    const invoiceText = (pdfData.text || "").trim();

    if (!invoiceText) {
      throw new Error("Could not extract text from PDF.");
    }

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        vendor: { type: "string" },
        invoice_number: { type: "string" },
        invoice_date: { type: "string" },
        po_number: { type: "string" },
        order_number: { type: "string" },
        shipment_number: { type: "string" },
        terms: { type: "string" },
        currency: { type: "string" },
        subtotal: { type: "number" },
        freight_charge: { type: "number" },
        drop_ship_charge: { type: "number" },
        misc_charges: { type: "number" },
        total_invoice: { type: "number" },
        lines: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              line_number: { type: "integer" },
              line_type: { type: "string" },
              part_number: { type: "string" },
              description: { type: "string" },
              origin: { type: "string" },
              quantity: { type: "number" },
              unit_price: { type: "number" },
              discount_percent: { type: "number" },
              net_unit_price: { type: "number" },
              line_total: { type: "number" },
            },
            required: [
              "line_number",
              "line_type",
              "part_number",
              "description",
              "origin",
              "quantity",
              "unit_price",
              "discount_percent",
              "net_unit_price",
              "line_total",
            ],
          },
        },
      },
      required: [
        "vendor",
        "invoice_number",
        "invoice_date",
        "po_number",
        "order_number",
        "shipment_number",
        "terms",
        "currency",
        "subtotal",
        "freight_charge",
        "drop_ship_charge",
        "misc_charges",
        "total_invoice",
        "lines",
      ],
    };

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You extract structured invoice data from equipment parts invoices. " +
                "Return only the fields requested in the JSON schema. " +
                "Capture freight and drop shipment as separate header charges. " +
                "Also include them as separate line items in the lines array with line_type values FREIGHT and DROP_SHIPMENT. " +
                "Use empty strings for missing text values and 0 for missing numeric values. " +
                "For charge lines like freight or drop shipment, use quantity 1, unit_price equal to the charge amount, net_unit_price equal to the charge amount, and line_total equal to the charge amount.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Extract this invoice text into the required schema. " +
                "Do not omit charges. " +
                "If a charge line like FREIGHT CHARGE or DROP SHIPMENT appears, include it in lines.\n\n" +
                "INVOICE TEXT:\n" +
                invoiceText,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "invoice_extraction",
          strict: true,
          schema,
        },
      },
    });

    const extractedText = getResponseText(response);

    if (!extractedText) {
      throw new Error("No structured output returned from OpenAI.");
    }

    const extracted = JSON.parse(extractedText);

    const { error: invoiceUpdateError } = await supabase
      .from("ap_invoices")
      .update({
        vendor: extracted.vendor,
        invoice_number: extracted.invoice_number,
        invoice_date: extracted.invoice_date,
        po_number: extracted.po_number,
        order_number: extracted.order_number,
        shipment_number: extracted.shipment_number,
        terms: extracted.terms,
        currency: extracted.currency,
        subtotal: extracted.subtotal,
        freight_charge: extracted.freight_charge,
        drop_ship_charge: extracted.drop_ship_charge,
        misc_charges: extracted.misc_charges,
        total_invoice: extracted.total_invoice,
        status: "parsed",
        parse_error: null,
      })
      .eq("id", invoiceId);

    if (invoiceUpdateError) {
      throw new Error(
        `Failed to update invoice header: ${invoiceUpdateError.message}`
      );
    }

    const { error: deleteLinesError } = await supabase
      .from("ap_invoice_lines")
      .delete()
      .eq("invoice_id", invoiceId);

    if (deleteLinesError) {
      throw new Error(
        `Failed to clear existing invoice lines: ${deleteLinesError.message}`
      );
    }

    if (Array.isArray(extracted.lines) && extracted.lines.length > 0) {
      const rows = extracted.lines.map((line: any) => ({
        invoice_id: invoiceId,
        line_number: line.line_number,
        line_type: line.line_type,
        part_number: line.part_number,
        description: line.description,
        origin: line.origin,
        quantity: line.quantity,
        unit_price: line.unit_price,
        discount_percent: line.discount_percent,
        net_unit_price: line.net_unit_price,
        line_total: line.line_total,
      }));

      const { error: lineInsertError } = await supabase
        .from("ap_invoice_lines")
        .insert(rows);

      if (lineInsertError) {
        throw new Error(
          `Failed to insert invoice lines: ${lineInsertError.message}`
        );
      }
    }

    return json({
      success: true,
      invoiceId,
      extracted,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown server error.";

    if (invoiceId) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

      if (supabaseUrl && serviceRoleKey) {
        const supabase = createClient(supabaseUrl, serviceRoleKey);
        await supabase
          .from("ap_invoices")
          .update({
            status: "failed",
            parse_error: message,
          })
          .eq("id", invoiceId);
      }
    }

    return json(
      {
        success: false,
        error: message,
      },
      500
    );
  }
});