// Popula a stack LOCAL de testes (nunca rode contra produção).
// Uso: SUPABASE_URL=http://127.0.0.1:54321 SERVICE_KEY=... PGURL=postgres://... node tests/crm/seed-local.mjs
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE = process.env.SERVICE_KEY;
const PGURL = process.env.PGURL ?? "postgres://postgres:postgres@localhost/idx";
if (!URL_.includes("127.0.0.1") && !URL_.includes("localhost")) throw new Error("seed-local só roda contra stack local");

const sql = (q) => execFileSync("psql", [PGURL, "-v", "ON_ERROR_STOP=1", "-qAt", "-c", q], { encoding: "utf8" }).trim();
export const PASSWORD = "Teste@12345";
export const USERS = {
  platform: "plataforma@idx.local",
  adminA: "dono@clinica.local",
  sellerA1: "ana.vendas@clinica.local",
  sellerA2: "bruno.vendas@clinica.local",
  marketingA: "marketing@clinica.local",
  viewerA: "leitura@clinica.local",
  adminB: "dona@perfumaria.local",
  sellerB: "vendas@perfumaria.local",
};

async function createUser(email) {
  const res = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const data = await res.json();
  if (!res.ok && !String(data.msg ?? data.message ?? "").includes("already")) throw new Error(`${email}: ${JSON.stringify(data)}`);
  return sql(`select id from auth.users where email = '${email}'`);
}

const ids = {};
for (const [k, email] of Object.entries(USERS)) ids[k] = await createUser(email);

const tA = sql(`insert into tenants(slug, name, whatsapp_number) values ('clinica-sorriso', 'Clínica Sorriso', '5511900000001')
  on conflict (slug) do update set name = excluded.name returning id`);
const tB = sql(`insert into tenants(slug, name, whatsapp_number) values ('perfumaria-aroma', 'Perfumaria Aroma', '5511900000002')
  on conflict (slug) do update set name = excluded.name returning id`);

sql(`insert into platform_users(user_id, role) values ('${ids.platform}', 'owner') on conflict (user_id) do nothing`);
const member = (t, u, email, role, crm) => sql(`insert into tenant_users(tenant_id, user_id, email, role, status, crm_role)
  values ('${t}', '${u}', '${email}', '${role}', 'active', ${crm ? `'${crm}'` : "null"})
  on conflict (tenant_id, user_id) do update set role = excluded.role, crm_role = excluded.crm_role`);
member(tA, ids.adminA, USERS.adminA, "owner");
member(tA, ids.sellerA1, USERS.sellerA1, "operator", "sales");
member(tA, ids.sellerA2, USERS.sellerA2, "operator", "sales");
member(tA, ids.marketingA, USERS.marketingA, "operator", "marketing");
member(tA, ids.viewerA, USERS.viewerA, "viewer");
member(tB, ids.adminB, USERS.adminB, "owner");
member(tB, ids.sellerB, USERS.sellerB, "operator", "sales");

// catálogo / Smart Link (fluxo legado)
const offerA = sql(`insert into offers(tenant_id, name, slug, category, price, kind) values
  ('${tA}', 'Avaliação odontológica', 'avaliacao', 'avaliacao', 150, 'service') on conflict (tenant_id, slug) do update set price = 150 returning id`);
sql(`insert into offers(tenant_id, name, slug, category, price, kind) values
  ('${tA}', 'Clareamento dental', 'clareamento', 'estetica', 1200, 'service'),
  ('${tA}', 'Implante unitário', 'implante', 'implante', 4500, 'service'),
  ('${tB}', 'Perfume Âmbar 100ml', 'ambar-100', 'perfume', 389, 'product'),
  ('${tB}', 'Kit Amostras Verão', 'kit-amostras', 'amostra', 0, 'product') on conflict (tenant_id, slug) do nothing`);
const linkA = sql(`insert into smart_links(tenant_id, offer_id, code, name, default_utm_source, default_utm_medium, default_utm_campaign)
  values ('${tA}', '${offerA}', 'sorriso-av-local', 'Avaliação - Meta', 'facebook', 'paid', 'avaliacao-nov') on conflict (code) do update set name = excluded.name returning id`);

// leads legados (tracking_sessions) em várias classificações
const sess = (ref, status, extra = "") => sql(`insert into tracking_sessions(tenant_id, smart_link_id, offer_id, ref, utm_source, utm_medium, utm_campaign, fbclid, lead_status, clicked_at ${extra ? "," + extra.split("|")[0] : ""})
  values ('${tA}', '${linkA}', '${offerA}', '${ref}', 'facebook', 'paid', 'avaliacao-nov', 'fb.1.${ref}', '${status}', now() - interval '${Math.floor(Math.random() * 9) + 1} days' ${extra ? "," + extra.split("|")[1] : ""})
  on conflict (ref) do nothing`);
