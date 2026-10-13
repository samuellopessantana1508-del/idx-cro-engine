import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function sha256(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function validateWebhookKey(
  apiKey: string | null,
): Promise<{ ok: true; tenantId: string } | { ok: false; error: string }> {
  if (!apiKey) return { ok: false, error: "missing_api_key" };

  const hash = await sha256(apiKey);

  const { data, error } = await supa
    .from("tenant_webhook_keys")
    .select("id, tenant_id, last_used_at")
    .eq("key_hash", hash)
    .eq("status", "active")
    .maybeSingle();

  if (error || !data) return { ok: false, error: "invalid_api_key" };

  supa
    .from("tenant_webhook_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(() => {});

  return { ok: true, tenantId: data.tenant_id };
}

export { sha256 };
