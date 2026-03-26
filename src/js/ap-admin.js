import { supabase } from "../lib/supabaseClient.js";

// ─── DOM refs ────────────────────────────────────────────────────────────────
const statusMessage      = document.getElementById("statusMessage");
const refreshButton      = document.getElementById("refreshButton");
const applyFiltersButton = document.getElementById("applyFiltersButton");
const clearFiltersButton = document.getElementById("clearFiltersButton");
const refreshDot         = document.getElementById("refreshDot");
const refreshLabel       = document.getElementById("refreshLabel");

const datePreset   = document.getElementById("datePreset");
const dateFrom     = document.getElementById("dateFrom");
const dateTo       = document.getElementById("dateTo");
const statusFilter = document.getElementById("statusFilter");
const vendorFilter = document.getElementById("vendorFilter");

const queuedJobs         = document.getElementById("queuedJobs");
const retryJobs          = document.getElementById("retryJobs");
const failedJobs         = document.getElementById("failedJobs");
const needsReviewInvoices = document.getElementById("needsReviewInvoices");
const criticalInvoices   = document.getElementById("criticalInvoices");
const approvedToday      = document.getElementById("approvedToday");
const duplicateInvoices  = document.getElementById("duplicateInvoices");
const failedExtractions7d = document.getElementById("failedExtractions7d");

const reviewDollars    = document.getElementById("reviewDollars");
const approvedDollars  = document.getElementById("approvedDollars");
const duplicateDollars = document.getElementById("duplicateDollars");
const failedDollars    = document.getElementById("failedDollars");
const avgInvoiceAmount = document.getElementById("avgInvoiceAmount");
const highRiskDollars  = document.getElementById("highRiskDollars");

const needsReviewTrend = document.getElementById("needsReviewTrend");
const criticalTrend    = document.getElementById("criticalTrend");
const approvedTrend    = document.getElementById("approvedTrend");
const duplicateTrend   = document.getElementById("duplicateTrend");

const jobIssuesTableBody           = document.getElementById("jobIssuesTableBody");
const topFlagsTableBody            = document.getElementById("topFlagsTableBody");
const topVendorsTableBody          = document.getElementById("topVendorsTableBody");
const highPriorityInvoicesTableBody = document.getElementById("highPriorityInvoicesTableBody");

const cardNeedsReview    = document.getElementById("cardNeedsReview");
const cardCritical       = document.getElementById("cardCritical");
const cardApprovedToday  = document.getElementById("cardApprovedToday");
const cardDuplicate      = document.getElementById("cardDuplicate");
const cardReviewDollars  = document.getElementById("cardReviewDollars");
const cardApprovedDollars  = document.getElementById("cardApprovedDollars");
const cardDuplicateDollars = document.getElementById("cardDuplicateDollars");
const cardFailedDollars  = document.getElementById("cardFailedDollars");
const cardHighRiskDollars = document.getElementById("cardHighRiskDollars");

// ─── State ───────────────────────────────────────────────────────────────────
let allInvoicesCache = [];

// ─── Event wiring ────────────────────────────────────────────────────────────
refreshButton.addEventListener("click",      () => loadDashboard());
applyFiltersButton.addEventListener("click", () => loadDashboard());
clearFiltersButton.addEventListener("click", clearFilters);
datePreset.addEventListener("change",        handleDatePresetChange);
dateFrom.addEventListener("change",          () => { datePreset.value = "custom"; });
dateTo.addEventListener("change",            () => { datePreset.value = "custom"; });

// Clickable metric cards → drill into AP Review
cardNeedsReview.addEventListener("click",     () => openReview({ status: "needs_review" }));
cardCritical.addEventListener("click",        () => openReview({ minPriority: 80 }));
cardApprovedToday.addEventListener("click",   () => openReview({ review: "approved" }));
cardDuplicate.addEventListener("click",       () => openReview({ duplicate: "confirmed" }));
cardReviewDollars.addEventListener("click",   () => openReview({ status: "needs_review" }));
cardApprovedDollars.addEventListener("click", () => openReview({ review: "approved" }));
cardDuplicateDollars.addEventListener("click",() => openReview({ status: "duplicate" }));
cardFailedDollars.addEventListener("click",   () => openReview({ status: "failed" }));
cardHighRiskDollars.addEventListener("click", () => openReview({ minPriority: 80 }));

// ─── Init ────────────────────────────────────────────────────────────────────
initDefaultDates();
loadDashboard();

// ─── Date helpers ────────────────────────────────────────────────────────────
function initDefaultDates() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 29);
  dateFrom.value = toDateInputValue(start);
  dateTo.value   = toDateInputValue(end);
}

function handleDatePresetChange() {
  if (datePreset.value === "custom") return;
  const days  = Number(datePreset.value || 30);
  const end   = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  dateFrom.value = toDateInputValue(start);
  dateTo.value   = toDateInputValue(end);
}

