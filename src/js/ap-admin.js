import { supabase } from "../lib/supabaseClient.js";

const statusMessage = document.getElementById("statusMessage");
const refreshButton = document.getElementById("refreshButton");

const queuedJobs = document.getElementById("queuedJobs");
const retryJobs = document.getElementById("retryJobs");
const failedJobs = document.getElementById("failedJobs");
const needsReviewInvoices = document.getElementById("needsReviewInvoices");
const criticalInvoices = document.getElementById("criticalInvoices");
const approvedToday = document.getElementById("approvedToday");
const duplicateInvoices = document.getElementById("duplicateInvoices");
const failedExtractions7d = document.getElementById("failedExtractions7d");

const reviewDollars = document.getElementById("reviewDollars");
const approvedDollars = document.getElementById("approvedDollars");
const duplicateDollars = document.getElementById("duplicateDollars");
const failedDollars = document.getElementById("failedDollars");
const avgInvoiceAmount = document.getElementById("avgInvoiceAmount");
const highRiskDollars = document.getElementById("highRiskDollars");

const jobIssuesTableBody = document.getElementById("jobIssuesTableBody");
const topFlagsTableBody = document.getElementById("topFlagsTableBody");
const topVendorsTableBody = document.getElementById("topVendorsTableBody");
const highPriorityInvoicesTableBody = document.getElementById("highPriorityInvoicesTableBody");

refreshButton.addEventListener("click", loadDashboard);

