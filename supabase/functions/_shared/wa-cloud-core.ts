// Regras puras da API oficial do WhatsApp (Meta Cloud API): montar o envio, ler o webhook,
// entender os erros e os modelos. Sem rede nem banco — testado em tests/flows/wa-cloud-core.test.ts.

export type OutboxItem = {
  phone: string; body?: string | null;
  media_url?: string | null; media_type?: string | null; file_name?: string | null;
  template?: { name: string; language: string; params?: string[] } | null;
  interactive?: { type: "buttons"; options: string[]; footer?: string | null } | null;
};

/** Corpo do POST /{phone_number_id}/messages */
export function cloudPayload(m: OutboxItem): Record<string, unknown> {
  const to = String(m.phone ?? "").replace(/\D/g, "");
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  if (m.template?.name) {
    const params = (m.template.params ?? []).map((t) => ({ type: "text", text: String(t ?? "").slice(0, 1024) || "-" }));
    return {
      ...base, type: "template",
      template: {
        name: m.template.name,
        language: { code: m.template.language || "pt_BR" },
        ...(params.length ? { components: [{ type: "body", parameters: params }] } : {}),
      },
    };
  }
  if (m.interactive?.type === "buttons" && m.interactive.options?.length) {
    return {
      ...base, type: "interactive",
      interactive: {
        type: "button",
        body: { text: String(m.body ?? "").slice(0, 1024) || "Escolha uma opção" },
        ...(m.interactive.footer ? { footer: { text: m.interactive.footer.slice(0, 60) } } : {}),
        action: { buttons: m.interactive.options.slice(0, 3).map((o, i) => ({ type: "reply", reply: { id: `opt${i + 1}`, title: o.slice(0, 20) } })) },
      },
    };
  }
  if (m.media_url && m.media_type) {
    const kind = ["image", "video", "audio", "document"].includes(m.media_type) ? m.media_type : "document";
    const caption = (m.body ?? "").trim();
    const media: Record<string, unknown> = { link: m.media_url };
    if (caption && kind !== "audio") media.caption = caption.slice(0, 1024);
    if (kind === "document") media.filename = m.file_name || decodeURIComponent(m.media_url.split("?")[0].split("/").pop() || "arquivo");
    return { ...base, type: kind, [kind]: media };
  }
  return { ...base, type: "text", text: { body: String(m.body ?? "").slice(0, 4096), preview_url: /https?:\/\//.test(String(m.body ?? "")) } };
}

export type CloudError = { message: string; retry: boolean; invalid: boolean; auth: boolean };

/** Traduz o erro da Meta para o que a fila precisa fazer (tentar de novo, número inválido, token...). */
export function classifyCloudError(err: Record<string, any>): CloudError {
  const code = Number(err?.code ?? 0);
  const detail = String(err?.error_data?.details ?? err?.message ?? "Erro da Meta").slice(0, 200);
  const out = (message: string, o: Partial<CloudError> = {}): CloudError => ({ message, retry: false, invalid: false, auth: false, ...o });
  if (code === 131047 || code === 470) return out("Fora da janela de 24 horas: a API oficial só aceita um modelo aprovado. Envie um modelo.");
  if (code === 131026) return out("Este número não tem WhatsApp ou não pode receber mensagens.", { invalid: true });
  if (code === 131030) return out("Número de teste: adicione este destinatário na lista permitida do app da Meta.");
  if (code === 131031) return out("A Meta bloqueou esta conta do WhatsApp Business. Veja o Gerenciador do WhatsApp.", { auth: true });
  if ([130429, 131048, 131056, 80007, 4, 613, 1, 2, 131000].includes(code)) return out(`Limite de envio da Meta; tentando de novo. (${detail})`, { retry: true });
  if (code === 190) return out("O token de acesso da API oficial venceu ou é inválido. Gere um token permanente e salve de novo.", { auth: true });
  if (code === 10 || code === 200 || (code === 100 && /permission/i.test(detail))) {
    return out("O token não tem permissão para este número. Use um token de usuário do sistema com whatsapp_business_messaging.", { auth: code !== 100 });
  }
  if (code === 133010) return out("O número não está registrado na API oficial. Conclua o registro no Gerenciador do WhatsApp.", { auth: true });
  if (code === 132000) return out("O número de variáveis não bate com o modelo aprovado.");
  if (code === 132001) return out("Modelo não existe neste idioma ou ainda não foi aprovado.");
  if (code === 132007 || code === 132015 || code === 132016) return out("Modelo pausado ou desativado pela Meta.");
  if (code === 131051) return out("Tipo de mensagem não suportado pela API oficial.");
  if (code === 131052 || code === 131053) return out("Não foi possível baixar a mídia. Use um link público (https).");
  return out(`Meta: ${detail}${code ? ` (código ${code})` : ""}`);
}

export type InboundMsg = Record<string, unknown> & { body: string | null };
export type StatusUpdate = { id: string; status: string; error: string | null };

const TYPES = new Set(["text", "image", "audio", "video", "document", "location", "sticker", "reaction"]);

/** Lê o webhook da Meta. Ignora mudanças de outro número (phone_number_id diferente). */
export function parseCloudWebhook(payload: unknown, phoneNumberId: string | null): { messages: InboundMsg[]; statuses: StatusUpdate[] } {
  const messages: InboundMsg[] = [];
  const statuses: StatusUpdate[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as Record<string, any>[]) {
    for (const change of (entry?.changes ?? []) as Record<string, any>[]) {
      if (change?.field && change.field !== "messages") continue;
      const v = change?.value ?? {};
      if (phoneNumberId && v?.metadata?.phone_number_id && String(v.metadata.phone_number_id) !== String(phoneNumberId)) continue;
      const names = new Map<string, string>();
      for (const c of (v.contacts ?? []) as Record<string, any>[]) if (c?.wa_id) names.set(String(c.wa_id), String(c?.profile?.name ?? ""));
      for (const m of (v.messages ?? []) as Record<string, any>[]) {
        if (!m?.id || !m?.from) continue;
        const t = String(m.type ?? "unknown");
        let body: string | null = null;
        let type = TYPES.has(t) ? t : "unknown";
        if (t === "text") body = m.text?.body ?? null;
        else if (["image", "video", "document", "sticker", "audio"].includes(t)) body = m[t]?.caption ?? (t === "document" ? m.document?.filename ?? null : null);
        else if (t === "button") { body = m.button?.text ?? null; type = "text"; }
        else if (t === "interactive") { body = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null; type = "text"; }
        else if (t === "location") body = [m.location?.name, m.location?.address, `${m.location?.latitude},${m.location?.longitude}`].filter(Boolean).join(" · ");
        else if (t === "reaction") body = m.reaction?.emoji ?? null;
        else if (t === "contacts") { type = "contact"; body = (m.contacts ?? []).map((c: any) => [c?.name?.formatted_name, c?.phones?.[0]?.phone].filter(Boolean).join(" ")).join("; ") || null; }
        const ts = Number(m.timestamp);
        messages.push({
          from_me: false, wa_id: String(m.from), phone: String(m.from), push_name: names.get(String(m.from)) || null,
          body, type, wa_message_id: String(m.id), ts: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
          quoted_id: m.context?.id ?? null, mime: m[t]?.mime_type ?? null, via: "cloud_api",
        });
      }
      for (const s of (v.statuses ?? []) as Record<string, any>[]) {
        if (!s?.id || !s?.status) continue;
        const e = (s.errors ?? [])[0];
        statuses.push({ id: String(s.id), status: String(s.status), error: e ? classifyCloudError(e).message : null });
      }
    }
  }
  return { messages, statuses };
}

/** Modelo como a Meta devolve → como o CRO guarda (texto do corpo e nº de variáveis). */
export function templateFromMeta(t: Record<string, any>): Record<string, unknown> {
  const comps = (t.components ?? []) as Record<string, any>[];
  const body = comps.find((c) => String(c.type).toUpperCase() === "BODY")?.text ?? null;
  const header = comps.find((c) => String(c.type).toUpperCase() === "HEADER" && String(c.format ?? "TEXT").toUpperCase() === "TEXT")?.text ?? null;
  const vars = new Set<string>();
  for (const m of String(body ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)) vars.add(m[1]);
  return {
    name: String(t.name ?? ""), language: String(t.language ?? "pt_BR"), status: String(t.status ?? "").toUpperCase(),
    category: t.category ?? null, body_text: body, header_text: header, param_count: vars.size, components: comps,
  };
}
