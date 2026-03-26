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
let allRows          = [];      // full unfiltered dataset from Supabase
let debounceTimer    = null;
let autoRefreshTimer = null;
let sortCol          = "review_priority";
let sortDir          = "desc";  // "asc" | "desc"
let openDropdownId   = null;    // invoice id whose dropdown is open
let pendingConfirm   = null;    // { id, action, el, timer }

// Read URL params on load
const pageParams     = new URLSearchParams(window.location.search);

// ─── Init ────────────────────────────────────────────────────────────────────
applyUrlParamsToInputs();
bindEvents();
startAutoRefresh();
loadInvoices();

// ─── Load ────────────────────────────────────────────────────────────────────
async function loadInvoices(showRefreshing = false) {
  if (showRefreshing) {
    refreshDot.classList.add("refreshing");
  } else {
    statusMessage.textContent = "Loading invoices…";
  }

  const { data, error } = await supabase
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
    .order("created_at",       { ascending: false });

  refreshDot.classList.remove("refreshing");

  if (error) {
    console.error("Error loading invoices:", error);
    statusMessage.textContent = `Error: ${error.message}`;
    invoiceTableBody.innerHTML = "";
    return;
  }

  allRows = Array.isArray(data) ? data : [];

  // Update last-refreshed label
  const now = new Date();
  refreshLabel.textContent = `Last refreshed ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;

  renderAll();
}

// ─── Render pipeline ─────────────────────────────────────────────────────────
function renderAll() {
  const filtered = applyFilters(allRows);
  updateStatPills(allRows, filtered);
  updateSortHeaders();
  const sorted = applySort(filtered);
  renderTable(sorted);
  syncUrlParams();
}

function applyFilters(rows) {
  const vendor    = vendorSearch.value.trim().toLowerCase();
  const po        = poSearch.value.trim().toLowerCase();
  const inv       = invoiceSearch.value.trim().toLowerCase();
  const status    = statusFilter.value;
  const review    = reviewFilter.value;
  const duplicate = duplicateFilter.value;

  // URL-only hidden filters
  const urlVendor      = pageParams.get("vendor") || "";
  const urlFrom        = pageParams.get("from")   || "";
  const urlTo          = pageParams.get("to")     || "";
  const urlMinPriority = Number(pageParams.get("minPriority") || 0);

  return rows.filter((row) => {
    if (vendor && !String(row.vendor || "").toLowerCase().includes(vendor)) return false;
    if (po     && !String(row.po_number || "").toLowerCase().includes(po))  return false;
    if (inv    && !String(row.invoice_number || "").toLowerCase().includes(inv)) return false;
    if (status    && row.status           !== status)    return false;
    if (review    && row.review_status    !== review)    return false;
    if (duplicate && row.duplicate_status !== duplicate) return false;

    // Hidden URL filters
    if (urlVendor && String(row.vendor || "") !== urlVendor) return false;
    if (urlFrom) {
      if (new Date(row.created_at) < new Date(`${urlFrom}T00:00:00`)) return false;
    }
    if (urlTo) {
      const toEx = new Date(`${urlTo}T00:00:00`);
      toEx.setDate(toEx.getDate() + 1);
      if (new Date(row.created_at) >= toEx) return false;
    }
    if (urlMinPriority > 0 && Number(row.review_priority || 0) < urlMinPriority) return false;

    return true;
  });
}

function applySort(rows) {
  return [...rows].sort((a, b) => {
    let valA = a[sortCol];
    let valB = b[sortCol];

    // Numeric cols
    if (["review_priority", "total_invoice", "exception_count"].includes(sortCol)) {
      valA = Number(valA || 0);
      valB = Number(valB || 0);
    } else if (sortCol === "warnings") {
      valA = Array.isArray(a.warnings) ? a.warnings.length : 0;
      valB = Array.isArray(b.warnings) ? b.warnings.length : 0;
    } else if (sortCol === "created_at") {
      valA = valA ? new Date(valA).getTime() : 0;
      valB = valB ? new Date(valB).getTime() : 0;
    } else {
      valA = String(valA || "").toLowerCase();
      valB = String(valB || "").toLowerCase();
    }

    if (valA < valB) return sortDir === "asc" ? -1 : 1;
    if (valA > valB) return sortDir === "asc" ? 1 : -1;
    return 0;
  });
}

function renderTable(rows) {
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

  statusMessage.textContent = buildStatusMessage(rows.length);

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

// ─── Stat pills ──────────────────────────────────────────────────────────────
function updateStatPills(all, filtered) {
  // Counts from the FULL dataset (not filtered) so pills always show global state
  const needsReview = all.filter(r => r.status === "needs_review").length;
  const approved    = all.filter(r => r.status === "approved").length;
  const duplicates  = all.filter(r => r.status === "duplicate").length;
  const failed      = all.filter(r => r.status === "failed").length;

  pillTotalCount.textContent     = filtered.length;
  pillReviewCount.textContent    = needsReview;
  pillApprovedCount.textContent  = approved;
  pillDuplicateCount.textContent = duplicates;
  pillFailedCount.textContent    = failed;

  // Highlight active pill based on current status filter
  const active = statusFilter.value;
  pillTotal.classList.toggle("active",     !active);
  pillReview.classList.toggle("active",    active === "needs_review");
  pillApproved.classList.toggle("active",  active === "approved");
  pillDuplicate.classList.toggle("active", active === "duplicate");
  pillFailed.classList.toggle("active",    active === "failed");
}

// ─── Sorting ─────────────────────────────────────────────────────────────────
function handleSort(col) {
  if (sortCol === col) {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  } else {
    sortCol = col;
    sortDir = col === "review_priority" || col === "created_at" ? "desc" : "asc";
  }
  renderAll();
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

  await loadInvoices(true);
}

// ─── Filter events ───────────────────────────────────────────────────────────
function scheduleRender() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(renderAll, 200);
}

function clearAllFilters() {
  vendorSearch.value    = "";
  poSearch.value        = "";
  invoiceSearch.value   = "";
  statusFilter.value    = "";
  reviewFilter.value    = "";
  duplicateFilter.value = "";
  window.history.replaceState({}, "", window.location.pathname);
  renderAll();
}

// Expose for empty-state button
window.clearAllFilters = clearAllFilters;

function bindEvents() {
  vendorSearch.addEventListener("input",    scheduleRender);
  poSearch.addEventListener("input",        scheduleRender);
  invoiceSearch.addEventListener("input",   scheduleRender);
  statusFilter.addEventListener("change",   renderAll);
  reviewFilter.addEventListener("change",   renderAll);
  duplicateFilter.addEventListener("change", renderAll);
  clearFiltersButton.addEventListener("click", clearAllFilters);
  refreshButton.addEventListener("click",   () => loadInvoices());

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
  renderAll();
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

  if (v && vendorSearch)    vendorSearch.value    = v;
  if (p && poSearch)        poSearch.value        = p;
  if (i && invoiceSearch)   invoiceSearch.value   = i;
  if (s && statusFilter)    statusFilter.value    = s;
  if (r && reviewFilter)    reviewFilter.value    = r;
  if (d && duplicateFilter) duplicateFilter.value = d;
}

// ─── Auto-refresh ────────────────────────────────────────────────────────────
function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (!document.hidden) loadInvoices(true);
  }, 10000);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function buildStatusMessage(count) {
  const filters = [];
  if (vendorSearch.value.trim())  filters.push(`vendor: "${vendorSearch.value.trim()}"`);
  if (poSearch.value.trim())      filters.push(`PO: "${poSearch.value.trim()}"`);
  if (invoiceSearch.value.trim()) filters.push(`invoice: "${invoiceSearch.value.trim()}"`);
  if (statusFilter.value)         filters.push(`status: ${statusFilter.value}`);
  if (reviewFilter.value)         filters.push(`review: ${reviewFilter.value}`);
  if (duplicateFilter.value)      filters.push(`duplicate: ${duplicateFilter.value}`);

  const suffix = filters.length ? ` · ${filters.join(" · ")}` : "";
  return `${count} invoice${count !== 1 ? "s" : ""}${suffix}`;
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