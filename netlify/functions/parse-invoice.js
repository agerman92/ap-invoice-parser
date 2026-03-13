const Busboy = require("busboy");
const pdf = require("pdf-parse");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Use a faster model by default to reduce timeout risk on large invoices.
// You can override this in Netlify with OPENAI_MODEL.
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  };
}

function parseMultipartForm(event) {
  return new Promise((resolve, reject) => {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"];

    if (!contentType || !contentType.includes("multipart/form-data")) {
      reject(new Error("Expected multipart/form-data upload."));
      return;
    }

    const busboy = Busboy({
      headers: {
        "content-type": contentType
      }
    });

    const bodyBuffer = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : Buffer.from(event.body || "", "utf8");

    const files = [];
    const fields = {};
    const filePromises = [];

    busboy.on("field", (fieldname, value) => {
      fields[fieldname] = value;
    });

    busboy.on("file", (fieldname, file, info) => {
      const { filename, mimeType } = info;
      const chunks = [];

      const filePromise = new Promise((resolveFile, rejectFile) => {
        file.on("data", (chunk) => {
          chunks.push(chunk);
        });

        file.on("end", () => {
          files.push({
            fieldname,
            filename: filename || "upload.pdf",
            mimeType: mimeType || "application/octet-stream",
            buffer: Buffer.concat(chunks)
          });
          resolveFile();
        });

        file.on("error", (err) => {
          rejectFile(err);
        });
      });

      filePromises.push(filePromise);
    });

    busboy.on("finish", async () => {
      try {
        await Promise.all(filePromises);
        resolve({ files, fields });
      } catch (err) {
        reject(err);
      }
    });

    busboy.on("error", (err) => {
      reject(err);
    });

    busboy.end(bodyBuffer);
  });
}

function getResponseText(responseJson) {
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

async function callOpenAIWithSchema({ systemPrompt, userPrompt, schema, schemaName }) {
  const openAiPayload = {
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: systemPrompt
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: userPrompt
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        strict: true,
        schema
      }
    }
  };

  const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(openAiPayload)
  });

  const rawResponseText = await openAiResponse.text();

  if (!openAiResponse.ok) {
    throw new Error(`OpenAI request failed: ${rawResponseText}`);
  }

  let openAiJson;
  try {
    openAiJson = JSON.parse(rawResponseText);
  } catch (err) {
    throw new Error(`OpenAI returned non-JSON response: ${rawResponseText}`);
  }

  const extractedText = getResponseText(openAiJson);

  if (!extractedText) {
    throw new Error("No structured output returned from OpenAI.");
  }

  try {
    return JSON.parse(extractedText);
  } catch (err) {
    throw new Error(`Structured output was not valid JSON: ${extractedText}`);
  }
}

function normalizeInvoiceText(text) {
  return (text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildHeaderText(invoiceText) {
  const head = invoiceText.slice(0, 6000);
  const tail = invoiceText.slice(-3000);
  return `${head}\n\n--- FINAL SECTION ---\n\n${tail}`;
}

function splitLinesIntoChunks(invoiceText, maxChars = 5000, overlapLines = 4) {
  const rows = invoiceText
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const row of rows) {
    const rowLen = row.length + 1;

    if (current.length > 0 && currentLen + rowLen > maxChars) {
      chunks.push(current.join("\n"));

      const overlap = current.slice(-overlapLines);
      current = [...overlap, row];
      currentLen = current.join("\n").length + 1;
    } else {
      current.push(row);
      currentLen += rowLen;
    }
  }

  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }

  return chunks;
}

function dedupeAndSortLines(lines) {
  const seen = new Set();
  const cleaned = [];

  for (const rawLine of lines || []) {
    const line = {
      line_number: Number(rawLine.line_number || 0),
      line_type: String(rawLine.line_type || "").trim(),
      part_number: String(rawLine.part_number || "").trim(),
      description: String(rawLine.description || "").trim(),
      origin: String(rawLine.origin || "").trim(),
      quantity: Number(rawLine.quantity || 0),
      unit_price: Number(rawLine.unit_price || 0),
      discount_percent: Number(rawLine.discount_percent || 0),
      net_unit_price: Number(rawLine.net_unit_price || 0),
      line_total: Number(rawLine.line_total || 0)
    };

    const key = [
      line.line_number,
      line.line_type,
      line.part_number,
      line.description,
      line.quantity,
      line.line_total
    ].join("|");

    if (!seen.has(key)) {
      seen.add(key);
      cleaned.push(line);
    }
  }

  cleaned.sort((a, b) => {
    if (a.line_number !== b.line_number) {
      return a.line_number - b.line_number;
    }
    return a.description.localeCompare(b.description);
  });

  return cleaned;
}

function sumChargesByType(lines, type) {
  return (lines || [])
    .filter((line) => line.line_type === type)
    .reduce((sum, line) => sum + Number(line.line_total || 0), 0);
}

