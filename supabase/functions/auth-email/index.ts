// Tela de login: "Receber link de acesso" e "Esqueci minha senha" pelo Resend.
// Pública (sem login). Sempre responde igual — não revela se o e-mail tem conta — e
// limita os pedidos por e-mail (3/hora) e por origem (10/hora). Só manda para quem já tem conta.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { accessLinkEmail, emailConfigured, sendEmail, verifyUrl } from "../_shared/email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const svc = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const appUrl = () => (Deno.env.get("APP_URL") || Deno.env.get("SITE_URL") || "https://cro.sanmarfidelize.com").replace(/\/$/, "");

async function sha(text: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${SERVICE.slice(-16)}:${text}`)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function userExists(email: string): Promise<boolean> {
  const { data } = await svc.from("tenant_users").select("id").eq("email", email).eq("status", "active").limit(1).maybeSingle();
  if (data) return true;
  for (let page = 1; page <= 20; page++) {
    const { data: list } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (list?.users?.some((u) => (u.email ?? "").toLowerCase() === email)) return true;
    if (!list?.users?.length || list.users.length < 200) break;
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);
  const body = await req.json().catch(() => ({})) as { action?: string; email?: string };
  const email = String(body.email ?? "").trim().toLowerCase();
  const recovery = body.action === "recovery";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return json({ error: "Informe um e-mail válido." }, 400);
  if (!emailConfigured()) return json({ error: "O envio de e-mails ainda não foi configurado. Fale com o administrador." }, 503);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "sem-ip";
  const { data: allowed } = await svc.rpc("auth_email_allow", { p_email_hash: await sha(email), p_ip_hash: await sha(ip), p_kind: recovery ? "recovery" : "link" });
  if (allowed === false) return json({ error: "Muitos pedidos seguidos. Aguarde alguns minutos e tente de novo." }, 429);

  // mesma resposta exista a conta ou não (não revela quem tem acesso)
  const done = json({ ok: true });
  if (!(await userExists(email))) return done;
  const redirectTo = recovery ? `${appUrl()}/?senha=nova` : `${appUrl()}/`;
  const link = await svc.auth.admin.generateLink({ type: recovery ? "recovery" : "magiclink", email, options: { redirectTo } });
  const url = verifyUrl(link.data?.properties, recovery ? "recovery" : "magiclink", redirectTo);
  if (link.error || !url) { console.error("auth-email link", link.error?.message); return done; }
  const sent = await sendEmail({ to: email, ...accessLinkEmail({ url, recovery }), tags: { tipo: recovery ? "nova_senha" : "link_acesso" } });
  if (!sent.ok) console.error("auth-email envio", sent.error);
  return done;
});
