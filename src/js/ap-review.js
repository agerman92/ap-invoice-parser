import { supabase } from "../lib/supabaseClient.js";

// ─── DOM refs ────────────────────────────────────────────────────────────────
const statusMessage     = document.getElementById("statusMessage");
const invoiceTableBody  = document.getElementById("invoiceTableBody");
const vendorSearch      = document.getElementById("vendorSearch");
const poSearch          = document.getElementById("poSearch");
const invoiceSearch     = document.getElementById("invoiceSearch");
const statusFilter      = document.getElementById("statusFilter");
const reviewFilter      = document.getElementById("reviewFilter");
const duplicateFilter   = document.getElementById("duplicateFilter");
const clearFiltersButton = document.getElementById("clearFiltersButton");
const refreshButton     = document.getElementById("refreshButton");
const refreshDot        = document.getElementById("refreshDot");
const refreshLabel      = document.getElementById("refreshLabel");

// Stat pill elements
const pillTotalCount     = document.getElementById("pillTotalCount");
const pillReviewCount    = document.getElementById("pillReviewCount");
const pillApprovedCount  = document.getElementById("pillApprovedCount");
const pillDuplicateCount = document.getElementById("pillDuplicateCount");
const pillFailedCount    = document.getElementById("pillFailedCount");
const pillTotal          = document.getElementById("pillTotal");
const pillReview         = document.getElementById("pillReview");
const pillApproved       = document.getElementById("pillApproved");
const pillDuplicate      = document.getElementById("pillDuplicate");
const pillFailed         = document.getElementById("pillFailed");

// ─── State ───────────────────────────────────────────────────────────────────
let currentPage    = 0;
let totalCount     = 0;
let currentRows    = [];   // current page only — NOT the full dataset
let debounceTimer    = null;
let autoRefreshTimer = null;
let sortCol          = "review_priority";
let sortDir          = "desc";
let openDropdownId   = null;
let pendingConfirm   = null;

const PAGE_SIZE = 75;

// Read URL params on load
const pageParams     = new URLSearchParams(window.location.search);

// ─── Init ────────────────────────────────────────────────────────────────────
applyUrlParamsToInputs();
bindEvents();
startAutoRefresh();
loadPage();

