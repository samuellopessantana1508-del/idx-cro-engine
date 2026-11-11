// Interpretação por regras (sem IA) de um resumo de ligação/atendimento falado
// ou digitado em português. Usada como reserva quando a IA não responde e
// também para completar datas/horários com precisão.

export type DialOutcome = "talked" | "meeting" | "callback" | "no_answer" | "not_interested" | "invalid";
export type RulesResult = {
  dial_outcome: DialOutcome | null;
  contact: { name?: string; phone?: string; company?: string; email?: string };
  value: number | null;
  due_local: string | null; // "YYYY-MM-DDTHH:mm" no fuso da empresa
  objection: string | null;
  wants_proposal: boolean;
};

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const WEEKDAYS: Record<string, number> = {
  domingo: 0, segunda: 1, "segunda-feira": 1, terca: 2, "terca-feira": 2, quarta: 3, "quarta-feira": 3,
  quinta: 4, "quinta-feira": 4, sexta: 5, "sexta-feira": 5, sabado: 6,
};

const OBJECTIONS: [RegExp, string][] = [
  [/\b(caro|muito caro|preco alto|achou caro|acharam caro|sem dinheiro|sem verba|sem orcamento)\b/, "Preço / orçamento"],
  [/\b(ja tem fornecedor|ja trabalha com|ja tem parceiro|ja usa outro|ja tem (um )?sistema|concorrente)\b/, "Já tem fornecedor"],
  [/\b(nao e o responsavel|nao e o dono|nao decide|falar com o dono|falar com o socio|gerente nao estava|dono nao estava)\b/, "Não é o decisor"],
  [/\b(sem tempo|muito ocupad|correria|agora nao da)\b/, "Sem tempo agora"],
  [/\b(nao confia|desconfiad|golpe)\b/, "Desconfiança"],
  [/\b(nao precisa|nao ve necessidade|ja vende bem)\b/, "Não vê necessidade"],
];

export function localNow(tz: string, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute), wd };
}

/** "YYYY-MM-DDTHH:mm" no fuso `tz` → ISO UTC */
export function zonedToUtcIso(local: string, tz: string): string | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const offset = (t: number) => {
    const l = localNow(tz, new Date(t));
    return Date.UTC(l.y, l.m - 1, l.d, l.h, l.min) - t;
  };
  let utc = guess - offset(guess);
  utc = guess - offset(utc); // ajuste em virada de horário de verão
  return new Date(utc).toISOString();
}

const pad = (n: number) => String(n).padStart(2, "0");
function addDays(y: number, m: number, d: number, days: number) {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function parseWhen(text: string, tz: string, now = new Date()): string | null {
  const t = norm(text);
  const today = localNow(tz, now);
  let day: { y: number; m: number; d: number } | null = null;

  if (/\bdepois de amanha\b/.test(t)) day = addDays(today.y, today.m, today.d, 2);
  else if (/\bamanha\b/.test(t)) day = addDays(today.y, today.m, today.d, 1);
  else if (/\bhoje\b|\bmais tarde\b|\bfim do dia\b/.test(t)) day = { y: today.y, m: today.m, d: today.d };
  else if (/\bsemana que vem\b|\bproxima semana\b/.test(t) && !/(segunda|terca|quarta|quinta|sexta|sabado|domingo)/.test(t)) {
    day = addDays(today.y, today.m, today.d, ((1 - today.wd + 7) % 7) || 7);
  }
  if (!day) {
    const wm = t.match(/\b(segunda|terca|quarta|quinta|sexta|sabado|domingo)(-feira)?\b/);
    if (wm) {
      const target = WEEKDAYS[wm[1]];
      let diff = (target - today.wd + 7) % 7;
      if (diff === 0) diff = 7;
      if (/\b(semana que vem|proxima semana)\b/.test(t) && diff < 7 && target > today.wd) diff += 7;
      day = addDays(today.y, today.m, today.d, diff);
    }
  }
  if (!day) {
    const dm = t.match(/\bdia (\d{1,2})(?:\/(\d{1,2}))?\b/) ?? t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/);
    if (dm) {
      const dd = Number(dm[1]);
      let mm = dm[2] ? Number(dm[2]) : today.m;
      let yy = today.y;
      if (!dm[2] && dd < today.d) mm += 1;
      if (mm > 12) { mm = 1; yy += 1; }
      if (dm[2] && (mm < today.m || (mm === today.m && dd < today.d))) yy += 1;
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) day = { y: yy, m: mm, d: dd };
    }
  }

  let hh: number | null = null;
  let mi = 0;
  const hm = t.match(/\b(?:as|a partir das|depois das|umas|por volta das)?\s*(\d{1,2})(?:[:h](\d{2}))\b/) ??
    t.match(/\b(\d{1,2})\s*(?:h|horas?)\b/) ?? t.match(/\b(\d{1,2}) da (?:tarde|manha|noite)\b/) ?? t.match(/\bas (\d{1,2})\b/);
  if (hm) {
    const v = Number(hm[1]);
    if (v >= 0 && v <= 23) { hh = v; mi = hm[2] ? Number(hm[2]) : 0; }
    if (hh !== null && hh >= 1 && hh <= 7 && /\b(tarde|noite)\b/.test(t)) hh += 12;
  } else if (/\bde manha\b|\bcedo\b/.test(t)) hh = 9;
  else if (/\bde tarde\b|\ba tarde\b|\bpela tarde\b/.test(t)) hh = 14;
  else if (/\bfim do dia\b|\bfinal do dia\b/.test(t)) hh = 17;
  else if (/\bmais tarde\b/.test(t)) hh = Math.min(today.h + 2, 18);

  if (!day && hh === null) return null;
  if (!day) day = (hh! < today.h || (hh === today.h && mi <= today.min)) ? addDays(today.y, today.m, today.d, 1) : { y: today.y, m: today.m, d: today.d };
  if (hh === null) hh = 9;
  return `${day.y}-${pad(day.m)}-${pad(day.d)}T${pad(hh)}:${pad(mi)}`;
}

