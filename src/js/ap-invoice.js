import { supabase } from "../lib/supabaseClient.js";

const statusMessage = document.getElementById("statusMessage");
const invoiceHeaderForm = document.getElementById("invoiceHeaderForm");
const invoiceWarnings = document.getElementById("invoiceWarnings");
const invoiceExceptions = document.getElementById("invoiceExceptions");
const financialChecks = document.getElementById("financialChecks");
const invoiceSummaryBar = document.getElementById("invoiceSummaryBar");
const lineTableBody = document.getElementById("lineTableBody");
const saveButton = document.getElementById("saveButton");
const approveButton = document.getElementById("approveButton");
const holdButton = document.getElementById("holdButton");
const rejectButton = document.getElementById("rejectButton");
const duplicateButton = document.getElementById("duplicateButton");
const rerunParserButton = document.getElementById("rerunParserButton");
const prevInvoiceButton = document.getElementById("prevInvoiceButton");
const nextInvoiceButton = document.getElementById("nextInvoiceButton");
const reloadPdfButton = document.getElementById("reloadPdfButton");
const reloadDebugButton = document.getElementById("reloadDebugButton");
const pdfFrame = document.getElementById("pdfFrame");
const pdfFallback = document.getElementById("pdfFallback");
const openPdfLink = document.getElementById("openPdfLink");
const apNotes = document.getElementById("apNotes");
const holdReason = document.getElementById("holdReason");
const rejectionReason = document.getElementById("rejectionReason");

const debugExtractionId = document.getElementById("debugExtractionId");
const debugParserVersion = document.getElementById("debugParserVersion");
const debugExtractionStatus = document.getElementById("debugExtractionStatus");
const debugModel = document.getElementById("debugModel");
const debugStartedAt = document.getElementById("debugStartedAt");
const debugCompletedAt = document.getElementById("debugCompletedAt");
const debugProcessingTime = document.getElementById("debugProcessingTime");
const debugVendorMatchMethod = document.getElementById("debugVendorMatchMethod");
const debugErrorMessage = document.getElementById("debugErrorMessage");
const debugWarnings = document.getElementById("debugWarnings");
const debugStructuredJson = document.getElementById("debugStructuredJson");
const debugRawText = document.getElementById("debugRawText");

let currentInvoice = null;
let currentLines = [];
let currentUser = null;
let latestExtraction = null;
let invoiceNavigationList = [];

async function initPage() {
  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) {
      console.warn("Could not load authenticated user:", userError);
    }
    currentUser = userData?.user || null;

    saveButton.addEventListener("click", saveChanges);
    approveButton.addEventListener("click", approveInvoice);
    holdButton.addEventListener("click", putInvoiceOnHold);
    rejectButton.addEventListener("click", rejectInvoice);
    duplicateButton.addEventListener("click", markDuplicate);
    rerunParserButton.addEventListener("click", rerunParser);
    prevInvoiceButton.addEventListener("click", goToPreviousInvoice);
    nextInvoiceButton.addEventListener("click", goToNextInvoice);
    reloadPdfButton.addEventListener("click", reloadPdf);
    reloadDebugButton.addEventListener("click", reloadDebugPanel);
    invoiceHeaderForm.addEventListener("input", renderFinancialChecks);
    lineTableBody.addEventListener("input", renderFinancialChecks);

    await loadInvoiceNavigation();
    await loadInvoiceDetail();
  } catch (error) {
    console.error(error);
    statusMessage.textContent = `Error initializing page: ${error.message}`;
  }
}

async function loadInvoiceNavigation() {
  const { data, error } = await supabase
    .from("ap_invoices")
    .select("id")
    .order("review_priority", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    console.warn("Could not load invoice navigation:", error);
    invoiceNavigationList = [];
    return;
  }

  invoiceNavigationList = data || [];
}

function getCurrentInvoiceId() {
  const params = new URLSearchParams(window.location.search);
  return params.get("id");
}

function goToInvoiceByIndex(index) {
  if (index < 0 || index >= invoiceNavigationList.length) return;
  const targetId = invoiceNavigationList[index]?.id;
  if (!targetId) return;
  window.location.href = `./ap-invoice.html?id=${targetId}`;
}

function goToPreviousInvoice() {
  const currentId = getCurrentInvoiceId();
  const idx = invoiceNavigationList.findIndex((item) => item.id === currentId);
  if (idx > 0) {
    goToInvoiceByIndex(idx - 1);
  }
}