// ─── Paginated server-side load ───────────────────────────────────────────────
async function loadPage(showRefreshing = false) {
  if (showRefreshing) {
    refreshDot.classList.add("refreshing");
  } else {
    statusMessage.textContent = "Loading invoices…";
  }

  try {
    let query = supabase
      .from("ap_invoices")
      .select(`
        id, file_name, vendor, invoice_number, po_number, invoice_date,
        total_invoice, status, review_status, duplicate_status, created_at,
        warnings, exception_flags, exception_count, review_priority
      `, { count: "exact" });

    query = applyServerFilters(query);
    query = applyServerSort(query);
    query = query.range(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    currentRows = data || [];
    totalCount  = count || 0;

    const now = new Date();
    refreshLabel.textContent = `Last refreshed ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;

    renderTable(currentRows);
    renderPagination();
    syncUrlParams();

    // Pill counts are lightweight HEAD queries — fire separately so table renders fast
    loadStatCounts();

  } catch (err) {
    console.error("Load failed:", err);
    statusMessage.textContent = `Error: ${err.message}`;
  } finally {
    refreshDot.classList.remove("refreshing");
  }
}

// Keep old name as alias so any remaining references work
const loadInvoices = (showRefreshing = false) => loadPage(showRefreshing);

// ─── Server-side filter builder ───────────────────────────────────────────────
function applyServerFilters(query) {
  const vendor    = vendorSearch.value.trim();
  const po        = poSearch.value.trim();
  const inv       = invoiceSearch.value.trim();
  const status    = statusFilter.value;
  const review    = reviewFilter.value;
  const duplicate = duplicateFilter.value;

  const urlVendor      = pageParams.get("vendor") || "";
  const urlFrom        = pageParams.get("from")   || "";
  const urlTo          = pageParams.get("to")     || "";
  const urlMinPriority = Number(pageParams.get("minPriority") || 0);

  if (vendor)    query = query.ilike("vendor", `%${vendor}%`);
  if (po)        query = query.ilike("po_number", `%${po}%`);
  if (inv)       query = query.ilike("invoice_number", `%${inv}%`);
  if (status)    query = query.eq("status", status);
  if (review)    query = query.eq("review_status", review);
  if (duplicate) query = query.eq("duplicate_status", duplicate);

  if (urlVendor)           query = query.eq("vendor", urlVendor);
  if (urlFrom)             query = query.gte("created_at", `${urlFrom}T00:00:00`);
  if (urlTo) {
    const d = new Date(`${urlTo}T00:00:00`);
    d.setDate(d.getDate() + 1);
    query = query.lt("created_at", d.toISOString());
  }
  if (urlMinPriority > 0)  query = query.gte("review_priority", urlMinPriority);

  return query;
}

function applyServerSort(query) {
  // "warnings" is an array — can't sort server-side, fall back to priority
  const dbCol = sortCol === "warnings" ? "review_priority" : sortCol;
  return query
    .order(dbCol, { ascending: sortDir === "asc" })
    .order("created_at", { ascending: false });
}

// ─── Stat pills — lightweight COUNT queries only ──────────────────────────────
async function loadStatCounts() {
  const countQ = async (filter) => {
    let q = supabase.from("ap_invoices").select("*", { count: "exact", head: true });
    q = filter(q);
    const { count } = await q;
    return Number(count || 0);
  };

  const [total, needsReview, approved, duplicates, failed] = await Promise.all([
    countQ(q => q),
    countQ(q => q.eq("status", "needs_review")),
    countQ(q => q.eq("status", "approved")),
    countQ(q => q.eq("status", "duplicate")),
    countQ(q => q.eq("status", "failed")),
  ]);

  pillTotalCount.textContent     = total;
  pillReviewCount.textContent    = needsReview;
  pillApprovedCount.textContent  = approved;
  pillDuplicateCount.textContent = duplicates;
  pillFailedCount.textContent    = failed;

  const active = statusFilter.value;
  pillTotal.classList.toggle("active",     !active);
  pillReview.classList.toggle("active",    active === "needs_review");
  pillApproved.classList.toggle("active",  active === "approved");
  pillDuplicate.classList.toggle("active", active === "duplicate");
  pillFailed.classList.toggle("active",    active === "failed");
}

// ─── Pagination ───────────────────────────────────────────────────────────────
function renderPagination() {
  const prevBtn  = document.getElementById("prevPageBtn");
  const nextBtn  = document.getElementById("nextPageBtn");
  const infoEl   = document.getElementById("pageInfo");
  if (!prevBtn || !nextBtn || !infoEl) return;

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const from = totalCount === 0 ? 0 : currentPage * PAGE_SIZE + 1;
  const to   = Math.min((currentPage + 1) * PAGE_SIZE, totalCount);

  infoEl.textContent    = totalCount === 0 ? "No results" : `${from}–${to} of ${totalCount}`;
  prevBtn.disabled      = currentPage === 0;
  nextBtn.disabled      = currentPage >= totalPages - 1;
}

function renderTable(rows) {
  updateSortHeaders();

  if (!rows.length) {
    const hasFilters = vendorSearch.value || poSearch.value || invoiceSearch.value ||
                       statusFilter.value || reviewFilter.value || duplicateFilter.value;
    invoiceTableBody.innerHTML = `
      <tr>
        <td colspan="14">
          <div class="empty-state">
            <div class="empty-state-icon">📭</div>
            <h3>${hasFilters ? "No invoices match your filters" : "No invoices found"}</h3>
            <p>${hasFilters ? "Try adjusting or clearing your filters to see more results." : "Invoices will appear here once they have been uploaded and processed."}</p>
            ${hasFilters ? `<button onclick="clearAllFilters()">Clear Filters</button>` : ""}
          </div>
        </td>
      </tr>
    `;
    statusMessage.textContent = "No invoices found.";
    return;
  }

  statusMessage.textContent = buildStatusMessage();

  invoiceTableBody.innerHTML = rows.map((invoice) => {
    const warningCount   = Array.isArray(invoice.warnings) ? invoice.warnings.length : 0;
    const exceptionCount = Number(invoice.exception_count || 0);
    const topFlags       = Array.isArray(invoice.exception_flags) ? invoice.exception_flags.slice(0, 3) : [];
    const age            = formatAge(invoice.created_at);

    return `
      <tr class="data-row" data-id="${invoice.id}" onclick="handleRowClick(event, '${invoice.id}')">
        <td>${priorityBadge(invoice.review_priority)}</td>
        <td>
          <div style="white-space:nowrap; font-size:12px;">${formatDateTime(invoice.created_at)}</div>
          ${age}
        </td>
        <td>${escapeHtml(invoice.vendor || "")}</td>
        <td style="font-size:12px;">${escapeHtml(invoice.invoice_number || "")}</td>
        <td style="font-size:12px;">${escapeHtml(invoice.po_number || "")}</td>
        <td style="font-size:12px;">${escapeHtml(invoice.invoice_date || "")}</td>
        <td style="white-space:nowrap;">${formatCurrency(invoice.total_invoice)}</td>
        <td>${statusBadge(invoice.status || "")}</td>
        <td>${reviewBadge(invoice.review_status || "")}</td>
        <td>${duplicateBadge(invoice.duplicate_status || "")}</td>
        <td style="text-align:center;">${warningCount}</td>
        <td style="text-align:center;">${exceptionCount}</td>
        <td>
          <div class="flag-cell">
            <div class="exception-badges">${renderExceptionBadges(topFlags)}</div>
          </div>
        </td>
        <td class="action-cell" onclick="event.stopPropagation()">
          <div class="action-menu-wrap">
            <a class="open-btn" href="./ap-invoice.html?id=${invoice.id}">Open →</a>
            <button
              class="action-menu-btn"
              title="Quick actions"
              onclick="toggleDropdown(event, '${invoice.id}')"
            >⋯</button>
            <div class="action-dropdown" id="dropdown-${invoice.id}">
              <button class="action-dropdown-item item-approve" onclick="quickAction(event, '${invoice.id}', 'approve')">✓ Approve</button>
              <button class="action-dropdown-item item-hold"    onclick="quickAction(event, '${invoice.id}', 'hold')">⏸ Put On Hold</button>
              <button class="action-dropdown-item item-reject"  onclick="quickAction(event, '${invoice.id}', 'reject')">✗ Reject</button>
              <button class="action-dropdown-item item-dup"     onclick="quickAction(event, '${invoice.id}', 'duplicate')">⊘ Mark Duplicate</button>
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

// ─── Sorting ─────────────────────────────────────────────────────────────────
function handleSort(col) {
  if (sortCol === col) {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  } else {
    sortCol = col;
    sortDir = col === "review_priority" || col === "created_at" ? "desc" : "asc";
  }
  currentPage = 0;
  loadPage();
}

function updateSortHeaders() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    const col = th.dataset.col;
    th.classList.toggle("sort-asc",  col === sortCol && sortDir === "asc");
    th.classList.toggle("sort-desc", col === sortCol && sortDir === "desc");
    const icon = th.querySelector(".sort-icon");
    if (icon) {
      icon.textContent = col !== sortCol ? "⇅" : sortDir === "asc" ? "↑" : "↓";
    }
  });
}

