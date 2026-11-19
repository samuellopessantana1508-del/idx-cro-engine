// Prospecção de farmácias da IDX pelo WhatsApp (QR Code / Evolution).
// Ordem: 1) confirmar que é o dono ou a dona; 2) duas perguntas (Google e recompra); 3) reunião de 30 min por vídeo.
// A oferta é o Método 3P (Google Ads para farmácias: Praça, Proximidade e Pedido), sem falar em "tráfego pago":
// a conversa fala de quem procura farmácia no Google e da recompra de quem usa remédio todo mês.
// Prova usada: Rede SanMar (Rio Verde), 8.150 cliques em ~9 meses a R$1,54 (Método 3P, seção 02). Nada de promessa de resultado.
// Nada aqui marca venda ganha/perdida: quem fecha é a pessoa, na reunião.

export const CALENDLY = "https://calendly.com/idxparasuaempresa/como-vender-mais-no-whatsapp-farmacias";

/** Primeira mensagem: só confirma se é o dono ({a|b} sorteia uma variação por contato). */
export const OPENER = [
  "{Oi|Olá}, tudo bem? Aqui é o Arthur, da IDX, de Rio Verde.",
  "",
  "{Queria|Preciso} falar com o dono ou a dona da {empresa}. É sobre os clientes que procuram farmácia no Google aí na região.",
  "",
  "É com você mesmo?",
  "",
  "1️⃣ Sim, sou eu",
  "2️⃣ Não, é outra pessoa",
].join("\n");

/** Follow-ups para quem não respondeu. Responder 1 em qualquer um leva para a conversa com o dono. */
export const FOLLOWUPS = [
  { after_hours: 26, label: "D1 · Lembrete", text: "Oi! Só para minha mensagem não se perder 🙂\n\nFalo com o dono ou a dona da {empresa}?\n1️⃣ Sim, sou eu\n2️⃣ Não, é outra pessoa" },
  { after_hours: 72, label: "D3 · Curiosidade", text: "Fiz um teste aqui: pesquisei “farmácia perto de mim” na sua região. O Google mostra 3 ou 4 farmácias no topo, e o pedido de quem precisa de remédio agora vai para elas.\n\nSe você for o dono ou a dona, responde 1 que eu te mostro onde a {empresa} aparece." },
  { after_hours: 120, label: "D5 · Prova", text: "Numa rede de farmácias aqui de Rio Verde, as buscas por farmácia no Google trouxeram mais de 8 mil cliques em 9 meses, pagando uns R$1,50 por clique.\n\nDá para montar algo do tamanho da sua cidade para a {empresa}. Responde 1 que eu te explico em 30 minutos." },
  { after_hours: 168, label: "D7 · Recompra", text: "Uma coisa que eu ainda não te contei: existe um jeito, sem custo para a farmácia, de fazer quem usa remédio de uso contínuo comprar com vocês todo mês.\n\nSe quiser saber como, responde 1." },
  { after_hours: 336, label: "D14 · Despedida", text: "Vou parar de te mandar mensagem para não incomodar. Se um dia quiser ver onde a {empresa} aparece no Google, é só me chamar por aqui.\n\nSucesso aí! 🙏" },
];

export const CAMPAIGN = {
  name: "Farmácias · Prospecção IDX (WhatsApp)",
  min_delay_sec: 60, // uma mensagem por minuto (mais natural e com menos risco de o WhatsApp derrubar o número)
  max_delay_sec: 75,
  daily_limit: 500,
  start_hour: 8,
  end_hour: 18,
  opt_out_footer: false,
};

const N = (id, type, config, x, y, label) => ({ id, type, position: { x, y }, data: { config, ...(label ? { label } : {}) } });
const E = (source, target, sourceHandle = null) => ({ id: `${source}-${target}-${sourceHandle ?? "n"}`, source, target, sourceHandle });
const rules = (match, list) => ({ match, rules: list.map(([op, value, field = "last_message"]) => ({ field, op, value })) });
const opt = (n) => ["equals", String(n), "option"]; // número da opção, também como emoji (1️⃣) ou no meio de várias mensagens