export function parseRules(text: string, tz: string, now = new Date()): RulesResult {
  const t = norm(text);
  let outcome: DialOutcome | null = null;
  if (/\b(numero (errado|invalido|nao existe)|nao existe|numero inexistente|fora de servico|telefone errado)\b/.test(t)) outcome = "invalid";
  else if (/\b(nao atendeu|ninguem atendeu|caixa postal|nao atende|chamou e nao|ocupado|desligado)\b/.test(t)) outcome = "no_answer";
  else if (/\b(sem interesse|nao tem interesse|nao quer|nao quis|nao se interessou|pediu para nao ligar|recusou)\b/.test(t)) outcome = "not_interested";
  else if (/\b(reuniao|marcamos|marquei|agendei|agendamos|agendou|visita marcada|apresentacao marcada|demonstracao)\b/.test(t)) outcome = "meeting";
  else if (/\b(retornar|retorno|ligar de novo|ligar depois|ligar mais tarde|me liga|ligar? (amanha|depois|semana|segunda|terca|quarta|quinta|sexta|sabado|outro dia|mais tarde|na (segunda|terca|quarta|quinta|sexta))|volto a ligar|retomar)\b/.test(t)) outcome = "callback";
  else if (t.trim().length > 0) outcome = "talked";

  let value: number | null = null;
  const vm = t.match(/r\$\s*([\d.]+(?:,\d{1,2})?)\s*(mil)?/) ?? t.match(/\b([\d.]+(?:,\d{1,2})?)\s*(mil)?\s*(reais|conto)\b/) ?? t.match(/\b(\d+(?:,\d+)?)\s*(mil)\b/);
  if (vm) {
    const n = Number(vm[1].replace(/\./g, "").replace(",", "."));
    if (Number.isFinite(n)) value = vm[2] === "mil" ? n * 1000 : n;
  }

  const contact: RulesResult["contact"] = {};
  const pm = text.replace(/[^\d+]/g, " ").match(/(?:\+?55)?\s*\d{2}\s*9?\d{8}\b/);
  const digits = text.match(/(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}/);
  if (digits) contact.phone = digits[0].replace(/\D/g, "");
  else if (pm) contact.phone = pm[0].replace(/\D/g, "");
  const em = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  if (em) contact.email = em[0].toLowerCase();
  const nm = text.match(/\b(?:[Ff]alei com|[Cc]onversei com|[Aa]tendeu|[Qq]uem atendeu foi|[Nn]ome (?:dele|dela|é))\s+(?:o |a |a sra\.? |o sr\.? |dona |seu )?([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wáéíóúâêôãõç]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wáéíóúâêôãõç]+)?)/);
  if (nm) contact.name = nm[1];
  const cm = text.match(/\b(?:[Dd]a|[Nn]a|[Dd]o)\s+((?:[Dd]rogaria|[Ff]arm[aá]cia|[Dd]rogas?|[Ff]arma)\s+[\wÀ-ÿ]+(?:\s+(?:[A-ZÀ-Ý][\wÀ-ÿ]+|d[aeo]s?|\d{1,6}))*)/);
  if (cm) contact.company = cm[1].trim().replace(/\s+(?:d[aeo]s?)$/i, "");

  let objection: string | null = null;
  for (const [re, label] of OBJECTIONS) if (re.test(t)) { objection = label; break; }

  return {
    dial_outcome: outcome,
    contact,
    value,
    due_local: parseWhen(text, tz, now),
    objection,
    wants_proposal: /\b(proposta|orcamento|cotacao|mandar (os )?precos|enviar (os )?precos|tabela)\b/.test(t),
  };
}