// ─── Row click / open ────────────────────────────────────────────────────────
function handleRowClick(event, id) {
  // Don't navigate if clicking inside the action cell
  if (event.target.closest(".action-cell")) return;
  window.location.href = `./ap-invoice.html?id=${id}`;
}

// Expose to inline onclick
window.handleRowClick = handleRowClick;

// ─── Inline action dropdown ──────────────────────────────────────────────────
function toggleDropdown(event, id) {
  event.stopPropagation();
  closeAllDropdowns();

  if (openDropdownId === id) {
    openDropdownId = null;
    return;
  }

  const el = document.getElementById(`dropdown-${id}`);
  if (el) {
    el.classList.add("open");
    openDropdownId = id;
  }
}

function closeAllDropdowns() {
  document.querySelectorAll(".action-dropdown.open").forEach(el => el.classList.remove("open"));
  openDropdownId = null;
  clearPendingConfirm();
}

window.toggleDropdown = toggleDropdown;

// Close dropdowns when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".action-cell")) closeAllDropdowns();
});

// ─── Quick actions with inline confirm ───────────────────────────────────────
const ACTION_LABELS = {
  approve:   "Confirm Approve ✓",
  hold:      "Confirm Hold ⏸",
  reject:    "Confirm Reject ✗",
  duplicate: "Confirm Duplicate ⊘",
};

function quickAction(event, id, action) {
  event.stopPropagation();

  const el = event.currentTarget;

  // Already pending confirmation for this button?
  if (pendingConfirm && pendingConfirm.id === id && pendingConfirm.action === action) {
    clearPendingConfirm();
    executeQuickAction(id, action);
    closeAllDropdowns();
    return;
  }

  clearPendingConfirm();

  const originalText = el.textContent;
  el.textContent = ACTION_LABELS[action] || "Confirm?";
  el.classList.add("confirming");

  const timer = setTimeout(() => {
    clearPendingConfirm();
  }, 4000);

  pendingConfirm = { id, action, el, originalText, timer };
}

