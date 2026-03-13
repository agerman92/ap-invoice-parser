const Busboy = require("busboy");
const pdf = require("pdf-parse");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

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
    const invoiceText = (pdfData.text || "").trim();

    if (!invoiceText) {
      return jsonResponse(400, {
        success: false,
        error: "Could not extract text from PDF."
      });
    }

    console.log("Extracted PDF text length:", invoiceText.length);

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
        "lines"
      ]
    };

    const openAiPayload = {
      model: OPENAI_MODEL,
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
                "For charge lines like freight or drop shipment, use quantity 1, unit_price equal to the charge amount, net_unit_price equal to the charge amount, and line_total equal to the charge amount."
            }
          ]
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
                invoiceText
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "invoice_extraction",
          strict: true,
          schema
        }
      }
    };

    console.log("Calling OpenAI Responses API");

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
      console.error("OpenAI error:", rawResponseText);
      return jsonResponse(openAiResponse.status, {
        success: false,
        error: "OpenAI request failed.",
        details: rawResponseText
      });
    }

    let openAiJson;
    try {
      openAiJson = JSON.parse(rawResponseText);
    } catch (parseErr) {
      return jsonResponse(500, {
        success: false,
        error: "OpenAI returned non-JSON response.",
        details: rawResponseText
      });
    }

    const extractedText = getResponseText(openAiJson);

    if (!extractedText) {
      return jsonResponse(500, {
        success: false,
        error: "No structured output returned from OpenAI.",
        openai_response: openAiJson
      });
    }

    let extractedJson;
    try {
      extractedJson = JSON.parse(extractedText);
    } catch (parseErr) {
      return jsonResponse(500, {
        success: false,
        error: "Structured output was not valid JSON.",
        details: extractedText
      });
    }

    return jsonResponse(200, {
      success: true,
      filename: pdfFile.filename,
      mimeType: pdfFile.mimeType,
      fileSize: pdfFile.buffer.length,
      extractedTextLength: invoiceText.length,
      extracted: extractedJson
    });
  } catch (error) {
    console.error("parse-invoice fatal error:", error);

    return jsonResponse(500, {
      success: false,
      error: error.message || "Unknown server error."
    });
  }
};