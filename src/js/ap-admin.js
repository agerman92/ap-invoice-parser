import { supabase } from "../lib/supabaseClient.js";

const statusMessage = document.getElementById("statusMessage");
const refreshButton = document.getElementById("refreshButton");
const applyFiltersButton = document.getElementById("applyFiltersButton");
const clearFiltersButton = document.getElementById("clearFiltersButton");

const datePreset = document.getElementById("datePreset");
const dateFrom = document.getElementById("dateFrom");
const dateTo = document.getElementById("dateTo");
const statusFilter = document.getElementById("statusFilter");
const vendorFilter = document.getElementById("vendorFilter");

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

const needsReviewTrend = document.getElementById("needsReviewTrend");
const criticalTrend = document.getElementById("criticalTrend");
const approvedTrend = document.getElementById("approvedTrend");
const duplicateTrend = document.getElementById("duplicateTrend");

const jobIssuesTableBody = document.getElementById("jobIssuesTableBody");
const topFlagsTableBody = document.getElementById("topFlagsTableBody");
const topVendorsTableBody = document.getElementById("topVendorsTableBody");
const highPriorityInvoicesTableBody = document.getElementById("highPriorityInvoicesTableBody");

const cardNeedsReview = document.getElementById("cardNeedsReview");
const cardCritical = document.getElementById("cardCritical");
const cardApprovedToday = document.getElementById("cardApprovedToday");
const cardDuplicate = document.getElementById("cardDuplicate");
const cardReviewDollars = document.getElementById("cardReviewDollars");
const cardApprovedDollars = document.getElementById("cardApprovedDollars");
const cardDuplicateDollars = document.getElementById("cardDuplicateDollars");
const cardFailedDollars = document.getElementById("cardFailedDollars");
const cardHighRiskDollars = document.getElementById("cardHighRiskDollars");

let allInvoicesCache = [];

refreshButton.addEventListener("click", loadDashboard);
applyFiltersButton.addEventListener("click", loadDashboard);
clearFiltersButton.addEventListener("click", clearFilters);
datePreset.addEventListener("change", handleDatePresetChange);

cardNeedsReview.addEventListener("click", () => openApReviewWithFilters({ status: "needs_review" }));
cardCritical.addEventListener("click", () => openApReviewWithFilters({ minPriority: 80 }));
cardApprovedToday.addEventListener("click", () => openApReviewWithFilters({ review: "approved" }));
cardDuplicate.addEventListener("click", () => openApReviewWithFilters({ duplicate: "confirmed" }));

cardReviewDollars.addEventListener("click", () => openApReviewWithFilters({ status: "needs_review" }));
cardApprovedDollars.addEventListener("click", () => openApReviewWithFilters({ review: "approved" }));
cardDuplicateDollars.addEventListener("click", () => openApReviewWithFilters({ status: "duplicate" }));
cardFailedDollars.addEventListener("click", () => openApReviewWithFilters({ status: "failed" }));
cardHighRiskDollars.addEventListener("click", () => openApReviewWithFilters({ minPriority: 80 }));

initDefaultDates();
loadDashboard();

function initDefaultDates() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 29);

  dateFrom.value = toDateInputValue(start);
  dateTo.value = toDateInputValue(end);
}

function handleDatePresetChange() {
  if (datePreset.value === "custom") return;

  const days = Number(datePreset.value || 30);
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));

  dateFrom.value = toDateInputValue(start);
  dateTo.value = toDateInputValue(end);
}

function clearFilters() {
  datePreset.value = "30";
  statusFilter.value = "";
  vendorFilter.value = "";
  initDefaultDates();
  loadDashboard();
}

