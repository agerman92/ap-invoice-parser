import { supabase } from "../lib/supabaseClient.js";

const statusMessage = document.getElementById("statusMessage");
const invoiceTableBody = document.getElementById("invoiceTableBody");
const poSearch = document.getElementById("poSearch");
const statusFilter = document.getElementById("statusFilter");
const reviewFilter = document.getElementById("reviewFilter");
const duplicateFilter = document.getElementById("duplicateFilter");
const clearFiltersButton = document.getElementById("clearFiltersButton");
const refreshButton = document.getElementById("refreshButton");

let debounceTimer = null;

async function loadInvoices() {
  statusMessage.textContent = "Loading invoices...";

  let query = supabase
    .from("ap_invoices")
    .select(`
      id,
      file_name,
      vendor,
      invoice_number,
      po_number,
      invoice_date,
      total_invoice,
      status,
      review_status,
      duplicate_status,
      created_at,
      warnings
    `)
    .order("created_at", { ascending: false });

  const poValue = poSearch.value.trim();
  const statusValue = statusFilter.value;
  const reviewValue = reviewFilter.value;
  const duplicateValue = duplicateFilter.value;

  if (poValue) {
    query = query.ilike("po_number", `%${poValue}%`);
  }

  if (statusValue) {
    query = query.eq("status", statusValue);
  }

  if (reviewValue) {
    query = query.eq("review_status", reviewValue);
  }

  if (duplicateValue) {
    query = query.eq("duplicate_status", duplicateValue);
  }

  const { data, error } = await query;

  if (error) {
    console.error("Error loading invoices:", error);
    statusMessage.textContent = `Error loading invoices: ${error.message}`;
    invoiceTableBody.innerHTML = "";
    return;
  }

  if (!data || data.length === 0) {
    statusMessage.textContent = "No invoices found.";
    invoiceTableBody.innerHTML = "";
    return;
  }

  statusMessage.textContent = `${data.length} invoice(s) loaded.`;

  invoiceTableBody.innerHTML = data.map((invoice) => {
    const warningCount = Array.isArray(invoice.warnings) ? invoice.warnings.length : 0;

    return `
      <tr>
        <td>${formatDateTime(invoice.created_at)}</td>
        <td>${escapeHtml(invoice.file_name || "")}</td>
        <td>${escapeHtml(invoice.vendor || "")}</td>
        <td>${escapeHtml(invoice.invoice_number || "")}</td>
        <td>${escapeHtml(invoice.po_number || "")}</td>
        <td>${escapeHtml(invoice.invoice_date || "")}</td>
        <td>${formatCurrency(invoice.total_invoice)}</td>
        <td>${escapeHtml(invoice.status || "")}</td>
        <td>${escapeHtml(invoice.review_status || "")}</td>
        <td>${escapeHtml(invoice.duplicate_status || "")}</td>
        <td>${warningCount}</td>
        <td>
          <a href="./ap-invoice.html?id=${invoice.id}">Open</a>
        </td>
      </tr>
    `;
  }).join("");
}

function scheduleReload() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    loadInvoices();
  }, 250);
}

function clearFilters() {
  poSearch.value = "";
  statusFilter.value = "";
  reviewFilter.value = "";
  duplicateFilter.value = "";
  loadInvoices();
}

function bindEvents() {
  poSearch.addEventListener("input", scheduleReload);
  statusFilter.addEventListener("change", loadInvoices);
  reviewFilter.addEventListener("change", loadInvoices);
  duplicateFilter.addEventListener("change", loadInvoices);
  clearFiltersButton.addEventListener("click", clearFilters);
  refreshButton.addEventListener("click", loadInvoices);
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

bindEvents();
loadInvoices();