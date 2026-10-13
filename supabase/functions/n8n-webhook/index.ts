import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateWebhookKey } from "../_shared/webhook-auth.ts";
import { normalizePhone, extractWaId, isGroupJid } from "../_shared/phone-utils.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function logEvent(
  tenantId: string,
  action: string,
  payload: unknown,
  status: "received" | "processed" | "failed",
  errorMessage?: string,
): Promise<string> {
  const { data } = await supa
    .from("webhook_events")
    .insert({
      tenant_id: tenantId,
      source: "n8n",
      action,
      payload,
      status,
      error_message: errorMessage ?? null,
      processed_at: status === "processed" ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  return data?.id ?? "";
}

async function findOrCreateInstance(tenantId: string, instanceName: string) {
  const { data: existing } = await supa
    .from("whatsapp_instances")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("instance_name", instanceName)
    .maybeSingle();

  if (existing) return existing;

  const { data: created } = await supa
    .from("whatsapp_instances")
    .insert({
      tenant_id: tenantId,
      instance_name: instanceName,
      provider: "evolution",
      status: "disconnected",
    })
    .select("*")
    .single();

  return created;
}

async function findOrCreateContact(
  tenantId: string,
  instanceId: string,
  waId: string,
  pushName?: string,
  profilePicUrl?: string,
) {
  const { data: existing } = await supa
    .from("whatsapp_contacts")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("wa_id", waId)
    .maybeSingle();

  if (existing) {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (pushName && pushName !== existing.push_name) updates.push_name = pushName;
    if (profilePicUrl && profilePicUrl !== existing.profile_pic_url) updates.profile_pic_url = profilePicUrl;
    if (Object.keys(updates).length > 1) {
      await supa.from("whatsapp_contacts").update(updates).eq("id", existing.id);
    }
    return existing;
  }

  const phone = normalizePhone(waId);
  const { data: created } = await supa
    .from("whatsapp_contacts")
    .insert({
      tenant_id: tenantId,
      instance_id: instanceId,
      wa_id: waId,
      phone: phone || null,
      push_name: pushName ?? null,
      profile_pic_url: profilePicUrl ?? null,
    })
    .select("*")
    .single();

  return created;
}

async function findOrCreateConversation(
  tenantId: string,
  instanceId: string,
  contactId: string,
) {
  const { data: existing } = await supa
    .from("whatsapp_conversations")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("instance_id", instanceId)
    .eq("contact_id", contactId)
    .maybeSingle();

  if (existing) return existing;

  const { data: created } = await supa
    .from("whatsapp_conversations")
    .insert({
      tenant_id: tenantId,
      instance_id: instanceId,
      contact_id: contactId,
      status: "active",
    })
    .select("*")
    .single();

  return created;
}

async function linkConversationToLead(
  tenantId: string,
  conversationId: string,
  contactPhone: string,
) {
  if (!contactPhone) return;

  const phone = normalizePhone(contactPhone);
  if (!phone) return;

  const { data: session } = await supa
    .from("tracking_sessions")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("customer_phone", phone)
    .order("clicked_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (session) {
    await supa
      .from("whatsapp_conversations")
      .update({ tracking_session_id: session.id })
      .eq("id", conversationId)
      .is("tracking_session_id", null);
  }
}

async function handleConnectionStatus(tenantId: string, payload: Record<string, unknown>) {
  const instanceName = String(payload.instance ?? payload.instanceName ?? "");
  const state = String(payload.state ?? payload.status ?? "");
  if (!instanceName) return json({ error: "missing_instance_name" }, 400);

  const instance = await findOrCreateInstance(tenantId, instanceName);
  if (!instance) return json({ error: "instance_create_failed" }, 500);

  const statusMap: Record<string, string> = {
    open: "connected",
    close: "disconnected",
    connecting: "connecting",
    connected: "connected",
    disconnected: "disconnected",
    refused: "banned",
  };

  const newStatus = statusMap[state.toLowerCase()] ?? "disconnected";
  const updates: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };

  if (newStatus === "connected") {
    updates.last_seen_at = new Date().toISOString();
    updates.qr_code_data = null;
  }

  if (payload.qrcode) {
    updates.qr_code_data = String(payload.qrcode);
    updates.status = "connecting";
  }

  if (payload.phoneNumber || payload.phone_number) {
    updates.phone_number = String(payload.phoneNumber ?? payload.phone_number);
  }

  await supa.from("whatsapp_instances").update(updates).eq("id", instance.id);
  await logEvent(tenantId, "connection_status", payload, "processed");

  return json({ ok: true, instance_id: instance.id, status: newStatus });
}

async function handleMessageReceived(tenantId: string, payload: Record<string, unknown>) {
  const instanceName = String(payload.instance ?? payload.instanceName ?? "");
  const msgData = (payload.data ?? payload.message ?? payload) as Record<string, unknown>;

  const remoteJid = String(msgData.remoteJid ?? msgData.key?.remoteJid ?? "");
  if (!remoteJid || isGroupJid(remoteJid)) {
    await logEvent(tenantId, "message_received", payload, "processed");
    return json({ ok: true, skipped: "group_or_empty" });
  }

  const waId = extractWaId(remoteJid);
  const waMessageId = String(msgData.key?.id ?? msgData.id ?? msgData.messageId ?? "");
  const pushName = String(msgData.pushName ?? msgData.push_name ?? "") || undefined;

  const instance = await findOrCreateInstance(tenantId, instanceName || "default");
  if (!instance) return json({ error: "instance_failed" }, 500);

  const contact = await findOrCreateContact(tenantId, instance.id, waId, pushName);
  if (!contact) return json({ error: "contact_failed" }, 500);

  const conversation = await findOrCreateConversation(tenantId, instance.id, contact.id);
  if (!conversation) return json({ error: "conversation_failed" }, 500);

  const msgType = String(msgData.messageType ?? msgData.type ?? "text").toLowerCase();
  const contentTypeMap: Record<string, string> = {
    conversation: "text",
    extendedtextmessage: "text",
    imagemessage: "image",
    audiomessage: "audio",
    videomessage: "video",
    documentmessage: "document",
    locationmessage: "location",
    contactmessage: "contact",
    stickermessage: "sticker",
    reactionmessage: "reaction",
  };
  const contentType = contentTypeMap[msgType] ?? (["text", "image", "audio", "video", "document", "location", "contact", "sticker", "reaction"].includes(msgType) ? msgType : "unknown");

  const body = String(
    msgData.body ??
    msgData.message?.conversation ??
    msgData.message?.extendedTextMessage?.text ??
    msgData.text ??
    ""
  ) || null;

  const mediaUrl = String(msgData.mediaUrl ?? msgData.media_url ?? "") || null;
  const mediaMime = String(msgData.mimetype ?? msgData.mediaMimetype ?? "") || null;

  const quotedId = String(
    msgData.contextInfo?.stanzaId ??
    msgData.quoted_message_id ??
    ""
  ) || null;

  const fromMe = Boolean(msgData.key?.fromMe ?? msgData.fromMe ?? false);
  const direction = fromMe ? "outbound" : "inbound";
  const timestamp = msgData.messageTimestamp
    ? new Date(Number(msgData.messageTimestamp) * 1000).toISOString()
    : new Date().toISOString();

  if (waMessageId) {
    const { data: dup } = await supa
      .from("whatsapp_messages")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("wa_message_id", waMessageId)
      .maybeSingle();
    if (dup) {
      return json({ ok: true, duplicate: true, message_id: dup.id });
    }
  }

  const { data: msg, error: msgError } = await supa
    .from("whatsapp_messages")
    .insert({
      tenant_id: tenantId,
      conversation_id: conversation.id,
      wa_message_id: waMessageId || null,
      direction,
      sender_phone: direction === "inbound" ? normalizePhone(waId) : null,
      content_type: contentType,
      body,
      media_url: mediaUrl,
      media_mime: mediaMime,
      quoted_message_id: quotedId,
      timestamp,
      status: "delivered",
      raw_payload: payload,
    })
    .select("id")
    .single();

  if (msgError) {
    await logEvent(tenantId, "message_received", payload, "failed", msgError.message);
    return json({ error: msgError.message }, 500);
  }

  await supa
    .from("whatsapp_conversations")
    .update({
      last_message_at: timestamp,
      unread_count: (conversation.unread_count ?? 0) + (direction === "inbound" ? 1 : 0),
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversation.id);

  if (contact.phone) {
    linkConversationToLead(tenantId, conversation.id, contact.phone).catch(() => {});
  }

  await logEvent(tenantId, "message_received", { message_id: msg.id, wa_message_id: waMessageId }, "processed");
  return json({ ok: true, message_id: msg.id, conversation_id: conversation.id });
}

async function handleMessageStatus(tenantId: string, payload: Record<string, unknown>) {
  const msgData = (payload.data ?? payload) as Record<string, unknown>;
  const waMessageId = String(msgData.key?.id ?? msgData.id ?? msgData.messageId ?? "");
  const statusRaw = String(msgData.status ?? msgData.ack ?? "");

  if (!waMessageId) {
    await logEvent(tenantId, "message_status", payload, "processed");
    return json({ ok: true, skipped: "no_message_id" });
  }

  const statusMap: Record<string, string> = {
    "1": "sent",
    "2": "delivered",
    "3": "read",
    sent: "sent",
    delivered: "delivered",
    read: "read",
    played: "read",
    failed: "failed",
    error: "failed",
    DELIVERY_ACK: "delivered",
    READ: "read",
    PLAYED: "read",
    SERVER_ACK: "sent",
  };

  const newStatus = statusMap[statusRaw] ?? null;
  if (!newStatus) {
    await logEvent(tenantId, "message_status", payload, "processed");
    return json({ ok: true, skipped: "unknown_status" });
  }

  const { error } = await supa
    .from("whatsapp_messages")
    .update({ status: newStatus })
    .eq("tenant_id", tenantId)
    .eq("wa_message_id", waMessageId);

  if (error) {
    await logEvent(tenantId, "message_status", payload, "failed", error.message);
    return json({ error: error.message }, 500);
  }

  await logEvent(tenantId, "message_status", { wa_message_id: waMessageId, status: newStatus }, "processed");
  return json({ ok: true, status: newStatus });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const apiKey = req.headers.get("x-api-key");
  const auth = await validateWebhookKey(apiKey);
  if (!auth.ok) return json({ error: auth.error }, 401);

  const tenantId = auth.tenantId;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const action = String(body.action ?? "");

  try {
    switch (action) {
      case "connection_status":
        return await handleConnectionStatus(tenantId, body);
      case "message_received":
        return await handleMessageReceived(tenantId, body);
      case "message_sent":
        return await handleMessageReceived(tenantId, { ...body, data: { ...((body.data ?? {}) as Record<string, unknown>), key: { ...((body.data as Record<string, unknown>)?.key as Record<string, unknown> ?? {}), fromMe: true } } });
      case "message_status":
        return await handleMessageStatus(tenantId, body);
      default:
        await logEvent(tenantId, action || "unknown", body, "received");
        return json({ ok: true, action: "logged" });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "internal_error";
    await logEvent(tenantId, action || "unknown", body, "failed", msg).catch(() => {});
    return json({ error: msg }, 500);
  }
});
