import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { extractPdfLayout } from "../_shared/pdf-layout.ts";
import { parseInvoiceWithRouter } from "../_shared/parser-router.ts";
import { validateInvoiceExtraction } from "../_shared/validation.ts";
import type { InvoiceExtraction } from "../_shared/invoice-schema.ts";
import {
  appendDuplicateFlag,
  buildFailedParseFlags,
  buildInvoiceExceptionFlags,
  calculateReviewPriority,
} from "../_shared/review-flags.ts";
import { normalizeVendorName, resolveVendorIdentity } from "../_shared/vendor-master.ts";

type JobRow = {
  id: number;
  invoice_id: string;
  job_type: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  payload: Record<string, unknown>;
};

function normalizeInvoiceNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return normalized || null;
}

function safeDate(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeError(error: unknown): {
  message: string;
  details?: string;
  hint?: string;
  code?: string;
  stack?: string | null;
  raw?: unknown;
} {
  if (error instanceof Error) {
    const anyErr = error as Error & {
      details?: string;
      hint?: string;
      code?: string;
      cause?: unknown;
    };

    return {
      message: anyErr.message || "Unknown error",
      details: anyErr.details,
      hint: anyErr.hint,
      code: anyErr.code,
      stack: anyErr.stack ?? null,
      raw: anyErr.cause,
    };
  }

  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    return {
      message: typeof obj.message === "string" ? obj.message : JSON.stringify(obj),
      details: typeof obj.details === "string" ? obj.details : undefined,
      hint: typeof obj.hint === "string" ? obj.hint : undefined,
      code: typeof obj.code === "string" ? obj.code : undefined,
      stack: typeof obj.stack === "string" ? obj.stack : null,
      raw: obj,
    };
  }

  return {
    message: String(error),
    stack: null,
  };
}

async function claimJob(
  supabase: ReturnType<typeof createClient>,
  workerId: string,
): Promise<JobRow | null> {
  const { data, error } = await supabase.rpc("claim_next_ap_invoice_job", {
    p_worker: workerId,
  });

  if (error) throw error;
  if (!data) return null;

  return {
    id: Number(data.id),
    invoice_id: String(data.invoice_id),
    job_type: String(data.job_type),
    status: String(data.status),
    attempt_count: Number(data.attempt_count ?? 0),
    max_attempts: Number(data.max_attempts ?? 0),
    payload: (data.payload ?? {}) as Record<string, unknown>,
  };
}

async function markJobCompleted(
  supabase: ReturnType<typeof createClient>,
  jobId: number,
) {
  const { error } = await supabase
    .from("ap_invoice_jobs")
    .update({
      status: "completed",
      updated_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: null,
    })
    .eq("id", jobId);

  if (error) throw error;
}

async function markJobRetry(
  supabase: ReturnType<typeof createClient>,
  job: JobRow,
  errorMessage: string,
) {
  const nextStatus = job.attempt_count >= job.max_attempts ? "failed" : "retry";
  const nextRunAfter = new Date(
    Date.now() + Math.min(job.attempt_count * 30, 300) * 1000,
  ).toISOString();

  const { error } = await supabase
    .from("ap_invoice_jobs")
    .update({
      status: nextStatus,
      run_after: nextStatus === "retry" ? nextRunAfter : new Date().toISOString(),
      updated_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: errorMessage,
    })
    .eq("id", job.id);

  if (error) throw error;

  return nextStatus;
}

async function detectDuplicate(
  supabase: ReturnType<typeof createClient>,
  invoiceId: string,
  vendorNormalized: string | null,
  invoiceNumberNormalized: string | null,
) {
  if (!vendorNormalized || !invoiceNumberNormalized) {
    return { duplicateStatus: "clear", duplicateOfInvoiceId: null };
  }

  const { data, error } = await supabase
    .from("ap_invoices")
    .select("id")
    .eq("vendor_normalized", vendorNormalized)
    .eq("invoice_number_normalized", invoiceNumberNormalized)
    .neq("id", invoiceId)
    .limit(1);

  if (error) throw error;

  if (data && data.length > 0) {
    return {
      duplicateStatus: "suspected",
      duplicateOfInvoiceId: data[0].id,
    };
  }

  return {
    duplicateStatus: "clear",
    duplicateOfInvoiceId: null,
  };
}