// Respostas (o motor compara sem acento e em minúsculas)
const SAIR = rules("any", [["equals", "sair"], ["equals", "parar"], ["equals", "pare"], ["starts_with", "sair "], ["contains", "nao me mande"], ["contains", "nao quero receber"], ["contains", "pare de mandar"], ["contains", "me tira da lista"], ["contains", "remover meu numero"]]);
// Recusa clara (vale em qualquer etapa da conversa)
const NEGATIVO = "(agora nao|sem interesse|nao (tenho|temos|ha) (nenhum )?interesse|nao (quero|queremos|preciso|precisamos)|dispenso|nao,? obrigad|nao me interessa|nao tenho mais (a )?farmacia|nao tenho farmacia|(fechei|fechamos|vendi|vendemos) a farmacia|a farmacia (fechou|foi vendida)|numero errado|engano|nao (e|eh) (uma )?farmacia|nao trabalho (mais )?(com|na|em) farmacia)";
const NAO = rules("any", [opt(3), ["regex", `^nao[.!]*$`], ["regex", NEGATIVO]]);
const NAO_MEIO = rules("any", [["regex", NEGATIVO], ["regex", `^nao[,.! ]*(obrigad[oa])?[.!]*$`]]);
// Resposta automática da farmácia (saudação do WhatsApp Business): não é a pessoa respondendo
const AUTO = rules("any", [["regex", "(agradece (o seu|seu|a sua|sua|pelo)|seja bem[- ]?vind|horario de atendimento|nosso horario|atendimento (e|eh) de|mensagem automatica|resposta automatica|deixe (aqui )?(o )?(seu|sua) (recado|mensagem|pedido)|retornaremos|entraremos em contato|responderemos (assim|em breve)|agradecemos (o|seu|a|pelo)|obrigad[oa] (por|pelo) (entrar em )?contato|fora do (nosso )?horario|estamos fechados|no momento (nao|estamos)|digite o numero|escolha uma (das )?opc|selecione uma opc|faca (ja )?(o )?seu pedido|confira (nosso|o nosso) cardapio|em breve (um|uma|nossa) (atendente|equipe))"]]);
// Só cumprimentou ou perguntou quem é: explica e pergunta de novo, antes das perguntas
const SAUDACAO = rules("any", [["regex", "^(oi+|ola|opa|e ai|bom dia|boa tarde|boa noite|tudo (bem|bom)|pois nao|diga|fala|sim\\?|alo|quem (e|eh|fala|seria)( voce| vc)?|do que se trata|qual (o )?assunto|o que seria|como assim|pode falar\\?)([ ,!?.]+(tudo (bem|bom)|como vai|bom dia|boa tarde|boa noite|quem (e|fala)|pois nao))*[ ,!?.]*$"]]);
const SIM = rules("any", [opt(1), ["regex", "^(sim|sou eu|sou sim|eu mesm[oa]|isso|sou o dono|sou a dona|sou (o |a )?proprietari[oa]|eu cuido|sou eu mesm[oa]|pode falar|pode mandar|sim,? (sou|pode|eu))"]]);
const OUTRO = rules("any", [opt(2), ["contains", "outra pessoa"], ["contains", "nao sou eu"], ["contains", "nao sou o"], ["contains", "nao sou a"], ["contains", "sou funcionari"], ["contains", "sou balconist"], ["contains", "sou atendente"], ["contains", "falar com o dono"], ["contains", "falar com a dona"], ["contains", "e o dono"], ["contains", "e a dona"], ["contains", "com o proprietari"], ["contains", "com a proprietari"], ["contains", "meu patrao"], ["contains", "minha patroa"]]);
// Pergunta ou objeção fora do roteiro: quem responde é a pessoa (playbook: concorde, mude o ângulo, devolva com pergunta)
const FORA = rules("any", [["contains", "?"], ["contains", "quanto"], ["contains", "preco"], ["contains", "valor"], ["contains", "custa"], ["contains", "ja tenho"], ["contains", "ja temos"], ["contains", "agencia"], ["contains", "ja tentei"], ["contains", "ja fiz anuncio"], ["contains", "ja faco"], ["contains", "golpe"], ["contains", "quem e voce"], ["contains", "quem fala"], ["contains", "do que se trata"], ["contains", "como conseguiu"]]);

