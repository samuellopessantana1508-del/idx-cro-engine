import { useCallback, useEffect, useState } from "react";
import { Bot, Check, Copy, KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { db } from "./api";
import { useCrm } from "./context";
import { errorText, relative } from "./format";
import { Confirm, Empty, Field, Modal, Pill, Skeleton } from "./ui";

type Tok = { id: string; name: string; token_prefix: string; scope: "read" | "write"; last_used_at: string | null; calls: number; created_at: string; revoked_at: string | null };
type CallRow = { id: number; tool: string; ok: boolean; error: string | null; created_at: string };

const MCP_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cro-mcp`;

function CopyBox({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="mcp-copy">
      <span>{label}</span>
      <div>
        <code className={secret ? "secret" : ""}>{value}</code>
        <button type="button" className="crm-btn ghost sm" onClick={async () => { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>
          {done ? <Check size={14} /> : <Copy size={14} />} {done ? "Copiado" : "Copiar"}
        </button>
      </div>
    </div>
  );
}

export function McpView() {
  const { tenantId, tenantName, access, notify, userId } = useCrm();
  const [tokens, setTokens] = useState<Tok[] | null>(null);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ token: string; name: string; scope: string } | null>(null);
  const [revoking, setRevoking] = useState<Tok | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([
        db().from("mcp_tokens").select("id, name, token_prefix, scope, last_used_at, calls, created_at, revoked_at").eq("tenant_id", tenantId).eq("user_id", userId).order("created_at", { ascending: false }),
        db().from("mcp_calls").select("id, tool, ok, error, created_at").eq("tenant_id", tenantId).eq("user_id", userId).order("created_at", { ascending: false }).limit(15),
      ]);
      if (t.error) throw t.error;
      setTokens((t.data ?? []) as Tok[]);
      setCalls((c.data ?? []) as CallRow[]);
    } catch (e) { notify(errorText(e)); setTokens([]); }
  }, [tenantId, userId, notify]);
  useEffect(() => { void load(); }, [load]);

  const active = (tokens ?? []).filter((t) => !t.revoked_at);

  return (
    <div className="crm-page">
      <section className="crm-card mcp-hero">
        <div className="wa-conn-icon"><Bot size={22} /></div>
        <div>
          <strong>Use o CRO dentro do Claude (e de outras IAs)</strong>
          <p className="crm-muted">
            O conector MCP do CRO deixa o Claude consultar seus contatos, funil, tarefas, discador, disparos de WhatsApp e buscas do Google Maps —
            e, se você permitir, criar tarefas, registrar ligações e enviar mensagens (sempre pedindo sua confirmação).
            Ele age com <b>as suas permissões</b> na empresa <b>{tenantName}</b>.
          </p>
        </div>
        <button type="button" className="crm-btn primary" onClick={() => setCreating(true)}><Plus size={16} /> Conectar ao Claude</button>
      </section>

      <h3 className="wa-sub"><KeyRound size={15} /> Meus tokens</h3>
      {!tokens ? <Skeleton rows={2} /> : active.length === 0 ? (
        <Empty icon={<KeyRound size={20} />} title="Nenhum token ativo" text="Crie um token para conectar o Claude ao CRO. Ele aparece uma única vez." />
      ) : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead><tr><th>Nome</th><th>Token</th><th>Permissão</th><th>Último uso</th><th>Chamadas</th><th></th></tr></thead>
            <tbody>
              {active.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td><code>{t.token_prefix}…</code></td>
                  <td>{t.scope === "write" ? <Pill tone="amber">Leitura e ações</Pill> : <Pill tone="green">Somente leitura</Pill>}</td>
                  <td>{t.last_used_at ? relative(t.last_used_at) : "nunca"}</td>
                  <td>{t.calls}</td>
                  <td><button type="button" className="crm-icon-btn" title="Revogar" onClick={() => setRevoking(t)}><Trash2 size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {calls.length > 0 && <>
        <h3 className="wa-sub"><ShieldCheck size={15} /> Últimas ações da IA</h3>
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead><tr><th>Quando</th><th>Ferramenta</th><th>Resultado</th></tr></thead>
            <tbody>{calls.map((c) => <tr key={c.id}><td>{relative(c.created_at)}</td><td><code>{c.tool}</code></td><td>{c.ok ? <Pill tone="green">ok</Pill> : <span className="tone-red">{c.error}</span>}</td></tr>)}</tbody>
          </table>
        </div>
      </>}

      {creating && <CreateToken canWrite={access.write} onClose={() => setCreating(false)}
        onCreated={(c) => { setCreating(false); setCreated(c); void load(); }} />}
      {created && <TokenInstructions created={created} onClose={() => setCreated(null)} />}
      <Confirm open={!!revoking} onClose={() => setRevoking(null)} danger confirmLabel="Revogar"
        title={`Revogar “${revoking?.name}”?`} text="O Claude (ou outra IA) que usa este token perde o acesso na hora."
        onConfirm={async () => { try { const r = await db().rpc("mcp_token_revoke", { p_id: revoking!.id }); if (r.error) throw r.error; notify("Token revogado"); void load(); } catch (e) { notify(errorText(e)); } }} />
    </div>
  );
}

function CreateToken({ canWrite, onClose, onCreated }: { canWrite: boolean; onClose: () => void; onCreated: (c: { token: string; name: string; scope: string }) => void }) {
  const { tenantId, notify } = useCrm();
  const [name, setName] = useState("Claude");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      const r = await db().rpc("mcp_token_create", { p_tenant_id: tenantId, p_name: name, p_scope: scope });
      if (r.error) throw r.error;
      onCreated({ token: (r.data as { token: string }).token, name, scope });
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Novo token para IA" width={520}
      footer={<><button type="button" className="crm-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="button" className="crm-btn primary" disabled={busy} onClick={create}>Criar token</button></>}>
      <div className="crm-form-grid one">
        <Field label="Nome (para você reconhecer)"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude do notebook" /></Field>
        <Field label="O que a IA pode fazer">
          <div className="mcp-scope">
            <label className={scope === "read" ? "on" : ""}><input type="radio" checked={scope === "read"} onChange={() => setScope("read")} />
              <b>Somente consultar</b><span>Ver resumo, contatos, funil, tarefas, discador, disparos e conversas.</span></label>
            <label className={`${scope === "write" ? "on" : ""} ${!canWrite ? "disabled" : ""}`}><input type="radio" disabled={!canWrite} checked={scope === "write"} onChange={() => setScope("write")} />
              <b>Consultar e agir</b><span>Também criar contatos e tarefas, registrar ligações, enviar WhatsApp e controlar disparos — a IA é orientada a pedir sua confirmação antes.</span></label>
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function TokenInstructions({ created, onClose }: { created: { token: string; name: string; scope: string }; onClose: () => void }) {
  const urlWithToken = `${MCP_URL}/${created.token}`;
  const claudeCode = `claude mcp add --transport http cro ${MCP_URL} --header "Authorization: Bearer ${created.token}"`;
  const desktop = JSON.stringify({ mcpServers: { cro: { command: "npx", args: ["-y", "mcp-remote", MCP_URL, "--header", `Authorization: Bearer ${created.token}`] } } }, null, 2);
  return (
    <Modal open onClose={onClose} title="Token criado — copie agora" width={720}
      footer={<button type="button" className="crm-btn primary" onClick={onClose}>Já copiei</button>}>
      <p className="wa-warn"><span>Este token aparece <b>só agora</b>. Trate como senha: quem tiver ele acessa o CRO com as suas permissões. Se vazar, revogue.</span></p>
      <h4 className="wa-sub">Claude.ai (site e app) — Conector personalizado</h4>
      <ol className="maps-steps">
        <li>No Claude: <b>Configurações → Conectores → Adicionar conector personalizado</b>.</li>
        <li>Nome: <b>IDX CRO</b>. Em “URL do servidor MCP remoto”, cole o endereço abaixo (ele já contém o token).</li>
        <li>Pronto. Em uma conversa, ative o conector “IDX CRO” e peça, por exemplo: “monte minha rotina de hoje no CRO”.</li>
      </ol>
      <CopyBox label="Endereço com token" value={urlWithToken} secret />
      <h4 className="wa-sub">Claude Code (terminal)</h4>
      <CopyBox label="Comando" value={claudeCode} secret />
      <h4 className="wa-sub">Claude Desktop (arquivo de configuração) e outros clientes MCP</h4>
      <CopyBox label="Endereço" value={MCP_URL} />
      <CopyBox label="Cabeçalho" value={`Authorization: Bearer ${created.token}`} secret />
      <details className="mcp-details"><summary>claude_desktop_config.json</summary><pre>{desktop}</pre></details>
    </Modal>
  );
}