sess("lead-maria", "new", "customer_phone, customer_name|'5511987650001', 'Maria Souza'");
sess("lead-joao", "contacted", "customer_phone, customer_name|'11987650002', 'João Lima'");
sess("lead-carla", "qualified", "customer_phone, customer_name, customer_email|'(11) 98765-0003', 'Carla Dias', 'carla@exemplo.com'");
sess("lead-pedro", "bad", "customer_phone, customer_name|'5511987650004', 'Pedro Alves'");
sess("lead-clique", "new");
sess("lead-lucas", "sold", "customer_phone, customer_name, revenue, sold_at|'5511987650005', 'Lucas Prado', 1200, now() - interval '2 days'");

// perfumaria: clientes com histórico de compras (para RFV)
const contactB = (name, phone) => sql(`insert into crm_contacts(tenant_id, name, phone, source_channel, acquisition_basis)
  values ('${tB}', '${name}', '${phone}', 'instagram', 'declared') on conflict do nothing returning id`) ||
  sql(`select id from crm_contacts where tenant_id = '${tB}' and phone = '${phone}'`);
const order = (contact, daysAgo, amount, status = "paid", extra = "") => sql(`insert into crm_orders(tenant_id, contact_id, order_date, status, gross_amount, evidence_type, source ${extra ? "," + extra.split("|")[0] : ""})
  values ('${tB}', '${contact}', now() - interval '${daysAgo} days', '${status}', ${amount}, 'payment', 'manual' ${extra ? "," + extra.split("|")[1] : ""})`);
const helena = contactB("Helena Campos", "5521998880001");
for (const d of [10, 40, 75, 120, 160]) order(helena, d, 389);
for (const d of [12, 50]) order(helena, d, 1200);
const rafael = contactB("Rafael Nunes", "5521998880002");
for (const d of [200, 230, 260, 300]) order(rafael, d, 1500);
const bia = contactB("Beatriz Rocha", "5521998880003");
order(bia, 5, 389);
const gui = contactB("Guilherme Teles", "5521998880004");
order(gui, 400, 389);
order(gui, 20, 389, "cancelled");
const iara = contactB("Iara Mendes", "5521998880005");
order(iara, 15, 0, "confirmed", "is_free|true");
sql(`insert into crm_samples(tenant_id, contact_id, product_name, delivered_at, campaign, rating, feedback)
  values ('${tB}', '${bia}', 'Âmbar (amostra 2ml)', now() - interval '12 days', 'Amostras Verão', 5, 'Adorou a fixação')`);
sql(`select crm_rfv_apply_preset('${tB}', 'perfumery')`);
sql(`select crm_compute_rfv('${tB}')`);

// chave de webhook do n8n para a clínica (usada pelo teste de ingestão WhatsApp)
const KEY = "local-n8n-key-clinica";
const hash = crypto.createHash("sha256").update(KEY).digest("hex");
sql(`insert into tenant_webhook_keys(tenant_id, key_hash, label) select '${tA}', '${hash}', 'local'
     where not exists (select 1 from tenant_webhook_keys where key_hash = '${hash}')`);

// mensagens reais pelo webhook do n8n (mesmo caminho da produção)
async function wa(action, jid, id, text, fromMe = false, name) {
  const res = await fetch(`${URL_}/functions/v1/n8n-webhook`, {
    method: "POST", headers: { "x-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ action, instance: "clinica", data: { key: { remoteJid: jid, id, fromMe }, pushName: name, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) } }),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}: ${await res.text()}`);
}
await wa("message_received", "551187650002@s.whatsapp.net", "MSG-J1", "Oi, quero remarcar minha avaliação", false, "Joao L");
await wa("message_received", "5511912340099@s.whatsapp.net", "MSG-N1", "Quanto custa o clareamento?", false, "Fernanda Reis");
await wa("message_sent", "5511912340099@s.whatsapp.net", "MSG-N2", "Olá Fernanda! O clareamento sai por R$ 1.200.", true);
await wa("message_received", "5511912340099@s.whatsapp.net", "MSG-N3", "Consigo parcelar em 3x?", false, "Fernanda Reis");

console.log(JSON.stringify({ tenantA: tA, tenantB: tB, users: ids, webhookKey: KEY }, null, 2));