function goToNextInvoice() {
  const currentId = getCurrentInvoiceId();
  const idx = invoiceNavigationList.findIndex((item) => item.id === currentId);
  if (idx >= 0 && idx < invoiceNavigationList.length - 1) {
    goToInvoiceByIndex(idx + 1);
  }
}

function updateNavigationButtons() {
  const currentId = getCurrentInvoiceId();
  const idx = invoiceNavigationList.findIndex((item) => item.id === currentId);
  prevInvoiceButton.disabled = idx <= 0;
  nextInvoiceButton.disabled = idx < 0 || idx >= invoiceNavigationList.length - 1;
}

async function loadInvoiceDetail() {
  const invoiceId = getCurrentInvoiceId();

  if (!invoiceId) {
    statusMessage.textContent = "Missing invoice ID.";
    return;
  }

  statusMessage.textContent = "Loading invoice...";

  const { data: invoice, error: invoiceError } = await supabase
    .from("ap_invoices")
    .select("*")
    .eq("id", invoiceId)
    .single();

  if (invoiceError) {
    console.error("Error loading invoice header:", invoiceError);
    statusMessage.textContent = `Error loading invoice: ${invoiceError.message}`;
    return;
  }

  const { data: lines, error: linesError } = await supabase
    .from("ap_invoice_lines")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("line_number", { ascending: true });

  if (linesError) {
    console.error("Error loading invoice lines:", linesError);
    statusMessage.textContent = `Error loading invoice lines: ${linesError.message}`;
    return;
  }

  currentInvoice = invoice;
  currentLines = lines || [];

  renderWorkflowValues(invoice);
  renderWarnings(invoice.warnings);
  renderExceptions(invoice.exception_flags, invoice.review_priority);
  await loadPdfPreview(invoice);
  await loadLatestExtraction(invoice.id, invoice.invoice_number);

  renderInvoiceHeaderForm(invoice);
  renderLines(currentLines);
  renderInvoiceSummaryBar();
  renderFinancialChecks();
  updateNavigationButtons();

  statusMessage.textContent = "Invoice loaded.";
}

async function loadPdfPreview(invoice) {
  pdfFallback.classList.add("hidden");
  pdfFrame.classList.remove("hidden");
  pdfFrame.removeAttribute("src");
  openPdfLink.href = "#";

  if (!invoice?.storage_path) {
    pdfFrame.classList.add("hidden");
    pdfFallback.classList.remove("hidden");
    pdfFallback.textContent = "No storage path found for this invoice PDF.";
    return;
  }

  try {
    const { data, error } = await supabase.storage
      .from("ap-invoices")
      .createSignedUrl(invoice.storage_path, 3600);

    if (error) throw error;
    if (!data?.signedUrl) {
      throw new Error("No signed PDF URL returned.");
    }

    pdfFrame.src = data.signedUrl;
    openPdfLink.href = data.signedUrl;
  } catch (error) {
    console.error("PDF preview load failed:", error);
    pdfFrame.classList.add("hidden");
    pdfFallback.classList.remove("hidden");
    pdfFallback.textContent = `PDF preview could not be loaded: ${error.message}`;
  }
}

async function loadLatestExtraction(invoiceId, invoiceNumber = "") {
  const { data, error } = await supabase
    .from("ap_invoice_extractions")
    .select(`
      id,
      invoice_id,
      status,
      parser_version,
      prompt_version,
      schema_version,
      model,
      raw_text,
      structured_json,
      warnings,
      header_confidence,
      line_confidence,
      started_at,
      completed_at,
      error_message,
      created_at
    `)
    .eq("invoice_id", invoiceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Error loading extraction debug:", error);
    renderDebugFallback(`Failed to load extraction debug: ${error.message}`);
    latestExtraction = null;
    return;
  }

  latestExtraction = data || null;

  if (!latestExtraction) {
    renderDebugFallback(
      `No extraction record found for this invoice yet. invoiceId=${invoiceId}${invoiceNumber ? `, invoiceNumber=${invoiceNumber}` : ""}`
    );
    return;
  }

  renderDebugPanel(latestExtraction);
}

async function reloadPdf() {
  if (!currentInvoice) return;
  statusMessage.textContent = "Reloading PDF preview...";
  await loadPdfPreview(currentInvoice);
  statusMessage.textContent = "PDF preview reloaded.";
}

