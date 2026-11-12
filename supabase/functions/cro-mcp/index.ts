// Conector MCP do IDX CRO Engine — Model Context Protocol, transporte Streamable HTTP (JSON).
// Endereço:  https://<projeto>.supabase.co/functions/v1/cro-mcp
// Autenticação: "Authorization: Bearer cro_…"  ou, para clientes que só aceitam URL (ex.: conector
// personalizado do Claude.ai), o token no fim do endereço: …/cro-mcp/cro_… (trate o link como senha).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PROMPTS, TOOLS } from "../_shared/mcp-tools.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const svc = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "idx-cro-engine", title: "IDX CRO Engine", version: "1.0.0" };
const INSTRUCTIONS =
  "Você está conectado ao CRO (CRM + discador + disparos de WhatsApp + busca de clientes no Google Maps) de uma empresa. " +
  "Responda em português. Comece por resumo_comercial quando precisar de contexto. " +
  "Nunca envie WhatsApp, inicie/cancele disparos ou altere dados sem mostrar o que vai fazer e receber confirmação explícita do usuário. " +
  "Interesse demonstrado pela IA não é venda: vendas só são marcadas manualmente no CRO.";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, accept",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "mcp-session-id, www-authenticate",
};

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, any> };
const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function tokenFrom(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  if (h.startsWith("Bearer cro_")) return h.slice(7).trim();
  const m = new URL(req.url).pathname.match(/\/(cro_[a-f0-9]{64})\/?$/);
  return m ? m[1] : null;
}

function unauthorized() {
  return new Response(JSON.stringify(err(null, -32001, "Token do CRO ausente, inválido ou revogado. Crie um em Configurações → IA (MCP).")), {
    status: 401,
    headers: { ...cors, "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="cro", error="invalid_token"' },
  });
}

async function handle(msg: Rpc, token: string, who: { scope: string; tenant: string; user: string }) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize": {
      const v = SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
      return ok(id, {
        protocolVersion: v,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER,
        instructions: `${INSTRUCTIONS} Empresa: ${who.tenant}. Usuário: ${who.user}. Permissão do token: ${who.scope === "write" ? "leitura e ações" : "somente leitura"}.`,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: TOOLS.filter((t) => !t.write || who.scope === "write").map(({ write: _w, ...t }) => t),
      });
    case "tools/call": {
      const name = String(params.name ?? "");
      const def = TOOLS.find((t) => t.name === name);
      if (!def) return err(id, -32602, `Ferramenta desconhecida: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const { data, error } = await svc.rpc("mcp_call", { p_token: token, p_tool: name, p_args: args });
      if (error) {
        const message = error.message.replace(/^.*?:\s(?=[A-ZÀ-Ú])/, "");
        await svc.rpc("mcp_log_error", { p_token: token, p_tool: name, p_error: error.message, p_args: def.write ? args : null });
        return ok(id, { content: [{ type: "text", text: `Não foi possível: ${message}` }], isError: true });
      }
      const structured = Array.isArray(data) ? { itens: data, total: data.length } : (data ?? {});
      return ok(id, {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: structured,
      });
    }
    case "prompts/list":
      return ok(id, { prompts: PROMPTS.map(({ text: _t, ...p }) => p) });
    case "prompts/get": {
      const p = PROMPTS.find((x) => x.name === params.name);
      if (!p) return err(id, -32602, "Prompt desconhecido");
      return ok(id, { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.text } }] });
    }
    case "resources/list":
      return ok(id, { resources: [] });
    default:
      return err(id, -32601, `Método não suportado: ${method}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method === "GET" || req.method === "DELETE") {
    // sem fluxo SSE do servidor: tudo responde no próprio POST
    return new Response(null, { status: 405, headers: { ...cors, Allow: "POST, OPTIONS" } });
  }
  if (req.method !== "POST") return new Response(null, { status: 405, headers: cors });

  const token = tokenFrom(req);
  if (!token) return unauthorized();
  const { data: who, error: werr } = await svc.rpc("mcp_whoami", { p_token: token });
  if (werr || !who) return unauthorized();
  const ctx = { scope: who.scope as string, tenant: who.tenant as string, user: who.user as string };

  let body: Rpc | Rpc[];
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify(err(null, -32700, "JSON inválido")), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
  const batch = Array.isArray(body) ? body : [body];
  const out: unknown[] = [];
  for (const m of batch) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") { out.push(err((m as Rpc)?.id, -32600, "Requisição inválida")); continue; }
    if (m.id === undefined || m.id === null) continue; // notificação (ex.: notifications/initialized)
    try { out.push(await handle(m, token, ctx)); }
    catch (e) { out.push(err(m.id, -32603, (e as Error).message)); }
  }
  if (!out.length) return new Response(null, { status: 202, headers: cors });
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), {
    status: 200, headers: { ...cors, "Content-Type": "application/json", "MCP-Protocol-Version": SUPPORTED[0] },
  });
});
