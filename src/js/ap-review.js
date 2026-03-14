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
let autoRefreshTimer = null;

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
      warnings,
      exception_flags,
      exception_count,
      review_priority
    `)
    .order("review_priority", { ascending: false })
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
    const exceptionCount = Number(invoice.exception_count || 0);
    const priorityLabel = getPriorityLabel(invoice.review_priority);
    const topFlags = Array.isArray(invoice.exception_flags) ? invoice.exception_flags.slice(0, 3) : [];

    return `
      <tr>
        <td>${priorityBadge(invoice.review_priority)}</td>
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
        <td>${exceptionCount}</td>
        <td>
          <div class="flag-cell">
            <div><strong>${priorityLabel}</strong></div>
            <div class="exception-badges">
              ${renderExceptionBadges(topFlags)}
            </div>
          </div>
        </td>
        <td>
          <a href="./ap-invoice.html?id=${invoice.id}">Open</a>
        </td>
      </tr>
    `;
  }).join("");
}

function renderExceptionBadges(flags) {
  if (!Array.isArray(flags) || flags.length === 0) {
    return `<span class="exception-badge">No exceptions</span>`;
  }

  return flags.map((flag) => {
    const label = formatFlagLabel(flag.code || "UNKNOWN");
    return `<span class="exception-badge">${escapeHtml(label)}</span>`;
  }).join("");
}

function formatFlagLabel(code) {
  return String(code || "")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getPriorityLabel(value) {
  const n = Number(value || 0);
  if (n >= 80) return "Critical";
  if (n >= 50) return "High";
  if (n >= 20) return "Medium";
  return "Low";
}

function priorityBadge(value) {
  const n = Number(value || 0);
  const label = getPriorityLabel(n);
  const klass =
    n >= 80 ? "priority-critical" :
    n >= 50 ? "priority-high" :
    n >= 20 ? "priority-medium" :
    "priority-low";

  return `<span class="priority-badge ${klass}">${label} (${n})</span>`;
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

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);

  autoRefreshTimer = setInterval(() => {
    if (!document.hidden) {
      loadInvoices();
    }
  }, 10000);
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
startAutoRefresh();
loadInvoices();