async function loadDashboard() {
  try {
    statusMessage.textContent = "Loading dashboard...";

    const filterState = getFilterState();

    const [
      queuedJobsCount,
      retryJobsCount,
      failedJobsCount,
      failedExtractionCount,
      issueJobsResult,
      allInvoicesResult
    ] = await Promise.all([
      getCount("ap_invoice_jobs", (q) => q.eq("status", "queued")),
      getCount("ap_invoice_jobs", (q) => q.eq("status", "retry")),
      getCount("ap_invoice_jobs", (q) => q.eq("status", "failed")),
      getCount("ap_invoice_extractions", (q) => q.eq("status", "failed").gte("created_at", sevenDaysAgoIso())),
      supabase
        .from("ap_invoice_jobs")
        .select("id, invoice_id, status, attempt_count, last_error, updated_at")
        .in("status", ["retry", "failed"])
        .order("updated_at", { ascending: false })
        .limit(25),
      loadInvoicesForDateWindow(filterState.fromIso, filterState.toIsoExclusive)
    ]);

    queuedJobs.textContent = String(queuedJobsCount);
    retryJobs.textContent = String(retryJobsCount);
    failedJobs.textContent = String(failedJobsCount);
    failedExtractions7d.textContent = String(failedExtractionCount);

    if (issueJobsResult.error) throw issueJobsResult.error;
    renderIssueJobs(issueJobsResult.data || []);

    if (allInvoicesResult.error) throw allInvoicesResult.error;

    allInvoicesCache = allInvoicesResult.data || [];
    populateVendorFilter(allInvoicesCache);

    const filteredInvoices = applyLocalFilters(allInvoicesCache, filterState);
    const priorInvoices = filterPriorPeriod(allInvoicesCache, filterState);

    renderHeadlineMetrics(filteredInvoices, priorInvoices);
    renderFinancials(filteredInvoices);
    renderTopFlags(filteredInvoices);
    renderTopVendors(filteredInvoices);
    renderHighPriorityInvoices(filteredInvoices);

    statusMessage.textContent = `Dashboard loaded. ${filteredInvoices.length} invoice(s) in current filter set.`;
  } catch (error) {
    console.error("Dashboard load failed:", error);
    statusMessage.textContent = `Dashboard load failed: ${error.message}`;
  }
}

async function loadInvoicesForDateWindow(fromIso, toIsoExclusive) {
  return supabase
    .from("ap_invoices")
    .select(`
      id,
      vendor,
      invoice_number,
      total_invoice,
      status,
      review_status,
      duplicate_status,
      review_priority,
      exception_flags,
      created_at,
      approved_at
    `)
    .gte("created_at", fromIso)
    .lt("created_at", toIsoExclusive)
    .limit(10000);
}

function getFilterState() {
  const from = dateFrom.value ? new Date(`${dateFrom.value}T00:00:00`) : new Date();
  const to = dateTo.value ? new Date(`${dateTo.value}T00:00:00`) : new Date();

  const toExclusive = new Date(to);
  toExclusive.setDate(toExclusive.getDate() + 1);

  return {
    fromIso: from.toISOString(),
    toIsoExclusive: toExclusive.toISOString(),
    fromDate: from,
    toDateExclusive: toExclusive,
    status: statusFilter.value || "",
    vendor: vendorFilter.value || ""
  };
}

function applyLocalFilters(rows, filterState) {
  return rows.filter((row) => {
    if (filterState.status && row.status !== filterState.status) return false;
    if (filterState.vendor && (row.vendor || "") !== filterState.vendor) return false;
    return true;
  });
}

function filterPriorPeriod(rows, filterState) {
  const currentStart = filterState.fromDate;
  const currentEndExclusive = filterState.toDateExclusive;
  const windowMs = currentEndExclusive.getTime() - currentStart.getTime();

  const priorStart = new Date(currentStart.getTime() - windowMs);
  const priorEndExclusive = new Date(currentStart.getTime());

  return rows.filter((row) => {
    const created = new Date(row.created_at);
    if (created < priorStart || created >= priorEndExclusive) return false;
    if (filterState.status && row.status !== filterState.status) return false;
    if (filterState.vendor && (row.vendor || "") !== filterState.vendor) return false;
    return true;
  });
}

