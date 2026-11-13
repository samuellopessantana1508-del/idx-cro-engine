// Automações da Douratto Buffet recriadas a partir dos salesbots do Kommo (conta dourattobuffet):
//   • "Douratto - Escolas - Fim de Ano 2026" (bot 11742) — resposta à sondagem (modelo douratto_escolas_sondagem_2026)
//   • "FIM DE ANO - ESCOLAS" (bot 11734)                 — qualificação após "Quero ver" (modelo douratto_escola_proposta)
// Mesmos textos, botões, campos (Nº de pessoas, Data pretendida), etapas, tarefas, SAIR e 24 h sem resposta.

export const PDF_NAME = "Douratto Buffet · Confraternização de Fim de Ano para Empresas.pdf";

export const STAGES = [
  // funil "Confraternização Fim de Ano 2026" do Kommo
  { key: "entrada", name: "Etapa de leads de entrada" },
  { key: "lista_fria", name: "lista fria" },
  { key: "contato", name: "Contato feito" },
  { key: "apresentacao", name: "Apresentação enviada" },
  { key: "qualificado", name: "Qualificado" },
  { key: "proposta", name: "Proposta enviada" },
  { key: "negociacao", name: "Negociação" },
  { key: "retomar", name: "Retomar em 2027" },
];

const N = (id, type, config, x, y, label) => ({ id, type, position: { x, y }, data: { config, ...(label ? { label } : {}) } });
const E = (source, target, sourceHandle = null) => ({ id: `${source}-${target}-${sourceHandle ?? "n"}`, source, target, sourceHandle });
const has = (...words) => ({ match: "any", rules: words.map((w) => ({ field: "last_message", op: "contains", value: w })) });

/** Resposta ao disparo de sondagem: "Já planejamos" / "Ainda avaliando" / "Não vamos realizar". */
export function sondagemGraph({ campaignId = null, pdfUrl = "", stages = {} }) {
  const nodes = [
    N("t", "trigger", { kind: "campaign", campaign_id: campaignId }, 0, 200, "Respondeu a sondagem"),
    N("c_plan", "condition", has("planejamos", "planejando"), 300, 60, "Já planejamos?"),
    N("c_aval", "condition", has("avaliando", "avaliar"), 300, 260, "Ainda avaliando?"),
    N("c_nao", "condition", has("não vamos", "nao vamos", "não vamos realiza"), 300, 460, "Não vamos realizar?"),
    N("deal_contato", "crm_deal", { action: "upsert", stage_id: stages.contato ?? null, title: "Fim de ano — {nome}" }, 600, 160, "Contato feito"),
    N("m_plan", "send_menu", {
      text: "Que ótimo! 🎉\n\nA Douratto Buffet tem opções para confraternizações escolares.\n\nPosso te enviar nossa apresentação para conhecer melhor os serviços?",
      options: "Quero receber\nAgora não", buttons: true, timeout: 24, timeoutUnit: "hours", footer: "",
    }, 900, 40, "Oferecer apresentação"),
    N("m_aval", "send_menu", {
      text: "Sem problemas! 😊\n\nVocês podem conhecer as opções da Douratto antes de decidir.\n\nGostaria de receber nossa apresentação para avaliar com tranquilidade?",
      options: "Quero conhecer\nAgora não", buttons: true, timeout: 24, timeoutUnit: "hours", footer: "",
    }, 900, 300, "Oferecer apresentação"),
    N("pdf_plan", "send_media", { mediaType: "document", url: pdfUrl, fileName: PDF_NAME, caption: "Perfeito! 🎉 Segue a apresentação da Douratto Buffet para sua escola." }, 1250, 0, "Apresentação (PDF)"),
    N("pdf_aval", "send_media", { mediaType: "document", url: pdfUrl, fileName: PDF_NAME, caption: "Segue nossa apresentação! 😊" }, 1250, 280, "Apresentação (PDF)"),
    N("deal_apres", "crm_deal", { action: "upsert", stage_id: stages.apresentacao ?? null, title: "Fim de ano — {nome}" }, 1550, 140, "Apresentação enviada"),
    N("bye", "send_text", { text: "Entendido! 😊\n\nAgradecemos pelo retorno. A Douratto fica à disposição para futuros eventos.\n\nUm excelente fim de ano para vocês!" }, 600, 480, "Agradecer"),
    N("aviso", "notify", { message: "{nome} respondeu a sondagem de fim de ano: “{resposta}”. Responder na caixa de entrada." }, 600, 640, "Avisar a equipe"),
    N("fim", "end", {}, 1850, 300, "Fim"),
  ];
  const edges = [
    E("t", "c_plan"),
    E("c_plan", "deal_contato", "yes"), E("c_plan", "c_aval", "no"),
    E("deal_contato", "m_plan"),
    E("c_aval", "m_aval", "yes"), E("c_aval", "c_nao", "no"),
    E("c_nao", "bye", "yes"), E("c_nao", "aviso", "no"),
    E("m_plan", "pdf_plan", "opt0"), E("m_plan", "fim", "opt1"), E("m_plan", "aviso", "other"), E("m_plan", "fim", "timeout"),
    E("m_aval", "pdf_aval", "opt0"), E("m_aval", "fim", "opt1"), E("m_aval", "aviso", "other"), E("m_aval", "fim", "timeout"),
    E("pdf_plan", "deal_apres"), E("pdf_aval", "deal_apres"), E("deal_apres", "fim"),
    E("bye", "fim"), E("aviso", "fim"),
  ];
  return { nodes, edges };
}

