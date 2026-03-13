const pdf = require("pdf-parse");

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  };
}

function normalizeText(text) {
  return (text || "")
    .replace(/\r/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanNumber(value) {
  if (value === undefined || value === null) return 0;
  const cleaned = String(value).replace(/,/g, "").trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function extractMatch(text, regex, group = 1, fallback = "") {
  const match = text.match(regex);
  return match ? String(match[group] || "").trim() : fallback;
}

function parseManitouInvoice(invoiceText) {
  const vendor = extractMatch(
    invoiceText,
    /(MANITOU NORTH AMERICA,\s*LLC)/i
  );

  const invoice_number = extractMatch(
    invoiceText,
    /INVOICE\s+(\d{6,})/i
  );

  const invoice_date =
    extractMatch(
      invoiceText,
      /INVOICE\s+\d{6,}[\s\S]{0,40}?Date\s*:\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i
    ) ||
    extractMatch(
      invoiceText,
      /\bDate\s*:\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i
    );

  const shipment_number = extractMatch(
    invoiceText,
    /SHIPMENT\s*:\s*(\d{6,})/i
  );

  const order_number = extractMatch(
    invoiceText,
    /Order Number\s*:\s*([0-9]+)/i
  );

  const po_number = extractMatch(
    invoiceText,
    /PO Number\s*:\s*([0-9]+)/i
  );

  const terms =
    extractMatch(
      invoiceText,
      /Terms of payment\s*:\s*([^\n]+)/i
    ) ||
    extractMatch(
      invoiceText,
      /AUTO FREIGHT CHARGE\s+([A-Za-z0-9 ]+)/i
    );

  const subtotal = cleanNumber(
    extractMatch(
      invoiceText,
      /Subtotal[\s\S]{0,120}?\n\s*([0-9,]+\.[0-9]{2})\s+[A-Z]{3}\s+[0-9,]+\.[0-9]{2}/i
    )
  );

  const currency =
    extractMatch(
      invoiceText,
      /Subtotal[\s\S]{0,120}?\n\s*[0-9,]+\.[0-9]{2}\s+([A-Z]{3})\s+[0-9,]+\.[0-9]{2}/i
    ) || "USD";

  const total_invoice = cleanNumber(
    extractMatch(
      invoiceText,
      /Subtotal[\s\S]{0,120}?\n\s*[0-9,]+\.[0-9]{2}\s+[A-Z]{3}\s+([0-9,]+\.[0-9]{2})/i
    )
  );

  const drop_ship_charge = cleanNumber(
    extractMatch(invoiceText, /DROP SHIPMENT\s+([0-9,]+\.[0-9]{2})/i)
  );

  const freight_charge = cleanNumber(
    extractMatch(invoiceText, /FREIGHT CHARGE\s+([0-9,]+\.[0-9]{2})/i)
  );

  const misc_charges = 0;

  const lines = [];
  const rows = invoiceText.split("\n");

  let awaitingOriginForIndex = -1;

  for (const rawRow of rows) {
    const row = rawRow.trim();
    if (!row) continue;

    const originMatch = row.match(/^Origin\s*:\s*(.+)$/i);
    if (originMatch) {
      if (awaitingOriginForIndex >= 0 && lines[awaitingOriginForIndex]) {
        lines[awaitingOriginForIndex].origin = originMatch[1].trim();
        awaitingOriginForIndex = -1;
      }
      continue;
    }

    const lineMatch = row.match(
      /^(\d+)\s+([A-Z0-9]+)\s+(.+?)\s+(\d+)\s+([0-9,]+\.[0-9]{2})\s+(\d+)\s*%\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})$/i
    );

    if (lineMatch) {
      lines.push({
        line_number: Number(lineMatch[1]),
        line_type: "PART",
        part_number: lineMatch[2].trim(),
        description: lineMatch[3].trim(),
        origin: "",
        quantity: cleanNumber(lineMatch[4]),
        unit_price: cleanNumber(lineMatch[5]),
        discount_percent: cleanNumber(lineMatch[6]),
        net_unit_price: cleanNumber(lineMatch[7]),
        line_total: cleanNumber(lineMatch[8])
      });

      awaitingOriginForIndex = lines.length - 1;
    }
  }

  if (drop_ship_charge > 0) {
    lines.push({
      line_number: lines.length + 1,
      line_type: "DROP_SHIPMENT",
      part_number: "",
      description: "DROP SHIPMENT",
      origin: "",
      quantity: 1,
      unit_price: drop_ship_charge,
      discount_percent: 0,
      net_unit_price: drop_ship_charge,
      line_total: drop_ship_charge
    });
  }

  if (freight_charge > 0) {
    lines.push({
      line_number: lines.length + 1,
      line_type: "FREIGHT",
      part_number: "",
      description: "FREIGHT CHARGE",
      origin: "",
      quantity: 1,
      unit_price: freight_charge,
      discount_percent: 0,
      net_unit_price: freight_charge,
      line_total: freight_charge
    });
  }

  return {
    vendor,
    invoice_number,
    invoice_date,
    po_number,
    order_number,
    shipment_number,
    terms,
    currency,
    subtotal,
    freight_charge,
    drop_ship_charge,
    misc_charges,
    total_invoice,
    lines
  };
}

function validateParsedInvoice(parsed) {
  const requiredTop = [
    "vendor",
    "invoice_number",
    "invoice_date",
    "po_number",
    "order_number",
    "shipment_number"
  ];

  for (const key of requiredTop) {
    if (!parsed[key]) {
      return `Missing required field: ${key}`;
    }
  }

  if (!Array.isArray(parsed.lines) || parsed.lines.length === 0) {
    return "No invoice lines were parsed.";
  }

  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      success: false,
      error: "Method not allowed. Use POST."
    });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { filename, mimeType, fileDataBase64 } = body;

    if (!fileDataBase64) {
      return jsonResponse(400, {
        success: false,
        error: "Missing fileDataBase64 in request body."
      });
    }

    const pdfBuffer = Buffer.from(fileDataBase64, "base64");

    if (!pdfBuffer.length) {
      return jsonResponse(400, {
        success: false,
        error: "Decoded PDF buffer was empty."
      });
    }

    const pdfData = await pdf(pdfBuffer);
    const invoiceText = normalizeText(pdfData.text || "");

    if (!invoiceText) {
      return jsonResponse(400, {
        success: false,
        error: "Could not extract text from PDF."
      });
    }

    if (!/MANITOU NORTH AMERICA,\s*LLC/i.test(invoiceText)) {
      return jsonResponse(400, {
        success: false,
        error: "This deterministic parser currently supports Manitou invoices only.",
        textPreview: invoiceText.slice(0, 1200)
      });
    }

    const extracted = parseManitouInvoice(invoiceText);
    const validationError = validateParsedInvoice(extracted);

    if (validationError) {
      return jsonResponse(500, {
        success: false,
        error: validationError,
        extractedTextLength: invoiceText.length,
        textPreview: invoiceText.slice(0, 1500),
        partialExtracted: extracted
      });
    }

    return jsonResponse(200, {
      success: true,
      filename: filename || "upload.pdf",
      mimeType: mimeType || "application/pdf",
      fileSize: pdfBuffer.length,
      extractedTextLength: invoiceText.length,
      extracted
    });
  } catch (error) {
    return jsonResponse(500, {
      success: false,
      error: error.message || "Unknown server error.",
      stack: error.stack || null
    });
  }
};