// IDX CRM — painel ao lado da conversa no WhatsApp Web.
// Lê só o nome/telefone do cabeçalho da conversa aberta para achar o cliente
// no CRM. Não lê o conteúdo das mensagens e NUNCA envia mensagens.
(() => {
  if (window.__idxCrmLoaded) return;
  window.__idxCrmLoaded = true;
  const CFG = globalThis.IDX_CONFIG;
  const W = 360;

  // ---------------- utilitários ----------------
  const send = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (r) => resolve(r ?? { ok: false, data: { error: chrome.runtime.lastError?.message ?? "Sem resposta" } })); }
    catch (e) { resolve({ ok: false, data: { error: "Extensão atualizada — recarregue a página do WhatsApp" } }); }
  });
  const api = (path, method = "GET", body, headers) => send({ type: "api", path, method, body, headers });
  const rpc = (fn, args) => api(`/rest/v1/rpc/${fn}`, "POST", args);
  const errMsg = (r) => r?.data?.error || r?.data?.message || r?.data?.msg || `Falha (${r?.status ?? "?"})`;
  const enc = encodeURIComponent;
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };
  const digits = (s) => String(s ?? "").replace(/\D/g, "");
  const phoneLabel = (p) => {
    const d = digits(p);
    if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
      const rest = d.slice(4);
      return `(${d.slice(2, 4)}) ${rest.length === 9 ? `${rest.slice(0, 5)}-${rest.slice(5)}` : `${rest.slice(0, 4)}-${rest.slice(4)}`}`;
    }
    return d ? `+${d}` : "";
  };
  const lifecycle = { lead: "Lead", mql: "Lead qualificado (MKT)", sal: "Aceito por vendas", sql: "Lead qualificado", opportunity: "Oportunidade", customer: "Cliente", inactive: "Inativo" };
  const brl = (v) => Number(v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  const when = (iso) => iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  const at9 = (days) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0); return d.toISOString(); };

  // ---------------- conversa aberta ----------------
  function currentChat() {
    const header = document.querySelector("#main header") || document.querySelector("[data-testid='conversation-header']");
    if (!header) return null;
    const titled = header.querySelector("span[title]") || header.querySelector("[dir='auto']");
    const name = (titled?.getAttribute("title") || titled?.textContent || "").trim();
    if (!name) return null;
    const d = digits(name);
    const isPhone = d.length >= 10 && d.length <= 13 && /^[+\d\s()-]+$/.test(name);
    return { key: name, name: isPhone ? null : name, phone: isPhone ? (d.length <= 11 ? `55${d}` : d) : null };
  }

  // ---------------- painel ----------------
  const host = h("div", { id: "idx-crm-host" });
  const root = host.attachShadow({ mode: "open" });
  root.append(h("style", {}, `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .tab { position: fixed; top: 50%; right: 0; transform: translateY(-50%); z-index: 2147483000; background: #111; color: #fff; border: 0; border-radius: 10px 0 0 10px; padding: 12px 8px; font-weight: 800; font-size: 12px; cursor: pointer; writing-mode: vertical-rl; letter-spacing: .08em; box-shadow: -2px 2px 10px rgba(0,0,0,.2); }
    .tab.open { right: ${W}px; }
    .panel { position: fixed; top: 0; right: 0; width: ${W}px; height: 100vh; z-index: 2147483000; background: #fff; color: #111; border-left: 1px solid #e5e7eb; display: none; flex-direction: column; font-size: 13px; }
    .panel.open { display: flex; }
    header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #eee; }
    header b { font-size: 14px; } header .sp { flex: 1; }
    .body { flex: 1; overflow: auto; padding: 12px 14px; display: grid; gap: 12px; align-content: start; }
    .muted { color: #6b7280; } .small { font-size: 12px; }
    .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 10px 12px; display: grid; gap: 6px; }
    .card h3 { margin: 0; font-size: 15px; } .card h4 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
    input, select, textarea { width: 100%; border: 1px solid #d1d5db; border-radius: 8px; padding: 7px 9px; font-size: 13px; background: #fff; color: #111; }
    textarea { resize: vertical; min-height: 54px; }
    button { border: 1px solid #d1d5db; background: #fff; color: #111; border-radius: 8px; padding: 7px 10px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
    button.primary { background: #111; border-color: #111; color: #fff; }
    button:disabled { opacity: .5; cursor: default; }
    button.link { border: 0; padding: 0; background: none; color: #2563eb; font-weight: 600; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .pill { display: inline-block; border-radius: 99px; padding: 1px 8px; background: #f3f4f6; font-size: 11.5px; font-weight: 600; }
    .pill.green { background: #dcfce7; color: #166534; } .pill.blue { background: #dbeafe; color: #1e3a8a; }
    .task { display: flex; gap: 8px; align-items: flex-start; } .task input { width: auto; margin-top: 2px; }
    .err { color: #b91c1c; } .ok { color: #166534; }
    .tl { border-left: 2px solid #e5e7eb; padding-left: 8px; }
    a { color: #2563eb; }
  `));
  const tab = h("button", { class: "tab", title: "IDX CRM" }, "IDX CRM");
  const panel = h("div", { class: "panel" });
  root.append(tab, panel);
  document.documentElement.append(host);
  const shrink = h("style", {}, `#app { width: calc(100% - ${W}px) !important; }`);

  let open = localStorage.getItem("idx-crm-open") !== "0";
  function setOpen(v) {
    open = v; localStorage.setItem("idx-crm-open", v ? "1" : "0");
    panel.classList.toggle("open", v); tab.classList.toggle("open", v);
    if (v) document.head.append(shrink); else shrink.remove();
    if (v) render(true);
  }
  tab.addEventListener("click", () => setOpen(!open));

  const state = { session: null, tenant: null, tenants: [], chat: null, contact: null, candidates: null, stages: [], cadences: null, busy: false, msg: null };
  const body = h("div", { class: "body" });
  const head = h("header", {}, h("b", {}, "IDX CRM"), h("span", { class: "sp" }));
  panel.append(head, body);

  function flash(text, kind = "ok") { state.msg = { text, kind }; draw(); setTimeout(() => { if (state.msg?.text === text) { state.msg = null; draw(); } }, 4000); }

  async function boot() {
    const s = await send({ type: "session" });
    state.session = s?.email ? s : null;
    state.tenant = s?.tenant ?? null;
    if (state.session && !state.tenants.length) {
      const r = await api("/rest/v1/tenants?select=id,name&order=name");
      state.tenants = r.ok ? r.data : [];
      if (state.tenant && !state.tenants.some((t) => t.id === state.tenant.id)) state.tenant = null;
      if (!state.tenant && state.tenants.length === 1) { state.tenant = state.tenants[0]; await send({ type: "setTenant", tenant: state.tenant }); }
    }
  }

  async function loadContext() {
    if (!state.tenant) return;
    const [st, cad] = await Promise.all([
      api(`/rest/v1/crm_stages?select=id,name,kind,pipeline_id,position&tenant_id=eq.${state.tenant.id}&archived_at=is.null&order=position`),
      rpc("crm_cadence_overview", { p_tenant_id: state.tenant.id }),
    ]);
    state.stages = st.ok ? st.data : [];
    state.cadences = cad.ok ? cad.data.filter((c) => c.active) : [];
  }

  async function lookup() {
    state.contact = null; state.candidates = null;
    const c = state.chat;
    if (!c || !state.tenant) return;
    if (c.phone) {
      const r = await rpc("crm_lookup_phone", { p_tenant_id: state.tenant.id, p_phone: c.phone });
      if (r.ok && r.data) state.contact = r.data;
      return;
    }
    const term = c.name.replace(/[%*,()]/g, " ").trim();
    if (term.length < 2) return;
    const r = await api(`/rest/v1/crm_contacts?select=id,name,phone&tenant_id=eq.${state.tenant.id}&merged_into_id=is.null&archived_at=is.null&name=ilike.*${enc(term)}*&limit=6`);
    const list = r.ok ? r.data : [];
    if (list.length === 1 && list[0].phone) await openCandidate(list[0]);
    else state.candidates = list;
  }
  async function openCandidate(c) {
    if (!c.phone) { state.candidates = null; state.contact = { id: c.id, name: c.name, phone: null, deals: [], tasks: [], timeline: [], cadences: [] }; return; }
    const r = await rpc("crm_lookup_phone", { p_tenant_id: state.tenant.id, p_phone: c.phone });
    state.contact = r.ok ? r.data : null; state.candidates = null;
  }

  let lastKey = null;
  async function render(force = false) {
    if (!open) return;
    const chat = currentChat();
    if (!force && chat?.key === lastKey) return;
    lastKey = chat?.key ?? null;
    state.chat = chat;
    await boot();
    if (state.session && state.tenant) {
      if (!state.stages.length || state.cadences === null) await loadContext();
      await lookup();
    }
    draw();
  }

  // ---------------- telas ----------------
  function draw() {
    body.replaceChildren();
    head.replaceChildren(h("b", {}, "IDX CRM"), h("span", { class: "sp" }),
      state.session ? h("button", { class: "link small", onclick: async () => { await send({ type: "logout" }); state.session = null; state.tenants = []; state.tenant = null; draw(); } }, "Sair") : null,
      h("button", { class: "link", title: "Fechar", onclick: () => setOpen(false) }, "✕"));
    if (state.msg) body.append(h("div", { class: `small ${state.msg.kind === "err" ? "err" : "ok"}` }, state.msg.text));
    if (!state.session) return body.append(loginView());
    if (state.tenants.length > 1 || !state.tenant) body.append(tenantPicker());
    if (!state.tenant) return;
    if (!state.chat) return body.append(h("p", { class: "muted" }, "Abra uma conversa para ver o cliente no CRM."));
    body.append(h("div", { class: "small muted" }, "Conversa: ", h("b", {}, state.chat.name ?? phoneLabel(state.chat.phone))));
    if (state.contact) body.append(...contactView(state.contact));
    else if (state.candidates?.length) body.append(candidatesView());
    else body.append(createView());
  }

  function loginView() {
    const email = h("input", { type: "email", placeholder: "E-mail do CRO Engine", autocomplete: "username" });
    const pass = h("input", { type: "password", placeholder: "Senha", autocomplete: "current-password" });
    const btn = h("button", { class: "primary", type: "submit" }, "Entrar");
    const form = h("form", { class: "card", onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true;
      const r = await send({ type: "login", email: email.value.trim(), password: pass.value });
      btn.disabled = false;
      if (!r.ok) return flash(errMsg(r), "err");
      state.tenants = []; await render(true);
    } }, h("h3", {}, "Entrar no CRM"), h("p", { class: "small muted" }, "Use o mesmo login do painel. Você só vê os clientes das empresas a que tem acesso."), email, pass, btn);
    return form;
  }

  function tenantPicker() {
    const sel = h("select", { onchange: async () => {
      state.tenant = state.tenants.find((t) => t.id === sel.value) ?? null;
      await send({ type: "setTenant", tenant: state.tenant });
      state.stages = []; state.cadences = null; await render(true);
    } }, h("option", { value: "" }, "Escolha a empresa…"), ...state.tenants.map((t) => h("option", { value: t.id, selected: state.tenant?.id === t.id }, t.name)));
    return sel;
  }

  function candidatesView() {
    return h("div", { class: "card" }, h("h4", {}, "Contatos com esse nome"),
      ...state.candidates.map((c) => h("button", { onclick: async () => { await openCandidate(c); draw(); } }, `${c.name ?? "Sem nome"} ${c.phone ? `· ${phoneLabel(c.phone)}` : ""}`)),
      h("button", { class: "link small", onclick: () => { state.candidates = []; draw(); } }, "Nenhum destes — cadastrar novo"));
  }

  function createView() {
    const name = h("input", { placeholder: "Nome", value: state.chat.name ?? "" });
    const phone = h("input", { placeholder: "Telefone com DDD", value: state.chat.phone ? phoneLabel(state.chat.phone) : "", inputmode: "tel" });
    const company = h("input", { placeholder: "Empresa (opcional)" });
    const note = h("textarea", { placeholder: "Observação (opcional)" });
    const btn = h("button", { class: "primary" }, "Cadastrar no CRM");
    btn.addEventListener("click", async () => {
      if (!name.value.trim() && !digits(phone.value)) return flash("Informe nome ou telefone", "err");
      btn.disabled = true;
      const r = await rpc("crm_assistant_apply", { p_tenant_id: state.tenant.id, p_plan: {
        source: "text", transcript: "", contact: { name: name.value.trim() || null, phone: digits(phone.value) || null, company: company.value.trim() || null },
        deal: { action: "none" }, task: null, note: note.value.trim() || null } });
      btn.disabled = false;
      if (!r.ok) return flash(errMsg(r), "err");
      if (digits(phone.value)) state.chat = { ...state.chat, phone: digits(phone.value).length <= 11 ? `55${digits(phone.value)}` : digits(phone.value) };
      await openCandidate({ id: r.data.contact_id, name: name.value, phone: digits(phone.value) ? state.chat.phone : null });
      flash("Cliente cadastrado ✓"); draw();
    });
    return h("div", { class: "card" }, h("h3", {}, "Cliente não encontrado"),
      h("p", { class: "small muted" }, state.chat.phone ? "Nenhum contato com este telefone." : "O WhatsApp mostra só o nome salvo. Informe o telefone para achar ou cadastrar."),
      name, phone, company, note, btn,
      !state.chat.phone ? h("button", { class: "link small", onclick: async () => {
        const d = digits(phone.value); if (d.length < 10) return flash("Digite o telefone com DDD", "err");
        state.chat = { ...state.chat, phone: d.length <= 11 ? `55${d}` : d }; await lookup(); draw();
      } }, "Só buscar por este telefone") : null);
  }

  function contactView(c) {
    const out = [];
    const crmUrl = `${CFG.APP_URL}/?section=crm-app&crm=contact&contact=${c.id}`;
    out.push(h("div", { class: "card" },
      h("h3", {}, c.name ?? "Sem nome"),
      h("div", { class: "small muted" }, [phoneLabel(c.phone), c.company?.name, [c.city, c.state].filter(Boolean).join("/")].filter(Boolean).join(" · ")),
      h("div", { class: "row" }, h("span", { class: c.lifecycle_stage === "customer" ? "pill green" : "pill" }, lifecycle[c.lifecycle_stage] ?? "Lead"), ...(c.tags ?? []).slice(0, 4).map((t) => h("span", { class: "pill" }, t)),
        ...(c.cadences ?? []).map((x) => h("span", { class: "pill blue", title: "Cadência ativa — para sozinha quando o cliente responde" }, `↻ ${x.name}`))),
      h("a", { href: crmUrl, target: "_blank", rel: "noreferrer", class: "small" }, "Abrir no CRM ↗")));

    // negociações
    const openStages = state.stages.filter((s) => s.kind === "open");
    const deals = (c.deals ?? []).filter((d) => d.status === "open");
    out.push(h("div", { class: "card" }, h("h4", {}, "Negociação"),
      deals.length ? deals.map((d) => {
        const sel = h("select", { onchange: async () => {
          const r = await api(`/rest/v1/crm_deals?id=eq.${d.id}`, "PATCH", { stage_id: sel.value }, { Prefer: "return=minimal" });
          if (!r.ok) return flash(errMsg(r), "err");
          flash("Etapa atualizada ✓"); await lookup(); draw();
        } }, ...openStages.filter((s) => s.pipeline_id === d.pipeline_id).map((s) => h("option", { value: s.id, selected: s.id === d.stage_id }, s.name)));
        return h("div", {}, h("div", { class: "row" }, h("b", {}, d.title), h("span", { class: "muted small" }, brl(d.value))), sel);
      }) : h("p", { class: "small muted" }, "Nenhuma negociação aberta."),
      h("p", { class: "small muted" }, "Venda ganha/perdida: marque pelo CRM.")));

    // tarefas
    const taskBox = h("div", { class: "card" }, h("h4", {}, "Próximas tarefas"));
    for (const t of c.tasks ?? []) {
      const cb = h("input", { type: "checkbox", title: "Concluir", onchange: async () => {
        const r = await api(`/rest/v1/crm_tasks?id=eq.${t.id}`, "PATCH", { status: "done", completed_at: new Date().toISOString() }, { Prefer: "return=minimal" });
        if (!r.ok) { cb.checked = false; return flash(errMsg(r), "err"); }
        flash("Tarefa concluída ✓"); await lookup(); draw();
      } });
      taskBox.append(h("label", { class: "task" }, cb, h("span", {}, t.title, h("br"), h("span", { class: "small muted" }, when(t.due_at)))));
    }
    if (!(c.tasks ?? []).length) taskBox.append(h("p", { class: "small muted" }, "Nada agendado."));
    const quick = (label, days) => h("button", { onclick: async () => {
      const r = await api("/rest/v1/crm_tasks", "POST", { tenant_id: state.tenant.id, task_type: "follow_up", title: `Retomar contato: ${c.name ?? phoneLabel(c.phone)}`,
        contact_id: c.id, deal_id: deals[0]?.id ?? null, owner_id: state.session.user_id, due_at: at9(days) }, { Prefer: "return=minimal" });
      if (!r.ok) return flash(errMsg(r), "err");
      flash(`Retorno agendado (${label}) ✓`); await lookup(); draw();
    } }, label);
    taskBox.append(h("div", { class: "row" }, h("span", { class: "small muted" }, "Retomar:"), quick("amanhã 9h", 1), quick("em 3 dias", 3), quick("em 7 dias", 7)));
    out.push(taskBox);

    // registro com IA / anotação
    const text = h("textarea", { placeholder: "Ex.: quer proposta de 1.500, retornar sexta às 10h, achou caro" });
    const result = h("div", { class: "small" });
    const aiBtn = h("button", { class: "primary" }, "Registrar com IA");
    const noteBtn = h("button", {}, "Só anotar");
    noteBtn.addEventListener("click", async () => {
      if (!text.value.trim()) return;
      const r = await api("/rest/v1/crm_timeline", "POST", { tenant_id: state.tenant.id, contact_id: c.id, kind: "note", title: "Anotação (WhatsApp Web)", body: text.value.trim(), metadata: { via: "extension" }, actor_id: state.session.user_id }, { Prefer: "return=minimal" });
      if (!r.ok) return flash(errMsg(r), "err");
      text.value = ""; flash("Anotação salva ✓"); await lookup(); draw();
    });
    aiBtn.addEventListener("click", async () => {
      if (!text.value.trim()) return;
      aiBtn.disabled = true; result.textContent = "Entendendo…";
      const r = await api("/functions/v1/crm-assistant", "POST", { tenant_id: state.tenant.id, text: text.value.trim(), source: "text", context: { contact_id: c.id } });
      aiBtn.disabled = false;
      if (!r.ok) { result.textContent = ""; return flash(errMsg(r), "err"); }
      const p = r.data.plan;
      const lines = [
        p.deal?.action === "create" ? `• Negociação${p.deal.value ? ` de ${brl(p.deal.value)}` : ""}${deals.length ? " (atualiza a aberta)" : ""}` : null,
        p.task ? `• ${p.task.title} — ${p.task.due_at ? when(p.task.due_at) : "sem data"}` : null,
        p.objection ? `• Objeção: ${p.objection}` : null,
        p.note ? `• Anotação: ${p.note}` : null,
      ].filter(Boolean);
      const ok = h("button", { class: "primary", onclick: async () => {
        ok.disabled = true;
        const a = await rpc("crm_assistant_apply", { p_tenant_id: state.tenant.id, p_plan: { ...p, contact_id: c.id } });
        if (!a.ok) { ok.disabled = false; return flash(errMsg(a), "err"); }
        text.value = ""; result.replaceChildren(); flash("Registrado no CRM ✓"); await lookup(); draw();
      } }, "Confirmar e salvar");
      result.replaceChildren(h("div", { class: "card" }, h("b", {}, r.data.engine === "ai" ? "A IA entendeu:" : "Entendido (sem IA):"),
        ...lines.map((l) => h("div", {}, l)), h("div", { class: "row" }, ok, h("button", { onclick: () => result.replaceChildren() }, "Cancelar"))));
    });
    out.push(h("div", { class: "card" }, h("h4", {}, "Registrar"), text, h("div", { class: "row" }, aiBtn, noteBtn), result));

    // cadência
    if (state.cadences?.length) {
      const sel = h("select", {}, ...state.cadences.map((x) => h("option", { value: x.id }, x.name)));
      out.push(h("div", { class: "card" }, h("h4", {}, "Cadência"), sel, h("button", { onclick: async () => {
        const r = await rpc("crm_cadence_enroll", { p_cadence_id: sel.value, p_contact_ids: [c.id] });
        if (!r.ok) return flash(errMsg(r), "err");
        flash(r.data.enrolled ? "Colocado na cadência ✓" : "Já está nesta cadência"); await lookup(); draw();
      } }, "Colocar nesta cadência")));
    }

    // histórico
    if ((c.timeline ?? []).length) {
      out.push(h("div", { class: "card" }, h("h4", {}, "Últimos registros"),
        ...c.timeline.map((t) => h("div", { class: "tl" }, h("b", { class: "small" }, t.title), h("div", { class: "small muted" }, when(t.occurred_at)), t.body ? h("div", { class: "small" }, t.body) : null))));
    }
    return out;
  }

  // observa troca de conversa
  setInterval(() => { if (open) render(false); }, 1200);
  setOpen(open);
})();
