// Rotinas automáticas do CRO. Chamada de hora em hora pelo motor do WhatsApp (header x-gateway-token).
//  1. Automações agendadas do CRM (negociação parada, tarefas, RFV)   → crm_run_scheduled_all()
//  2. Avisos operacionais (Meta vencendo/erro, Google erro, WhatsApp off) → cro_ops_notifications()
//  3. Sincronização diária dos gastos da Meta (últimos 7 dias, empresas conectadas, 1x a cada ~20 h)
// Cada rotina registra o resultado em cro_jobs (tela "Saúde do sistema").
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { syncMetaInsights } from "../_shared/meta-sync.ts";

const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const GRAPH = Deno.env.get("META_GRAPH_BASE") || undefined; // só para testes
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });

async function job(name: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    await svc.rpc("cro_job_done", { p_job: name, p_ok: true, p_result: result ?? null, p_error: null });
    return { job: name, ok: true, result };
  } catch (e) {
    const msg = (e as Error).message;
    await svc.rpc("cro_job_done", { p_job: name, p_ok: false, p_result: null, p_error: msg });
    return { job: name, ok: false, error: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);
  const token = req.headers.get("x-gateway-token") ?? "";
  const { error: authErr } = await svc.rpc("wa_gw_instances", { p_token: token });
  if (authErr) return json({ error: "unauthorized" }, 401);

  const results = [];
  results.push(await job("automacoes_crm", async () => {
    const { data, error } = await svc.rpc("crm_run_scheduled_all");
    if (error) throw new Error(error.message);
    return { empresas: data };
  }));
  results.push(await job("avisos", async () => {
    const { data, error } = await svc.rpc("cro_ops_notifications");
    if (error) throw new Error(error.message);
    return data;
  }));
  results.push(await job("meta_gastos", async () => {
    const cutoff = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
    const { data: due, error } = await svc.from("tenant_meta_credentials")
      .select("tenant_id, last_verified_at, facebook_token_expires_at")
      .eq("enabled", true).not("selected_ad_account_id", "is", null)
      .or(`last_verified_at.is.null,last_verified_at.lt.${cutoff}`);
    if (error) throw new Error(error.message);
    const out: Record<string, unknown> = {};
    for (const t of due ?? []) {
      if (t.facebook_token_expires_at && new Date(t.facebook_token_expires_at) < new Date()) { out[t.tenant_id] = "token vencido"; continue; }
      const r = await syncMetaInsights(svc, t.tenant_id, { days: 7, graphBase: GRAPH });
      out[t.tenant_id] = r.ok ? r.synced : r.error;
    }
    return { empresas: Object.keys(out).length, detalhe: out };
  }));
  return json({ ok: results.every((r) => r.ok), results });
});
