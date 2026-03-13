import { supabase } from "../lib/supabaseClient.js";

const statusMessage = document.getElementById("statusMessage");
const invoiceTableBody = document.getElementById("invoiceTableBody");

async function loadInvoices() {
  statusMessage.textContent = "Loading invoices...";

  const { data, error } = await supabase
    .from("ap_invoices")
    .select(`
      id,
      file_name,
      vendor,
      invoice_number,
      invoice_date,
      total_invoice,
      status,
      review_status,
      duplicate_status,
      created_at,
      warnings
    `)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error loading invoices:", error);
    statusMessage.textContent = `Error loading invoices: ${error.message}`;
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

loadInvoices();