async function writeInvoiceDraft(
  supabase: ReturnType<typeof createClient>,
  invoiceId: string,
  parsed: InvoiceExtraction,
  warnings: unknown[],
  headerConfidence: Record<string, number> | null = null,
  lineConfidence: unknown[] | null = null,
) {
  const resolvedVendor = await resolveVendorIdentity(supabase, parsed.vendor);
  const vendorNormalized =
    resolvedVendor.normalizedName ?? normalizeVendorName(parsed.vendor);
  const invoiceNumberNormalized = normalizeInvoiceNumber(parsed.invoice_number);
  const invoiceDateParsed = safeDate(parsed.invoice_date);

  const duplicate = await detectDuplicate(
    supabase,
    invoiceId,
    vendorNormalized,
    invoiceNumberNormalized,
  );

  let exceptionFlags = buildInvoiceExceptionFlags(parsed, warnings);
  exceptionFlags = appendDuplicateFlag(exceptionFlags, duplicate.duplicateStatus);
  const reviewPriority = calculateReviewPriority(exceptionFlags);

  const { error: updateInvoiceError } = await supabase
    .from("ap_invoices")
    .update({
      vendor: resolvedVendor.canonicalName || parsed.vendor || null,
      vendor_raw_name: parsed.vendor || null,
      vendor_normalized: vendorNormalized,
      vendor_id: resolvedVendor.vendorId,
      vendor_match_method: resolvedVendor.matchMethod,
      invoice_number: parsed.invoice_number || null,
      invoice_number_normalized: invoiceNumberNormalized,
      invoice_date: parsed.invoice_date || null,
      invoice_date_parsed: invoiceDateParsed,
      po_number: parsed.po_number || null,
      order_number: parsed.order_number || null,
      shipment_number: parsed.shipment_number || null,
      terms: parsed.terms || null,
      currency: parsed.currency || null,
      subtotal: parsed.subtotal ?? 0,
      freight_charge: parsed.freight_charge ?? 0,
      drop_ship_charge: parsed.drop_ship_charge ?? 0,
      misc_charges: parsed.misc_charges ?? 0,
      total_invoice: parsed.total_invoice ?? 0,
      warnings,
      duplicate_status: duplicate.duplicateStatus,
      duplicate_of_invoice_id: duplicate.duplicateOfInvoiceId,
      exception_flags: exceptionFlags,
      exception_count: exceptionFlags.length,
      review_priority: reviewPriority,
      status: "needs_review",
      review_status: "unreviewed",
      parse_error: null,
    })
    .eq("id", invoiceId);

  if (updateInvoiceError) throw updateInvoiceError;

  const { error: deleteLinesError } = await supabase
    .from("ap_invoice_lines")
    .delete()
    .eq("invoice_id", invoiceId);

  if (deleteLinesError) throw deleteLinesError;

  const lineRows = (parsed.lines || []).map((line) => ({
    invoice_id: invoiceId,
    line_number: line.line_number,
    line_type: line.line_type,
    part_number: line.part_number || null,
    description: line.description || null,
    origin: line.origin || null,
    quantity: line.quantity ?? 0,
    unit_price: line.unit_price ?? 0,
    discount_percent: line.discount_percent ?? 0,
    net_unit_price: line.net_unit_price ?? 0,
    line_total: line.line_total ?? 0,
  }));

  if (lineRows.length > 0) {
    const { error: insertLinesError } = await supabase
      .from("ap_invoice_lines")
      .insert(lineRows);

    if (insertLinesError) throw insertLinesError;
  }

  const { error: extractionConfidenceError } = await supabase
    .from("ap_invoice_extractions")
    .update({
      header_confidence: headerConfidence,
      line_confidence: lineConfidence,
    })
    .eq("invoice_id", invoiceId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (extractionConfidenceError) {
    console.warn("Could not update extraction confidence:", extractionConfidenceError);
  }
}

async function processOneJob(
  supabase: ReturnType<typeof createClient>,
  workerId: string,
): Promise<boolean> {
  const job = await claimJob(supabase, workerId);
  if (!job) return false;

  let extractionId: string | null = null;

  try {
    const { data: invoice, error: invoiceError } = await supabase
      .from("ap_invoices")
      .select("id, storage_path, file_name")
      .eq("id", job.invoice_id)
      .single();

    if (invoiceError) throw invoiceError;
    if (!invoice?.storage_path) {
      throw new Error("Invoice storage_path is missing.");
    }

    const { error: invoiceStatusError } = await supabase
      .from("ap_invoices")
      .update({
        status: "extracting",
        review_status: "unreviewed",
        parse_error: null,
      })
      .eq("id", job.invoice_id);

    if (invoiceStatusError) throw invoiceStatusError;

    const { data: extraction, error: extractionInsertError } = await supabase
      .from("ap_invoice_extractions")
      .insert({
        invoice_id: job.invoice_id,
        storage_path: invoice.storage_path,
        status: "processing",
        parser_version: "router-v2",
        prompt_version: "v1",
        schema_version: "v1",
        model: "gpt-5",
      })
      .select("id")
      .single();

    if (extractionInsertError) throw extractionInsertError;
    extractionId = extraction.id;

    const { data: fileData, error: downloadError } = await supabase.storage
      .from("ap-invoices")
      .download(invoice.storage_path);

    if (downloadError) throw downloadError;

    const bytes = new Uint8Array(await fileData.arrayBuffer());
    const layout = await extractPdfLayout(bytes);
    const routed = await parseInvoiceWithRouter(layout);
    const parsed = routed.parsed;
    const warnings = validateInvoiceExtraction(parsed);

    const headerConfidence =
  (routed as { headerConfidence?: Record<string, number> }).headerConfidence ?? {};
const lineConfidence =
  (routed as { lineConfidence?: unknown[] }).lineConfidence ?? [];

    const { error: extractionUpdateError } = await supabase
      .from("ap_invoice_extractions")
      .update({
        status: "completed",
        raw_text: layout.plainText,
        structured_json: parsed,
        warnings,
        parser_version: routed.parserVersion,
        header_confidence: headerConfidence,
        line_confidence: lineConfidence,
        completed_at: new Date().toISOString(),
      })
      .eq("id", extractionId);

    if (extractionUpdateError) throw extractionUpdateError;

    await writeInvoiceDraft(
      supabase,
      job.invoice_id,
      parsed,
      warnings,
      headerConfidence,
      lineConfidence,
    );
    await markJobCompleted(supabase, job.id);

    return true;
  } catch (error) {
    const normalized = normalizeError(error);
    const errorMessage = [
      normalized.message,
      normalized.code ? `code=${normalized.code}` : null,
      normalized.details ? `details=${normalized.details}` : null,
      normalized.hint ? `hint=${normalized.hint}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    if (extractionId) {
      await supabase
        .from("ap_invoice_extractions")
        .update({
          status: "failed",
          error_message: errorMessage,
          completed_at: new Date().toISOString(),
        })
        .eq("id", extractionId);
    }

    const nextJobStatus = await markJobRetry(supabase, job, errorMessage);

    if (nextJobStatus === "failed") {
      const failedFlags = buildFailedParseFlags(errorMessage);
      await supabase
        .from("ap_invoices")
        .update({
          status: "failed",
          parse_error: errorMessage,
          exception_flags: failedFlags,
          exception_count: failedFlags.length,
          review_priority: calculateReviewPriority(failedFlags),
        })
        .eq("id", job.invoice_id);
    } else {
      await supabase
        .from("ap_invoices")
        .update({
          status: "queued",
          parse_error: errorMessage,
        })
        .eq("id", job.invoice_id);
    }

    return true;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const batchSize = Math.min(Number(url.searchParams.get("batch") || 1), 10);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const workerId = `worker-${crypto.randomUUID()}`;
    let processed = 0;

    for (let i = 0; i < batchSize; i++) {
      const didProcess = await processOneJob(supabase, workerId);
      if (!didProcess) break;
      processed += 1;
    }

    return new Response(
      JSON.stringify({ success: true, processed }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    const normalized = normalizeError(error);

    return new Response(
      JSON.stringify({
        success: false,
        error: normalized.message,
        details: normalized.details ?? null,
        hint: normalized.hint ?? null,
        code: normalized.code ?? null,
        stack: normalized.stack ?? null,
        raw: normalized.raw ?? null,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});