function renderHeadlineMetrics(currentRows, priorRows) {
  const needsReviewCurrent = currentRows.filter((i) => i.status === "needs_review").length;
  const needsReviewPrior = priorRows.filter((i) => i.status === "needs_review").length;

  const criticalCurrent = currentRows.filter((i) => Number(i.review_priority || 0) >= 80).length;
  const criticalPrior = priorRows.filter((i) => Number(i.review_priority || 0) >= 80).length;

  const approvedCurrent = currentRows.filter((i) => i.review_status === "approved").length;
  const approvedPrior = priorRows.filter((i) => i.review_status === "approved").length;

  const duplicateCurrent = currentRows.filter((i) => i.status === "duplicate").length;
  const duplicatePrior = priorRows.filter((i) => i.status === "duplicate").length;

  needsReviewInvoices.textContent = String(needsReviewCurrent);
  criticalInvoices.textContent = String(criticalCurrent);
  approvedToday.textContent = String(approvedCurrent);
  duplicateInvoices.textContent = String(duplicateCurrent);

  renderTrend(needsReviewTrend, needsReviewCurrent, needsReviewPrior);
  renderTrend(criticalTrend, criticalCurrent, criticalPrior);
  renderTrend(approvedTrend, approvedCurrent, approvedPrior);
  renderTrend(duplicateTrend, duplicateCurrent, duplicatePrior);
}

function renderTrend(el, currentValue, priorValue) {
  if (!el) return;

  if (priorValue === 0 && currentValue === 0) {
    el.textContent = "0%";
    el.className = "trend-flat";
    return;
  }

  if (priorValue === 0 && currentValue > 0) {
    el.textContent = "+100%";
    el.className = "trend-up";
    return;
  }

  const pct = ((currentValue - priorValue) / Math.abs(priorValue || 1)) * 100;
  const rounded = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;

  el.textContent = rounded;
  if (pct > 0.1) el.className = "trend-up";
  else if (pct < -0.1) el.className = "trend-down";
  else el.className = "trend-flat";
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
  const filtered = rows
    .filter((row) => Number(row.review_priority || 0) >= 50)
    .sort((a, b) => {
      const p = Number(b.review_priority || 0) - Number(a.review_priority || 0);
      if (p !== 0) return p;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    })
    .slice(0, 20);

  if (!filtered.length) {
    highPriorityInvoicesTableBody.innerHTML = `
      <tr>
        <td colspan="5">No high-priority invoices found.</td>
      </tr>
    `;
    return;
  }

  highPriorityInvoicesTableBody.innerHTML = filtered.map((row) => `
    <tr>
      <td>${renderPriorityPill(row.review_priority)}</td>
      <td>${escapeHtml(row.vendor || "")}</td>
      <td>${escapeHtml(row.invoice_number || "")}</td>
      <td>${formatCurrency(row.total_invoice)}</td>
      <td>${escapeHtml(row.status || "")}</td>
    </tr>
  `).join("");
}

function populateVendorFilter(rows) {
  const currentValue = vendorFilter.value;
  const vendors = Array.from(
    new Set(
      rows
        .map((row) => (row.vendor || "").trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));

  vendorFilter.innerHTML = `<option value="">All Vendors</option>` +
    vendors.map((vendor) => `<option value="${escapeHtml(vendor)}">${escapeHtml(vendor)}</option>`).join("");

  vendorFilter.value = vendors.includes(currentValue) ? currentValue : "";
}

function openApReviewWithFilters(options = {}) {
  const params = new URLSearchParams();

  if (options.status) params.set("status", options.status);
  if (options.review) params.set("review", options.review);
  if (options.duplicate) params.set("duplicate", options.duplicate);
  if (vendorFilter.value) params.set("vendor", vendorFilter.value);
  if (dateFrom.value) params.set("from", dateFrom.value);
  if (dateTo.value) params.set("to", dateTo.value);
  if (options.minPriority) params.set("minPriority", String(options.minPriority));

  window.location.href = `./ap-review.html?${params.toString()}`;
}

async function getCount(tableName, applyFilters) {
  let query = supabase.from(tableName).select("*", { count: "exact", head: true });
  query = applyFilters(query);
  const { count, error } = await query;
  if (error) throw error;
  return Number(count || 0);
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

function sevenDaysAgoIso() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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