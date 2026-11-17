// Disparos de e-mail do CRO (aba Disparos) pelo Resend.
//   POST {action:"tick"}  (chave de serviço — chamado pelo cro-flows a cada 30 s): envia o que está na fila,
//                          respeitando o limite por minuto e por dia de cada disparo.
//   POST {action:"kick"}  (usuário logado): mesmo envio, na hora (botão Iniciar/Retomar da tela).
//   GET/POST /email-dispatch/sair?t=<id do envio>  descadastro pelo link do e-mail (um clique).
// Remetente: "<nome da empresa> <disparos@<domínio verificado>>"; respostas vão para o e-mail
// escolhido no disparo. Todo e-mail leva o link de descadastro e o cabeçalho List-Unsubscribe.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { senderDomain, sendEmail } from "../_shared/email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const svc = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const TIME_BUDGET_MS = 40_000;

type Claimed = {
  id: string; tenant_id: string; tenant_name: string | null; campaign_id: string; email: string;
  subject: string; body: string; reply_to: string | null; button_label: string | null; button_url: string | null;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const linkify = (s: string) => s.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" style="color:#111;text-decoration:underline">${u}</a>`);

/** Texto do disparo → HTML simples e legível (parágrafos, links, botão e rodapé de descadastro). */
export function renderEmail(m: Pick<Claimed, "body" | "button_label" | "button_url" | "tenant_name">, unsubUrl: string) {
  const empresa = m.tenant_name || "nossa empresa";
  const paragraphs = m.body.trim().split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 16px;line-height:1.6">${linkify(esc(p)).replace(/\n/g, "<br>")}</p>`).join("");
  const button = m.button_url
    ? `<p style="margin:24px 0"><a href="${esc(m.button_url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">${esc(m.button_label || "Saiba mais")}</a></p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f4;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#1c1917;font-size:15px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">${paragraphs}${button}</div>
<p style="max-width:600px;margin:16px auto 0;color:#78716c;font-size:12px;line-height:1.5;text-align:center">Você recebeu este e-mail de ${esc(empresa)}.
Não quer mais receber? <a href="${unsubUrl}" style="color:#78716c">Descadastrar</a></p></body></html>`;
  const text = `${m.body.trim()}${m.button_url ? `\n\n${m.button_label || "Saiba mais"}: ${m.button_url}` : ""}\n\n—\nVocê recebeu este e-mail de ${empresa}. Para não receber mais: ${unsubUrl}`;
  return { html, text };
}

const fromName = (s: string | null) => (s || "CRO").replace(/["<>\r\n]/g, "").slice(0, 60);

async function sendOne(m: Claimed) {
  const unsub = `${SUPABASE_URL}/functions/v1/email-dispatch/sair?t=${m.id}`;
  const { html, text } = renderEmail(m, unsub);
  const r = await sendEmail({
    to: m.email, subject: m.subject || "(sem assunto)", html, text,
    from: `${fromName(m.tenant_name)} <${Deno.env.get("RESEND_CAMPAIGN_LOCAL") || "disparos"}@${senderDomain()}>`,
    replyTo: m.reply_to,
    headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    tags: { tipo: "disparo", disparo: m.campaign_id },
  });
  await svc.rpc("email_result", {
    p_id: m.id, p_ok: r.ok, p_provider_id: r.id ?? null, p_error: r.ok ? null : r.error ?? "Falha no envio",
    p_invalid: !r.ok && r.status === 422,
  });
  return r.ok;
}

/** Envia a fila até acabar o tempo ou o limite de cada disparo. */
async function tick() {
  const deadline = Date.now() + TIME_BUDGET_MS;
  let sent = 0, failed = 0;
  while (Date.now() < deadline) {
    const { data, error } = await svc.rpc("email_claim", { p_limit: 40 });
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Claimed[];
    if (!batch.length) break;
    for (let i = 0; i < batch.length; i += 5) {
      const results = await Promise.all(batch.slice(i, i + 5).map((m) => sendOne(m).catch(async (e) => {
        await svc.rpc("email_result", { p_id: m.id, p_ok: false, p_error: (e as Error).message, p_invalid: false });
        return false;
      })));
      for (const ok of results) ok ? sent++ : failed++;
    }
  }
  return { sent, failed };
}

const page = (title: string, text: string) => new Response(
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;background:#f5f5f4;color:#1c1917;display:flex;min-height:90vh;align-items:center;justify-content:center;margin:0">
<div style="background:#fff;border-radius:12px;padding:32px;max-width:420px;text-align:center"><h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1><p style="margin:0;line-height:1.5">${esc(text)}</p></div></body></html>`,
  { headers: { "Content-Type": "text/html; charset=utf-8" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  if (/\/sair\/?$/.test(url.pathname)) {
    const t = url.searchParams.get("t") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(t)) return page("Link inválido", "Este link de descadastro não é válido.");
    const { data, error } = await svc.rpc("email_unsubscribe", { p_token: t });
    const r = (data ?? {}) as { ok?: boolean; empresa?: string };
    if (error || !r.ok) return page("Link inválido", "Não encontramos este envio. Se precisar, responda o e-mail pedindo para sair da lista.");
    return page("Pronto, você foi descadastrado", `Você não vai mais receber e-mails de disparo de ${r.empresa ?? "esta empresa"}.`);
  }

  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);
  const body = await req.json().catch(() => ({})) as { action?: string };
  const authz = req.headers.get("Authorization") ?? "";
  const internal = authz === `Bearer ${SERVICE}`;
  if (!internal) {
    // usuário logado pode pedir o envio na hora (o limite de cada disparo continua valendo)
    const { data: u } = await svc.auth.getUser(authz.replace(/^Bearer\s+/i, ""));
    if (!u?.user || body.action !== "kick") return json({ error: "unauthorized" }, 401);
  }
  try {
    return json({ ok: true, ...(await tick()) });
  } catch (e) {
    console.error("email-dispatch", (e as Error).message);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
