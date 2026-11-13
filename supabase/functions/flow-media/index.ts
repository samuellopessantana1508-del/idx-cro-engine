// Arquivos das automações (PDF, imagem, vídeo, áudio) enviados pelo computador.
//   POST /flow-media                 multipart {tenant_id, file} — quem escreve no CRM da empresa
//   GET  /flow-media/<id>/<nome>     link público que o WhatsApp (QR Code ou API oficial) baixa
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const svc = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const MAX = 16 * 1024 * 1024;

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const ALLOWED: Record<string, "image" | "video" | "audio" | "document"> = {
  "image/jpeg": "image", "image/png": "image", "image/webp": "image",
  "video/mp4": "video", "video/3gpp": "video",
  "audio/ogg": "audio", "audio/mpeg": "audio", "audio/mp4": "audio", "audio/aac": "audio", "audio/amr": "audio",
  "application/pdf": "document", "application/msword": "document", "text/plain": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.ms-excel": "document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/vnd.ms-powerpoint": "document", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "document",
};

const toHex = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0"); return s; };
function fromHex(h: string): Uint8Array {
  const clean = h.startsWith("\\x") ? h.slice(2) : h;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
const safeName = (n: string) => n.normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "arquivo";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const m = url.pathname.match(/\/flow-media\/([0-9a-f-]{36})(?:\/[^/]*)?$/i);

  if (req.method === "GET" || req.method === "HEAD") {
    if (!m) return new Response("not found", { status: 404 });
    const { data } = await svc.from("flow_media").select("file_name, mime, size_bytes, data").eq("id", m[1]).maybeSingle();
    if (!data) return new Response("not found", { status: 404 });
    const row = data as { file_name: string; mime: string; size_bytes: number; data: string };
    const headers = {
      ...cors, "Content-Type": row.mime, "Content-Length": String(row.size_bytes),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
      "Cache-Control": "public, max-age=86400",
    };
    if (req.method === "HEAD") return new Response(null, { headers });
    return new Response(fromHex(row.data), { headers });
  }

  if (req.method !== "POST") return json({ error: "Método não suportado" }, 405);
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Faça login novamente" }, 401);
  const form = await req.formData().catch(() => null);
  if (!form) return json({ error: "Envie o arquivo" }, 400);
  const tenantId = String(form.get("tenant_id") ?? "");
  const file = form.get("file");
  if (!tenantId || !(file instanceof File)) return json({ error: "Envie o arquivo" }, 400);

  const db = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u } = await db.auth.getUser(auth.slice(7));
  if (!u?.user) return json({ error: "Faça login novamente" }, 401);
  const { data: access } = await db.rpc("crm_my_access", { p_tenant_id: tenantId });
  if (!(access as { write?: boolean } | null)?.write) return json({ error: "Sem permissão para enviar arquivos nesta empresa" }, 403);

  const mime = (file.type || "application/octet-stream").split(";")[0].toLowerCase();
  const kind = ALLOWED[mime];
  if (!kind) return json({ error: "Tipo de arquivo não aceito pelo WhatsApp. Use PDF, imagem (JPG/PNG), vídeo MP4, áudio (OGG/MP3) ou Office." }, 400);
  if (file.size <= 0 || file.size > MAX) return json({ error: "Arquivo vazio ou maior que 16 MB." }, 400);
  if (kind === "image" && file.size > 5 * 1024 * 1024) return json({ error: "Imagem maior que 5 MB (limite do WhatsApp)." }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = safeName(file.name || "arquivo");
  const { data: row, error } = await svc.from("flow_media")
    .insert({ tenant_id: tenantId, file_name: name, mime, size_bytes: bytes.length, data: `\\x${toHex(bytes)}`, created_by: u.user.id })
    .select("id").single();
  if (error) return json({ error: error.message }, 400);
  const id = (row as { id: string }).id;
  return json({ id, url: `${SUPABASE_URL}/functions/v1/flow-media/${id}/${encodeURIComponent(name)}`, file_name: name, mime, media_type: kind, size: bytes.length });
});
