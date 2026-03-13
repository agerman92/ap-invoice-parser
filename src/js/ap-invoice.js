import { supabase } from "../lib/supabaseClient.js";

const statusMessage = document.getElementById("statusMessage");
const invoiceHeaderForm = document.getElementById("invoiceHeaderForm");
const invoiceWarnings = document.getElementById("invoiceWarnings");
const lineTableBody = document.getElementById("lineTableBody");
const saveButton = document.getElementById("saveButton");
const approveButton = document.getElementById("approveButton");
const duplicateButton = document.getElementById("duplicateButton");
const reloadPdfButton = document.getElementById("reloadPdfButton");
const pdfFrame = document.getElementById("pdfFrame");
const pdfFallback = document.getElementById("pdfFallback");
const openPdfLink = document.getElementById("openPdfLink");

let currentInvoice = null;
let currentLines = [];
let currentUser = null;
let currentPdfUrl = null;

async function initPage() {
  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) {
      console.warn("Could not load authenticated user:", userError);
    }
    currentUser = userData?.user || null;

    await loadInvoiceDetail();

    saveButton.addEventListener("click", saveChanges);
    approveButton.addEventListener("click", approveInvoice);
    duplicateButton.addEventListener("click", markDuplicate);
    reloadPdfButton.addEventListener("click", reloadPdf);
  } catch (error) {
    console.error(error);
    statusMessage.textContent = `Error initializing page: ${error.message}`;
  }
}

async function loadInvoiceDetail() {
  const params = new URLSearchParams(window.location.search);
  const invoiceId = params.get("id");

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

  renderInvoiceHeaderForm(invoice);
  renderWarnings(invoice.warnings);
  renderLines(currentLines);
  await loadPdfPreview(invoice);

  statusMessage.textContent = "Invoice loaded.";
}

async function loadPdfPreview(invoice) {
  pdfFallback.style.display = "none";
  pdfFrame.style.display = "block";
  pdfFrame.removeAttribute("src");
  openPdfLink.href = "#";

  if (!invoice?.storage_path) {
    pdfFrame.style.display = "none";
    pdfFallback.style.display = "block";
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

    currentPdfUrl = data.signedUrl;
    pdfFrame.src = currentPdfUrl;
    openPdfLink.href = currentPdfUrl;
  } catch (error) {
    console.error("PDF preview load failed:", error);
    pdfFrame.style.display = "none";
    pdfFallback.style.display = "block";
    pdfFallback.textContent = `PDF preview could not be loaded: ${error.message}`;
  }
}

async function reloadPdf() {
  if (!currentInvoice) return;
  statusMessage.textContent = "Reloading PDF preview...";
  await loadPdfPreview(currentInvoice);
  statusMessage.textContent = "PDF preview reloaded.";
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
  return `
    <div class="field-group">
      <label for="${name}">${label}</label>
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
  return `
    <div class="field-group field-full">
      <label for="${name}">${label}</label>
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

function renderLines(lines) {
  if (!lines.length) {
    lineTableBody.innerHTML = `
      <tr>
        <td colspan="10">No lines found.</td>
      </tr>
    `;
    return;
  }

  lineTableBody.innerHTML = lines.map((line, index) => `
    <tr data-line-index="${index}">
      <td><input class="line-input" data-field="line_number" type="number" value="${line.line_number ?? index + 1}" /></td>
      <td>
        <select class="line-input" data-field="line_type">
          <option value="PART" ${line.line_type === "PART" ? "selected" : ""}>PART</option>
          <option value="FREIGHT" ${line.line_type === "FREIGHT" ? "selected" : ""}>FREIGHT</option>
          <option value="DROP_SHIPMENT" ${line.line_type === "DROP_SHIPMENT" ? "selected" : ""}>DROP_SHIPMENT</option>
          <option value="MISC" ${line.line_type === "MISC" ? "selected" : ""}>MISC</option>
        </select>
      </td>
      <td><input class="line-input" data-field="part_number" type="text" value="${escapeAttribute(line.part_number || "")}" /></td>
      <td><input class="line-input" data-field="description" type="text" value="${escapeAttribute(line.description || "")}" /></td>
      <td><input class="line-input" data-field="origin" type="text" value="${escapeAttribute(line.origin || "")}" /></td>
      <td><input class="line-input" data-field="quantity" type="number" step="0.01" value="${line.quantity ?? 0}" /></td>
      <td><input class="line-input" data-field="unit_price" type="number" step="0.01" value="${line.unit_price ?? 0}" /></td>
      <td><input class="line-input" data-field="discount_percent" type="number" step="0.01" value="${line.discount_percent ?? 0}" /></td>
      <td><input class="line-input" data-field="net_unit_price" type="number" step="0.01" value="${line.net_unit_price ?? 0}" /></td>
      <td><input class="line-input" data-field="line_total" type="number" step="0.01" value="${line.line_total ?? 0}" /></td>
    </tr>
  `).join("");
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
    total_invoice: getNumericValue("total_invoice")
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

    const { error } = await supabase
      .from("ap_invoices")
      .update({
        status: "approved",
        review_status: "approved",
        approved_at: new Date().toISOString()
      })
      .eq("id", currentInvoice.id);

    if (error) throw error;

    await loadInvoiceDetail();
    setBusyState(false, "Invoice approved.");
  } catch (error) {
    console.error("Approve failed:", error);
    setBusyState(false, `Approve failed: ${error.message}`);
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
        review_status: "in_review"
      })
      .eq("id", currentInvoice.id);

    if (error) throw error;

    await loadInvoiceDetail();
    setBusyState(false, "Invoice marked as duplicate.");
  } catch (error) {
    console.error("Duplicate action failed:", error);
    setBusyState(false, `Duplicate action failed: ${error.message}`);
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
    "total_invoice"
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

function setBusyState(isBusy, message) {
  saveButton.disabled = isBusy;
  approveButton.disabled = isBusy;
  duplicateButton.disabled = isBusy;
  reloadPdfButton.disabled = isBusy;
  statusMessage.textContent = message;
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