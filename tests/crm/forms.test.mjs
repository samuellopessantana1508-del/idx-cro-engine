// Formulários do CRO: página pública (sem login) → rastreio de cada passo → envio vira contato, negociação e linha do tempo.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "../../web/node_modules/@supabase/supabase-js/dist/main/index.js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.ANON_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
const sql = (q) => execFileSync("psql", [PGURL, "-qAt", "-c", q], { encoding: "utf8" }).trim();
const TAG = Date.now().toString(36);
let A, B, owner, seller, other, pub, formId, stageId;

const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const r = await c.auth.signInWithPassword({ email, password: "Teste@12345" });
  assert.equal(r.error, null, r.error?.message);
  return { c, id: r.data.user.id };
};
const must = (r) => { assert.equal(r.error, null, r.error?.message); return r.data; };

const CONTENT = {
  header: { name: "Dr. Teste", subtitle: "CRM-GO 1234 · Rio Verde" },
  intro: { eyebrow: "Cirurgia plástica", badge: "Lipo e contorno", title: "Entenda o seu caso", subtitle: "6 perguntas", bullets: ["Entenda a avaliação"], cta: "Começar" },
  questions: [
    { id: "q1", type: "choice", title: "O que você quer mudar?", options: [{ id: "a", label: "Gordura localizada" }, { id: "b", label: "Contorno" }] },
    { id: "q2", type: "choice", title: "Já fez alguma cirurgia?", options: [{ id: "a", label: "Sim" }, { id: "b", label: "Não" }] },
  ],
  capture: { title: "Para onde mando a orientação?", fields: { name: true, phone: true, email: false } },
  done: { title: "Pronto!", text: "Já recebemos." },
};

before(async () => {
  A = sql(`select id from tenants where slug = 'clinica-sorriso'`);
  B = sql(`select id from tenants where slug <> 'clinica-sorriso' order by slug limit 1`);
  owner = await login("dono@clinica.local");
  seller = await login("bruno.vendas@clinica.local");
  other = await login("dona@perfumaria.local");
  pub = createClient(URL_, ANON, { auth: { persistSession: false } });
  sql(`update tenant_users set status = 'active' where tenant_id = '${A}'`);
  stageId = sql(`select s.id from crm_stages s join crm_pipelines p on p.id = s.pipeline_id where s.tenant_id = '${A}' and s.kind = 'open' and s.archived_at is null order by p.is_default desc, s.position offset 1 limit 1`);
});

test("dono cria, salva e publica; endereço é único; vendedor e outra empresa não editam", async () => {
  const f = must(await owner.c.rpc("form_save", { p_tenant_id: A, p_id: null, p_name: "Lipo teste", p_slug: `lipo-${TAG}`, p_style: "card",
    p_content: CONTENT, p_settings: { stage_id: stageId, tags: ["lipo"] } }));
  formId = f.id;
  assert.equal(f.status, "draft");
  // rascunho não abre na página pública
  assert.equal(must(await pub.rpc("form_public", { p_slug: `lipo-${TAG}` })), null);
  assert.match((await owner.c.rpc("form_save", { p_tenant_id: A, p_id: null, p_name: "Outro", p_slug: `lipo-${TAG}`, p_style: "steps", p_content: CONTENT, p_settings: {} })).error?.message ?? "", /já está em uso/);
  assert.ok((await seller.c.rpc("form_save", { p_tenant_id: A, p_id: formId, p_name: "x", p_slug: `lipo-${TAG}`, p_style: "card", p_content: CONTENT, p_settings: {} })).error);
  assert.ok((await other.c.rpc("form_set_status", { p_id: formId, p_status: "published" })).error);
  must(await owner.c.rpc("form_set_status", { p_id: formId, p_status: "published" }));
  sql(`update crm_settings set logo_url = 'https://exemplo.com/logo.png', brand_color = '#0E3850' where tenant_id = '${A}'`);
  const p = must(await pub.rpc("form_public", { p_slug: `LIPO-${TAG}` }));
  assert.equal(p.style, "card");
  assert.equal(p.brand.logo_url, "https://exemplo.com/logo.png");
  assert.equal(p.content.questions.length, 2);
});