async function loadDashboard() {
  try {
    statusMessage.textContent = "Loading dashboard...";

    const todayStart = startOfTodayIso();
    const sevenDaysAgo = sevenDaysAgoIso();

    const [
      queuedJobsCount,
      retryJobsCount,
      failedJobsCount,
      needsReviewCount,
      criticalCount,
      approvedTodayCount,
      duplicateCount,
      failedExtractionCount,
      issueJobsResult,
      invoiceFlagsResult,
      allInvoicesResult,
      highPriorityInvoicesResult
    ] = await Promise.all([
      getCount("ap_invoice_jobs", (q) => q.eq("status", "queued")),
      getCount("ap_invoice_jobs", (q) => q.eq("status", "retry")),
      getCount("ap_invoice_jobs", (q) => q.eq("status", "failed")),
      getCount("ap_invoices", (q) => q.eq("status", "needs_review")),
      getCount("ap_invoices", (q) => q.gte("review_priority", 80)),
      getCount("ap_invoices", (q) => q.eq("review_status", "approved").gte("approved_at", todayStart)),
      getCount("ap_invoices", (q) => q.eq("status", "duplicate")),
      getCount("ap_invoice_extractions", (q) => q.eq("status", "failed").gte("created_at", sevenDaysAgo)),
      supabase
        .from("ap_invoice_jobs")
        .select("id, invoice_id, status, attempt_count, last_error, updated_at")
        .in("status", ["retry", "failed"])
        .order("updated_at", { ascending: false })
        .limit(25),
      supabase
        .from("ap_invoices")
        .select("id, exception_flags")
        .not("exception_flags", "is", null)
        .limit(1000),
      supabase
        .from("ap_invoices")
        .select("id, vendor, total_invoice, status, review_status, review_priority")
        .limit(5000),
      supabase
        .from("ap_invoices")
        .select("id, vendor, invoice_number, total_invoice, status, review_priority")
        .gte("review_priority", 50)
        .order("review_priority", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(20)
    ]);

    queuedJobs.textContent = String(queuedJobsCount);
    retryJobs.textContent = String(retryJobsCount);
    failedJobs.textContent = String(failedJobsCount);
    needsReviewInvoices.textContent = String(needsReviewCount);
    criticalInvoices.textContent = String(criticalCount);
    approvedToday.textContent = String(approvedTodayCount);
    duplicateInvoices.textContent = String(duplicateCount);
    failedExtractions7d.textContent = String(failedExtractionCount);

    if (issueJobsResult.error) throw issueJobsResult.error;
    renderIssueJobs(issueJobsResult.data || []);

    if (invoiceFlagsResult.error) throw invoiceFlagsResult.error;
    renderTopFlags(invoiceFlagsResult.data || []);

    if (allInvoicesResult.error) throw allInvoicesResult.error;
    const invoices = allInvoicesResult.data || [];
    renderFinancials(invoices);
    renderTopVendors(invoices);

    if (highPriorityInvoicesResult.error) throw highPriorityInvoicesResult.error;
    renderHighPriorityInvoices(highPriorityInvoicesResult.data || []);

    statusMessage.textContent = "Dashboard loaded.";
  } catch (error) {
    console.error("Dashboard load failed:", error);
    statusMessage.textContent = `Dashboard load failed: ${error.message}`;
  }
}

async function getCount(tableName, applyFilters) {
  let query = supabase.from(tableName).select("*", { count: "exact", head: true });
  query = applyFilters(query);
  const { count, error } = await query;
  if (error) throw error;
  return Number(count || 0);
}

function renderFinancials(invoices) {
  const reviewSet = invoices.filter((i) => i.status === "needs_review");
  const approvedSet = invoices.filter((i) => i.review_status === "approved");
  const duplicateSet = invoices.filter((i) => i.status === "duplicate");
  const failedSet = invoices.filter((i) => i.status === "failed");
  const highRiskSet = invoices.filter((i) => Number(i.review_priority || 0) >= 80);

  const allDollars = sumTotals(invoices);
  const reviewTotal = sumTotals(reviewSet);
  const approvedTotal = sumTotals(approvedSet);
  const duplicateTotal = sumTotals(duplicateSet);
  const failedTotal = sumTotals(failedSet);
  const highRiskTotal = sumTotals(highRiskSet);
  const avg = invoices.length ? allDollars / invoices.length : 0;

  reviewDollars.textContent = formatCurrency(reviewTotal);
  approvedDollars.textContent = formatCurrency(approvedTotal);
  duplicateDollars.textContent = formatCurrency(duplicateTotal);
  failedDollars.textContent = formatCurrency(failedTotal);
  avgInvoiceAmount.textContent = formatCurrency(avg);
  highRiskDollars.textContent = formatCurrency(highRiskTotal);
}

function renderIssueJobs(rows) {
  if (!rows.length) {
    jobIssuesTableBody.innerHTML = `
      <tr>
        <td colspan="5">No retry/failed jobs found.</td>
      </tr>
    `;
    return;
  }

  jobIssuesTableBody.innerHTML = rows.map((row) => `
    <tr>
      <td>${row.id}</td>
      <td>${renderStatusPill(row.status)}</td>
      <td>${Number(row.attempt_count || 0)}</td>
      <td>${escapeHtml(row.last_error || "")}</td>
      <td>${formatDateTime(row.updated_at)}</td>
    </tr>
  `).join("");
}

function renderTopFlags(rows) {
  const counts = new Map();

  for (const row of rows) {
    const flags = Array.isArray(row.exception_flags) ? row.exception_flags : [];
    for (const flag of flags) {
      const code = flag?.code || "UNKNOWN";
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  if (!sorted.length) {
    topFlagsTableBody.innerHTML = `
      <tr>
        <td colspan="2">No exception flags found.</td>
      </tr>
    `;
    return;
  }

  topFlagsTableBody.innerHTML = sorted.map(([code, count]) => `
    <tr>
      <td>${escapeHtml(code)}</td>
      <td>${count}</td>
    </tr>
  `).join("");
}

function renderTopVendors(invoices) {
  const vendorMap = new Map();

  for (const invoice of invoices) {
    const vendor = (invoice.vendor || "Unknown Vendor").trim() || "Unknown Vendor";
    const current = vendorMap.get(vendor) || { count: 0, total: 0 };
    current.count += 1;
    current.total += Number(invoice.total_invoice || 0);
    vendorMap.set(vendor, current);
  }

  const sorted = Array.from(vendorMap.entries())
    .map(([vendor, data]) => ({ vendor, ...data }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15);

  if (!sorted.length) {
    topVendorsTableBody.innerHTML = `
      <tr>
        <td colspan="3">No vendor data found.</td>
      </tr>
    `;
    return;
  }

  topVendorsTableBody.innerHTML = sorted.map((row) => `
    <tr>
      <td>${escapeHtml(row.vendor)}</td>
      <td>${row.count}</td>
      <td>${formatCurrency(row.total)}</td>
    </tr>
  `).join("");
}

function renderHighPriorityInvoices(rows) {
  if (!rows.length) {
    highPriorityInvoicesTableBody.innerHTML = `
      <tr>
        <td colspan="5">No high-priority invoices found.</td>
      </tr>
    `;
    return;
  }

  highPriorityInvoicesTableBody.innerHTML = rows.map((row) => `
    <tr>
      <td>${renderPriorityPill(row.review_priority)}</td>
      <td>${escapeHtml(row.vendor || "")}</td>
      <td>${escapeHtml(row.invoice_number || "")}</td>
      <td>${formatCurrency(row.total_invoice)}</td>
      <td>${escapeHtml(row.status || "")}</td>
    </tr>
  `).join("");
}

function sumTotals(rows) {
  return rows.reduce((sum, row) => sum + Number(row.total_invoice || 0), 0);
}

function renderStatusPill(status) {
  const s = String(status || "").toLowerCase();
  if (s === "failed") return `<span class="pill pill-red">failed</span>`;
  if (s === "retry") return `<span class="pill pill-yellow">retry</span>`;
  if (s === "queued") return `<span class="pill pill-blue">queued</span>`;
  return `<span class="pill pill-green">${escapeHtml(status || "")}</span>`;
}

function renderPriorityPill(priority) {
  const n = Number(priority || 0);
  if (n >= 80) return `<span class="pill pill-red">Critical (${n})</span>`;
  if (n >= 50) return `<span class="pill pill-yellow">High (${n})</span>`;
  if (n >= 20) return `<span class="pill pill-blue">Medium (${n})</span>`;
  return `<span class="pill pill-green">Low (${n})</span>`;
}

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function sevenDaysAgoIso() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
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

loadDashboard();