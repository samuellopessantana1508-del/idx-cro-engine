// Motor das automações de WhatsApp do CRO.
// O motor do WhatsApp (services/wa-gateway) chama esta função (header x-gateway-token):
//   - logo depois de receber uma mensagem;
//   - a cada 30s, para retomar esperas vencidas e iniciar execuções agendadas.
// Ela processa a fila wa_flow_queue (mensagens, etiquetas, etapas, inícios manuais) e as
// execuções com espera vencida. Toda mensagem vai para a fila única wa_outbox (source 'flow').
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  step, startState, matchTrigger, normalize,
  type Graph, type RunState, type FlowEffects, type ContactInfo, type FlowEvent, type OutMsg,
} from "../_shared/flow-core.ts";
import { chatReply } from "../_shared/ai-chat.ts";
import { phoneVariants } from "../_shared/phone-variants.ts";

const svc: SupabaseClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ALLOW_HTTP_WEBHOOK = Deno.env.get("FLOW_WEBHOOK_ALLOW_HTTP") === "1"; // só testes locais
const TIME_BUDGET_MS = 25_000;
const RESPONSE_WAITS = new Set(["response", "menu", "ask"]);
// prioridade entre gatilhos de mensagem: o mais específico ganha (uma automação por mensagem)
const KIND_RANK: Record<string, number> = { keyword: 4, campaign: 3, first_message: 2, message: 1 };

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

type Flow = {
  id: string; tenant_id: string; name: string; status: string; graph: Graph; trigger_kind: string | null;
  reentry: "once" | "cooldown" | "always"; cooldown_hours: number; priority: number; instance_id: string | null; created_by: string | null;
};
type Run = {
  id: string; tenant_id: string; flow_id: string; instance_id: string | null; phone: string; conversation_id: string | null;
  crm_contact_id: string | null; is_test: boolean; state: RunState; status: string; wait_kind: string | null; started_by: string | null;
};
type QueueItem = {
  id: number; tenant_id: string; kind: "message" | "tag" | "stage" | "manual" | "webhook"; phone: string | null; instance_id: string | null;
  conversation_id: string | null; message_id: string | null; flow_id: string | null; payload: Record<string, any>; attempts: number;
};

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

// --- caches por chamada -------------------------------------------------------
const tzCache = new Map<string, string>();
async function tenantTz(tenant: string) {
  if (!tzCache.has(tenant)) {
    const { data } = await svc.from("tenants").select("timezone").eq("id", tenant).maybeSingle();
    tzCache.set(tenant, (data?.timezone as string) || "America/Sao_Paulo");
  }
  return tzCache.get(tenant)!;
}
const flowCache = new Map<string, Flow | null>();
async function getFlow(id: string): Promise<Flow | null> {
  if (!flowCache.has(id)) {
    const { data } = await svc.from("wa_flows").select("*").eq("id", id).maybeSingle();
    flowCache.set(id, (data as Flow) ?? null);
  }
  return flowCache.get(id)!;
}
async function gatewayInstance(tenant: string): Promise<string | null> {
  // a conexão ATIVA da empresa (QR Code do CRO ou API oficial), conectada primeiro
  const { data } = await svc.rpc("wa_active_instance_id", { p_tenant_id: tenant });
  return (data as string | null) ?? null;
}
async function conversationFor(tenant: string, phone: string, instance: string | null): Promise<{ id: string; bot_mode: string; bot_paused_until: string | null } | null> {
  if (!instance) return null;
  let { data: wc } = await svc.from("whatsapp_contacts").select("id").eq("tenant_id", tenant).eq("instance_id", instance).eq("phone", phone).limit(1).maybeSingle();
  if (!wc) {
    // a mensagem pode ter chegado pela outra conexão (QR Code x API oficial)
    ({ data: wc } = await svc.from("whatsapp_contacts").select("id").eq("tenant_id", tenant).eq("phone", phone).order("updated_at", { ascending: false }).limit(1).maybeSingle());
  }
  if (!wc) return null;
  const { data } = await svc.from("whatsapp_conversations").select("id, bot_mode, bot_paused_until").eq("contact_id", wc.id).limit(1).maybeSingle();
  return data as any;
}
async function convState(id: string | null) {
  if (!id) return null;
  const { data } = await svc.from("whatsapp_conversations").select("id, bot_mode, bot_paused_until").eq("id", id).maybeSingle();
  return data as { id: string; bot_mode: string; bot_paused_until: string | null } | null;
}
const botBlocked = (c: { bot_mode: string; bot_paused_until: string | null } | null) =>
  !!c && (c.bot_mode === "human" || (!!c.bot_paused_until && new Date(c.bot_paused_until) > new Date()));