async function reloadDebugPanel() {
  if (!currentInvoice) return;
  statusMessage.textContent = "Refreshing debug panel...";
  await loadLatestExtraction(currentInvoice.id, currentInvoice.invoice_number);
  renderInvoiceHeaderForm(currentInvoice);
  renderLines(currentLines);
  renderInvoiceSummaryBar();
  renderFinancialChecks();
  statusMessage.textContent = "Debug panel refreshed.";
}

function renderWorkflowValues(invoice) {
  apNotes.value = invoice.ap_notes || "";
  holdReason.value = invoice.hold_reason || "";
  rejectionReason.value = invoice.rejection_reason || "";
}

function renderInvoiceSummaryBar() {
  const vendor = currentInvoice?.vendor || "Unknown Vendor";
  const parser = latestExtraction?.parser_version || "Unknown Parser";
  const priority = Number(currentInvoice?.review_priority || 0);
  const vendorMatchMethod = currentInvoice?.vendor_match_method || "n/a";
  const total = Number(currentInvoice?.total_invoice || 0);

  invoiceSummaryBar.innerHTML = `
    <span class="summary-pill">Vendor: ${escapeHtml(vendor)}</span>
    <span class="summary-pill">Parser: ${escapeHtml(parser)}</span>
    <span class="summary-pill">Priority: ${priority}</span>
    <span class="summary-pill">Vendor Match: ${escapeHtml(vendorMatchMethod)}</span>
    <span class="summary-pill">Total: ${escapeHtml(formatCurrency(total))}</span>
  `;
}

function renderInvoiceHeaderForm(invoice) {
  invoiceHeaderForm.innerHTML = `
    ${buildInput("file_name", "File Name", invoice.file_name || "", true)}
    ${buildInput("vendor", "Vendor", invoice.vendor || "")}
    ${buildInput("invoice_number", "Invoice Number", invoice.invoice_number || "")}
    ${buildInput("invoice_date", "Invoice Date", invoice.invoice_date || "")}
    ${buildInput("po_number", "PO Number", invoice.po_number || "")}
    ${buildInput("order_number", "Order Number", invoice.order_number || "")}
    ${buildInput("shipment_number", "Shipment Number", invoice.shipment_number || "")}
    ${buildInput("terms", "Terms", invoice.terms || "")}
    ${buildInput("currency", "Currency", invoice.currency || "")}
    ${buildInput("subtotal", "Subtotal", invoice.subtotal ?? 0, false, "number", "0.01")}
    ${buildInput("freight_charge", "Freight", invoice.freight_charge ?? 0, false, "number", "0.01")}
    ${buildInput("drop_ship_charge", "Drop Ship", invoice.drop_ship_charge ?? 0, false, "number", "0.01")}
    ${buildInput("misc_charges", "Misc", invoice.misc_charges ?? 0, false, "number", "0.01")}
    ${buildInput("total_invoice", "Total Invoice", invoice.total_invoice ?? 0, false, "number", "0.01")}
    ${buildInput("status", "Status", invoice.status || "", true)}
    ${buildInput("review_status", "Review Status", invoice.review_status || "", true)}
    ${buildInput("duplicate_status", "Duplicate Status", invoice.duplicate_status || "", true)}
    ${buildTextArea("parse_error", "Parse Error", invoice.parse_error || "", true)}
  `;
}

function buildInput(name, label, value, readonly = false, type = "text", step = "") {
  const stepAttr = step ? `step="${step}"` : "";
  const readonlyAttr = readonly ? "readonly" : "";
  const confidence = getHeaderConfidence(name);
  const groupClass = confidenceClass(confidence);
  const badgeHtml = confidenceBadge(confidence);

  return `
    <div class="field-group ${groupClass}" data-field="${name}">
      <label for="${name}">
        <span>${label}</span>
        ${badgeHtml}
      </label>
      <input
        id="${name}"
        name="${name}"
        type="${type}"
        value="${escapeAttribute(value)}"
        ${readonlyAttr}
        ${stepAttr}
      />
    </div>
  `;
}

