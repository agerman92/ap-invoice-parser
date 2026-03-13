-- =========================================================
-- AP Invoice Processing Phase 1
-- Durable jobs + extraction history + review-ready statuses
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1) Extend ap_invoices
-- ---------------------------------------------------------

alter table public.ap_invoices
  add column if not exists review_status text not null default 'unreviewed',
  add column if not exists duplicate_status text not null default 'clear',
  add column if not exists duplicate_of_invoice_id uuid null references public.ap_invoices(id),
  add column if not exists vendor_raw_name text,
  add column if not exists vendor_normalized text,
  add column if not exists invoice_date_parsed date,
  add column if not exists invoice_number_normalized text,
  add column if not exists warnings jsonb not null default '[]'::jsonb,
  add column if not exists extraction_version integer not null default 0,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid;

-- Normalize current statuses to future-safe values if needed.
update public.ap_invoices
set status = 'uploaded'
where status is null;

-- Helpful status constraints
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ap_invoices_status_check_v2'
  ) then
    alter table public.ap_invoices
      add constraint ap_invoices_status_check_v2
      check (status in (
        'uploaded',
        'queued',
        'extracting',
        'extracted',
        'needs_review',
        'approved',
        'duplicate',
        'rejected',
        'failed'
      ));
  end if;
end$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ap_invoices_review_status_check'
  ) then
    alter table public.ap_invoices
      add constraint ap_invoices_review_status_check
      check (review_status in (
        'unreviewed',
        'in_review',
        'approved',
        'rejected'
      ));
  end if;
end$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ap_invoices_duplicate_status_check'
  ) then
    alter table public.ap_invoices
      add constraint ap_invoices_duplicate_status_check
      check (duplicate_status in (
        'clear',
        'suspected',
        'confirmed'
      ));
  end if;
end$$;

create index if not exists idx_ap_invoices_status on public.ap_invoices(status);
create index if not exists idx_ap_invoices_review_status on public.ap_invoices(review_status);
create index if not exists idx_ap_invoices_vendor_norm_invoice_norm
  on public.ap_invoices(vendor_normalized, invoice_number_normalized);
create index if not exists idx_ap_invoices_invoice_date_parsed
  on public.ap_invoices(invoice_date_parsed);

-- ---------------------------------------------------------
-- 2) Extraction history table
-- ---------------------------------------------------------

create table if not exists public.ap_invoice_extractions (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.ap_invoices(id) on delete cascade,
  storage_path text not null,
  status text not null default 'processing',
  parser_version text not null default 'v1',
  prompt_version text not null default 'v1',
  schema_version text not null default 'v1',
  model text not null,
  raw_text text,
  structured_json jsonb,
  warnings jsonb not null default '[]'::jsonb,
  header_confidence jsonb not null default '{}'::jsonb,
  line_confidence jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_ap_invoice_extractions_invoice_id
  on public.ap_invoice_extractions(invoice_id, created_at desc);

create index if not exists idx_ap_invoice_extractions_status
  on public.ap_invoice_extractions(status);

-- ---------------------------------------------------------
-- 3) Jobs table
-- ---------------------------------------------------------

create table if not exists public.ap_invoice_jobs (
  id bigserial primary key,
  invoice_id uuid not null references public.ap_invoices(id) on delete cascade,
  job_type text not null default 'parse',
  status text not null default 'queued',
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  payload jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ap_invoice_jobs_status_check'
  ) then
    alter table public.ap_invoice_jobs
      add constraint ap_invoice_jobs_status_check
      check (status in (
        'queued',
        'processing',
        'retry',
        'completed',
        'failed'
      ));
  end if;
end$$;

create index if not exists idx_ap_invoice_jobs_status_run_after
  on public.ap_invoice_jobs(status, run_after, created_at);

create index if not exists idx_ap_invoice_jobs_invoice_id
  on public.ap_invoice_jobs(invoice_id);

-- Prevent duplicate open jobs for the same invoice/job_type
create unique index if not exists uq_ap_invoice_jobs_one_open_job
  on public.ap_invoice_jobs(invoice_id, job_type)
  where status in ('queued', 'processing', 'retry');

-- ---------------------------------------------------------
-- 4) Review audit log
-- ---------------------------------------------------------

create table if not exists public.ap_invoice_review_events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.ap_invoices(id) on delete cascade,
  field_name text not null,
  old_value jsonb,
  new_value jsonb,
  changed_by uuid,
  change_reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_ap_invoice_review_events_invoice_id
  on public.ap_invoice_review_events(invoice_id, created_at desc);

-- ---------------------------------------------------------
-- 5) Normalization helper functions
-- ---------------------------------------------------------

create or replace function public.normalize_vendor_name(p_value text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(lower(trim(coalesce(p_value, ''))), '[^a-z0-9]+', '', 'g'),
    ''
  );
$$;

create or replace function public.normalize_invoice_number(p_value text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(upper(trim(coalesce(p_value, ''))), '[^A-Z0-9]+', '', 'g'),
    ''
  );
$$;

-- ---------------------------------------------------------
-- 6) Queue helper
-- ---------------------------------------------------------

create or replace function public.queue_ap_invoice_parse(
  p_invoice_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
as $$
declare
  v_job_id bigint;
begin
  update public.ap_invoices
  set status = 'queued'
  where id = p_invoice_id
    and status in ('uploaded', 'failed', 'rejected');

  insert into public.ap_invoice_jobs (
    invoice_id,
    job_type,
    status,
    payload
  )
  values (
    p_invoice_id,
    'parse',
    'queued',
    coalesce(p_payload, '{}'::jsonb)
  )
  on conflict do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select id
    into v_job_id
    from public.ap_invoice_jobs
    where invoice_id = p_invoice_id
      and job_type = 'parse'
      and status in ('queued', 'processing', 'retry')
    order by created_at desc
    limit 1;
  end if;

  return v_job_id;
end;
$$;

-- ---------------------------------------------------------
-- 7) Job claim helper using SKIP LOCKED
-- ---------------------------------------------------------

create or replace function public.claim_next_ap_invoice_job(p_worker text)
returns public.ap_invoice_jobs
language plpgsql
security definer
as $$
declare
  v_job public.ap_invoice_jobs;
begin
  with cte as (
    select id
    from public.ap_invoice_jobs
    where status in ('queued', 'retry')
      and run_after <= now()
    order by created_at
    for update skip locked
    limit 1
  )
  update public.ap_invoice_jobs j
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker,
      attempt_count = attempt_count + 1,
      updated_at = now()
  from cte
  where j.id = cte.id
  returning j.* into v_job;

  return v_job;
end;
$$;

-- ---------------------------------------------------------
-- 8) Duplicate candidate view
-- ---------------------------------------------------------

create or replace view public.ap_invoice_duplicate_candidates as
select
  a.id as invoice_id,
  b.id as possible_duplicate_invoice_id,
  a.vendor_normalized,
  a.invoice_number_normalized,
  a.total_invoice,
  a.invoice_date_parsed,
  b.total_invoice as possible_duplicate_total_invoice,
  b.invoice_date_parsed as possible_duplicate_invoice_date
from public.ap_invoices a
join public.ap_invoices b
  on a.id <> b.id
 and a.vendor_normalized is not null
 and a.invoice_number_normalized is not null
 and a.vendor_normalized = b.vendor_normalized
 and a.invoice_number_normalized = b.invoice_number_normalized;

commit;