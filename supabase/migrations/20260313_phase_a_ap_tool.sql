-- =========================================================
-- Phase A - AP Review Workflow / Vendor Master / Ops
-- =========================================================

-- ----------------------------
-- A1 + A2 fields on ap_invoices
-- ----------------------------
alter table public.ap_invoices
  add column if not exists exception_flags jsonb not null default '[]'::jsonb,
  add column if not exists exception_count integer not null default 0,
  add column if not exists review_priority integer not null default 0,
  add column if not exists hold_reason text,
  add column if not exists rejection_reason text,
  add column if not exists ap_notes text,
  add column if not exists vendor_id uuid,
  add column if not exists vendor_match_method text;

create index if not exists idx_ap_invoices_review_priority
  on public.ap_invoices (review_priority desc, created_at desc);

create index if not exists idx_ap_invoices_exception_count
  on public.ap_invoices (exception_count desc);

create index if not exists idx_ap_invoice_jobs_queue
  on public.ap_invoice_jobs (status, run_after);

-- ----------------------------
-- A4 vendor master
-- ----------------------------
create table if not exists public.ap_vendors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null,
  canonical_name text not null,
  normalized_name text not null,
  parser_key text null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_ap_vendors_org_normalized
  on public.ap_vendors (organization_id, normalized_name);

create table if not exists public.ap_vendor_aliases (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.ap_vendors(id) on delete cascade,
  alias_name text not null,
  alias_normalized text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_ap_vendor_aliases_vendor_alias
  on public.ap_vendor_aliases (vendor_id, alias_normalized);

alter table public.ap_invoices
  add constraint ap_invoices_vendor_id_fkey
  foreign key (vendor_id) references public.ap_vendors(id)
  on delete set null;

-- ----------------------------
-- A5 optional permissive read policies
-- Adjust later for tenant/RLS maturity
-- ----------------------------

-- Uncomment if you need browser reads and do not already have policies:
-- create policy "Allow read ap_vendors"
-- on public.ap_vendors
-- for select
-- to anon, authenticated
-- using (true);

-- create policy "Allow read ap_vendor_aliases"
-- on public.ap_vendor_aliases
-- for select
-- to anon, authenticated
-- using (true);