async function loadContact(tenant: string, phone: string, crmId: string | null, convId: string | null): Promise<{ info: ContactInfo; row: any }> {
  let row: any = null;
  if (crmId) row = (await svc.from("crm_contacts").select("id, name, phone, email, city, tags, custom, owner_id, company_id").eq("id", crmId).maybeSingle()).data;
  let company: string | null = null;
  if (row?.company_id) company = ((await svc.from("crm_companies").select("name").eq("id", row.company_id).maybeSingle()).data?.name as string) ?? null;
  let push: string | null = null;
  if (!row?.name && convId) {
    const { data } = await svc.from("whatsapp_conversations").select("whatsapp_contacts(push_name)").eq("id", convId).maybeSingle();
    push = (data as any)?.whatsapp_contacts?.push_name ?? null;
  }
  const { data: opt } = await svc.from("wa_optouts").select("phone").eq("tenant_id", tenant).in("phone", phoneVariants(phone)).limit(1).maybeSingle();
  return {
    row,
    info: {
      name: row?.name ?? push, phone, email: row?.email ?? null, city: row?.city ?? null, company,
      tags: row?.tags ?? [], fields: row?.custom ?? {}, optedOut: !!opt,
    },
  };
}

// --- efeitos reais (banco) ----------------------------------------------------
function isSafeWebhook(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" && !(ALLOW_HTTP_WEBHOOK && u.protocol === "http:")) return false;
  if (ALLOW_HTTP_WEBHOOK) return true;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return false;
  return true;
}