function clearPendingConfirm() {
  if (!pendingConfirm) return;
  clearTimeout(pendingConfirm.timer);
  if (pendingConfirm.el) {
    pendingConfirm.el.textContent = pendingConfirm.originalText;
    pendingConfirm.el.classList.remove("confirming");
  }
  pendingConfirm = null;
}

window.quickAction = quickAction;

async function executeQuickAction(id, action) {
  const updates = {
    approve:   { status: "approved",      review_status: "approved",   approved_at: new Date().toISOString() },
    hold:      { status: "needs_review",   review_status: "in_review" },
    reject:    { status: "needs_review",   review_status: "rejected"  },
    duplicate: { status: "duplicate",      duplicate_status: "confirmed", review_status: "in_review" },
  }[action];

  if (!updates) return;

  statusMessage.textContent = `Updating invoice…`;

  const { error } = await supabase
    .from("ap_invoices")
    .update(updates)
    .eq("id", id);

  if (error) {
    console.error("Quick action failed:", error);
    statusMessage.textContent = `Update failed: ${error.message}`;
    return;
  }

  // Write audit event
  await supabase.from("ap_invoice_review_events").insert([{
    invoice_id:    id,
    field_name:    "review_status",
    new_value:     updates.review_status || null,
    change_reason: `Quick action: ${action} from queue`,
  }]);

  await loadPage(true);
}

// ─── Filter events ───────────────────────────────────────────────────────────
function scheduleLoad() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { currentPage = 0; loadPage(); }, 350);
}

function clearAllFilters() {
  vendorSearch.value    = "";
  poSearch.value        = "";
  invoiceSearch.value   = "";
  statusFilter.value    = "";
  reviewFilter.value    = "";
  duplicateFilter.value = "";
  window.history.replaceState({}, "", window.location.pathname);
  currentPage = 0;
  loadPage();
}

// Expose for empty-state button
window.clearAllFilters = clearAllFilters;

function bindEvents() {
  vendorSearch.addEventListener("input",    scheduleLoad);
  poSearch.addEventListener("input",        scheduleLoad);
  invoiceSearch.addEventListener("input",   scheduleLoad);
  statusFilter.addEventListener("change",   () => { currentPage = 0; loadPage(); });
  reviewFilter.addEventListener("change",   () => { currentPage = 0; loadPage(); });
  duplicateFilter.addEventListener("change",() => { currentPage = 0; loadPage(); });
  clearFiltersButton.addEventListener("click", clearAllFilters);
  refreshButton.addEventListener("click",   () => loadPage());

  // Pagination buttons (added in HTML)
  const prevBtn = document.getElementById("prevPageBtn");
  const nextBtn = document.getElementById("nextPageBtn");
  if (prevBtn) prevBtn.addEventListener("click", () => { if (currentPage > 0) { currentPage--; loadPage(); } });
  if (nextBtn) nextBtn.addEventListener("click", () => { currentPage++; loadPage(); });

  // Column sort headers
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => handleSort(th.dataset.col));
  });

  // Stat pill clicks
  pillTotal.addEventListener("click",     () => setStatusFilter(""));
  pillReview.addEventListener("click",    () => setStatusFilter("needs_review"));
  pillApproved.addEventListener("click",  () => setStatusFilter("approved"));
  pillDuplicate.addEventListener("click", () => setStatusFilter("duplicate"));
  pillFailed.addEventListener("click",    () => setStatusFilter("failed"));
}

function setStatusFilter(value) {
  statusFilter.value = value;
  currentPage = 0;
  loadPage();
}

// ─── URL persistence ─────────────────────────────────────────────────────────
function syncUrlParams() {
  const params = new URLSearchParams();
  if (vendorSearch.value.trim())    params.set("vendor",    vendorSearch.value.trim());
  if (poSearch.value.trim())        params.set("po",        poSearch.value.trim());
  if (invoiceSearch.value.trim())   params.set("inv",       invoiceSearch.value.trim());
  if (statusFilter.value)           params.set("status",    statusFilter.value);
  if (reviewFilter.value)           params.set("review",    reviewFilter.value);
  if (duplicateFilter.value)        params.set("duplicate", duplicateFilter.value);
  if (currentPage > 0)              params.set("page",      String(currentPage));

  const qs = params.toString();
  const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState({}, "", newUrl);
}

