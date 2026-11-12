import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Acesso ao banco SOMENTE pelas funções wa_gw_* (security definer) com o token
 * do motor. Usa a chave pública (anon); não precisa nem guarda service role.
 */
export class Db {
  private client: SupabaseClient;
  constructor(url: string, anonKey: string, private token: string) {
    this.client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private async rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, { p_token: this.token, ...args });
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  }

  instances() {
    return this.rpc<Array<{ id: string; tenant_id: string; instance_name: string; desired_status: string; status: string; phone_number: string | null }>>(
      "wa_gw_instances", {});
  }
  updateInstance(id: string, status: string, extra: { qr?: string | null; phone?: string | null; error?: string | null } = {}) {
    return this.rpc("wa_gw_instance_update", {
      p_instance: id, p_status: status, p_qr: extra.qr ?? null, p_phone: extra.phone ?? null, p_error: extra.error ?? null,
    });
  }
  recover(id: string) {
    return this.rpc<number>("wa_gw_recover", { p_instance: id });
  }
  claim(id: string) {
    return this.rpc<{ id: string; phone: string; body: string; source: "manual" | "campaign" | "flow"; campaign_id?: string;
      media_url?: string | null; media_type?: "image" | "video" | "audio" | "document" | null; file_name?: string | null } | null>(
      "wa_gw_claim", { p_instance: id });
  }
  result(outboxId: string, r: { ok: boolean; waMessageId?: string; jid?: string; error?: string; invalid?: boolean; retry?: boolean }) {
    return this.rpc("wa_gw_result", {
      p_outbox_id: outboxId, p_ok: r.ok, p_wa_message_id: r.waMessageId ?? null, p_jid: r.jid ?? null,
      p_error: r.error ?? null, p_invalid: r.invalid ?? false, p_retry: r.retry ?? false,
    });
  }
  ingest(instanceId: string, msg: object) {
    return this.rpc("wa_gw_ingest", { p_instance: instanceId, p_msg: msg });
  }
  status(instanceId: string, waMessageId: string, status: string) {
    return this.rpc("wa_gw_status", { p_instance: instanceId, p_wa_message_id: waMessageId, p_status: status });
  }
}