function makeEffects(run: Run, flow: Flow, contact: { info: ContactInfo; row: any }, events: any[]): FlowEffects {
  const ensureContact = async (): Promise<string> => {
    if (run.crm_contact_id) return run.crm_contact_id;
    const id = must(await svc.rpc("wa_flow_contact", { p_tenant_id: run.tenant_id, p_phone: run.phone, p_name: contact.info.name ?? null }), "contato") as string;
    if (!id) throw new Error("Não foi possível criar o contato no CRM");
    run.crm_contact_id = id;
    await svc.from("wa_flow_runs").update({ crm_contact_id: id }).eq("id", run.id);
    contact.row = (await svc.from("crm_contacts").select("id, name, phone, email, city, tags, custom, owner_id, company_id").eq("id", id).maybeSingle()).data;
    return id;
  };
  const ownerOrCreator = () => contact.row?.owner_id ?? run.started_by ?? flow.created_by ?? null;
  const label = contact.info.name || run.phone;

  return {
    async send(msg: OutMsg, nodeId: string) {
      // a conexão pode ter sido trocada depois que a automação começou: usa a atual
      const current = await gatewayInstance(run.tenant_id);
      if (current && current !== run.instance_id) {
        run.instance_id = current;
        await svc.from("wa_flow_runs").update({ instance_id: current }).eq("id", run.id);
      }
      if (!run.instance_id) throw new Error("WhatsApp do CRO não está conectado");
      const row: Record<string, unknown> = {
        tenant_id: run.tenant_id, instance_id: run.instance_id, phone: run.phone, source: "flow", flow_run_id: run.id,
        conversation_id: run.conversation_id, created_by: run.started_by,
      };
      if (msg.kind === "text") {
        if (!msg.text.trim()) return;
        row.body = msg.text.slice(0, 4096);
        if (msg.buttons) {
          const { data: inst } = await svc.from("whatsapp_instances").select("provider").eq("id", run.instance_id).maybeSingle();
          if ((inst as { provider?: string } | null)?.provider === "cloud_api") {
            // API oficial: botões de resposta de verdade (até 3, título até 20 letras)
            row.body = msg.buttons.text.slice(0, 1024);
            row.interactive = { type: "buttons", options: msg.buttons.options.map((o) => o.slice(0, 20)), footer: msg.buttons.footer?.slice(0, 60) ?? null };
          }
        }
      } else {
        if (!/^https?:\/\//.test(msg.url)) throw new Error("Arquivo sem link válido");
        Object.assign(row, { body: (msg.caption ?? "").slice(0, 1024), media_url: msg.url, media_type: msg.mediaType, file_name: msg.fileName ?? null });
      }
      must(await svc.from("wa_outbox").insert(row), "fila de envio");
      events.push({ node_id: nodeId, event: "sent", detail: { kind: msg.kind } });
    },
    async tag(action, tag) {
      if (!tag) return;
      const id = await ensureContact();
      const cur: string[] = contact.row?.tags ?? [];
      const next = action === "add"
        ? (cur.some((t) => normalize(t) === normalize(tag)) ? cur : [...cur, tag])
        : cur.filter((t) => normalize(t) !== normalize(tag));
      if (next.length === cur.length && next.every((t, i) => t === cur[i])) return;
      must(await svc.from("crm_contacts").update({ tags: next }).eq("id", id), "etiqueta");
      contact.row = { ...contact.row, tags: next };
    },
    async setField(field, value) {
      if (!field) return;
      const id = await ensureContact();
      const std: Record<string, string> = { nome: "name", name: "name", email: "email", cidade: "city", city: "city" };
      const col = std[field.toLowerCase()];
      if (col) {
        if (col === "email" && value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return; // e-mail inválido não sobrescreve
        must(await svc.from("crm_contacts").update({ [col]: value || null }).eq("id", id), "campo");
      } else {
        const custom = { ...(contact.row?.custom ?? {}), [field]: value };
        must(await svc.from("crm_contacts").update({ custom }).eq("id", id), "campo");
        contact.row = { ...contact.row, custom };
      }
    },
    async crmDeal(cfg) {
      const contactId = await ensureContact();
      let stage: any = null;
      if (cfg.stage_id) {
        stage = (await svc.from("crm_stages").select("id, pipeline_id, kind").eq("tenant_id", run.tenant_id).eq("id", cfg.stage_id).is("archived_at", null).maybeSingle()).data;
        if (!stage) throw new Error("Etapa do funil não existe mais");
        // regra do CRO: automação nunca marca venda/perda — só etapas em aberto
        if (stage.kind !== "open") throw new Error("Automação não pode marcar ganho/perda; escolha uma etapa em aberto");
      }
      const { data: open } = await svc.from("crm_deals").select("id, stage_id").eq("tenant_id", run.tenant_id).eq("contact_id", contactId).eq("status", "open")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      // "criar ou mover": move a negociação aberta; se não houver, cria na etapa escolhida
      if (cfg.action === "upsert" && open) {
        if (stage && open.stage_id !== stage.id) must(await svc.from("crm_deals").update({ stage_id: stage.id }).eq("id", open.id), "negociação");
        return;
      }
      if (cfg.action === "move") {
        if (!open) throw new Error("Contato não tem negociação em aberto para mover");
        if (!stage || open.stage_id === stage.id) return;
        must(await svc.from("crm_deals").update({ stage_id: stage.id }).eq("id", open.id), "negociação");
        return;
      }
      if (open) { events.push({ node_id: null, event: "deal_exists", detail: { deal_id: open.id } }); return; }
      if (!stage) {
        const { data: settings } = await svc.from("crm_settings").select("default_pipeline_id").eq("tenant_id", run.tenant_id).maybeSingle();
        let pipeline = settings?.default_pipeline_id as string | undefined;
        if (!pipeline) pipeline = (await svc.from("crm_pipelines").select("id").eq("tenant_id", run.tenant_id).is("archived_at", null).order("is_default", { ascending: false }).order("position").limit(1).maybeSingle()).data?.id;
        if (!pipeline) throw new Error("Nenhum funil configurado no CRM");
        stage = (await svc.from("crm_stages").select("id, pipeline_id, kind").eq("pipeline_id", pipeline).eq("kind", "open").is("archived_at", null).order("position").limit(1).maybeSingle()).data;
        if (!stage) throw new Error("Funil sem etapas em aberto");
      }
      must(await svc.from("crm_deals").insert({
        tenant_id: run.tenant_id, pipeline_id: stage.pipeline_id, stage_id: stage.id, title: (cfg.title || `WhatsApp — ${label}`).slice(0, 200),
        contact_id: contactId, owner_id: contact.row?.owner_id ?? null, value: cfg.value && cfg.value > 0 ? cfg.value : 0,
        source_channel: "whatsapp", attribution_basis: "unknown", conversation_id: run.conversation_id,
      }), "negociação");
    },
    async task(cfg) {
      const contactId = await ensureContact();
      const types = ["call", "meeting", "follow_up", "callback", "task", "proposal", "email", "whatsapp", "visit", "other"];
      must(await svc.from("crm_tasks").insert({
        tenant_id: run.tenant_id, task_type: types.includes(cfg.type) ? cfg.type : "follow_up", title: cfg.title.slice(0, 200),
        description: cfg.description ?? `Criada pela automação “${flow.name}”`, owner_id: ownerOrCreator(), contact_id: contactId,
        due_at: new Date(Date.now() + Math.max(0, cfg.due_in_hours || 0) * 3600_000).toISOString(), created_by: flow.created_by,
      }), "tarefa");
    },
    async assign(cfg) {
      const contactId = await ensureContact();
      let user = cfg.strategy === "user" ? cfg.user_id ?? null : null;
      const { data: members } = await svc.from("tenant_users").select("user_id, role").eq("tenant_id", run.tenant_id).eq("status", "active");
      const ids = (members ?? []).map((m: any) => m.user_id as string);
      if (user && !ids.includes(user)) throw new Error("Usuário escolhido não faz mais parte da empresa");
      if (!user) {
        // rodízio: quem recebeu menos contatos nas últimas 24h (vendedores primeiro)
        const sellers = (members ?? []).filter((m: any) => m.role === "operator").map((m: any) => m.user_id as string);
        const pool = sellers.length ? sellers : ids;
        if (!pool.length) throw new Error("Nenhum usuário ativo para distribuir");
        const since = new Date(Date.now() - 86400_000).toISOString();
        let best = pool[0], bestN = Infinity;
        for (const u of pool) {
          const { count } = await svc.from("crm_contacts").select("id", { count: "exact", head: true }).eq("tenant_id", run.tenant_id).eq("owner_id", u).gte("updated_at", since);
          if ((count ?? 0) < bestN) { best = u; bestN = count ?? 0; }
        }
        user = best;
      }
      must(await svc.from("crm_contacts").update({ owner_id: user }).eq("id", contactId), "responsável");
      await svc.from("crm_deals").update({ owner_id: user }).eq("contact_id", contactId).eq("status", "open");
      contact.row = { ...contact.row, owner_id: user };
      await svc.from("crm_notifications").insert({
        tenant_id: run.tenant_id, user_id: user, title: `Novo contato para você: ${label}`, body: `Distribuído pela automação “${flow.name}”`,
        severity: "info", link_type: "contact", link_id: contactId,
      });
    },
    async notify(cfg) {
      const to = cfg.to || ownerOrCreator();
      if (!to) return;
      await ensureContact().catch(() => null);
      must(await svc.from("crm_notifications").insert({
        tenant_id: run.tenant_id, user_id: to, title: cfg.message.slice(0, 200), body: `Automação “${flow.name}” · ${run.phone}`,
        severity: "info", link_type: run.crm_contact_id ? "contact" : null, link_id: run.crm_contact_id,
      }), "aviso");
    },
    async conversion(lbl) {
      const contactId = await ensureContact();
      // registro de interesse/marco — NÃO é venda (venda só com pedido/pagamento confirmado)
      must(await svc.from("crm_timeline").insert({
        tenant_id: run.tenant_id, contact_id: contactId, kind: "automation", title: `Marco da automação: ${lbl}`,
        body: `Registrado pela automação “${flow.name}”. Não conta como venda.`,
        metadata: { flow_id: flow.id, run_id: run.id, label: lbl, is_sale: false },
      }), "conversão");
    },
    async webhook(cfg) {
      if (!isSafeWebhook(cfg.url)) return { ok: false, status: 0, data: { error: "Endereço não permitido" } };
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10_000);
      try {
        const method = String(cfg.method || "POST").toUpperCase() === "GET" ? "GET" : "POST";
        const res = await fetch(cfg.url, {
          method, signal: ctl.signal, redirect: "manual",
          headers: { "Content-Type": "application/json", "User-Agent": "IDX-CRO-Automacoes/1.0" },
          body: method === "GET" ? undefined : JSON.stringify({ evento: "automacao", automacao: { id: flow.id, nome: flow.name }, telefone: run.phone, ...cfg.body }),
        });
        const text = (await res.text()).slice(0, 20_000);
        let data: unknown = text;
        try { data = JSON.parse(text); } catch { /* texto */ }
        return { ok: res.ok, status: res.status, data };
      } catch (e) {
        return { ok: false, status: 0, data: { error: (e as Error).name === "AbortError" ? "Tempo esgotado" : "Falha de conexão" } };
      } finally {
        clearTimeout(t);
      }
    },
    async ai(cfg) {
      const { data: tenant } = await svc.from("tenants").select("name").eq("id", run.tenant_id).maybeSingle();
      const history: { role: "user" | "assistant"; content: string }[] = [];
      if (run.conversation_id) {
        const { data } = await svc.from("whatsapp_messages").select("direction, body").eq("conversation_id", run.conversation_id)
          .not("body", "is", null).order("timestamp", { ascending: false }).limit(12);
        for (const m of (data ?? []).reverse()) history.push({ role: m.direction === "inbound" ? "user" : "assistant", content: String(m.body) });
      }
      if (!history.length || history[history.length - 1].role !== "user") history.push({ role: "user", content: cfg.message || "(sem mensagem)" });
      const system = [
        `Você é o atendimento de WhatsApp da empresa ${tenant?.name ?? ""}. Responda em português do Brasil, curto (até 3 frases), cordial e natural, como uma pessoa da equipe.`,
        `Instruções da empresa:\n${cfg.prompt}`,
        "Regras: nunca invente preços, prazos, estoque ou condições que não estejam nas instruções; se não souber, diga que um atendente vai confirmar. Não prometa descontos. Não peça dados sensíveis (senha, cartão). Não use markdown.",
        contact.info.name ? `Nome do cliente: ${contact.info.name}.` : "",
      ].filter(Boolean).join("\n\n");
      return await chatReply(system, history, { maxTokens: 400 });
    },
    async handoff(message?: string) {
      if (message) await this.send({ kind: "text", text: message }, "handoff");
      if (run.conversation_id && !run.is_test) await svc.from("whatsapp_conversations").update({ bot_mode: "human" }).eq("id", run.conversation_id);
      const to = ownerOrCreator();
      if (to) {
        await svc.from("crm_notifications").insert({
          tenant_id: run.tenant_id, user_id: to, title: `${label} quer falar com um atendente`, body: `Automação “${flow.name}” passou a conversa para a equipe`,
          severity: "warning", link_type: run.crm_contact_id ? "contact" : null, link_id: run.crm_contact_id,
        });
      }
    },
    async optout() {
      await svc.from("wa_optouts").upsert({ tenant_id: run.tenant_id, phone: run.phone, source: "manual", body: `Automação: ${flow.name}` }, { onConflict: "tenant_id,phone", ignoreDuplicates: true });
    },
    log(nodeId, event, detail) {
      events.push({ node_id: nodeId, event, detail: detail ?? null });
    },
  };
}

// --- executar / salvar --------------------------------------------------------
async function advance(run: Run, flow: Flow, input: { message?: string; timeout?: boolean }) {
  const tz = await tenantTz(run.tenant_id);
  const contact = await loadContact(run.tenant_id, run.phone, run.crm_contact_id, run.conversation_id);
  const events: any[] = [];
  const effects = makeEffects(run, flow, contact, events);
  let s: RunState;
  try {
    s = await step(flow.graph, run.state, { now: new Date(), tz, contact: contact.info, effects }, input);
  } catch (e) {
    s = { ...run.state, status: "failed", error: (e as Error).message };
  }
  const done = ["completed", "failed", "cancelled"].includes(s.status);
  must(await svc.from("wa_flow_runs").update({
    state: s, status: s.status, wait_kind: s.wait?.kind ?? null, current_node: s.wait?.node ?? s.node,
    resume_at: s.status === "waiting" ? s.wait?.until ?? null : null, steps: s.steps, last_error: s.error ?? null,
    finished_at: done ? new Date().toISOString() : null, locked_until: null, updated_at: new Date().toISOString(),
    crm_contact_id: run.crm_contact_id,
  }).eq("id", run.id), "salvar execução");
  if (s.status === "failed") events.push({ node_id: s.node, event: "failed", detail: { error: s.error } });
  if (events.length) {
    await svc.from("wa_flow_events").insert(events.map((e) => ({ tenant_id: run.tenant_id, flow_id: flow.id, run_id: run.id, ...e })));
  }
  return s.status;
}

async function startRun(flow: Flow, phone: string, opts: {
  conversationId: string | null; instanceId: string | null; triggerKind: string; trigger: Record<string, any>; isTest?: boolean; startedBy?: string | null; crmContactId?: string | null;
}): Promise<string | null> {
  // reentrada (não vale para teste nem início manual)
  if (!opts.isTest && opts.triggerKind !== "manual" && flow.reentry !== "always") {
    let q = svc.from("wa_flow_runs").select("id", { count: "exact", head: true }).eq("flow_id", flow.id).eq("phone", phone).eq("is_test", false);
    if (flow.reentry === "cooldown") q = q.gte("started_at", new Date(Date.now() - flow.cooldown_hours * 3600_000).toISOString());
    const { count } = await q;
    if ((count ?? 0) > 0) return null;
  }
  const instance = opts.instanceId ?? (await gatewayInstance(flow.tenant_id)) ?? flow.instance_id;
  let crmId = opts.crmContactId ?? null;
  if (!crmId) {
    const { data } = await svc.from("crm_contacts").select("id").eq("tenant_id", flow.tenant_id).in("phone", phoneVariants(phone)).is("merged_into_id", null).limit(1).maybeSingle();
    crmId = (data?.id as string) ?? null;
  }
  const state = startState(flow.graph, opts.trigger);
  const { data, error } = await svc.from("wa_flow_runs").insert({
    tenant_id: flow.tenant_id, flow_id: flow.id, instance_id: instance, phone, conversation_id: opts.conversationId, crm_contact_id: crmId,
    trigger_kind: opts.triggerKind, is_test: !!opts.isTest, state, status: "running", current_node: state.node,
    resume_at: new Date(Date.now() + 120_000).toISOString(), // recuperação se cair no meio
    locked_until: new Date(Date.now() + 120_000).toISOString(), started_by: opts.startedBy ?? null,
  }).select("*").single();
  if (error) {
    if (/duplicate key|wa_flow_runs_one_open/.test(error.message)) return null; // já está no fluxo
    throw new Error(error.message);
  }
  await svc.from("wa_flow_events").insert({ tenant_id: flow.tenant_id, flow_id: flow.id, run_id: data.id, node_id: null, event: "start", detail: { trigger: opts.triggerKind } });
  await advance(data as Run, flow, {});
  return data.id as string;
}

async function activeFlows(tenant: string, kinds: string[]): Promise<Flow[]> {
  const { data } = await svc.from("wa_flows").select("*").eq("tenant_id", tenant).eq("status", "active").in("trigger_kind", kinds);
  const list = (data ?? []) as Flow[];
  for (const f of list) flowCache.set(f.id, f);
  return list;
}

async function handleMessage(item: QueueItem): Promise<string> {
  const phone = item.phone!;
  const text = String(item.payload.text ?? "");
  const conv = await convState(item.conversation_id);
  if (botBlocked(conv)) return "atendente";
  // atendente respondeu manualmente há pouco: o robô não se mete na conversa
  const { count: human } = await svc.from("wa_outbox").select("id", { count: "exact", head: true }).eq("tenant_id", item.tenant_id)
    .eq("phone", phone).eq("source", "manual").gte("created_at", new Date(Date.now() - 30 * 60_000).toISOString());
  if ((human ?? 0) > 0) return "atendente conversando";

  // 1) uma execução esperando resposta deste contato consome a mensagem
  const { data: waiting } = await svc.from("wa_flow_runs").select("id").eq("tenant_id", item.tenant_id).eq("phone", phone)
    .eq("status", "waiting").in("wait_kind", [...RESPONSE_WAITS]).order("updated_at", { ascending: false });
  // só a automação mais recente responde (antes, duas esperando respondiam à mesma mensagem)
  let resumed = 0;
  for (const w of waiting ?? []) {
    if (resumed) {
      await svc.from("wa_flow_runs").update({ status: "cancelled", finished_at: new Date().toISOString(), last_error: "Outra automação mais recente assumiu a conversa" })
        .eq("id", w.id).eq("status", "waiting").eq("is_test", false);
      continue;
    }
    const { data: run } = await svc.rpc("wa_flow_lock_run", { p_run_id: w.id });
    const r = (Array.isArray(run) ? run[0] : run) as Run | null;
    if (!r?.id) continue;
    const flow = await getFlow(r.flow_id);
    if (!flow || (flow.status !== "active" && !r.is_test)) {
      await svc.from("wa_flow_runs").update({ locked_until: null }).eq("id", r.id);
      continue;
    }
    if (!r.conversation_id && item.conversation_id) { r.conversation_id = item.conversation_id; }
    await svc.from("wa_flow_events").insert({ tenant_id: r.tenant_id, flow_id: r.flow_id, run_id: r.id, node_id: r.state?.wait?.node ?? null, event: "replied", detail: { text: text.slice(0, 200) } });
    await svc.from("wa_flow_runs").update({ conversation_id: r.conversation_id }).eq("id", r.id);
    await advance(r, flow, { message: text });
    resumed++;
  }
  if (resumed) return `retomou ${resumed}`;

  // 2) contato já está no meio de outra automação (ex.: esperando um intervalo): não começa outra por cima
  const { count: busy } = await svc.from("wa_flow_runs").select("id", { count: "exact", head: true }).eq("tenant_id", item.tenant_id)
    .eq("phone", phone).eq("is_test", false)
    .or(`status.eq.waiting,and(status.eq.running,updated_at.gt.${new Date(Date.now() - 10 * 60_000).toISOString()})`);
  if ((busy ?? 0) > 0) return "já está em uma automação";

  // 3) nova automação: a mais específica / de maior prioridade que casar
  const flows = await activeFlows(item.tenant_id, ["message", "first_message", "keyword", "campaign"]);
  if (!flows.length) return "sem automação";
  const tz = await tenantTz(item.tenant_id);
  let campaignId: string | null = null;
  if (flows.some((f) => f.trigger_kind === "campaign")) {
    // o WhatsApp às vezes entrega o celular sem o 9º dígito (556492884069 × 5564992884069)
    const { data } = await svc.from("wa_campaign_recipients").select("campaign_id").eq("tenant_id", item.tenant_id).in("phone", phoneVariants(phone))
      .not("sent_at", "is", null).gte("sent_at", new Date(Date.now() - 30 * 86400_000).toISOString()).order("sent_at", { ascending: false }).limit(1).maybeSingle();
    campaignId = (data?.campaign_id as string) ?? null;
  }
  const ordered = flows.sort((a, b) => (b.priority - a.priority) || ((KIND_RANK[b.trigger_kind!] ?? 0) - (KIND_RANK[a.trigger_kind!] ?? 0)));
  const now = new Date();
  for (const f of ordered) {
    const ev: FlowEvent = f.trigger_kind === "campaign"
      ? (campaignId ? { kind: "campaign", campaignId } : { kind: "manual" })
      : { kind: "message", text, firstMessage: !!item.payload.first };
    if (f.trigger_kind === "campaign" && !campaignId) continue;
    if (!matchTrigger(f.graph, ev, now, tz)) continue;
    const id = await startRun(f, phone, { conversationId: item.conversation_id, instanceId: item.instance_id, triggerKind: f.trigger_kind!, trigger: { text, campaign_id: campaignId } });
    if (id) return `iniciou ${f.name}`;
  }
  return "nenhum gatilho";
}

async function handleOther(item: QueueItem): Promise<string> {
  const phone = item.phone!;
  if (item.kind === "manual") {
    const flow = await getFlow(item.flow_id!);
    if (!flow || flow.status === "archived") return "automação removida";
    if (!item.payload.test && flow.status !== "active") return "automação não está ativa";
    const inst = (await gatewayInstance(flow.tenant_id)) ?? flow.instance_id;
    const conv = await conversationFor(flow.tenant_id, phone, inst);
    if (!item.payload.test && botBlocked(conv)) return "atendente";
    const id = await startRun(flow, phone, { conversationId: conv?.id ?? null, instanceId: inst, triggerKind: "manual", trigger: {}, isTest: !!item.payload.test, startedBy: item.payload.started_by ?? null });
    return id ? "iniciou" : "já está nesta automação";
  }
  if (item.kind === "webhook") {
    const flow = await getFlow(item.flow_id!);
    if (!flow || flow.status !== "active") return "automação não está ativa";
    const inst = (await gatewayInstance(flow.tenant_id)) ?? flow.instance_id;
    const conv = await conversationFor(flow.tenant_id, phone, inst);
    if (botBlocked(conv)) return "atendente";
    const p = item.payload ?? {};
    const name = String(p.nome ?? p.name ?? "").trim().slice(0, 200) || null;
    const { data: cid } = await svc.rpc("wa_flow_contact", { p_tenant_id: flow.tenant_id, p_phone: phone, p_name: name });
    const id = await startRun(flow, phone, { conversationId: conv?.id ?? null, instanceId: inst, triggerKind: "webhook", trigger: p, crmContactId: (cid as string) ?? null });
    return id ? "iniciou" : "não iniciou (já está na automação ou dentro do intervalo)";
  }
  const kind = item.kind; // tag | stage
  const flows = await activeFlows(item.tenant_id, [kind]);
  const ev: FlowEvent = kind === "tag" ? { kind: "tag", tag: String(item.payload.tag ?? "") } : { kind: "stage", stageId: String(item.payload.stage_id ?? "") };
  const tz = await tenantTz(item.tenant_id);
  let started = 0;
  for (const f of flows) {
    if (!matchTrigger(f.graph, ev, new Date(), tz)) continue;
    const inst = (await gatewayInstance(f.tenant_id)) ?? f.instance_id;
    const conv = await conversationFor(f.tenant_id, phone, inst);
    if (botBlocked(conv)) continue;
    const id = await startRun(f, phone, { conversationId: conv?.id ?? null, instanceId: inst, triggerKind: kind, trigger: item.payload, crmContactId: item.payload.contact_id ?? null });
    if (id) started++;
  }
  return `iniciou ${started}`;
}

async function processQueue(deadline: number) {
  let n = 0;
  while (Date.now() < deadline) {
    const items = must(await svc.rpc("wa_flow_claim_queue", { p_limit: 25 }), "fila") as QueueItem[];
    if (!items?.length) break;
    for (const it of items) {
      try {
        const result = it.phone ? (it.kind === "message" ? await handleMessage(it) : await handleOther(it)) : "sem telefone";
        await svc.from("wa_flow_queue").update({ processed_at: new Date().toISOString(), result: result.slice(0, 200), locked_until: null }).eq("id", it.id);
      } catch (e) {
        const msg = (e as Error).message.slice(0, 200);
        console.error("cro-flows fila", it.id, msg);
        await svc.from("wa_flow_queue").update(it.attempts >= 3
          ? { processed_at: new Date().toISOString(), result: `erro: ${msg}`, locked_until: null }
          : { locked_until: null, not_before: new Date(Date.now() + 30_000).toISOString(), result: `tentando de novo: ${msg}` }).eq("id", it.id);
      }
      n++;
    }
  }
  return n;
}

async function processDue(deadline: number) {
  let n = 0;
  while (Date.now() < deadline) {
    const runs = must(await svc.rpc("wa_flow_claim_due", { p_limit: 25 }), "esperas") as Run[];
    if (!runs?.length) break;
    for (const r of runs) {
      try {
        const flow = await getFlow(r.flow_id);
        if (!flow || flow.status === "archived") {
          await svc.from("wa_flow_runs").update({ status: "cancelled", finished_at: new Date().toISOString(), last_error: "Automação removida", locked_until: null }).eq("id", r.id);
          continue;
        }
        if (!r.is_test && flow.status !== "active") {
          // pausada: segura a execução e confere de novo em 10 min
          await svc.from("wa_flow_runs").update({ resume_at: new Date(Date.now() + 600_000).toISOString(), locked_until: null }).eq("id", r.id);
          continue;
        }
        const conv = await convState(r.conversation_id);
        if (!r.is_test && botBlocked(conv)) {
          await svc.from("wa_flow_runs").update({ status: "cancelled", finished_at: new Date().toISOString(), last_error: "Atendente assumiu a conversa", locked_until: null }).eq("id", r.id);
          continue;
        }
        const input = r.status === "waiting" && RESPONSE_WAITS.has(r.wait_kind ?? "") ? { timeout: true } : {};
        if ((input as any).timeout) {
          await svc.from("wa_flow_events").insert({ tenant_id: r.tenant_id, flow_id: r.flow_id, run_id: r.id, node_id: r.state?.wait?.node ?? null, event: "timeout" });
        }
        await advance(r, flow, input);
      } catch (e) {
        console.error("cro-flows espera", r.id, (e as Error).message);
        await svc.from("wa_flow_runs").update({ locked_until: null, resume_at: new Date(Date.now() + 60_000).toISOString(), last_error: (e as Error).message.slice(0, 300) }).eq("id", r.id);
      }
      n++;
    }
  }
  return n;
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

/** Outro sistema inicia uma automação: POST /cro-flows/hook/<id da automação>/<segredo> {telefone, nome, ...} */
async function handleHook(req: Request, flowId: string, secret: string) {
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* corpo vazio */ }
  if (typeof body !== "object" || body === null || Array.isArray(body)) body = {};
  if (JSON.stringify(body).length > 20_000) return new Response(JSON.stringify({ ok: false, error: "Dados grandes demais" }), { status: 413, headers: { ...CORS, "Content-Type": "application/json" } });
  const phone = String(body.telefone ?? body.phone ?? body.whatsapp ?? body.celular ?? "");
  const { data, error } = await svc.rpc("wa_flow_hook_enqueue", { p_flow_id: flowId, p_secret: secret, p_phone: phone, p_payload: body });
  if (error) return new Response(JSON.stringify({ ok: false, error: "Falha ao registrar" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  const r = data as { ok: boolean; status?: number; error?: string; queued?: boolean };
  // responde rápido e já processa (o motor também pega na próxima volta)
  if (r.ok && r.queued) { try { await processQueue(Date.now() + 8000); } catch { /* o motor tenta de novo */ } }
  return new Response(JSON.stringify(r), { status: r.ok ? 200 : r.status ?? 400, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Leitura das conversas pela IA (detecta interesse, negociação e vendas) para as
// mensagens que chegam pela conexão do CRO. Mesmo caminho do fluxo antigo do n8n:
// ai-analyze → se houver sinal de venda, sale-confirm (auto_process).
// Roda em segundo plano para não atrasar as respostas das automações.
// ---------------------------------------------------------------------------
async function internalCall(fn: string, body: Record<string, unknown>) {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  return await res.json().catch(() => ({})) as Record<string, unknown>;
}

async function processAiReading() {
  const { data, error } = await svc.rpc("wa_ai_claim", { p_limit: 3 });
  if (error) { console.error("wa_ai_claim", error.message); return 0; }
  let done = 0;
  for (const row of (data ?? []) as { conversation_id: string; tenant_id: string }[]) {
    try {
      const r = await internalCall("ai-analyze", { action: "analyze_conversation", tenant_id: row.tenant_id, conversation_id: row.conversation_id });
      if (Number(r.sale_signals_created ?? 0) > 0) {
        await internalCall("sale-confirm", { action: "auto_process", tenant_id: row.tenant_id, conversation_id: row.conversation_id });
      }
      done++;
    } catch (e) {
      console.error("leitura IA", row.conversation_id, (e as Error).message);
    }
  }
  return done;
}

function inBackground(p: Promise<unknown>) {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p); else void p;
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname;
  const hook = path.match(/\/hook\/([0-9a-f-]{36})\/([0-9a-f]{32,64})\/?$/i);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (hook && req.method === "POST") { tzCache.clear(); flowCache.clear(); return await handleHook(req, hook[1], hook[2]); }
  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);
  const token = req.headers.get("x-gateway-token") ?? "";
  const internal = (req.headers.get("Authorization") ?? "") === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;
  if (!internal) {
    const { error: authErr } = await svc.rpc("wa_gw_instances", { p_token: token });
    if (authErr) return json({ error: "unauthorized" }, 401);
  }
  tzCache.clear(); flowCache.clear();
  const deadline = Date.now() + TIME_BUDGET_MS;
  try {
    const queue = await processQueue(deadline);
    const due = await processDue(deadline);
    inBackground(processAiReading().catch((e) => console.error("leitura IA", (e as Error).message)));
    // API oficial: envia o que entrou na fila (respostas das automações, disparos, cadências)
    if (!internal) inBackground(internalCall("wa-cloud/flush", {}).catch((e) => console.error("api oficial", (e as Error).message)));
    return json({ ok: true, queue, due });
  } catch (e) {
    console.error("cro-flows", (e as Error).message);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