function buildTextArea(name, label, value, readonly = false) {
  const readonlyAttr = readonly ? "readonly" : "";
  const confidence = getHeaderConfidence(name);
  const groupClass = confidenceClass(confidence);
  const badgeHtml = confidenceBadge(confidence);

  return `
    <div class="field-group field-full ${groupClass}" data-field="${name}">
      <label for="${name}">
        <span>${label}</span>
        ${badgeHtml}
      </label>
      <textarea id="${name}" name="${name}" rows="3" ${readonlyAttr}>${escapeHtml(value)}</textarea>
    </div>
  `;
}

function renderWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) {
    invoiceWarnings.innerHTML = "<p>No warnings.</p>";
    return;
  }

  invoiceWarnings.innerHTML = `
    <ul>
      ${warnings.map((warning) => `
        <li>
          <strong>${escapeHtml(warning.code || "")}</strong>:
          ${escapeHtml(warning.message || "")}
          (${escapeHtml(warning.severity || "")})
        </li>
      `).join("")}
    </ul>
  `;
}

function renderExceptions(flags, priority) {
  if (!Array.isArray(flags) || flags.length === 0) {
    invoiceExceptions.innerHTML = `<p>No exception flags. Review priority: <strong>${Number(priority || 0)}</strong></p>`;
    return;
  }

  invoiceExceptions.innerHTML = `
    <p><strong>Review priority:</strong> ${Number(priority || 0)}</p>
    <ul>
      ${flags.map((flag) => `
        <li>
          <strong>${escapeHtml(flag.code || "")}</strong>:
          ${escapeHtml(flag.message || "")}
          (${escapeHtml(flag.severity || "")})
        </li>
      `).join("")}
    </ul>
  `;
}

