import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

export async function uploadInvoice(file: File) {
  const invoiceId = crypto.randomUUID();
  const storagePath = `manual-tests/${Date.now()}-${file.name}`;

  const { error: uploadError } = await supabase.storage
    .from("ap-invoices")
    .upload(storagePath, file, {
      upsert: false,
      contentType: "application/pdf",
    });

  if (uploadError) throw uploadError;

  const { error: insertError } = await supabase.from("ap_invoices").insert({
    id: invoiceId,
    file_name: file.name,
    storage_path: storagePath,
    status: "uploaded",
    review_status: "unreviewed",
  });

  if (insertError) throw insertError;

  const functionUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/enqueue-invoice`;

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  const res = await fetch(functionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ invoiceId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to enqueue invoice: ${text}`);
  }

  return {
    invoiceId,
    storagePath,
  };
}