function clearFilters() {
  datePreset.value   = "30";
  statusFilter.value = "";
  vendorFilter.value = "";
  initDefaultDates();
  loadDashboard();
}

// ─── Main load ───────────────────────────────────────────────────────────────
async function loadDashboard(silent = false) {
  try {
    if (silent) {
      refreshDot.classList.add("refreshing");
    } else {
      statusMessage.textContent = "Loading dashboard…";
      refreshDot.classList.add("refreshing");
    }

    const filterState = getFilterState();

    const [
      queuedCount,
      retryCount,
      failedCount,
      failedExtrCount,
      issueJobsResult,
      allInvoicesResult
    ] = await Promise.all([
      getCount("ap_invoice_jobs", (q) => q.eq("status", "queued")),
      getCount("ap_invoice_jobs", (q) => q.eq("status", "retry")),
      getCount("ap_invoice_jobs", (q) => q.eq("status", "failed")),
      getCount("ap_invoice_extractions", (q) =>
        q.eq("status", "failed").gte("created_at", sevenDaysAgoIso())
      ),
      supabase
        .from("ap_invoice_jobs")
        .select("id, invoice_id, status, attempt_count, last_error, updated_at")
        .in("status", ["retry", "failed"])
        .order("updated_at", { ascending: false })
        .limit(25),
      loadInvoicesForDateWindow(filterState.fromIso, filterState.toIsoExclusive)
    ]);

    refreshDot.classList.remove("refreshing");

    const now = new Date();
    refreshLabel.textContent = `Last refreshed ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;

    queuedJobs.textContent        = String(queuedCount);
    retryJobs.textContent         = String(retryCount);
    failedJobs.textContent        = String(failedCount);
    failedExtractions7d.textContent = String(failedExtrCount);

    if (issueJobsResult.error) throw issueJobsResult.error;
    renderIssueJobs(issueJobsResult.data || []);

    if (allInvoicesResult.error) throw allInvoicesResult.error;

    allInvoicesCache = allInvoicesResult.data || [];
    populateVendorFilter(allInvoicesCache);

    const filtered = applyLocalFilters(allInvoicesCache, filterState);
    const prior    = filterPriorPeriod(allInvoicesCache, filterState);

    renderHeadlineMetrics(filtered, prior);
    renderFinancials(filtered);
    renderTopFlags(filtered);
    renderTopVendors(filtered);
    renderHighPriorityInvoices(filtered);

    statusMessage.textContent = `Dashboard loaded · ${filtered.length} invoice${filtered.length !== 1 ? "s" : ""} in current window`;
  } catch (error) {
    refreshDot.classList.remove("refreshing");
    console.error("Dashboard load failed:", error);
    statusMessage.textContent = `Load failed: ${error.message}`;
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

// ─── Filter state ────────────────────────────────────────────────────────────
function getFilterState() {
  const from = dateFrom.value ? new Date(`${dateFrom.value}T00:00:00`) : new Date();
  const to   = dateTo.value   ? new Date(`${dateTo.value}T00:00:00`)   : new Date();

  const toExclusive = new Date(to);
  toExclusive.setDate(toExclusive.getDate() + 1);

  return {
    fromIso:          from.toISOString(),
    toIsoExclusive:   toExclusive.toISOString(),
    fromDate:         from,
    toDateExclusive:  toExclusive,
    status:           statusFilter.value || "",
    vendor:           vendorFilter.value || ""
  };
}

function applyLocalFilters(rows, filterState) {
  return rows.filter((row) => {
    if (filterState.status && row.status         !== filterState.status) return false;
    if (filterState.vendor && (row.vendor || "") !== filterState.vendor) return false;
    return true;
  });
}

function filterPriorPeriod(rows, filterState) {
  const windowMs         = filterState.toDateExclusive.getTime() - filterState.fromDate.getTime();
  const priorStart       = new Date(filterState.fromDate.getTime() - windowMs);
  const priorEndExclusive = new Date(filterState.fromDate.getTime());

  return rows.filter((row) => {
    const created = new Date(row.created_at);
    if (created < priorStart || created >= priorEndExclusive) return false;
    if (filterState.status && row.status         !== filterState.status) return false;
    if (filterState.vendor && (row.vendor || "") !== filterState.vendor) return false;
    return true;
  });
}

// ─── Renderers ───────────────────────────────────────────────────────────────
function renderHeadlineMetrics(currentRows, priorRows) {
  const nrCurr = currentRows.filter(i => i.status === "needs_review").length;
  const nrPrior = priorRows.filter(i => i.status === "needs_review").length;

  const crCurr = currentRows.filter(i => Number(i.review_priority || 0) >= 80).length;
  const crPrior = priorRows.filter(i => Number(i.review_priority || 0) >= 80).length;

  const apCurr = currentRows.filter(i => i.review_status === "approved").length;
  const apPrior = priorRows.filter(i => i.review_status === "approved").length;

  const dupCurr = currentRows.filter(i => i.status === "duplicate").length;
  const dupPrior = priorRows.filter(i => i.status === "duplicate").length;

  needsReviewInvoices.textContent = String(nrCurr);
  criticalInvoices.textContent    = String(crCurr);
  approvedToday.textContent       = String(apCurr);
  duplicateInvoices.textContent   = String(dupCurr);

  renderTrend(needsReviewTrend, nrCurr,  nrPrior);
  renderTrend(criticalTrend,    crCurr,  crPrior);
  renderTrend(approvedTrend,    apCurr,  apPrior);
  renderTrend(duplicateTrend,   dupCurr, dupPrior);
}

function renderTrend(el, current, prior) {
  if (!el) return;
  if (prior === 0 && current === 0) { el.textContent = "—";     el.className = "trend-flat"; return; }
  if (prior === 0 && current > 0)   { el.textContent = "new";   el.className = "trend-up";   return; }

  const pct     = ((current - prior) / Math.abs(prior)) * 100;
  const rounded = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  el.textContent = rounded;
  el.className   = pct > 0.1 ? "trend-up" : pct < -0.1 ? "trend-down" : "trend-flat";
}

function renderFinancials(invoices) {
  const reviewSet   = invoices.filter(i => i.status === "needs_review");
  const approvedSet = invoices.filter(i => i.review_status === "approved");
  const dupSet      = invoices.filter(i => i.status === "duplicate");
  const failedSet   = invoices.filter(i => i.status === "failed");
  const highRiskSet = invoices.filter(i => Number(i.review_priority || 0) >= 80);

  const allDollars = sumTotals(invoices);
  const avg        = invoices.length ? allDollars / invoices.length : 0;

  reviewDollars.textContent    = formatCurrency(sumTotals(reviewSet));
  approvedDollars.textContent  = formatCurrency(sumTotals(approvedSet));
  duplicateDollars.textContent = formatCurrency(sumTotals(dupSet));
  failedDollars.textContent    = formatCurrency(sumTotals(failedSet));
  avgInvoiceAmount.textContent = formatCurrency(avg);
  highRiskDollars.textContent  = formatCurrency(sumTotals(highRiskSet));
}

function renderIssueJobs(rows) {
  if (!rows.length) {
    jobIssuesTableBody.innerHTML = emptyRow(5, "No retry/failed jobs — queue is healthy ✓");
    return;
  }

  jobIssuesTableBody.innerHTML = rows.map((row) => {
    const invoiceLink = row.invoice_id
      ? `<a class="table-open-btn" href="./ap-invoice.html?id=${escapeHtml(row.invoice_id)}">Open →</a>`
      : "—";

    return `
      <tr>
        <td>${renderStatusPill(row.status)}</td>
        <td style="text-align:center;">${Number(row.attempt_count || 0)}</td>
        <td style="font-size:11px; max-width:280px; word-break:break-word;">${escapeHtml(row.last_error || "—")}</td>
        <td style="font-size:11px; white-space:nowrap;">${formatDateTime(row.updated_at)}</td>
        <td>${invoiceLink}</td>
      </tr>
    `;
  }).join("");
}

function renderTopFlags(rows) {
  const counts = new Map();

  for (const row of rows) {
    for (const flag of (Array.isArray(row.exception_flags) ? row.exception_flags : [])) {
      const code = flag?.code || "UNKNOWN";
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  if (!sorted.length) {
    topFlagsTableBody.innerHTML = emptyRow(3, "No exception flags in this window.");
    return;
  }

  topFlagsTableBody.innerHTML = sorted.map(([code, count]) => {
    const label = formatFlagLabel(code);
    return `
      <tr class="clickable-row" onclick="openReviewByFlag('${escapeHtml(code)}')">
        <td>${escapeHtml(label)}</td>
        <td style="text-align:center; font-weight:bold;">${count}</td>
        <td><span class="table-open-btn">View →</span></td>
      </tr>
    `;
  }).join("");
}

function renderTopVendors(invoices) {
  const vendorMap = new Map();

  for (const invoice of invoices) {
    const vendor = (invoice.vendor || "Unknown Vendor").trim() || "Unknown Vendor";
    const curr   = vendorMap.get(vendor) || { count: 0, total: 0 };
    curr.count  += 1;
    curr.total  += Number(invoice.total_invoice || 0);
    vendorMap.set(vendor, curr);
  }

  const sorted = Array.from(vendorMap.entries())
    .map(([vendor, data]) => ({ vendor, ...data }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15);

  if (!sorted.length) {
    topVendorsTableBody.innerHTML = emptyRow(4, "No vendor data in this window.");
    return;
  }

  topVendorsTableBody.innerHTML = sorted.map((row) => `
    <tr class="clickable-row" onclick="openReviewByVendor('${escapeHtml(row.vendor)}')">
      <td>${escapeHtml(row.vendor)}</td>
      <td style="text-align:center;">${row.count}</td>
      <td style="text-align:right; font-weight:bold;">${formatCurrency(row.total)}</td>
      <td><span class="table-open-btn">View →</span></td>
    </tr>
  `).join("");
}

function renderHighPriorityInvoices(rows) {
  const filtered = rows
    .filter(r => Number(r.review_priority || 0) >= 50)
    .sort((a, b) => {
      const p = Number(b.review_priority || 0) - Number(a.review_priority || 0);
      if (p !== 0) return p;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    })
    .slice(0, 20);

  if (!filtered.length) {
    highPriorityInvoicesTableBody.innerHTML = emptyRow(5, "No high-priority invoices in this window.");
    return;
  }

  highPriorityInvoicesTableBody.innerHTML = filtered.map((row) => `
    <tr class="clickable-row" onclick="window.location.href='./ap-invoice.html?id=${row.id}'">
      <td>${renderPriorityPill(row.review_priority)}</td>
      <td>${escapeHtml(row.vendor || "")}</td>
      <td style="font-size:12px;">${escapeHtml(row.invoice_number || "")}</td>
      <td style="white-space:nowrap;">${formatCurrency(row.total_invoice)}</td>
      <td>${renderStatusPill(row.status)}</td>
    </tr>
  `).join("");
}

// ─── Vendor filter ────────────────────────────────────────────────────────────
function populateVendorFilter(rows) {
  const currentValue = vendorFilter.value;
  const vendors = Array.from(
    new Set(rows.map(r => (r.vendor || "").trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  vendorFilter.innerHTML = `<option value="">All Vendors</option>` +
    vendors.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");

  vendorFilter.value = vendors.includes(currentValue) ? currentValue : "";
}

// ─── Navigation helpers ───────────────────────────────────────────────────────
function openReview(options = {}) {
  const params = new URLSearchParams();
  if (options.status)      params.set("status",      options.status);
  if (options.review)      params.set("review",       options.review);
  if (options.duplicate)   params.set("duplicate",    options.duplicate);
  if (options.minPriority) params.set("minPriority",  String(options.minPriority));
  if (vendorFilter.value)  params.set("vendor",       vendorFilter.value);
  if (dateFrom.value)      params.set("from",         dateFrom.value);
  if (dateTo.value)        params.set("to",           dateTo.value);
  window.location.href = `./ap-review.html?${params.toString()}`;
}

// Exposed to inline onclick handlers in table rows
window.openReview = openReview;

window.openReviewByVendor = function(vendor) {
  const params = new URLSearchParams();
  params.set("vendor", vendor);
  if (dateFrom.value) params.set("from", dateFrom.value);
  if (dateTo.value)   params.set("to",   dateTo.value);
  window.location.href = `./ap-review.html?${params.toString()}`;
};

window.openReviewByFlag = function(flagCode) {
  // Best we can do from the review page is open with no filter pre-applied
  // but show the user context — in future this could be a dedicated flag filter
  window.location.href = `./ap-review.html`;
};

// ─── Utilities ────────────────────────────────────────────────────────────────
async function getCount(tableName, applyFilter) {
  let query = supabase.from(tableName).select("*", { count: "exact", head: true });
  query = applyFilter(query);
  const { count, error } = await query;
  if (error) throw error;
  return Number(count || 0);
}

function sumTotals(rows) {
  return rows.reduce((sum, r) => sum + Number(r.total_invoice || 0), 0);
}

function emptyRow(cols, message) {
  return `<tr class="empty-row"><td colspan="${cols}">${message}</td></tr>`;
}

function formatFlagLabel(code) {
  return String(code || "")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function renderStatusPill(status) {
  const s = String(status || "").toLowerCase();
  if (s === "failed")       return `<span class="pill pill-red">Failed</span>`;
  if (s === "retry")        return `<span class="pill pill-yellow">Retry</span>`;
  if (s === "queued")       return `<span class="pill pill-blue">Queued</span>`;
  if (s === "needs_review") return `<span class="pill pill-yellow">Needs Review</span>`;
  if (s === "approved")     return `<span class="pill pill-green">Approved</span>`;
  if (s === "duplicate")    return `<span class="pill pill-purple">Duplicate</span>`;
  return `<span class="pill pill-blue">${escapeHtml(status || "—")}</span>`;
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
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], {
    month: "short", day: "numeric", year: "2-digit",
    hour: "2-digit", minute: "2-digit"
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