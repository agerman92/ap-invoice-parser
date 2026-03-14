import { createClient } from "jsr:@supabase/supabase-js@2";

export type VendorResolution = {
  vendorId: string | null;
  canonicalName: string | null;
  normalizedName: string | null;
  parserKey: string | null;
  matchMethod: "exact_vendor" | "alias_vendor" | "raw_normalized" | null;
};

export function normalizeVendorName(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized || null;
}

type SupabaseClientType = ReturnType<typeof createClient>;

export async function resolveVendorIdentity(
  supabase: SupabaseClientType,
  rawVendorName: string | null | undefined,
): Promise<VendorResolution> {
  const normalized = normalizeVendorName(rawVendorName);

  if (!normalized) {
    return {
      vendorId: null,
      canonicalName: null,
      normalizedName: null,
      parserKey: null,
      matchMethod: null,
    };
  }

  const { data: exactVendor, error: exactError } = await supabase
    .from("ap_vendors")
    .select("id, canonical_name, normalized_name, parser_key")
    .eq("normalized_name", normalized)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (exactError) throw exactError;

  if (exactVendor) {
    return {
      vendorId: exactVendor.id,
      canonicalName: exactVendor.canonical_name,
      normalizedName: exactVendor.normalized_name,
      parserKey: exactVendor.parser_key,
      matchMethod: "exact_vendor",
    };
  }

  const { data: aliasRow, error: aliasError } = await supabase
    .from("ap_vendor_aliases")
    .select("vendor_id")
    .eq("alias_normalized", normalized)
    .limit(1)
    .maybeSingle();

  if (aliasError) throw aliasError;

  if (aliasRow?.vendor_id) {
    const { data: aliasVendor, error: aliasVendorError } = await supabase
      .from("ap_vendors")
      .select("id, canonical_name, normalized_name, parser_key")
      .eq("id", aliasRow.vendor_id)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (aliasVendorError) throw aliasVendorError;

    if (aliasVendor) {
      return {
        vendorId: aliasVendor.id,
        canonicalName: aliasVendor.canonical_name,
        normalizedName: aliasVendor.normalized_name,
        parserKey: aliasVendor.parser_key,
        matchMethod: "alias_vendor",
      };
    }
  }

  return {
    vendorId: null,
    canonicalName: rawVendorName ?? null,
    normalizedName: normalized,
    parserKey: null,
    matchMethod: "raw_normalized",
  };
}