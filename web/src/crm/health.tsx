import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, RefreshCw, XCircle } from "lucide-react";
import { db } from "./api";
import { useCrm } from "./context";
import { dateTime, errorText, phoneLabel, relative } from "./format";
import { Skeleton } from "./ui";

type Health = {
  motor_visto_em: string | null;
  rotinas: Record<string, { quando: string | null; ok: boolean | null; erro: string | null; resultado: unknown }>;
  whatsapp: { status: string; numero: string | null; desde: string } | null;
  meta: { status: string | null; vence_em: string | null; verificado_em: string | null; conta: string | null; erro: boolean } | null;
  google: { status: string | null; sincronizado_em: string | null; conta: string | null; erro: boolean } | null;
  google_maps: { has_key: boolean; calls_this_month: number; monthly_call_limit: number };
  automacoes_ativas: number; cadencias_ativas: number; buscas_automaticas: number; disparos_enviando: number;
};
type Level = "ok" | "warn" | "bad" | "off";

const jobNames: Record<string, string> = {
  automacoes_crm: "Automações do CRM (negociação parada, tarefas, RFV)",
  avisos: "Avisos automáticos (Meta, Google, WhatsApp)",
  meta_gastos: "Gastos das campanhas da Meta",
};

function Row({ level, title, detail }: { level: Level; title: string; detail: string }) {
  const icon = level === "ok" ? <CheckCircle2 size={18} className="tone-green" /> : level === "warn" ? <AlertTriangle size={18} style={{ color: "#b45309" }} />
    : level === "bad" ? <XCircle size={18} className="tone-red" /> : <Clock size={18} className="crm-muted" />;
  return <div className={`health-row lv-${level}`}>{icon}<div><b>{title}</b><span>{detail}</span></div></div>;
}

export function HealthView() {
  const { tenantId, notify } = useCrm();
  const [h, setH] = useState<Health | null>(null);
  const load = useCallback(async () => {
    try { const r = await db().rpc("cro_health", { p_tenant_id: tenantId }); if (r.error) throw r.error; setH(r.data as Health); }
    catch (e) { notify(errorText(e)); }
  }, [tenantId, notify]);
  useEffect(() => { void load(); }, [load]);
  if (!h) return <Skeleton rows={6} />;

  const ago = (v: string | null) => (v ? Date.now() - new Date(v).getTime() : Infinity);
  const motorOk = ago(h.motor_visto_em) < 5 * 60_000;
  const days = h.meta?.vence_em ? Math.ceil((new Date(h.meta.vence_em).getTime() - Date.now()) / 86400000) : null;

  return (
    <div className="health">
      <div className="crm-toolbar"><div className="crm-toolbar-left"><p className="crm-muted small" style={{ margin: 0 }}>Tudo o que roda sozinho no CRO e as conexões desta empresa.</p></div>
        <button type="button" className="crm-btn ghost sm" onClick={() => void load()}><RefreshCw size={14} /> Atualizar</button></div>

      <h4 className="wa-sub">Motor e rotinas automáticas</h4>
      <Row level={motorOk ? "ok" : "bad"} title="Motor do CRO (VPS)"
        detail={motorOk ? `Ativo — último sinal ${relative(h.motor_visto_em)}` : h.motor_visto_em ? `Sem sinal desde ${dateTime(h.motor_visto_em)} — verifique o container idx-wa-gateway` : "Nunca conectou"} />
      {Object.keys(jobNames).map((k) => {
        const j = h.rotinas[k];
        const lv: Level = !j ? "off" : !j.ok ? "bad" : ago(j.quando) > 2 * 3600_000 ? "warn" : "ok";
        return <Row key={k} level={lv} title={jobNames[k]} detail={!j ? "Ainda não rodou (roda de hora em hora)" : j.ok ? `Rodou ${relative(j.quando)}` : `Falhou ${relative(j.quando)}: ${j.erro}`} />;
      })}

      <h4 className="wa-sub">Conexões desta empresa</h4>
      <Row level={!h.whatsapp ? "off" : h.whatsapp.status === "connected" ? "ok" : h.whatsapp.status === "banned" ? "bad" : "warn"} title="WhatsApp do CRO"
        detail={!h.whatsapp ? "Não conectado (Disparos → Conectar)" : h.whatsapp.status === "connected" ? `Conectado · ${phoneLabel(h.whatsapp.numero)}` : `Status: ${h.whatsapp.status} desde ${relative(h.whatsapp.desde)} — leia o QR em Disparos`} />
      <Row level={!h.meta ? "off" : h.meta.status === "needs_attention" || (days !== null && days < 0) ? "bad" : days !== null && days <= 14 ? "warn" : "ok"} title="Meta (Facebook/Instagram)"
        detail={!h.meta ? "Não conectada" : `${h.meta.conta ?? "Conta não escolhida"} · ${h.meta.status === "needs_attention" ? "precisa de atenção" : "conectada"}${days !== null ? ` · acesso ${days < 0 ? "VENCIDO" : `vence em ${days} dia(s)`}` : ""}${h.meta.verificado_em ? ` · sincronizou ${relative(h.meta.verificado_em)}` : ""}`} />
      <Row level={!h.google ? "off" : h.google.erro ? "bad" : "ok"} title="Google Ads"
        detail={!h.google ? "Não conectado" : `${h.google.conta ?? "Conta não escolhida"}${h.google.sincronizado_em ? ` · sincronizou ${relative(h.google.sincronizado_em)}` : ""}${h.google.erro ? " · com erro" : ""}`} />
      <Row level={h.google_maps.has_key ? (h.google_maps.calls_this_month >= h.google_maps.monthly_call_limit ? "warn" : "ok") : "off"} title="Google Maps (busca de clientes)"
        detail={h.google_maps.has_key ? `${h.google_maps.calls_this_month} de ${h.google_maps.monthly_call_limit} buscas no mês` : "Sem chave (Disparos → Buscar clientes → Configurar)"} />

      <h4 className="wa-sub">Processos ligados</h4>
      <div className="health-counts">
        <div><b>{h.automacoes_ativas}</b><span>automações ativas</span></div>
        <div><b>{h.cadencias_ativas}</b><span>cadências ativas</span></div>
        <div><b>{h.buscas_automaticas}</b><span>buscas automáticas</span></div>
        <div><b>{h.disparos_enviando}</b><span>disparos enviando</span></div>
      </div>
    </div>
  );
}
