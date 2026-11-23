// Chamadas do CRO para os formulários (gestão, números e respostas).
import { db } from "../crm/api";
import type { FormContent, FormListRow, FormRow, FormSession, FormSettings, FormStyle } from "./types";

function check<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data as T;
}

export async function formList(tenantId: string, days = 30): Promise<FormListRow[]> {
  const rows = check(await db().rpc("form_list", { p_tenant_id: tenantId, p_days: days })) as FormListRow[];
  return rows.map((r) => ({ ...r, views: Number(r.views), starts: Number(r.starts), leads: Number(r.leads) }));
}

export async function formGet(id: string): Promise<FormRow> {
  return check(await db().from("crm_forms").select("*").eq("id", id).single()) as FormRow;
}

export async function formSave(tenantId: string, id: string | null, input: {
  name: string; slug: string; style: FormStyle; content: FormContent; settings: FormSettings;
}): Promise<FormRow> {
  return check(await db().rpc("form_save", {
    p_tenant_id: tenantId, p_id: id, p_name: input.name, p_slug: input.slug, p_style: input.style,
    p_content: input.content, p_settings: input.settings,
  })) as FormRow;
}

export async function formSetStatus(id: string, status: FormRow["status"]): Promise<FormRow> {
  return check(await db().rpc("form_set_status", { p_id: id, p_status: status })) as FormRow;
}

export async function formFunnel(id: string, days = 30): Promise<{ step: number; reached: number }[]> {
  const rows = check(await db().rpc("form_funnel", { p_form_id: id, p_days: days })) as { step: number; reached: number }[];
  return rows.map((r) => ({ step: Number(r.step), reached: Number(r.reached) }));
}

const SESSION_COLS = "id, created_at, started_at, completed_at, max_step, answers, events, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid, referrer, landing_url, device, name, phone, email, contact_id, deal_id";

export async function formSessions(formId: string, opts: { onlyLeads?: boolean; days?: number; limit?: number } = {}): Promise<FormSession[]> {
  const since = new Date(Date.now() - (opts.days ?? 30) * 86400000).toISOString();
  let q = db().from("crm_form_sessions").select(SESSION_COLS).eq("form_id", formId).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(opts.limit ?? 200);
  if (opts.onlyLeads) q = q.not("completed_at", "is", null);
  return check(await q) as FormSession[];
}

/** Respostas de formulário de um contato (para a ficha do cliente). */
export async function formSessionsForContact(contactId: string): Promise<(FormSession & { form_id: string })[]> {
  return check(await db().from("crm_form_sessions").select(`form_id, ${SESSION_COLS}`).eq("contact_id", contactId)
    .not("completed_at", "is", null).order("created_at", { ascending: false }).limit(20)) as (FormSession & { form_id: string })[];
}