function applyUrlParamsToInputs() {
  const v = pageParams.get("vendor");
  const p = pageParams.get("po");
  const i = pageParams.get("inv");
  const s = pageParams.get("status");
  const r = pageParams.get("review");
  const d = pageParams.get("duplicate");
  const pg = pageParams.get("page");

  if (v && vendorSearch)    vendorSearch.value    = v;
  if (p && poSearch)        poSearch.value        = p;
  if (i && invoiceSearch)   invoiceSearch.value   = i;
  if (s && statusFilter)    statusFilter.value    = s;
  if (r && reviewFilter)    reviewFilter.value    = r;
  if (d && duplicateFilter) duplicateFilter.value = d;
  if (pg)                   currentPage           = Number(pg) || 0;
}

// ─── Auto-refresh (30s — reduced to ease DB load at scale) ───────────────────
function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (!document.hidden) loadPage(true);
  }, 30000);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function buildStatusMessage() {
  const filters = [];
  if (vendorSearch.value.trim())  filters.push(`vendor: "${vendorSearch.value.trim()}"`);
  if (poSearch.value.trim())      filters.push(`PO: "${poSearch.value.trim()}"`);
  if (invoiceSearch.value.trim()) filters.push(`invoice: "${invoiceSearch.value.trim()}"`);
  if (statusFilter.value)         filters.push(`status: ${statusFilter.value}`);
  if (reviewFilter.value)         filters.push(`review: ${reviewFilter.value}`);
  if (duplicateFilter.value)      filters.push(`duplicate: ${duplicateFilter.value}`);

  const suffix = filters.length ? ` · ${filters.join(" · ")}` : "";

  if (totalCount <= PAGE_SIZE) {
    return `${totalCount} invoice${totalCount !== 1 ? "s" : ""}${suffix}`;
  }
  const from = currentPage * PAGE_SIZE + 1;
  const to   = Math.min((currentPage + 1) * PAGE_SIZE, totalCount);
  return `Showing ${from}–${to} of ${totalCount} invoices${suffix}`;
}

function formatAge(dateStr) {
  if (!dateStr) return "";
  const diffMs  = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr  = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  let label, cls;
  if (diffMin < 60) {
    label = `${diffMin}m`;
    cls   = "";
  } else if (diffHr < 24) {
    label = `${diffHr}h`;
    cls   = "";
  } else if (diffDay < 3) {
    label = `${diffDay}d`;
    cls   = "age-warn";
  } else {
    label = `${diffDay}d`;
    cls   = "age-stale";
  }

  return `<span class="age-badge ${cls}">${label}</span>`;
}

function renderExceptionBadges(flags) {
  if (!Array.isArray(flags) || flags.length === 0) {
    return `<span class="exception-badge" style="opacity:0.5;">None</span>`;
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
  const n     = Number(value || 0);
  const label = getPriorityLabel(n);
  const klass = n >= 80 ? "priority-critical" :
                n >= 50 ? "priority-high"     :
                n >= 20 ? "priority-medium"   : "priority-low";
  return `<span class="priority-badge ${klass}">${label} (${n})</span>`;
}

function statusBadge(value) {
  const v = String(value || "").toLowerCase();
  if (v === "failed")       return `<span class="exception-badge">Failed</span>`;
  if (v === "needs_review") return `<span class="priority-badge priority-high">Needs Review</span>`;
  if (v === "approved")     return `<span class="priority-badge priority-low">Approved</span>`;
  if (v === "duplicate")    return `<span class="priority-badge priority-medium">Duplicate</span>`;
  return `<span style="font-size:12px;color:var(--muted);">${escapeHtml(value || "—")}</span>`;
}

function reviewBadge(value) {
  const v = String(value || "").toLowerCase();
  if (v === "approved")  return `<span class="priority-badge priority-low">Approved</span>`;
  if (v === "rejected")  return `<span class="exception-badge">Rejected</span>`;
  if (v === "in_review") return `<span class="priority-badge priority-medium">In Review</span>`;
  return `<span style="font-size:12px;color:var(--muted);">${escapeHtml(value || "—")}</span>`;
}

function duplicateBadge(value) {
  const v = String(value || "").toLowerCase();
  if (v === "confirmed") return `<span class="exception-badge">Confirmed</span>`;
  if (v === "suspected") return `<span class="priority-badge priority-medium">Suspected</span>`;
  if (v === "clear")     return `<span class="priority-badge priority-low">Clear</span>`;
  return `<span style="font-size:12px;color:var(--muted);">${escapeHtml(value || "—")}</span>`;
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