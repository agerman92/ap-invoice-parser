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

function compactSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function dedupeLines(lines) {
  const seen = new Set();
  const out = [];

  for (const line of lines) {
    const key = [
      line.line_number,
      line.part_number,
      line.description,
      line.quantity,
      line.unit_price,
      line.line_total,
      line.origin
    ].join("|");

    if (!seen.has(key)) {
      seen.add(key);
      out.push(line);
    }
  }

  out.sort((a, b) => a.line_number - b.line_number);
  return out;
}

function parseManitouPartLines(invoiceText) {
  const lines = [];

  // Pattern 1: spaced row layout (common on larger invoices)
  const spacedPattern =
    /(?:^|\n)\s*(\d+)\s+([A-Z0-9]+)\s+(.+?)\s+(\d+)\s+([0-9,]+\.[0-9]{2})\s+(\d+)\s*%\s+([0-9,]+\.[0-9]{2})\s+([0-9,]+\.[0-9]{2})\s*\n\s*Origin\s*:\s*([A-Z]{2,})/gms;

  let match;
  while ((match = spacedPattern.exec(invoiceText)) !== null) {
    lines.push({
      line_number: Number(match[1]),
      line_type: "PART",
      part_number: compactSpaces(match[2]),
      description: compactSpaces(match[3]),
      origin: compactSpaces(match[9]),
      quantity: cleanNumber(match[4]),
      unit_price: cleanNumber(match[5]),
      discount_percent: cleanNumber(match[6]),
      net_unit_price: cleanNumber(match[7]),
      line_total: cleanNumber(match[8])
    });
  }

  // Pattern 2: compact multi-line layout from pdf-parse
  // Example:
  // 1
  // 210722
  // CAP/ VENTED FUEL172.9824 %55.4655.46
  // Origin :US
  const compactPattern =
    /(?:^|\n)\s*(\d+)\s*\n\s*([A-Z0-9]+)\s*\n\s*(.+?)(\d+)([0-9,]+\.[0-9]{2})(\d+)\s*%([0-9,]+\.[0-9]{2})([0-9,]+\.[0-9]{2})\s*\n\s*Origin\s*:\s*([A-Z]{2,})/gms;

  while ((match = compactPattern.exec(invoiceText)) !== null) {
    lines.push({
      line_number: Number(match[1]),
      line_type: "PART",
      part_number: compactSpaces(match[2]),
      description: compactSpaces(match[3]),
      origin: compactSpaces(match[9]),
      quantity: cleanNumber(match[4]),
      unit_price: cleanNumber(match[5]),
      discount_percent: cleanNumber(match[6]),
      net_unit_price: cleanNumber(match[7]),
      line_total: cleanNumber(match[8])
    });
  }

  return dedupeLines(lines);
}

function parseManitouInvoice(invoiceText) {
  const vendor = extractMatch(
    invoiceText,
    /(MANITOU NORTH AMERICA,\s*LLC)/i
  );

  const invoice_number = extractMatch(
    invoiceText,
    /INVOICE\s*\n?\s*(\d{6,})\s*Date\s*:?\s*\n?\s*[0-9]{2}\/[0-9]{2}\/[0-9]{4}/i
  ) || extractMatch(invoiceText, /INVOICE\s*\n?\s*(\d{6,})/i);

  const invoice_date =
    extractMatch(
      invoiceText,
      /INVOICE\s*\n?\s*\d{6,}\s*Date\s*:?\s*\n?\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i
    ) ||
    extractMatch(
      invoiceText,
      /Date\s*:?\s*\n?\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i
    );

  const shipment_number = extractMatch(
    invoiceText,
    /SHIPMENT\s*:\s*(\d{6,})/i
  );

  const order_number = extractMatch(
    invoiceText,
    /Order Number\s*:?\s*([0-9]+)/i
  );

  const po_number = extractMatch(
    invoiceText,
    /PO Number\s*:?\s*([0-9]+)/i
  );

  const terms =
    extractMatch(invoiceText, /\b(Net\s*\d+)\b/i) ||
    extractMatch(invoiceText, /Terms of payment\s*:?\s*([^\n]+)/i);

  const totalsMatch = invoiceText.match(
    /Subtotal[\s\S]{0,100}?([0-9,]+\.[0-9]{2})\s*([A-Z]{3})\s*([0-9,]+\.[0-9]{2})/i
  );

  const subtotal = totalsMatch ? cleanNumber(totalsMatch[1]) : 0;
  const currency = totalsMatch ? compactSpaces(totalsMatch[2]) : "USD";
  const total_invoice = totalsMatch ? cleanNumber(totalsMatch[3]) : 0;

  const drop_ship_charge = cleanNumber(
    extractMatch(invoiceText, /DROP\s*SHIPMENT\s*([0-9,]+\.[0-9]{2})/i)
  );

  const freight_charge = cleanNumber(
    extractMatch(invoiceText, /FREIGHT\s*CHARGE\s*([0-9,]+\.[0-9]{2})/i)
  );

  const misc_charges = 0;

  const lines = parseManitouPartLines(invoiceText);

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
        textPreview: invoiceText.slice(0, 1500)
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