function getDuplicatePartNumbers(lines) {
  const counts = new Map();

  for (const line of lines) {
    const key = String(line.part_number || "").trim().toUpperCase();
    if (!key || key === "NULL") continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const duplicates = new Set();
  for (const [key, count] of counts.entries()) {
    if (count > 1) duplicates.add(key);
  }

  return duplicates;
}

function renderLines(lines) {
  if (!lines.length) {
    lineTableBody.innerHTML = `
      <tr>
        <td colspan="10">No lines found.</td>
      </tr>
    `;
    return;
  }

  const duplicateParts = getDuplicatePartNumbers(lines);

  lineTableBody.innerHTML = lines.map((line, index) => {
    const duplicateKey = String(line.part_number || "").trim().toUpperCase();
    const duplicateClass = duplicateParts.has(duplicateKey) ? "line-duplicate" : "";

    return `
      <tr data-line-index="${index}" class="${duplicateClass}">
        <td><input class="line-input ${lineConfidenceClass(line.line_number, "line_number")}" data-field="line_number" type="number" value="${line.line_number ?? index + 1}" /></td>
        <td>
          <select class="line-input ${lineConfidenceClass(line.line_number, "line_type")}" data-field="line_type">
            <option value="PART" ${line.line_type === "PART" ? "selected" : ""}>PART</option>
            <option value="FREIGHT" ${line.line_type === "FREIGHT" ? "selected" : ""}>FREIGHT</option>
            <option value="DROP_SHIPMENT" ${line.line_type === "DROP_SHIPMENT" ? "selected" : ""}>DROP_SHIPMENT</option>
            <option value="MISC" ${line.line_type === "MISC" ? "selected" : ""}>MISC</option>
          </select>
        </td>
        <td><input class="line-input ${lineConfidenceClass(line.line_number, "part_number")}" data-field="part_number" type="text" value="${escapeAttribute(line.part_number || "")}" /></td>
        <td><input class="line-input ${lineConfidenceClass(line.line_number, "description")}" data-field="description" type="text" value="${escapeAttribute(line.description || "")}" /></td>
        <td><input class="line-input ${lineConfidenceClass(line.line_number, "origin")}" data-field="origin" type="text" value="${escapeAttribute(line.origin || "")}" /></td>
        <td><input class="line-input ${lineConfidenceClass(line.line_number, "quantity")}" data-field="quantity" type="number" step="0.01" value="${line.quantity ?? 0}" /></td>
        <td><input class="line-input ${lineConfidenceClass(line.line_number, "unit_price")}" data-field="unit_price" type="number" step="0.01" value="${line.unit_price ?? 0}" /></td>
        <td><input class="line-input ${lineConfidenceClass(line.line_number, "discount_percent")}" data-field="discount_percent" type="number" step="0.01" value="${line.discount_percent ?? 0}" /></td>
        <td><input class="line-input ${lineConfidenceClass(line.line_number, "net_unit_price")}" data-field="net_unit_price" type="number" step="0.01" value="${line.net_unit_price ?? 0}" /></td>
        <td><input class="line-input ${lineConfidenceClass(line.line_number, "line_total")}" data-field="line_total" type="number" step="0.01" value="${line.line_total ?? 0}" /></td>
      </tr>
    `;
  }).join("");
}

function renderFinancialChecks() {
  const subtotal = getNumericValue("subtotal");
  const freight = getNumericValue("freight_charge");
  const dropShip = getNumericValue("drop_ship_charge");
  const misc = getNumericValue("misc_charges");
  const totalInvoice = getNumericValue("total_invoice");

  const expectedHeaderTotal = subtotal + freight + dropShip + misc;
  const headerDifference = roundCurrency(totalInvoice - expectedHeaderTotal);

  const editedLines = getEditedLines();
  const lineSubtotal = roundCurrency(
    editedLines.reduce((sum, line) => sum + Number(line.line_total || 0), 0)
  );
  const lineDifference = roundCurrency(totalInvoice - lineSubtotal);

  const headerStatusClass = Math.abs(headerDifference) <= 0.05 ? "financial-ok" : "financial-warn";
  const lineStatusClass = Math.abs(lineDifference) <= 0.05 ? "financial-ok" : "financial-warn";

  financialChecks.innerHTML = `
    <div class="financial-grid">
      <div class="financial-card">
        <div class="financial-title">Header Total Validation</div>
        <div class="financial-row"><span>Subtotal + charges</span><span>${formatCurrency(expectedHeaderTotal)}</span></div>
        <div class="financial-row"><span>Invoice total</span><span>${formatCurrency(totalInvoice)}</span></div>
        <div class="financial-row"><span>Difference</span><span class="${headerStatusClass}">${formatCurrency(headerDifference)}</span></div>
        <div class="financial-row"><span>Status</span><span class="${headerStatusClass}">${Math.abs(headerDifference) <= 0.05 ? "Totals match" : "Totals mismatch"}</span></div>
      </div>

      <div class="financial-card">
        <div class="financial-title">Line Total Preview</div>
        <div class="financial-row"><span>Sum of line totals</span><span>${formatCurrency(lineSubtotal)}</span></div>
        <div class="financial-row"><span>Invoice total</span><span>${formatCurrency(totalInvoice)}</span></div>
        <div class="financial-row"><span>Difference</span><span class="${lineStatusClass}">${formatCurrency(lineDifference)}</span></div>
        <div class="financial-row"><span>Status</span><span class="${lineStatusClass}">${Math.abs(lineDifference) <= 0.05 ? "Lines match invoice" : "Lines differ from invoice"}</span></div>
      </div>
    </div>
  `;
}

function renderDebugPanel(extraction) {
  if (!extraction) {
    renderDebugFallback("No extraction record found for this invoice yet.");
    return;
  }

  debugExtractionId.textContent = extraction.id || "";
  debugParserVersion.textContent = extraction.parser_version || "";
  debugExtractionStatus.textContent = extraction.status || "";
  debugModel.textContent = extraction.model || "";
  debugStartedAt.textContent = formatDateTime(extraction.started_at);
  debugCompletedAt.textContent = formatDateTime(extraction.completed_at);
  debugProcessingTime.textContent = calculateProcessingTime(extraction.started_at, extraction.completed_at);
  debugVendorMatchMethod.textContent = currentInvoice?.vendor_match_method || "n/a";
  debugErrorMessage.textContent = extraction.error_message || "None";

  const storedWarnings = Array.isArray(extraction.warnings) ? extraction.warnings : [];
  if (!storedWarnings.length) {
    debugWarnings.innerHTML = "<p>No stored warnings.</p>";
  } else {
    debugWarnings.innerHTML = `
      <ul>
        ${storedWarnings.map((warning) => `
          <li>
            <strong>${escapeHtml(warning.code || "")}</strong>:
            ${escapeHtml(warning.message || "")}
            (${escapeHtml(warning.severity || "")})
          </li>
        `).join("")}
      </ul>
    `;
  }

  debugStructuredJson.textContent = prettyJson(extraction.structured_json);
  debugRawText.textContent = (extraction.raw_text || "").slice(0, 12000) || "No raw text stored.";
}

function renderDebugFallback(message) {
  debugExtractionId.textContent = "";
  debugParserVersion.textContent = "";
  debugExtractionStatus.textContent = "";
  debugModel.textContent = "";
  debugStartedAt.textContent = "";
  debugCompletedAt.textContent = "";
  debugProcessingTime.textContent = "";
  debugVendorMatchMethod.textContent = "";
  debugErrorMessage.textContent = message;
  debugWarnings.innerHTML = "<p>No stored warnings.</p>";
  debugStructuredJson.textContent = "";
  debugRawText.textContent = "";
}

function calculateProcessingTime(startedAt, completedAt) {
  if (!startedAt || !completedAt) return "N/A";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "N/A";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} sec`;
}

function getHeaderValues() {
  return {
    vendor: getInputValue("vendor"),
    invoice_number: getInputValue("invoice_number"),
    invoice_date: getInputValue("invoice_date"),
    po_number: getInputValue("po_number"),
    order_number: getInputValue("order_number"),
    shipment_number: getInputValue("shipment_number"),
    terms: getInputValue("terms"),
    currency: getInputValue("currency"),
    subtotal: getNumericValue("subtotal"),
    freight_charge: getNumericValue("freight_charge"),
    drop_ship_charge: getNumericValue("drop_ship_charge"),
    misc_charges: getNumericValue("misc_charges"),
    total_invoice: getNumericValue("total_invoice"),
    ap_notes: apNotes.value.trim(),
    hold_reason: holdReason.value.trim(),
    rejection_reason: rejectionReason.value.trim()
  };
}

function getEditedLines() {
  const rows = Array.from(lineTableBody.querySelectorAll("tr[data-line-index]"));

  return rows.map((row) => ({
    invoice_id: currentInvoice.id,
    line_number: getRowNumberValue(row, "line_number"),
    line_type: getRowValue(row, "line_type") || "PART",
    part_number: getRowValue(row, "part_number"),
    description: getRowValue(row, "description"),
    origin: getRowValue(row, "origin"),
    quantity: getRowNumericValue(row, "quantity"),
    unit_price: getRowNumericValue(row, "unit_price"),
    discount_percent: getRowNumericValue(row, "discount_percent"),
    net_unit_price: getRowNumericValue(row, "net_unit_price"),
    line_total: getRowNumericValue(row, "line_total")
  }));
}

async function saveChanges() {
  if (!currentInvoice) return;

  try {
    setBusyState(true, "Saving changes...");

    const editedHeader = getHeaderValues();
    const editedLines = getEditedLines();
    const auditEvents = buildHeaderAuditEvents(currentInvoice, editedHeader);

    const { error: updateInvoiceError } = await supabase
      .from("ap_invoices")
      .update({
        ...editedHeader,
        review_status: "in_review"
      })
      .eq("id", currentInvoice.id);

    if (updateInvoiceError) throw updateInvoiceError;

    const { error: deleteLinesError } = await supabase
      .from("ap_invoice_lines")
      .delete()
      .eq("invoice_id", currentInvoice.id);

    if (deleteLinesError) throw deleteLinesError;

    if (editedLines.length > 0) {
      const { error: insertLinesError } = await supabase
        .from("ap_invoice_lines")
        .insert(editedLines);

      if (insertLinesError) throw insertLinesError;
    }

    if (auditEvents.length > 0) {
      const { error: auditError } = await supabase
        .from("ap_invoice_review_events")
        .insert(auditEvents);

      if (auditError) throw auditError;
    }

    await loadInvoiceDetail();
    setBusyState(false, "Changes saved successfully.");
  } catch (error) {
    console.error("Save failed:", error);
    setBusyState(false, `Save failed: ${error.message}`);
  }
}

async function approveInvoice() {
  if (!currentInvoice) return;

  try {
    setBusyState(true, "Approving invoice...");

    const workflowEvents = buildWorkflowAuditEvents(currentInvoice, {
      ap_notes: apNotes.value.trim(),
      hold_reason: "",
      rejection_reason: "",
      review_status: "approved"
    });

    const { error } = await supabase
      .from("ap_invoices")
      .update({
        status: "approved",
        review_status: "approved",
        approved_at: new Date().toISOString(),
        ap_notes: apNotes.value.trim(),
        hold_reason: null,
        rejection_reason: null
      })
      .eq("id", currentInvoice.id);

    if (error) throw error;

    if (workflowEvents.length > 0) {
      await supabase.from("ap_invoice_review_events").insert(workflowEvents);
    }

    await loadInvoiceDetail();
    setBusyState(false, "Invoice approved.");
  } catch (error) {
    console.error("Approve failed:", error);
    setBusyState(false, `Approve failed: ${error.message}`);
  }
}

async function putInvoiceOnHold() {
  if (!currentInvoice) return;

  try {
    setBusyState(true, "Putting invoice on hold...");

    const workflowEvents = buildWorkflowAuditEvents(currentInvoice, {
      ap_notes: apNotes.value.trim(),
      hold_reason: holdReason.value.trim(),
      rejection_reason: rejectionReason.value.trim(),
      review_status: "in_review"
    });

    const { error } = await supabase
      .from("ap_invoices")
      .update({
        status: "needs_review",
        review_status: "in_review",
        ap_notes: apNotes.value.trim(),
        hold_reason: holdReason.value.trim() || null,
        rejection_reason: rejectionReason.value.trim() || null
      })
      .eq("id", currentInvoice.id);

    if (error) throw error;

    if (workflowEvents.length > 0) {
      await supabase.from("ap_invoice_review_events").insert(workflowEvents);
    }

    await loadInvoiceDetail();
    setBusyState(false, "Invoice placed on hold.");
  } catch (error) {
    console.error("Hold failed:", error);
    setBusyState(false, `Hold failed: ${error.message}`);
  }
}

async function rejectInvoice() {
  if (!currentInvoice) return;

  try {
    setBusyState(true, "Rejecting invoice...");

    const workflowEvents = buildWorkflowAuditEvents(currentInvoice, {
      ap_notes: apNotes.value.trim(),
      hold_reason: holdReason.value.trim(),
      rejection_reason: rejectionReason.value.trim(),
      review_status: "rejected"
    });

    const { error } = await supabase
      .from("ap_invoices")
      .update({
        status: "needs_review",
        review_status: "rejected",
        ap_notes: apNotes.value.trim(),
        hold_reason: holdReason.value.trim() || null,
        rejection_reason: rejectionReason.value.trim() || null
      })
      .eq("id", currentInvoice.id);

    if (error) throw error;

    if (workflowEvents.length > 0) {
      await supabase.from("ap_invoice_review_events").insert(workflowEvents);
    }

    await loadInvoiceDetail();
    setBusyState(false, "Invoice rejected.");
  } catch (error) {
    console.error("Reject failed:", error);
    setBusyState(false, `Reject failed: ${error.message}`);
  }
}

async function markDuplicate() {
  if (!currentInvoice) return;

  try {
    setBusyState(true, "Marking invoice as duplicate...");

    const { error } = await supabase
      .from("ap_invoices")
      .update({
        status: "duplicate",
        duplicate_status: "confirmed",
        review_status: "in_review",
        ap_notes: apNotes.value.trim(),
        hold_reason: holdReason.value.trim() || null,
        rejection_reason: rejectionReason.value.trim() || null
      })
      .eq("id", currentInvoice.id);

    if (error) throw error;

    await supabase
      .from("ap_invoice_review_events")
      .insert([{
        invoice_id: currentInvoice.id,
        field_name: "duplicate_status",
        old_value: currentInvoice.duplicate_status,
        new_value: "confirmed",
        changed_by: currentUser?.id || null,
        change_reason: "Marked duplicate during AP review"
      }]);

    await loadInvoiceDetail();
    setBusyState(false, "Invoice marked as duplicate.");
  } catch (error) {
    console.error("Duplicate action failed:", error);
    setBusyState(false, `Duplicate action failed: ${error.message}`);
  }
}

async function rerunParser() {
  if (!currentInvoice?.id) return;

  try {
    setBusyState(true, "Re-queueing invoice for parsing...");

    const { data, error } = await supabase.functions.invoke("enqueue-invoice", {
      body: { invoiceId: currentInvoice.id }
    });

    if (error) throw error;

    await supabase
      .from("ap_invoice_review_events")
      .insert([{
        invoice_id: currentInvoice.id,
        field_name: "status",
        old_value: currentInvoice.status,
        new_value: "queued",
        changed_by: currentUser?.id || null,
        change_reason: "Invoice manually re-queued for parsing"
      }]);

    await loadInvoiceDetail();
    setBusyState(false, `Invoice re-queued successfully. ${data?.jobId ? `Job ID: ${data.jobId}` : ""}`);
  } catch (error) {
    console.error("Re-run parser failed:", error);
    setBusyState(false, `Re-run parser failed: ${error.message}`);
  }
}

function buildHeaderAuditEvents(original, edited) {
  const fields = [
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
    "ap_notes",
    "hold_reason",
    "rejection_reason"
  ];

  const events = [];

  for (const field of fields) {
    const oldValue = original[field] ?? null;
    const newValue = edited[field] ?? null;

    if (String(oldValue) !== String(newValue)) {
      events.push({
        invoice_id: original.id,
        field_name: field,
        old_value: oldValue,
        new_value: newValue,
        changed_by: currentUser?.id || null,
        change_reason: "Manual AP review edit"
      });
    }
  }

  return events;
}

function buildWorkflowAuditEvents(original, edited) {
  const fields = ["ap_notes", "hold_reason", "rejection_reason", "review_status"];
  const events = [];

  for (const field of fields) {
    const oldValue = original[field] ?? null;
    const newValue = edited[field] ?? null;

    if (String(oldValue) !== String(newValue)) {
      events.push({
        invoice_id: original.id,
        field_name: field,
        old_value: oldValue,
        new_value: newValue,
        changed_by: currentUser?.id || null,
        change_reason: "Workflow action during AP review"
      });
    }
  }

  return events;
}

function getHeaderConfidence(fieldName) {
  const value = latestExtraction?.header_confidence?.[fieldName];
  return typeof value === "number" ? value : null;
}

function confidenceClass(value) {
  if (value == null) return "";
  if (value < 0.6) return "field-low-confidence";
  if (value < 0.8) return "field-medium-confidence";
  return "";
}

function confidenceBadge(value) {
  if (value == null) return `<span class="confidence-badge confidence-high">N/A</span>`;
  if (value < 0.6) return `<span class="confidence-badge confidence-low">${Math.round(value * 100)}%</span>`;
  if (value < 0.8) return `<span class="confidence-badge confidence-medium">${Math.round(value * 100)}%</span>`;
  return `<span class="confidence-badge confidence-high">${Math.round(value * 100)}%</span>`;
}

function getLineFieldConfidence(lineNumber, fieldName) {
  if (!Array.isArray(latestExtraction?.line_confidence)) return null;
  const row = latestExtraction.line_confidence.find((item) => Number(item.line_number) === Number(lineNumber));
  if (!row) return null;
  const value = row[fieldName];
  return typeof value === "number" ? value : null;
}

function lineConfidenceClass(lineNumber, fieldName) {
  const value = getLineFieldConfidence(lineNumber, fieldName);
  if (value == null) return "";
  if (value < 0.6) return "line-low-confidence";
  if (value < 0.8) return "line-medium-confidence";
  return "";
}

function getInputValue(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

function getNumericValue(id) {
  const el = document.getElementById(id);
  if (!el) return 0;
  const value = Number(el.value);
  return Number.isFinite(value) ? value : 0;
}

function getRowValue(row, field) {
  const el = row.querySelector(`[data-field="${field}"]`);
  return el ? el.value.trim() : "";
}

function getRowNumericValue(row, field) {
  const el = row.querySelector(`[data-field="${field}"]`);
  if (!el) return 0;
  const value = Number(el.value);
  return Number.isFinite(value) ? value : 0;
}

function getRowNumberValue(row, field) {
  const value = getRowNumericValue(row, field);
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function setBusyState(isBusy, message) {
  saveButton.disabled = isBusy;
  approveButton.disabled = isBusy;
  holdButton.disabled = isBusy;
  rejectButton.disabled = isBusy;
  duplicateButton.disabled = isBusy;
  rerunParserButton.disabled = isBusy;
  prevInvoiceButton.disabled = isBusy || prevInvoiceButton.disabled;
  nextInvoiceButton.disabled = isBusy || nextInvoiceButton.disabled;
  reloadPdfButton.disabled = isBusy;
  reloadDebugButton.disabled = isBusy;
  statusMessage.textContent = message;
}

function formatCurrency(value) {
  const number = Number(value || 0);
  return number.toLocaleString("en-US", {
    style: "currency",
    currency: "USD"
  });
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function prettyJson(value) {
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

initPage();