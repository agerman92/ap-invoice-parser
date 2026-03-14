import { supabase } from "../lib/supabaseClient.js";

const statusMessage = document.getElementById("statusMessage");
const refreshButton = document.getElementById("refreshButton");
const queuedJobs = document.getElementById("queuedJobs");
const retryJobs = document.getElementById("retryJobs");
const failedJobs = document.getElementById("failedJobs");
const needsReviewInvoices = document.getElementById("needsReviewInvoices");
const criticalInvoices = document.getElementById("criticalInvoices");
const failedExtractions7d = document.getElementById("failedExtractions7d");
const jobIssuesTableBody = document.getElementById("jobIssuesTableBody");
const topFlagsTableBody = document.getElementById("topFlagsTableBody");

refreshButton.addEventListener("click", loadDashboard);

async function loadDashboard() {
  try {
    statusMessage.textContent = "Loading dashboard...";

    const [
      queuedJobsCount,
      retryJobsCount,
      failedJobsCount,
      needsReviewCount,
      criticalCount,
      failedExtractionCount,
      issueJobsResult,
      invoiceFlagsResult
    ] = await Promise.all([
      getCount("ap_invoice_jobs", (q) => q.eq("status", "queued")),
      getCount("ap_invoice_jobs", (q) => q.eq("status", "retry")),
      getCount("ap_invoice_jobs", (q) => q.eq("status", "failed")),
      getCount("ap_invoices", (q) => q.eq("status", "needs_review")),
      getCount("ap_invoices", (q) => q.gte("review_priority", 80)),
      getCount("ap_invoice_extractions", (q) =>
        q.eq("status", "failed").gte("created_at", sevenDaysAgoIso())
      ),
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
        .limit(500)
    ]);

    queuedJobs.textContent = String(queuedJobsCount);
    retryJobs.textContent = String(retryJobsCount);
    failedJobs.textContent = String(failedJobsCount);
    needsReviewInvoices.textContent = String(needsReviewCount);
    criticalInvoices.textContent = String(criticalCount);
    failedExtractions7d.textContent = String(failedExtractionCount);

    if (issueJobsResult.error) throw issueJobsResult.error;
    renderIssueJobs(issueJobsResult.data || []);

    if (invoiceFlagsResult.error) throw invoiceFlagsResult.error;
    renderTopFlags(invoiceFlagsResult.data || []);

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

function renderIssueJobs(rows) {
  if (!rows.length) {
    jobIssuesTableBody.innerHTML = `
      <tr>
        <td colspan="6">No retry/failed jobs found.</td>
      </tr>
    `;
    return;
  }

  jobIssuesTableBody.innerHTML = rows.map((row) => `
    <tr>
      <td>${row.id}</td>
      <td>${escapeHtml(row.invoice_id || "")}</td>
      <td>${escapeHtml(row.status || "")}</td>
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

function sevenDaysAgoIso() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
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