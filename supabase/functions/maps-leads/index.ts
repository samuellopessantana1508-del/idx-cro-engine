// Busca de clientes no Google Maps (Places API oficial) → Discador → Disparos.
// Ações:
//   set_key / remove_key {tenant_id, api_key}       (gestor)  — chave guardada criptografada
//   preview {tenant_id, query, location}             (quem escreve no CRM) — 1 chamada, não grava
//   run {source_id}                                  (quem escreve no CRM) — roda uma fonte agora
//   auto_extract {tenant_id, ramo, cidade, tagName?, list_name?} — extrator do FlowZap original (7 buscas × 3 páginas, até 120)
//   cron  (header x-gateway-token)                   — motor do WhatsApp chama a cada 10 min; roda as fontes vencidas
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decrypt, encrypt } from "../_shared/encryption.ts";
import { parsePlaces, PlacesError, searchText, type Place } from "../_shared/places.ts";
import { collectLeads } from "../_shared/flowzap-auto-extract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PLACES_BASE = Deno.env.get("PLACES_API_URL") || undefined; // só para testes
const svc = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-gateway-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function userAccess(req: Request, tenantId: string) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const db = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u } = await db.auth.getUser(auth.slice(7));
  if (!u?.user) return null;
  const { data: access } = await db.rpc("crm_my_access", { p_tenant_id: tenantId });
  return { user: u.user, access: (access ?? {}) as { write?: boolean; configure?: boolean } };
}

async function apiKeyFor(tenantId: string): Promise<string> {
  const { data: enc } = await svc.rpc("maps_get_key", { p_tenant: tenantId });
  if (enc) return await decrypt(enc as string);
  const env = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (env) return env;
  throw new PlacesError("Configure a chave do Google Maps em Disparos → Buscar clientes → Configurar.");
}