test("visita completa sem login: rastreia passos e cliques; envio cria contato, negociação, linha do tempo e aviso", async () => {
  const slug = `lipo-${TAG}`;
  const meta = { utm_source: "facebook", utm_medium: "cpc", utm_campaign: "lipo-nov", fbclid: "IwAR123", landing_url: `https://croengine.pro/f/${slug}?utm_source=facebook` };
  const sid = must(await pub.rpc("form_track", { p_slug: slug, p_session: null, p_event: "view", p_step: 0, p_data: {}, p_meta: meta }));
  must(await pub.rpc("form_track", { p_slug: slug, p_session: sid, p_event: "start", p_step: 1, p_data: {}, p_meta: {} }));
  must(await pub.rpc("form_track", { p_slug: slug, p_session: sid, p_event: "answer", p_step: 1, p_data: { question: "q1", answer: "Contorno", ms: 3200 }, p_meta: {} }));
  must(await pub.rpc("form_track", { p_slug: slug, p_session: sid, p_event: "back", p_step: 1, p_data: {}, p_meta: {} }));
  must(await pub.rpc("form_track", { p_slug: slug, p_session: sid, p_event: "answer", p_step: 2, p_data: { question: "q2", answer: "Não", ms: 1500 }, p_meta: {} }));
  must(await pub.rpc("form_track", { p_slug: slug, p_session: sid, p_event: "capture_view", p_step: 3, p_data: {}, p_meta: {} }));
  assert.equal(sql(`select event_count || ':' || max_step || ':' || utm_campaign from crm_form_sessions where id = '${sid}'`), "6:3:lipo-nov");
  assert.ok((await pub.rpc("form_track", { p_slug: slug, p_session: sid, p_event: "hack", p_step: 1, p_data: {}, p_meta: {} })).error);

  // telefone inválido é recusado
  assert.match((await pub.rpc("form_submit", { p_slug: slug, p_session: sid, p_answers: {}, p_contact: { name: "Ana", phone: "123" } })).error?.message ?? "", /WhatsApp válido/);
  const phone = `64 9${String(Date.now()).slice(-8)}`;
  const r = must(await pub.rpc("form_submit", { p_slug: slug, p_session: sid, p_answers: { q1: "Contorno", q2: "Não" }, p_contact: { name: "Ana Teste", phone, email: "ana@teste.com" } }));
  assert.ok(r.contact_id && r.deal_id);
  const c = JSON.parse(sql(`select row_to_json(x) from (select name, email, source_channel, utm_campaign, tags, custom from crm_contacts where id = '${r.contact_id}') x`));
  assert.equal(c.name, "Ana Teste");
  assert.equal(c.email, "ana@teste.com");
  assert.equal(c.utm_campaign, "lipo-nov");
  assert.ok(c.tags.includes("lipo") && c.tags.some((t) => t.startsWith("formulário:")));
  assert.equal(c.custom[`formulario_${slug}`]["O que você quer mudar?"], "Contorno");
  assert.equal(sql(`select stage_id from crm_deals where id = '${r.deal_id}'`), stageId);
  assert.equal(sql(`select utm_source || '|' || (ad_ids->>'fbclid') from crm_deals where id = '${r.deal_id}'`), "facebook|IwAR123");
  const tl = sql(`select body from crm_timeline where contact_id = '${r.contact_id}' and kind = 'form'`);
  assert.match(tl, /Já fez alguma cirurgia\?\n  Não/);
  assert.match(tl, /Origem: facebook \/ cpc \/ lipo-nov/);
  assert.equal(sql(`select count(*) from crm_notifications where link_id = '${r.contact_id}'`) >= "1", true);
  assert.equal(sql(`select (completed_at is not null)::text from crm_form_sessions where id = '${sid}'`), "true");
  // enviar de novo não duplica
  assert.equal(must(await pub.rpc("form_submit", { p_slug: slug, p_session: sid, p_answers: {}, p_contact: { phone } })).already, true);
  assert.equal(sql(`select count(*) from crm_deals where contact_id = '${r.contact_id}'`), "1");

  // mesma pessoa em outra visita: usa o mesmo contato e a negociação aberta
  const sid2 = must(await pub.rpc("form_track", { p_slug: slug, p_session: null, p_event: "view", p_step: 0, p_data: {}, p_meta: {} }));
  const r2 = must(await pub.rpc("form_submit", { p_slug: slug, p_session: sid2, p_answers: { q1: "Gordura localizada" }, p_contact: { name: "Ana", phone } }));
  assert.equal(r2.contact_id, r.contact_id);
  assert.equal(r2.deal_id, r.deal_id);
});

test("números e funil por passo para o CRO; outra empresa não vê", async () => {
  const list = must(await owner.c.rpc("form_list", { p_tenant_id: A, p_days: 30 }));
  const me = list.find((x) => x.id === formId);
  assert.equal(Number(me.views), 2);
  assert.equal(Number(me.leads), 2);
  const funnel = must(await owner.c.rpc("form_funnel", { p_form_id: formId, p_days: 30 }));
  assert.equal(Number(funnel[0].reached), 2);
  assert.ok(Number(funnel[1].reached) >= 1);
  assert.equal(must(await other.c.rpc("form_funnel", { p_form_id: formId, p_days: 30 })).length, 0);
  assert.equal((must(await other.c.from("crm_form_sessions").select("id").eq("form_id", formId))).length, 0);
  assert.equal((must(await owner.c.from("crm_form_sessions").select("id").eq("form_id", formId))).length, 2);
  // a página pública não lê sessões direto
  assert.ok((await pub.from("crm_form_sessions").select("id").limit(1)).error || (await pub.from("crm_form_sessions").select("id").limit(1)).data.length === 0);
});

test("despublicado some da página pública e para de aceitar envio", async () => {
  must(await owner.c.rpc("form_set_status", { p_id: formId, p_status: "draft" }));
  assert.equal(must(await pub.rpc("form_public", { p_slug: `lipo-${TAG}` })), null);
  assert.ok((await pub.rpc("form_track", { p_slug: `lipo-${TAG}`, p_session: null, p_event: "view", p_step: 0, p_data: {}, p_meta: {} })).error);
});
