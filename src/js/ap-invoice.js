import { supabase } from "../lib/supabaseClient.js";

const statusMessage = document.getElementById("statusMessage");
const invoiceHeader = document.getElementById("invoiceHeader");
const invoiceWarnings = document.getElementById("invoiceWarnings");
const lineTableBody = document.getElementById("lineTableBody");

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

  renderInvoiceHeader(invoice);
  renderWarnings(invoice.warnings);
  renderLines(lines || []);

  statusMessage.textContent = "Invoice loaded.";
}

function renderInvoiceHeader(invoice) {
  invoiceHeader.innerHTML = `
    <p><strong>File Name:</strong> ${escapeHtml(invoice.file_name || "")}</p>
    <p><strong>Vendor:</strong> ${escapeHtml(invoice.vendor || "")}</p>
    <p><strong>Invoice Number:</strong> ${escapeHtml(invoice.invoice_number || "")}</p>
    <p><strong>Invoice Date:</strong> ${escapeHtml(invoice.invoice_date || "")}</p>
    <p><strong>PO Number:</strong> ${escapeHtml(invoice.po_number || "")}</p>
    <p><strong>Order Number:</strong> ${escapeHtml(invoice.order_number || "")}</p>
    <p><strong>Shipment Number:</strong> ${escapeHtml(invoice.shipment_number || "")}</p>
    <p><strong>Terms:</strong> ${escapeHtml(invoice.terms || "")}</p>
    <p><strong>Currency:</strong> ${escapeHtml(invoice.currency || "")}</p>
    <p><strong>Subtotal:</strong> ${formatCurrency(invoice.subtotal)}</p>
    <p><strong>Freight:</strong> ${formatCurrency(invoice.freight_charge)}</p>
    <p><strong>Drop Ship:</strong> ${formatCurrency(invoice.drop_ship_charge)}</p>
    <p><strong>Misc:</strong> ${formatCurrency(invoice.misc_charges)}</p>
    <p><strong>Total Invoice:</strong> ${formatCurrency(invoice.total_invoice)}</p>
    <p><strong>Status:</strong> ${escapeHtml(invoice.status || "")}</p>
    <p><strong>Review Status:</strong> ${escapeHtml(invoice.review_status || "")}</p>
    <p><strong>Duplicate Status:</strong> ${escapeHtml(invoice.duplicate_status || "")}</p>
    <p><strong>Parse Error:</strong> ${escapeHtml(invoice.parse_error || "")}</p>
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

  lineTableBody.innerHTML = lines.map((line) => `
    <tr>
      <td>${line.line_number ?? ""}</td>
      <td>${escapeHtml(line.line_type || "")}</td>
      <td>${escapeHtml(line.part_number || "")}</td>
      <td>${escapeHtml(line.description || "")}</td>
      <td>${escapeHtml(line.origin || "")}</td>
      <td>${line.quantity ?? ""}</td>
      <td>${formatCurrency(line.unit_price)}</td>
      <td>${line.discount_percent ?? 0}</td>
      <td>${formatCurrency(line.net_unit_price)}</td>
      <td>${formatCurrency(line.line_total)}</td>
    </tr>
  `).join("");
}

function formatCurrency(value) {
  const number = Number(value || 0);
  return number.toLocaleString("en-US", {
    style: "currency",
    currency: "USD"
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

loadInvoiceDetail();