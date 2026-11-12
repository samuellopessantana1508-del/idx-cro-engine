// E-mails transacionais do CRO pelo Resend (https://resend.com).
// Segredos (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY  chave da API do Resend (re_...)
//   RESEND_FROM     remetente de um domínio verificado no Resend, ex.: "IDX CRO <acesso@sanmarfidelize.com>"
//   RESEND_REPLY_TO (opcional) endereço para respostas
// RESEND_API_URL só existe para os testes (servidor simulado).

export type EmailResult = { ok: boolean; id?: string; error?: string; skipped?: boolean };

export function emailConfigured(): boolean {
  return !!Deno.env.get("RESEND_API_KEY");
}

export async function sendEmail(msg: { to: string; subject: string; html: string; text: string; tags?: Record<string, string> }): Promise<EmailResult> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, skipped: true, error: "Envio de e-mail não configurado (RESEND_API_KEY)." };
  const from = Deno.env.get("RESEND_FROM") || "IDX CRO <onboarding@resend.dev>";
  const replyTo = Deno.env.get("RESEND_REPLY_TO") || undefined;
  const base = (Deno.env.get("RESEND_API_URL") || "https://api.resend.com").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(msg.tags ? { tags: Object.entries(msg.tags).map(([name, value]) => ({ name, value: value.replace(/[^a-zA-Z0-9_-]/g, "_") })) } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
    if (!res.ok) return { ok: false, error: friendlyResendError(res.status, body.message ?? body.name ?? "") };
    return { ok: true, id: body.id };
  } catch (e) {
    return { ok: false, error: `Sem resposta do Resend: ${(e as Error).message}` };
  }
}

function friendlyResendError(status: number, message: string): string {
  if (status === 401 || (status === 403 && /api key/i.test(message))) return "Chave do Resend inválida (RESEND_API_KEY).";
  if (status === 403 && /domain|verify/i.test(message)) return "O domínio do remetente não está verificado no Resend (RESEND_FROM).";
  if (status === 403 && /testing emails|own email/i.test(message)) return "No modo de teste o Resend só envia para o seu próprio e-mail. Verifique um domínio no Resend.";
  if (status === 422) return `Endereço de e-mail recusado pelo Resend: ${message}`.slice(0, 200);
  if (status === 429) return "Limite de envio do Resend atingido. Tente de novo em instantes.";
  return `Resend: ${message || `erro ${status}`}`.slice(0, 200);
}

/**
 * Link de verificação do Supabase Auth a partir do generateLink (forma recomendada para e-mails
 * próprios: usa o hashed_token e sempre aponta para /auth/v1/verify do projeto).
 */
export function verifyUrl(props: { hashed_token?: string; verification_type?: string; action_link?: string; redirect_to?: string } | null | undefined, fallbackType: string, redirectTo: string): string | null {
  if (!props) return null;
  const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  if (props.hashed_token && base) {
    const type = props.verification_type || fallbackType;
    return `${base}/auth/v1/verify?token=${encodeURIComponent(props.hashed_token)}&type=${encodeURIComponent(type)}&redirect_to=${encodeURIComponent(props.redirect_to || redirectTo)}`;
  }
  return props.action_link ?? null;
}

// ---------------------------------------------------------------------------
// Modelos (português, HTML simples que funciona em qualquer cliente de e-mail)
// ---------------------------------------------------------------------------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function layout(title: string, paragraphs: string[], button: { label: string; url: string }, footer: string) {
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:12px;border:1px solid #e5e7eb">
<tr><td style="padding:24px 28px 8px;font-size:18px;font-weight:bold">IDX<span style="color:#16a34a">.</span> CRO Engine</td></tr>
<tr><td style="padding:8px 28px 0"><h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px;color:#374151">${p}</p>`).join("")}
<p style="margin:20px 0"><a href="${esc(button.url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;font-size:15px">${esc(button.label)}</a></p>
<p style="font-size:12px;line-height:1.5;color:#6b7280;margin:0 0 8px">Se o botão não funcionar, copie e cole este endereço no navegador:<br><span style="word-break:break-all;color:#374151">${esc(button.url)}</span></p>
</td></tr>
<tr><td style="padding:16px 28px 24px;font-size:12px;color:#9ca3af;border-top:1px solid #f0f0f0">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [title, "", ...paragraphs.map((p) => p.replace(/<[^>]+>/g, "")), "", `${button.label}: ${button.url}`, "", footer].join("\n");
  return { html, text };
}

const ROLE_LABEL: Record<string, string> = { owner: "dono(a)", admin: "administrador(a)", operator: "vendedor(a) / atendimento", viewer: "visualizador(a)" };

export function inviteEmail(p: { tenantName: string; role: string; inviter: string | null; url: string; newUser: boolean }) {
  const subject = `Seu acesso ao CRO da ${p.tenantName}`;
  const who = p.inviter ? `<b>${esc(p.inviter)}</b> liberou` : "Foi liberado";
  const { html, text } = layout(
    p.newUser ? "Você foi convidado para o CRO" : "Você ganhou acesso a mais uma empresa",
    [
      `${who} um acesso para você no painel da <b>${esc(p.tenantName)}</b> como <b>${esc(ROLE_LABEL[p.role] ?? p.role)}</b>.`,
      p.newUser
        ? "Clique no botão para entrar e criar a sua senha. O link vale por 24 horas e só pode ser usado uma vez."
        : "Clique no botão para entrar. O link vale por 1 hora e só pode ser usado uma vez; depois você entra com a sua senha de sempre.",
    ],
    { label: p.newUser ? "Aceitar convite e criar senha" : "Entrar no CRO", url: p.url },
    "Você recebeu este e-mail porque alguém da empresa adicionou o seu endereço. Se não esperava por isso, pode ignorar.",
  );
  return { subject, html, text };
}

export function accessLinkEmail(p: { url: string; recovery: boolean }) {
  const subject = p.recovery ? "Crie uma nova senha do CRO" : "Seu link de acesso ao CRO";
  const { html, text } = layout(
    p.recovery ? "Criar uma nova senha" : "Entrar no CRO",
    [p.recovery
      ? "Recebemos um pedido para trocar a sua senha. Clique no botão para entrar e escolher uma senha nova. O link vale por 1 hora."
      : "Clique no botão para entrar no CRO sem senha. O link vale por 1 hora e só pode ser usado uma vez."],
    { label: p.recovery ? "Criar nova senha" : "Entrar no CRO", url: p.url },
    "Se não foi você que pediu, ignore este e-mail — nada muda na sua conta.",
  );
  return { subject, html, text };
}