/** Executa uma fonte: locais em rodízio, até N páginas cada, respeitando o orçamento de chamadas */
async function runSource(sourceId: string, trigger: "manual" | "auto") {
  const { data: begin, error } = await svc.rpc("maps_begin_run", { p_source: sourceId, p_trigger: trigger });
  if (error) throw new PlacesError(error.message);
  const b = begin as { run_id: string; tenant_id: string; query: string; locations: string[]; pages: number; budget: number; max_new: number };
  let calls = 0;
  let inserted = 0;
  let errorMsg: string | null = null;
  try {
    const key = await apiKeyFor(b.tenant_id);
    outer: for (const loc of b.locations) {
      let token: string | null = null;
      let rank = 0;
      for (let page = 0; page < b.pages; page++) {
        if (calls >= b.budget) { errorMsg = "Limite mensal de buscas atingido no meio da execução."; break outer; }
        const body = await searchText({ apiKey: key, query: b.query, location: loc, pageToken: token, baseUrl: PLACES_BASE });
        calls++;
        await svc.rpc("maps_count_call", { p_tenant: b.tenant_id, p_run: b.run_id });
        const parsed = parsePlaces(body, loc, rank);
        rank += (body?.places ?? []).length;
        if (parsed.places.length) {
          const { data: r, error: ie } = await svc.rpc("maps_ingest", { p_run: b.run_id, p_places: parsed.places as Place[] });
          if (ie) throw new Error(ie.message);
          inserted += (r as { inserted: number }).inserted;
          if (inserted >= b.max_new) break outer;
        }
        token = parsed.next;
        if (!token) break;
      }
    }
  } catch (e) {
    errorMsg = e instanceof PlacesError ? e.message : `Falha na busca: ${(e as Error).message}`;
  }
  const { data: end } = await svc.rpc("maps_end_run", { p_run: b.run_id, p_error: errorMsg });
  return end;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "Corpo inválido" }, 400); }
  const action = String(body.action ?? "");

  try {
    // --- agendamento (motor do WhatsApp) ---
    if (action === "cron") {
      const token = req.headers.get("x-gateway-token") ?? "";
      const { error } = await svc.rpc("wa_gw_instances", { p_token: token });
      if (error) return json({ error: "unauthorized" }, 401);
      const { data: due } = await svc.rpc("maps_due_sources", { p_limit: 5 });
      const results = [];
      for (const id of (due ?? []) as string[]) {
        try { results.push(await runSource(id, "auto")); }
        catch (e) { results.push({ source_id: id, error: (e as Error).message }); }
      }
      return json({ ran: results.length, results });
    }

    // --- ações do usuário ---
    let tenantId = String(body.tenant_id ?? "");
    if (action === "run") {
      const { data: s } = await svc.from("lead_sources").select("tenant_id").eq("id", String(body.source_id ?? "")).maybeSingle();
      if (!s) return json({ error: "Busca não encontrada" }, 404);
      tenantId = s.tenant_id;
    }
    if (!tenantId) return json({ error: "Empresa não informada" }, 400);
    const ua = await userAccess(req, tenantId);
    if (!ua) return json({ error: "Faça login de novo" }, 401);

    if (action === "set_key" || action === "remove_key") {
      if (!ua.access.configure) return json({ error: "Somente gestores podem configurar a chave" }, 403);
      if (action === "remove_key") {
        await svc.rpc("maps_store_key", { p_tenant: tenantId, p_enc: null, p_hint: null, p_user: ua.user.id });
        return json({ ok: true });
      }
      const key = String(body.api_key ?? "").trim();
      if (!/^[A-Za-z0-9_\-]{30,60}$/.test(key)) return json({ error: "Isso não parece uma chave de API do Google (começa com “AIza…”)." }, 400);
      await svc.rpc("maps_store_key", { p_tenant: tenantId, p_enc: await encrypt(key), p_hint: key.slice(-4), p_user: ua.user.id });
      return json({ ok: true, key_hint: key.slice(-4) });
    }

    if (!ua.access.write) return json({ error: "Sem permissão no CRM desta empresa" }, 403);

    if (action === "preview") {
      const query = String(body.query ?? "").trim();
      const location = String(body.location ?? "").trim();
      if (!query || !location) return json({ error: "Informe o que buscar e onde" }, 400);
      const { data: left } = await svc.rpc("maps_budget", { p_tenant: tenantId });
      if (Number(left) <= 0) return json({ error: "Limite mensal de buscas atingido. Aumente em Configurar ou aguarde o próximo mês." }, 400);
      const key = await apiKeyFor(tenantId);
      const res = await searchText({ apiKey: key, query, location, baseUrl: PLACES_BASE });
      await svc.rpc("maps_count_call", { p_tenant: tenantId, p_run: null });
      const parsed = parsePlaces(res, location, 0);
      // marca quem já está no discador
      const phones = parsed.places.map((p) => p.phone).filter(Boolean) as string[];
      const { data: norm } = await svc.rpc("crm_normalize_phones", { p_phones: phones });
      const normMap = new Map<string, string>(((norm ?? []) as { raw: string; e164: string }[]).map((x) => [x.raw, x.e164]));
      const e164s = [...new Set([...normMap.values()].filter(Boolean))];
      const { data: existing } = e164s.length
        ? await svc.from("crm_dial_leads").select("phone").eq("tenant_id", tenantId).in("phone", e164s)
        : { data: [] };
      const have = new Set(((existing ?? []) as { phone: string }[]).map((x) => x.phone));
      return json({
        places: parsed.places.map((p) => ({ ...p, already: p.phone ? have.has(normMap.get(p.phone) ?? "") : false })),
        closed: parsed.closed,
      });
    }

    if (action === "auto_extract") {
      const ramo = String(body.ramo ?? "").trim().slice(0, 80);
      const cidade = String(body.cidade ?? "").trim().slice(0, 80);
      if (!ramo || !cidade) return json({ error: "Ramo e cidade são obrigatórios" }, 400);
      const { data: left } = await svc.rpc("maps_budget", { p_tenant: tenantId });
      if (Number(left) <= 0) return json({ error: "Limite mensal de buscas atingido. Aumente em Configurar ou aguarde o próximo mês." }, 400);
      const key = await apiKeyFor(tenantId);
      let budget = Number(left);
      const { leads, calls, errors } = await collectLeads(key, ramo, cidade, {
        baseUrl: PLACES_BASE,
        pageDelayMs: PLACES_BASE ? 10 : 2000,
        onCall: async () => {
          if (budget <= 0) return false;
          budget--;
          await svc.rpc("maps_count_call", { p_tenant: tenantId, p_run: null });
          return true;
        },
      });
      if (!leads.length && errors.length) return json({ error: errors[0] }, 400);
      const { data: saved, error: sErr } = await svc.rpc("flowzap_import_leads", {
        p_tenant_id: tenantId, p_user: ua.user.id, p_leads: leads, p_ramo: ramo, p_cidade: cidade,
        p_tag: String(body.tagName ?? "").trim() || null, p_list_name: String(body.list_name ?? "").trim() || null, p_api_calls: calls,
      });
      if (sErr) return json({ error: sErr.message }, 500);
      return json({ ...(saved as Record<string, unknown>), api_calls: calls, leads: leads.slice(0, 50) });
    }

    if (action === "run") {
      const result = await runSource(String(body.source_id), "manual");
      return json(result);
    }
    return json({ error: "Ação inválida" }, 400);
  } catch (e) {
    const msg = e instanceof PlacesError ? e.message : (e as Error).message;
    return json({ error: msg }, e instanceof PlacesError ? 400 : 500);
  }
});
