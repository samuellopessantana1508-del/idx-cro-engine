// Catálogo de ferramentas do conector MCP do CRO.
// Leitura: readOnlyHint. Ações: só aparecem para tokens "leitura e ações".

type Schema = Record<string, unknown>;
export type ToolDef = {
  name: string; title: string; description: string; inputSchema: Schema; write?: boolean;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
};

const obj = (props: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description: string, extra: Schema = {}): Schema => ({ type: "string", description, ...extra });
const int = (description: string, min = 1, max = 100): Schema => ({ type: "integer", description, minimum: min, maximum: max });
const uuid = (description: string): Schema => ({ type: "string", format: "uuid", description });
const limite = int("Quantos itens trazer (padrão 20, máx. 100)");
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS: ToolDef[] = [
  {
    name: "resumo_comercial", title: "Resumo comercial",
    description: "Visão geral da empresa no CRO: indicadores de vendas e funil do período, discador (pendentes, ligados hoje, reuniões), tarefas atrasadas/de hoje, negociações abertas, WhatsApp (conectado, conversas não lidas) e disparos em andamento. Use primeiro para entender a situação.",
    inputSchema: obj({ dias: int("Período dos indicadores em dias (padrão 30)", 1, 365) }), annotations: RO,
  },
  {
    name: "buscar_contatos", title: "Buscar contatos",
    description: "Procura contatos do CRM por nome, telefone (4+ dígitos), e-mail ou empresa. Sem busca, traz os mais recentes.",
    inputSchema: obj({ busca: str("Texto a procurar"), limite }), annotations: RO,
  },
  {
    name: "ver_contato", title: "Ver contato",
    description: "Ficha completa de um contato: dados, negociações, tarefas abertas, histórico recente e últimas mensagens de WhatsApp.",
    inputSchema: obj({ contato_id: uuid("ID do contato (de buscar_contatos)") }, ["contato_id"]), annotations: RO,
  },
  {
    name: "listar_negociacoes", title: "Listar negociações",
    description: "Negociações do funil com etapa, valor, contato e próxima atividade, ordenadas por valor.",
    inputSchema: obj({ status: str("open (padrão), won ou lost", { enum: ["open", "won", "lost"] }), limite }), annotations: RO,
  },
  {
    name: "listar_tarefas", title: "Listar tarefas",
    description: "Tarefas abertas (ligações, WhatsApp, reuniões…). Por padrão só as suas e até hoje (inclui atrasadas).",
    inputSchema: obj({
      filtro: str("hoje (até hoje, padrão), atrasadas, semana ou todas", { enum: ["hoje", "atrasadas", "semana", "todas"] }),
      so_minhas: { type: "boolean", description: "Só as minhas (padrão true)" }, limite,
    }), annotations: RO,
  },
  {
    name: "discador", title: "Discador",
    description: "Resumo do discador e a fila de números (ex.: farmácias do Google Maps com posição e nota no Google). Filtre por lista, status, UF ou nome/cidade.",
    inputSchema: obj({
      lista: str("Nome da lista (ex.: Farmácias (Google Maps))"), status: str("pending (padrão) ou called", { enum: ["pending", "called"] }),
      uf: str("UF, ex.: SP"), busca: str("Parte do nome ou da cidade"), limite,
    }), annotations: RO,
  },
  {
    name: "listar_disparos", title: "Listar disparos de WhatsApp",
    description: "Disparos (campanhas de WhatsApp) com progresso: enviados, pendentes, quem respondeu, sem WhatsApp, pediram SAIR, limite diário e próximo envio.",
    inputSchema: obj({}), annotations: RO,
  },
  {
    name: "ver_disparo", title: "Ver disparo",
    description: "Contatos de um disparo. Padrão: quem respondeu (para dar sequência).",
    inputSchema: obj({
      disparo_id: uuid("ID do disparo"), filtro: str("responderam (padrão), enviados, falhas, pendentes ou todos", { enum: ["responderam", "enviados", "falhas", "pendentes", "todos"] }), limite,
    }, ["disparo_id"]), annotations: RO,
  },
  {
    name: "conversas_whatsapp", title: "Conversas de WhatsApp",
    description: "Conversas mais recentes da caixa de entrada do CRO, com a última mensagem e não lidas.",
    inputSchema: obj({ nao_lidas: { type: "boolean", description: "Só conversas com mensagens não lidas" }, limite }), annotations: RO,
  },
  {
    name: "buscas_google_maps", title: "Buscas no Google Maps",
    description: "Buscas automáticas de clientes no Google Maps: termo, próximo bairro do rodízio, agenda e resultado da última execução.",
    inputSchema: obj({}), annotations: RO,
  },
  // ---------------- ações ----------------
  {
    name: "criar_contato", title: "Criar contato", write: true,
    description: "Cria um contato no CRM (se o telefone já existir, devolve o existente sem duplicar).",
    inputSchema: obj({ nome: str("Nome"), telefone: str("Telefone com DDD"), email: str("E-mail"), empresa: str("Empresa"), cidade: str("Cidade"), observacoes: str("Observações") }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "criar_tarefa", title: "Criar tarefa", write: true,
    description: "Agenda uma tarefa (ligação, WhatsApp, reunião…) para você, opcionalmente ligada a um contato.",
    inputSchema: obj({
      titulo: str("O que fazer"), tipo: str("call, whatsapp, meeting, follow_up, task, visit, email ou proposal", { enum: ["call", "whatsapp", "meeting", "follow_up", "task", "visit", "email", "proposal"] }),
      vencimento: str("Data e hora ISO 8601 com fuso, ex.: 2026-11-14T15:00:00-03:00 (padrão: daqui 1 hora)"),
      contato_id: uuid("Contato relacionado"), descricao: str("Detalhes ou texto pronto"), prioridade: str("low, normal, high ou urgent", { enum: ["low", "normal", "high", "urgent"] }),
    }, ["titulo"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "concluir_tarefa", title: "Concluir tarefa", write: true,
    description: "Marca uma tarefa como feita (em cadências, isso agenda o próximo passo automaticamente).",
    inputSchema: obj({ tarefa_id: uuid("ID da tarefa"), resultado: str("Como foi") }, ["tarefa_id"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "adicionar_nota", title: "Adicionar nota", write: true,
    description: "Registra uma nota no histórico do contato.",
    inputSchema: obj({ contato_id: uuid("Contato"), texto: str("Texto da nota") }, ["contato_id", "texto"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "registrar_ligacao", title: "Registrar ligação do discador", write: true,
    description: "Registra o resultado de uma ligação do discador. 'meeting' cria tarefa de reunião; 'callback' agenda retorno em retorno_em. Não marca venda.",
    inputSchema: obj({
      lead_id: uuid("ID do lead do discador"),
      resultado: str("talked, meeting, callback, no_answer, not_interested ou invalid", { enum: ["talked", "meeting", "callback", "no_answer", "not_interested", "invalid"] }),
      observacao: str("O que foi conversado"), retorno_em: str("Data/hora ISO 8601 do retorno ou da reunião"), objecao: str("Principal objeção, se houver"),
    }, ["lead_id", "resultado"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "enviar_whatsapp", title: "Enviar WhatsApp", write: true,
    description: "Envia UMA mensagem de WhatsApp pelo número conectado ao CRO (vai para a fila e sai em segundos). Antes de chamar, SEMPRE mostre o texto final e o destinatário ao usuário e peça confirmação explícita. Respeita quem pediu SAIR. Para várias pessoas use um disparo, não esta ferramenta.",
    inputSchema: obj({ mensagem: str("Texto exato a enviar"), telefone: str("Telefone com DDD (ou use conversa_id)"), conversa_id: uuid("Conversa existente (de conversas_whatsapp)") }, ["mensagem"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "controlar_disparo", title: "Iniciar, pausar ou cancelar disparo", write: true,
    description: "Inicia, pausa, retoma ou cancela um disparo de WhatsApp. Iniciar começa a enviar mensagens para o público (com intervalo aleatório, limite diário e horário) — confirme com o usuário antes de iniciar ou cancelar.",
    inputSchema: obj({ disparo_id: uuid("ID do disparo"), acao: str("iniciar, pausar, retomar ou cancelar", { enum: ["iniciar", "pausar", "retomar", "cancelar"] }) }, ["disparo_id", "acao"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "rodar_busca_google_maps", title: "Rodar busca no Google Maps", write: true,
    description: "Pede para rodar agora uma busca salva de clientes no Google Maps (executa em até 10 minutos; os novos aparecem no discador e, se configurado, no disparo).",
    inputSchema: obj({ busca_id: uuid("ID da busca (de buscas_google_maps)") }, ["busca_id"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

export const PROMPTS = [
  {
    name: "rotina_do_dia", title: "Minha rotina de hoje",
    description: "Organiza o dia comercial: tarefas, retornos, quem respondeu aos disparos e próximos passos.",
    text: "Use as ferramentas do CRO para montar minha rotina de hoje: 1) resumo_comercial; 2) listar_tarefas (hoje e atrasadas); 3) listar_disparos e, para os que têm respostas, ver_disparo com filtro 'responderam'; 4) conversas_whatsapp não lidas. Termine com uma lista priorizada do que fazer agora, com nome e telefone de cada pessoa. Não envie mensagens nem altere nada sem eu confirmar.",
  },
  {
    name: "analisar_disparos", title: "Analisar disparos de WhatsApp",
    description: "Avalia os disparos: taxa de resposta, números sem WhatsApp, descadastros, e sugere melhorias.",
    text: "Use listar_disparos e ver_disparo para analisar meus disparos de WhatsApp: taxa de resposta, % sem WhatsApp, % que pediu SAIR, e compare as mensagens. Sugira melhorias de texto e de público, sem enviar nada.",
  },
  {
    name: "prospectar_farmacias", title: "Prospecção de farmácias",
    description: "Revisa o discador e as buscas do Google Maps e sugere quem ligar primeiro.",
    text: "Use discador (lista de farmácias) e buscas_google_maps. Sugira as 15 farmácias para ligar primeiro, priorizando as que estão fora do top 3 do Google (oportunidade de melhorar posição) e com boa nota. Mostre posição, nota e telefone. Não registre nada sem eu confirmar.",
  },
];
