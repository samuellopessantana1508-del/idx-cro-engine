// Sincronização de gastos/insights de campanhas da Meta (usada pela tela e pela rotina diária).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { adsAccessToken } from "./meta-config.ts";

export function normalizeActId(value: string): string {
  const clean = value.trim();
  return clean.startsWith("act_") ? clean : `act_${clean}`;
}

export function lastNDays(days: number): { since: string; until: string } {
  const until = new Date();
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const fmt = (date: Date) => date.toISOString().slice(0, 10);
  return { since: fmt(since), until: fmt(until) };
}

export type SyncResult = { ok: true; synced: number } | { ok: false; status: number; error: string; detail?: unknown };

/** Busca os insights por campanha/dia (todas as páginas) e grava em meta_campaign_insights. */
export async function syncMetaInsights(
  supa: SupabaseClient,
  tenantId: string,
  opts: { days?: number; since?: string; until?: string; adAccountId?: string; adAccountName?: string; graphBase?: string } = {},
): Promise<SyncResult> {
  const { data: creds } = await supa.from("tenant_meta_credentials").select("*").eq("tenant_id", tenantId).maybeSingle();
  const adsToken = adsAccessToken(creds);
  if (!creds || !adsToken) return { ok: false, status: 400, error: "meta_not_connected" };

  const adAccountId = normalizeActId(String(opts.adAccountId ?? creds.selected_ad_account_id ?? ""));
  if (!adAccountId || adAccountId === "act_") return { ok: false, status: 400, error: "missing_ad_account_id" };

  const days = Math.min(Math.max(Number(opts.days ?? 30), 1), 90);
  const range = opts.since && opts.until ? { since: opts.since, until: opts.until } : lastNDays(days);
  const version = Deno.env.get("META_GRAPH_VERSION") ?? creds.graph_version ?? "v25.0";
  const fields = ["campaign_id", "campaign_name", "spend", "impressions", "reach", "clicks", "cpc", "cpm", "ctr", "date_start", "date_stop"].join(",");

  const first = new URL(`${opts.graphBase ?? "https://graph.facebook.com"}/${version}/${adAccountId}/insights`);
  first.searchParams.set("level", "campaign");
  first.searchParams.set("fields", fields);
  first.searchParams.set("time_increment", "1");
  first.searchParams.set("limit", "500");
  first.searchParams.set("time_range", JSON.stringify(range));
  first.searchParams.set("access_token", adsToken);

  const items: Record<string, string>[] = [];
  let next: string | null = first.toString();
  for (let page = 0; next && page < 20; page++) {
    const response: Response = await fetch(next, { signal: AbortSignal.timeout(30000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // não grava o token: só a mensagem de erro da Meta
      const detail = { error: payload?.error ? { message: payload.error.message, code: payload.error.code, type: payload.error.type } : payload };
      await supa.from("tenant_meta_credentials").update({
        integration_status: "needs_attention",
        last_error: JSON.stringify(detail),
        last_verified_at: new Date().toISOString(),
      }).eq("tenant_id", tenantId);
      return { ok: false, status: 400, error: "meta_insights_failed", detail };
    }
    items.push(...(payload.data ?? []));
    next = payload?.paging?.next ?? null;
  }

  const rows = items.map((item) => ({
    tenant_id: tenantId,
    ad_account_id: adAccountId,
    ad_account_name: creds.selected_ad_account_name ?? opts.adAccountName ?? null,
    campaign_id: item.campaign_id,
    campaign_name: item.campaign_name,
    date_start: item.date_start,
    date_stop: item.date_stop,
    spend: Number(item.spend ?? 0),
    impressions: Number(item.impressions ?? 0),
    reach: Number(item.reach ?? 0),
    clicks: Number(item.clicks ?? 0),
    cpc: item.cpc ? Number(item.cpc) : null,
    cpm: item.cpm ? Number(item.cpm) : null,
    ctr: item.ctr ? Number(item.ctr) : null,
    raw: item,
    synced_at: new Date().toISOString(),
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supa.from("meta_campaign_insights").upsert(rows.slice(i, i + 500), {
      onConflict: "tenant_id,ad_account_id,campaign_id,date_start,date_stop",
    });
    if (error) return { ok: false, status: 500, error: error.message };
  }

  await supa.from("tenant_meta_credentials").update({
    selected_ad_account_id: adAccountId,
    selected_ad_account_name: creds.selected_ad_account_name ?? opts.adAccountName ?? null,
    integration_status: "connected",
    last_error: null,
    last_verified_at: new Date().toISOString(),
  }).eq("tenant_id", tenantId);

  return { ok: true, synced: rows.length };
}