/**
 * Automação "Farmácias · Prospecção IDX": responde ao disparo.
 * stages: { novo, followup, reuniao } (ids das etapas do funil comercial)
 */
export function farmaciasGraph({ campaignId = null, stages = {} } = {}) {
  const nodes = [];
  const edges = [];
  const add = (...n) => nodes.push(...n);
  const link = (...e) => edges.push(...e);
  const title = "Farmácia — {nome}";
  let y = 0;

  // ---- entrada: SAIR / agora não / outra pessoa / conversa ----
  add(
    N("t", "trigger", { kind: "campaign", campaign_id: campaignId }, 0, 300, "Respondeu o disparo (farmácias)"),
    N("c_sair", "condition", SAIR, 260, 300, "Pediu para sair?"),
    N("c_auto", "condition", AUTO, 260, 520, "Resposta automática da farmácia?"),
    N("c_nao", "condition", NAO, 520, 300, "Agora não?"),
    N("c_outro", "condition", OUTRO, 780, 300, "É outra pessoa?"),
    N("c_sim", "condition", SIM, 780, 440, "Sou eu / 1?"),
    N("c_oi", "condition", SAUDACAO, 780, 580, "Só cumprimentou / quem é?"),
    N("c_oi_ja", "condition", { match: "any", rules: [{ field: "contact_field", key: "farm_explicado", op: "not_empty", value: "" }] }, 1040, 580, "Já explicou antes?"),
    N("c_auto_ja", "condition", { match: "any", rules: [{ field: "contact_field", key: "farm_resposta_automatica", op: "not_empty", value: "" }] }, 520, 640, "Já veio resposta automática?"),
    N("f_auto", "set_field", { field: "farm_resposta_automatica", value: "sim" }, 780, 760, "Marcar: resposta automática"),
    N("w_auto", "wait_response", { timeout: 40, timeoutUnit: "minutes" }, 1040, 760, "Esperar a pessoa (40 min)"),
    N("w_auto2", "wait_response", { timeout: 48, timeoutUnit: "hours" }, 780, 900, "Esperar a pessoa (48 h)"),
    N("f_oi", "set_field", { field: "farm_explicado", value: "sim" }, 1300, 640, "Marcar: já explicou"),
    N("confirma", "send_menu", {
      text: "{Oi|Olá}! 🙂 Aqui é o Arthur, da IDX, de Rio Verde. Eu ajudo farmácias da região a receber o pedido de quem procura farmácia no Google.\n\nAntes de tudo: falo com o dono ou a dona da farmácia?",
      options: "Sim, sou eu\nNão, é outra pessoa", buttons: true, timeout: 24, timeoutUnit: "hours", footer: "",
    }, 1560, 700, "Explicar e perguntar de novo"),
  );
  link(E("t", "c_sair"), E("c_sair", "tag_optout", "yes"), E("c_sair", "c_auto", "no"),
    E("c_auto", "c_auto_ja", "yes"), E("c_auto", "c_nao", "no"),
    E("c_auto_ja", "w_auto2", "yes"), E("c_auto_ja", "f_auto", "no"),
    E("f_auto", "w_auto"), E("w_auto", "c_sair", "replied"), E("w_auto", "f_oi", "timeout"),
    E("w_auto2", "c_sair", "replied"), E("w_auto2", "fim", "timeout"),
    E("c_nao", "bye", "yes"), E("c_nao", "c_outro", "no"),
    E("c_outro", "ask_resp", "yes"), E("c_outro", "c_sim", "no"),
    E("c_sim", "deal_novo", "yes"), E("c_sim", "c_oi", "no"),
    E("c_oi", "c_oi_ja", "yes"), E("c_oi", "deal_novo", "no"),
    E("c_oi_ja", "deal_novo", "yes"), E("c_oi_ja", "f_oi", "no"),
    E("f_oi", "confirma"),
    E("confirma", "deal_novo", "opt0"), E("confirma", "ask_resp", "opt1"),
    E("confirma", "c_sair", "other"), E("confirma", "fim", "timeout"));

  // ---- SAIR ----
  add(
    N("tag_optout", "tag", { action: "add", tag: "opt-out marketing" }, 520, 700, "Opt-out"),
    N("msg_optout", "send_text", { text: "Combinado, não envio mais mensagens. Desculpe o incômodo e sucesso para a farmácia! 🙏" }, 780, 700, "Confirmar"),
    N("optout", "optout", {}, 1040, 700, "Descadastrar (SAIR)"),
  );
  link(E("tag_optout", "msg_optout"), E("msg_optout", "optout"));

  // ---- agora não ----
  add(
    N("bye", "send_text", { text: "Sem problema, obrigado por responder! 😊\n\nSe em algum momento fizer sentido trazer mais clientes do bairro pelo WhatsApp, é só me chamar por aqui.\n\nSucesso para a farmácia! 🙏" }, 780, 520, "Agradecer"),
    N("tag_nao", "tag", { action: "add", tag: "farmácia: agora não" }, 1040, 520, "Etiqueta: agora não"),
    N("fim", "end", {}, 5200, 300, "Fim"),
  );
  link(E("bye", "tag_nao"), E("tag_nao", "fim"));

  // ---- outra pessoa: pede o contato de quem decide ----
  add(
    N("ask_resp", "ask", { text: "Obrigado por avisar! 🙏\n\nVocê me passa o nome e o WhatsApp do dono ou da dona? Se preferir, me diz o melhor horário para encontrar ele(a) na farmácia.", saveAs: "responsavel", timeout: 48, timeoutUnit: "hours" }, 1040, 100, "Quem é o responsável?"),
    N("c_sair_resp", "condition", SAIR, 1300, 100, "Pediu para sair?"),
    N("f_resp", "set_field", { field: "responsavel", value: "{resposta}" }, 1560, 40, "Salvar responsável"),
    N("deal_resp", "crm_deal", { action: "upsert", stage_id: stages.novo ?? null, title }, 1820, 40, "Novo lead"),
    N("task_resp", "task", { title: "Falar com o responsável da {nome}", description: "Indicado pela farmácia: {resposta}. Abordar com a mensagem B do playbook (ponto forte real + quem cuida da divulgação).", taskType: "whatsapp", dueInHours: 4 }, 2080, 40, "Tarefa: falar com o dono"),
    N("msg_resp", "send_text", { text: "Valeu demais! Vou falar com ele(a). Bom trabalho aí! 😊" }, 2340, 40, "Agradecer"),
  );
  link(E("ask_resp", "c_sair_resp", "answered"), E("ask_resp", "fim", "timeout"),
    E("c_sair_resp", "tag_optout", "yes"), E("c_sair_resp", "f_resp", "no"),
    E("f_resp", "deal_resp"), E("deal_resp", "task_resp"), E("task_resp", "msg_resp"), E("msg_resp", "fim"));

  // ---- conversa com quem decide: negócio + SPIN ----
  add(
    N("deal_novo", "crm_deal", { action: "upsert", stage_id: stages.novo ?? null, title }, 1040, 300, "Novo lead"),
    N("tag_conv", "tag", { action: "add", tag: "farmácia: conversando" }, 1300, 300, "Etiqueta: conversando"),
  );
  link(E("deal_novo", "tag_conv"), E("tag_conv", "q1"));

  // Pergunta com 3 opções: cada resposta salva um campo; texto livre passa pelo filtro de SAIR e de pergunta/objeção.
  const QX = 1560;
  const question = (id, x, label, text, options, field, values, next) => {
    add(N(id, "send_menu", { text, options: options.join("\n"), buttons: true, timeout: 24, timeoutUnit: "hours", footer: "" }, x, y, label));
    options.forEach((_, i) => {
      add(N(`${id}_f${i}`, "set_field", { field, value: values[i] }, x + 260, y - 120 + i * 80, `Salvar: ${values[i]}`));
      link(E(id, `${id}_f${i}`, `opt${i}`), E(`${id}_f${i}`, next));
    });
    add(
      N(`${id}_sair`, "condition", SAIR, x + 260, y + 160, "Pediu para sair?"),
      N(`${id}_nao`, "condition", NAO_MEIO, x + 390, y + 220, "Desistiu?"),
      N(`${id}_fora`, "condition", FORA, x + 520, y + 160, "Pergunta ou objeção?"),
      N(`${id}_ft`, "set_field", { field, value: "{resposta}" }, x + 780, y + 160, "Salvar resposta livre"),
      N(`${id}_sem`, "task", { title: `Conversa parou (${label}): {nome}`, description: `A farmácia parou de responder em “${label}”. Retomar à mão, sem insistência automática.`, taskType: "follow_up", dueInHours: 4 }, x + 260, y + 260, "Tarefa: parou de responder"),
    );
    link(E(id, `${id}_sair`, "other"), E(`${id}_sair`, "tag_optout", "yes"), E(`${id}_sair`, `${id}_nao`, "no"),
      E(`${id}_nao`, "bye", "yes"), E(`${id}_nao`, `${id}_fora`, "no"),
      E(`${id}_fora`, "humano", "yes"), E(`${id}_fora`, `${id}_ft`, "no"), E(`${id}_ft`, next),
      E(id, `${id}_sem`, "timeout"), E(`${id}_sem`, "fim"));
  };

  question("q1", QX, "Google",
    "Prazer! Vou ser rápido.\n\nQuando alguém aí perto pesquisa “farmácia perto de mim” ou “farmácia que entrega” no Google, você sabe se a farmácia de vocês aparece entre as primeiras?",
    ["Aparece sim", "Não sei", "Acho que não aparece"], "google_posicao_percebida",
    ["Acha que aparece", "Não sabe", "Acha que não aparece"], "q2");

  question("q2", QX + 1040, "Recompra",
    "Pergunto porque quem faz essa busca quer comprar agora e quase sempre pede na primeira farmácia que aparece. Numa rede de farmácias aqui de Rio Verde, essas buscas trouxeram mais de 8 mil cliques em 9 meses, a uns R$1,50 cada.\n\nE o cliente novo que chega: vocês conseguem fazer ele voltar todo mês? Quem usa remédio de uso contínuo, por exemplo.",
    ["Sim, a gente acompanha", "Às vezes", "Não, depende dele"], "recompra",
    ["Acompanha a recompra", "Às vezes", "Depende do cliente"], "oferta");

  // ---- convite para a reunião (insinua o canal de uso contínuo, sem vender nada por mensagem) ----
  const OX = QX + 2080;
  add(
    N("oferta", "send_menu", {
      text: "Entendi. Quem paga o investimento é a recompra de todo mês, por isso essa parte pesa tanto.\n\nMinha proposta é uma conversa de 30 minutos por vídeo. Te mostro onde a farmácia aparece hoje no Google, quantas pessoas da sua região procuram farmácia e o plano que usamos: anúncio só para quem está perto e procurando farmácia na hora. Também te mostro um jeito, sem custo para a farmácia, de trazer de volta todo mês quem usa remédio de uso contínuo.\n\nVocê fica com esse diagnóstico mesmo que não feche nada comigo. Vamos marcar?",
      options: "Sim, vamos marcar\nPrefiro uma ligação\nAgora não", buttons: true, timeout: 24, timeoutUnit: "hours", footer: "",
    }, OX, 0, "Convite: reunião de 30 min"),
    N("oferta_sair", "condition", SAIR, OX + 260, 300, "Pediu para sair?"),
    N("oferta_sim", "condition", rules("any", [["starts_with", "sim"], ["equals", "ok"], ["equals", "pode"], ["contains", "vamos marcar"], ["contains", "pode marcar"], ["contains", "pode ser"], ["contains", "bora"], ["contains", "claro"], ["contains", "beleza"], ["contains", "fechado"], ["contains", "combinado"], ["contains", "topo"], ["contains", "quero sim"]]), OX + 520, 300, "Aceitou por texto?"),
    N("oferta_sem", "task", { title: "Convite sem resposta: {nome}", description: "Respondeu as perguntas mas não respondeu o convite para a reunião de 30 min. Retomar à mão com o resumo das respostas.", taskType: "follow_up", dueInHours: 4 }, OX + 260, 520, "Tarefa: sem resposta"),
  );
  link(E("oferta", "periodo", "opt0"), E("oferta", "ask_lig", "opt1"), E("oferta", "por_escrito", "opt2"),
    E("oferta", "oferta_sair", "other"), E("oferta_sair", "tag_optout", "yes"), E("oferta_sair", "oferta_sim", "no"),
    E("oferta_sim", "periodo", "yes"), E("oferta_sim", "humano", "no"),
    E("oferta", "oferta_sem", "timeout"), E("oferta_sem", "fim"));

  // sim → período → dia/horário (ou o próprio link de agenda)
  add(
    N("periodo", "send_menu", { text: "Ótimo! 🎯 Qual período costuma ser mais tranquilo para você?", options: "Manhã\nTarde\nFim do dia", buttons: true, timeout: 24, timeoutUnit: "hours", footer: "" }, OX + 260, -260, "Período"),
    N("periodo_f", "set_field", { field: "periodo_reuniao", value: "{var.lastChoice}" }, OX + 520, -300, "Salvar período"),
    N("periodo_ft", "set_field", { field: "periodo_reuniao", value: "{resposta}" }, OX + 520, -180, "Salvar período (texto)"),
    N("ask_dia", "ask", { text: `Combinado! Me diz o melhor dia e horário (por exemplo: quinta às 10h) que eu já reservo para você.\n\nSe preferir, você mesmo escolhe aqui na minha agenda: ${CALENDLY}`, saveAs: "horario", timeout: 24, timeoutUnit: "hours" }, OX + 780, -260, "Dia e horário"),
    N("c_sair_dia", "condition", SAIR, OX + 1040, -260, "Pediu para sair?"),
    N("f_dia", "set_field", { field: "horario_reuniao", value: "{resposta}" }, OX + 1300, -300, "Salvar horário"),
    N("deal_reuniao", "crm_deal", { action: "upsert", stage_id: stages.reuniao ?? null, title }, OX + 1560, -300, "Reunião"),
    N("tag_reuniao", "tag", { action: "add", tag: "farmácia: reunião" }, OX + 1820, -300, "Etiqueta: reunião"),
    N("task_reuniao", "task", { title: "Confirmar reunião de 30 min com {nome}", description: "Pediu: {resposta} ({periodo_reuniao}). Confirmar o horário e mandar o link da chamada. Antes: busca “farmácia com entrega em [cidade]”, perfil no Google e Instagram abertos; respostas da conversa estão nos campos do contato.", taskType: "meeting", dueInHours: 1 }, OX + 2080, -300, "Tarefa: confirmar reunião"),
    N("aviso_reuniao", "notify", { message: "📅 {nome} quer marcar a reunião de 30 min: “{resposta}”. Confirmar o horário e mandar o link." }, OX + 2340, -300, "Avisar a equipe"),
    N("msg_reuniao", "send_text", { text: "Perfeito, anotado! ✅\n\nTe confirmo por aqui com o link da chamada. Se puder, separa o ticket médio e quantos pedidos chegam por dia: eu já levo a conta feita para a sua farmácia." }, OX + 2600, -300, "Confirmar"),
    N("dia_sem", "task", { title: "Aceitou a reunião mas não passou o horário: {nome}", description: "Disse sim para a reunião de 30 min ({periodo_reuniao}), mas não respondeu o dia. Chamar com duas opções de horário.", taskType: "meeting", dueInHours: 2 }, OX + 1040, -80, "Tarefa: sem horário"),
  );
  link(E("periodo", "periodo_f", "opt0"), E("periodo", "periodo_f", "opt1"), E("periodo", "periodo_f", "opt2"),
    E("periodo", "periodo_ft", "other"), E("periodo", "dia_sem", "timeout"),
    E("periodo_f", "ask_dia"), E("periodo_ft", "ask_dia"),
    E("ask_dia", "c_sair_dia", "answered"), E("ask_dia", "dia_sem", "timeout"),
    E("c_sair_dia", "tag_optout", "yes"), E("c_sair_dia", "f_dia", "no"),
    E("f_dia", "deal_reuniao"), E("deal_reuniao", "tag_reuniao"), E("tag_reuniao", "task_reuniao"),
    E("task_reuniao", "aviso_reuniao"), E("aviso_reuniao", "msg_reuniao"), E("msg_reuniao", "fim"), E("dia_sem", "fim"));

  // prefere ligação
  add(
    N("ask_lig", "ask", { text: "Claro! Qual o melhor dia e horário para eu te ligar? (por exemplo: amanhã às 15h)", saveAs: "horario", timeout: 24, timeoutUnit: "hours" }, OX + 260, 160, "Horário da ligação"),
    N("c_sair_lig", "condition", SAIR, OX + 520, 160, "Pediu para sair?"),
    N("f_lig", "set_field", { field: "horario_ligacao", value: "{resposta}" }, OX + 780, 120, "Salvar horário"),
    N("deal_lig", "crm_deal", { action: "upsert", stage_id: stages.followup ?? null, title }, OX + 1040, 120, "Follow-up"),
    N("task_lig", "task", { title: "Ligar para {nome}", description: "Prefere ligação: {resposta}. Objetivo: marcar a reunião de 30 min por vídeo.", taskType: "callback", dueInHours: 1 }, OX + 1300, 120, "Tarefa: ligar"),
    N("aviso_lig", "notify", { message: "📞 {nome} prefere uma ligação: “{resposta}”." }, OX + 1560, 120, "Avisar a equipe"),
    N("msg_lig", "send_text", { text: "Anotado! ✅ Te ligo no horário combinado. Até lá! 😊" }, OX + 1820, 120, "Confirmar"),
    N("lig_sem", "task", { title: "Pediu ligação mas não passou o horário: {nome}", description: "Escolheu “Prefiro uma ligação” e não respondeu o horário. Ligar no horário comercial.", taskType: "callback", dueInHours: 2 }, OX + 520, 260, "Tarefa: sem horário"),
  );
  link(E("ask_lig", "c_sair_lig", "answered"), E("ask_lig", "lig_sem", "timeout"),
    E("c_sair_lig", "tag_optout", "yes"), E("c_sair_lig", "f_lig", "no"),
    E("f_lig", "deal_lig"), E("deal_lig", "task_lig"), E("task_lig", "aviso_lig"), E("aviso_lig", "msg_lig"), E("msg_lig", "fim"), E("lig_sem", "fim"));

  // agora não → oferece o diagnóstico por escrito (objeção "me manda por WhatsApp")
  add(
    N("por_escrito", "send_menu", { text: "Sem problema! Posso te mandar o diagnóstico por aqui mesmo, por escrito, para você ver com calma quando der?", options: "Pode mandar\nNão, obrigado", buttons: true, timeout: 48, timeoutUnit: "hours", footer: "" }, OX + 260, 400, "Diagnóstico por escrito?"),
    N("deal_escrito", "crm_deal", { action: "upsert", stage_id: stages.followup ?? null, title }, OX + 520, 360, "Follow-up"),
    N("task_escrito", "task", { title: "Enviar diagnóstico por escrito para {nome}", description: "Não quis reunião agora, mas aceitou receber o diagnóstico por WhatsApp. Mandar algo feito para a farmácia (o que aparece no Google, onde perde pedido) e propor a reunião de novo.", taskType: "whatsapp", dueInHours: 24 }, OX + 780, 360, "Tarefa: diagnóstico"),
    N("msg_escrito", "send_text", { text: "Combinado! Vou preparar com calma e te mando por aqui nos próximos dias. 😊" }, OX + 1040, 360, "Confirmar"),
  );
  link(E("por_escrito", "deal_escrito", "opt0"), E("por_escrito", "bye", "opt1"), E("por_escrito", "humano", "other"), E("por_escrito", "fim", "timeout"),
    E("deal_escrito", "task_escrito"), E("task_escrito", "msg_escrito"), E("msg_escrito", "fim"));

  // ---- fora do roteiro: avisa e passa para a pessoa ----
  add(
    N("humano", "notify", { message: "💬 {nome} respondeu fora do roteiro: “{resposta}”. Assumir a conversa na caixa de entrada (playbook, seção de objeções)." }, OX + 260, 700, "Avisar a equipe"),
    N("msg_humano", "send_text", { text: "Boa! Vou te responder direitinho em instantes. 😊" }, OX + 520, 700, "Avisar o contato"),
    N("handoff", "handoff", {}, OX + 780, 700, "Passar para a equipe"),
  );
  link(E("humano", "msg_humano"), E("msg_humano", "handoff"));

  return { nodes, edges };
}