exports.handler = async (event) => {
  console.log("parse-invoice started");

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      success: false,
      error: "Method not allowed. Use POST."
    });
  }

  if (!OPENAI_API_KEY) {
    return jsonResponse(500, {
      success: false,
      error: "Missing OPENAI_API_KEY environment variable."
    });
  }

  try {
    const { files } = await parseMultipartForm(event);

    if (!files.length) {
      return jsonResponse(400, {
        success: false,
        error: "No file was uploaded."
      });
    }

    const pdfFile =
      files.find((f) => f.mimeType === "application/pdf") || files[0];

    if (!pdfFile || !pdfFile.buffer || !pdfFile.buffer.length) {
      return jsonResponse(400, {
        success: false,
        error: "Uploaded file was empty."
      });
    }

    console.log("Uploaded file:", {
      filename: pdfFile.filename,
      mimeType: pdfFile.mimeType,
      size: pdfFile.buffer.length
    });

    const pdfData = await pdf(pdfFile.buffer);
    const invoiceText = normalizeInvoiceText(pdfData.text || "");

    if (!invoiceText) {
      return jsonResponse(400, {
        success: false,
        error: "Could not extract text from PDF."
      });
    }

    console.log("Extracted PDF text length:", invoiceText.length);

    const headerSchema = {
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
        total_invoice: { type: "number" }
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
        "total_invoice"
      ]
    };

    const lineSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
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
              line_total: { type: "number" }
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
              "line_total"
            ]
          }
        }
      },
      required: ["lines"]
    };

    const headerSystemPrompt =
      "You extract invoice header fields from equipment parts invoices. " +
      "Return only the fields requested in the JSON schema. " +
      "Use empty strings for missing text values and 0 for missing numeric values. " +
      "Read carefully from the invoice text. " +
      "Freight and drop shipment should be header-level numeric charges when shown. " +
      "Do not include line items in this step.";

    const headerUserPrompt =
      "Extract only the invoice header fields from this invoice text.\n\n" +
      buildHeaderText(invoiceText);

    console.log("Calling OpenAI for header extraction");

    const headerData = await callOpenAIWithSchema({
      systemPrompt: headerSystemPrompt,
      userPrompt: headerUserPrompt,
      schema: headerSchema,
      schemaName: "invoice_header_extraction"
    });

    const lineChunks = splitLinesIntoChunks(invoiceText, 4500, 4);
    console.log("Line chunk count:", lineChunks.length);

    const lineSystemPrompt =
      "You extract invoice line items from equipment parts invoices. " +
      "Return only the lines visible in the provided text chunk. " +
      "Do not invent lines. " +
      "Include normal part lines and special charge lines like FREIGHT CHARGE and DROP SHIPMENT. " +
      "For charge lines, set line_type to FREIGHT or DROP_SHIPMENT as appropriate, quantity to 1, unit_price to the charge amount, net_unit_price to the charge amount, and line_total to the charge amount. " +
      "For normal rows, use line_type PART. " +
      "Use empty strings for missing text values and 0 for missing numeric values.";

    const lineResults = [];
    for (let i = 0; i < lineChunks.length; i += 1) {
      console.log(`Calling OpenAI for line chunk ${i + 1} of ${lineChunks.length}`);

      const chunkResult = await callOpenAIWithSchema({
        systemPrompt: lineSystemPrompt,
        userPrompt:
          `Extract only the invoice line items visible in this chunk.\n\n` +
          `Chunk ${i + 1} of ${lineChunks.length}:\n\n` +
          lineChunks[i],
        schema: lineSchema,
        schemaName: `invoice_lines_chunk_${i + 1}`
      });

      lineResults.push(...(chunkResult.lines || []));
    }

    const finalLines = dedupeAndSortLines(lineResults);

    // If the model misses header charges, backfill them from extracted lines.
    const freightFromLines = sumChargesByType(finalLines, "FREIGHT");
    const dropShipFromLines = sumChargesByType(finalLines, "DROP_SHIPMENT");

    const finalResult = {
      vendor: String(headerData.vendor || ""),
      invoice_number: String(headerData.invoice_number || ""),
      invoice_date: String(headerData.invoice_date || ""),
      po_number: String(headerData.po_number || ""),
      order_number: String(headerData.order_number || ""),
      shipment_number: String(headerData.shipment_number || ""),
      terms: String(headerData.terms || ""),
      currency: String(headerData.currency || ""),
      subtotal: Number(headerData.subtotal || 0),
      freight_charge: Number(headerData.freight_charge || freightFromLines || 0),
      drop_ship_charge: Number(headerData.drop_ship_charge || dropShipFromLines || 0),
      misc_charges: Number(headerData.misc_charges || 0),
      total_invoice: Number(headerData.total_invoice || 0),
      lines: finalLines
    };

    return jsonResponse(200, {
      success: true,
      filename: pdfFile.filename,
      mimeType: pdfFile.mimeType,
      fileSize: pdfFile.buffer.length,
      extractedTextLength: invoiceText.length,
      chunkCount: lineChunks.length,
      extracted: finalResult
    });
  } catch (error) {
    console.error("parse-invoice fatal error:", error);

    return jsonResponse(500, {
      success: false,
      error: error.message || "Unknown server error.",
      stack: error.stack || null
    });
  }
};