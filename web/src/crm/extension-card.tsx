import { useState } from "react";
import { Download, MessageCircle, X } from "lucide-react";

const ZIP = "/extensao/idx-crm-whatsapp.zip";

/** Download + passo a passo da extensão "IDX CRM no WhatsApp Web". */
export function ExtensionCard({ dismissible }: { dismissible?: boolean }) {
  const [hidden, setHidden] = useState(() => { try { return dismissible && localStorage.getItem("crm.ext.card") === "0"; } catch { return false; } });
  const [steps, setSteps] = useState(!dismissible);
  if (hidden) return null;
  return (
    <section className="crm-panel crm-ext-card">
      <header>
        <h3><MessageCircle size={16} /> CRM dentro do WhatsApp Web</h3>
        {dismissible && <button type="button" className="crm-icon-btn xs" aria-label="Ocultar" onClick={() => { setHidden(true); try { localStorage.setItem("crm.ext.card", "0"); } catch { /* sem storage */ } }}><X size={13} /></button>}
      </header>
      <p className="crm-muted small">Ao abrir uma conversa no WhatsApp Web (computador), aparece ao lado o cliente do CRM: negociação, tarefas, histórico e o botão “Registrar com IA”. A extensão não lê nem envia mensagens — usa o mesmo login do painel.</p>
      <div className="crm-row gap wrap">
        <a className="crm-btn primary sm" href={ZIP} download><Download size={15} /> Baixar extensão (Chrome/Edge)</a>
        {dismissible && <button type="button" className="crm-btn ghost sm" onClick={() => setSteps((s) => !s)}>{steps ? "Ocultar instruções" : "Como instalar"}</button>}
      </div>
      {steps && (
        <ol className="crm-ext-steps">
          <li>Baixe o arquivo e <b>descompacte</b> (clique com o botão direito → Extrair tudo).</li>
          <li>No Chrome, abra <code>chrome://extensions</code> (no Edge: <code>edge://extensions</code>) e ligue o <b>Modo do desenvolvedor</b>.</li>
          <li>Clique em <b>Carregar sem compactação</b> e escolha a pasta <code>idx-crm-whatsapp</code>.</li>
          <li>Abra <code>web.whatsapp.com</code>, clique na aba preta <b>IDX CRM</b> à direita e entre com seu e-mail e senha do CRO Engine.</li>
        </ol>
      )}
    </section>
  );
}