/** Qualificação depois do "Quero ver" (modelo douratto_escola_proposta). */
export function qualificacaoGraph({ campaignId = null, pdfUrl = "", stages = {} }) {
  const sair = has("sair", "parar");
  const nodes = [
    N("t", "trigger", { kind: "campaign", campaign_id: campaignId }, 0, 300, "Respondeu a proposta"),
    N("c_ver", "condition", has("quero ver"), 280, 300, "Quero ver?"),
    N("c_agora", "condition", has("agora não", "agora nao"), 280, 520, "Agora não?"),
    N("msg_pdf", "send_text", { text: "Perfeito! 🎉\n\nSegue a apresentação da Douratto Buffet para a confraternização de fim de ano da sua escola.\n\nDê uma olhadinha nas opções e me avise quando estiver pronto para conversarmos sobre o evento!" }, 560, 120, "Enviar apresentação"),
    N("pdf", "send_media", { mediaType: "document", url: pdfUrl, fileName: PDF_NAME, caption: "" }, 840, 120, "Apresentação (PDF)"),
    N("deal_apres", "crm_deal", { action: "upsert", stage_id: stages.apresentacao ?? null, title: "Fim de ano — {nome}" }, 1120, 120, "Apresentação enviada"),
    N("ask_pessoas", "ask", { text: "Para prepararmos uma proposta personalizada para a sua escola, me conta uma coisa:\n\nQuantas pessoas participarão da confraternização? 🎉\n\nPode responder só com o número, por exemplo: 80", saveAs: "pessoas", saveTo: "", timeout: 24, timeoutUnit: "hours" }, 1400, 120, "Nº de pessoas"),
    N("c_sair1", "condition", sair, 1680, 120, "Pediu para parar?"),
    N("f_pessoas", "set_field", { field: "numero_pessoas", value: "{resposta}" }, 1960, 40, "Salvar Nº de pessoas"),
    N("ask_data", "ask", { text: "Ótimo! 😊\n\nE qual data vocês estão pensando para realizar a confraternização?\n\nPode me informar o dia, mês e ano.", saveAs: "data", saveTo: "", timeout: 24, timeoutUnit: "hours" }, 2240, 40, "Data pretendida"),
    N("c_sair2", "condition", sair, 2520, 40, "Pediu para parar?"),
    N("f_data", "set_field", { field: "data_pretendida", value: "{resposta}" }, 2800, 0, "Salvar data"),
    N("deal_qual", "crm_deal", { action: "upsert", stage_id: stages.qualificado ?? null, title: "Fim de ano — {nome}" }, 3080, 0, "Qualificado"),
    N("task_prop", "task", { title: "Montar proposta para {nome}", description: "Montar proposta com base nas informações coletadas (Nº de pessoas e Data pretendida). Se o Nº de pessoas estiver vazio, conferir a resposta na conversa.", taskType: "proposal", dueInHours: 4 }, 3360, 0, "Tarefa: montar proposta"),
    N("task_sem", "task", { title: "Escola não respondeu: {nome}", description: "Escola não respondeu à qualificação em 24h. Avaliar contato manual, sem insistência automática. Não marcar como Qualificado.", taskType: "follow_up", dueInHours: 2 }, 1960, 420, "Tarefa: sem resposta"),
    N("tag_optout", "tag", { action: "add", tag: "opt-out marketing" }, 1960, 260, "Assinatura de marketing: Opt-out"),
    N("msg_optout", "send_text", { text: "Combinado! Registramos o seu pedido e não enviaremos mais mensagens promocionais. Se precisar de algo, é só chamar por aqui." }, 2240, 260, "Confirmar"),
    N("task_optout", "task", { title: "Opt-out: {nome}", description: "Escola pediu para parar mensagens promocionais. Opt-out registrado no contato (Assinatura de marketing). Não incluir em novas campanhas.", taskType: "follow_up", dueInHours: 24 }, 2520, 260, "Tarefa: opt-out"),
    N("optout", "optout", {}, 2800, 260, "Descadastrar (SAIR)"),
    N("aviso", "notify", { message: "{nome} respondeu a proposta de fim de ano: “{resposta}”. Responder na caixa de entrada." }, 560, 600, "Avisar a equipe"),
    N("fim", "end", {}, 3640, 300, "Fim"),
  ];
  const edges = [
    E("t", "c_ver"),
    E("c_ver", "msg_pdf", "yes"), E("c_ver", "c_agora", "no"),
    E("c_agora", "fim", "yes"), E("c_agora", "aviso", "no"),
    E("msg_pdf", "pdf"), E("pdf", "deal_apres"), E("deal_apres", "ask_pessoas"),
    E("ask_pessoas", "c_sair1", "answered"), E("ask_pessoas", "task_sem", "timeout"),
    E("c_sair1", "tag_optout", "yes"), E("c_sair1", "f_pessoas", "no"),
    E("f_pessoas", "ask_data"),
    E("ask_data", "c_sair2", "answered"), E("ask_data", "task_sem", "timeout"),
    E("c_sair2", "tag_optout", "yes"), E("c_sair2", "f_data", "no"),
    E("f_data", "deal_qual"), E("deal_qual", "task_prop"), E("task_prop", "fim"),
    E("task_sem", "fim"),
    E("tag_optout", "msg_optout"), E("msg_optout", "task_optout"), E("task_optout", "optout"),
    E("aviso", "fim"),
  ];
  return { nodes, edges };
}
