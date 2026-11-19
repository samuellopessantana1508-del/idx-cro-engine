#!/usr/bin/env python3
"""Seleciona farmácias independentes com celular (WhatsApp) da base aberta de CNPJ, perto de Rio Verde (GO).

Entrada: farmacias.csv gerado por rf-farmacias.py (cnpj;nome;telefone;telefone2;cidade;uf;bairro).
Regras:
- só celular (11 dígitos começando com 9; celular antigo de 8 dígitos ganha o 9);
- fora redes: CNPJ-base com 3+ lojas no país, nome de rede conhecida ou nome fantasia repetido em 4+ CNPJs diferentes;
- fora telefone repetido em mais de um estabelecimento (costuma ser contabilidade/matriz);
- prioridade: cidades próximas de Rio Verde, depois o resto do DDD 64 (sudoeste goiano), depois DDD 34 (Triângulo Mineiro).
O telefone é o de contato cadastrado pela própria empresa na Receita Federal (dado público de pessoa jurídica).

Saída: CSV ; com nome;empresa;telefone;cidade;uf;bairro;cnpj  (empresa = nome para usar na mensagem)
Uso: python3 rf-farmacias-prospect.py farmacias.csv saida.csv [quantidade=200] [excluir.txt]
"""
import collections, csv, re, sys, unicodedata

src, dst = sys.argv[1], sys.argv[2]
LIMIT = int(sys.argv[3]) if len(sys.argv) > 3 else 200
EXCLUDE = set()
if len(sys.argv) > 4:
    EXCLUDE = {re.sub(r"\D", "", l)[-11:] for l in open(sys.argv[4], encoding="utf-8") if l.strip()}

NEAR = ["Rio Verde", "Santa Helena De Goias", "Montividiu", "Acreuna", "Santo Antonio Da Barra", "Maurilandia", "Castelandia",
        "Turvelandia", "Parauna", "Jatai", "Quirinopolis", "Mineiros", "Cacu", "Aparecida Do Rio Doce", "Cachoeira Alta",
        "Caiaponia", "Serranopolis", "Chapadao Do Ceu", "Perolandia", "Itaruma", "Palminopolis", "Indiara", "Edeia",
        "Porteirao", "Gouvelandia", "Itaja", "Lagoa Santa", "Paranaiguara", "Sao Simao", "Bom Jesus De Goias",
        "Goiatuba", "Itumbiara", "Pontalina", "Joviania", "Morrinhos", "Caldas Novas"]
CHAINS = re.compile(r"DROGASIL|DROGA ?RAIA|\bRAIA\b|PAGUE ?MENOS|PACHECO|DROGARIA ?S(AO|\.) ?PAULO|ARAUJO|ULTRA ?POPULAR|NISSEI|DROGAL\b|"
                    r"ROSARIO|BIFARMA|INDIANA|EXTRAFARMA|PANVEL|SANTA ?MARTA|FARMAIS|DROGAO ?SUPER|MINAS ?BRASIL|VENANCIO|"
                    r"MAIS ?ECONOMICA|PRECO ?POPULAR|FARMACIA ?DO ?TRABALHADOR|DROGARIAS? ?GLOBO|TAMOIO|FARMAPONTE|DROGASMIL|"
                    r"REDE ?FARMA|FARMACIAS ?ASSOCIADAS|FARMELHOR|DROGARIA ?ROCHA|BRASIL ?POPULAR|DROGAVET")
LEGAL = re.compile(r"\b(LTDA|EIRELI|EPP|ME|S/?A|SOCIEDADE|COMERCIO|COMERCIAL|DE PRODUTOS|PRODUTOS FARMACEUTICOS)\b\.?", re.I)


def plain(s):
    return unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().upper().strip()


def mobile(num):
    d = re.sub(r"\D", "", num or "")
    if len(d) == 10 and d[2] in "6789":
        d = d[:2] + "9" + d[2:]
    return d if len(d) == 11 and d[2] == "9" else None


def nice(name):
    n = re.sub(r"\s+", " ", LEGAL.sub(" ", name or "")).strip(" -.,")
    # razão social de pessoa ("J R DE SOUZA ME") não serve na mensagem: aí fica "farmácia"
    if len(n) < 4 or not re.search(r"FARM|DROG|PHARM|MEDIC|SAUDE|REMED|BOTICA", plain(n)):
        return ""
    words = [w if w in ("da", "de", "do", "das", "dos", "e") else ACCENT.get(w, w.capitalize()) for w in n.lower().split()]
    return " ".join(words)


ACCENT = {"farmacia": "Farmácia", "farmacias": "Farmácias", "sao": "São", "jose": "José", "saude": "Saúde", "joao": "João",
          "economica": "Econômica", "familia": "Família", "drogao": "Drogão", "vitoria": "Vitória", "antonio": "Antônio",
          "conceicao": "Conceição", "pratica": "Prática", "remedio": "Remédio", "remedios": "Remédios", "mae": "Mãe", "medica": "Médica"}


rows = list(csv.DictReader(open(src, encoding="utf-8"), delimiter=";"))
by_base = collections.Counter(r["cnpj"][:8] for r in rows)
by_name = collections.Counter(plain(r["nome"]) for r in rows)
phones = collections.Counter()
for r in rows:
    for p in {mobile(r["telefone"]), mobile(r.get("telefone2"))} - {None}:
        phones[p] += 1

near_rank = {plain(c): i for i, c in enumerate(NEAR)}
# DDDs aceitos, em ordem de prioridade (padrão: sudoeste goiano e Triângulo Mineiro). Ex.: DDDS=64,34,62
import os
DDDS = [d.strip() for d in os.environ.get("DDDS", "64,34").split(",") if d.strip()]
out, seen = [], set()
for r in rows:
    if r["uf"] not in ("GO", "MG", "DF", "MS", "MT"):
        continue
    p = mobile(r["telefone"]) or mobile(r.get("telefone2"))
    if not p or p[:2] not in DDDS or p in seen or p in EXCLUDE or phones[p] > 1:
        continue
    nm = plain(r["nome"])
    if re.search(r"^REDE |MANIPULA|ASSOCIADAS", nm) or re.search(r"(\d)\1{7}", p):
        continue
    if by_base[r["cnpj"][:8]] >= 3 or CHAINS.search(nm) or by_name[nm] >= 4:
        continue
    city = plain(r["cidade"])
    prio = near_rank.get(city, 100 + 100 * DDDS.index(p[:2]))
    seen.add(p)
    out.append((prio, r["cidade"], r["nome"], p, r))

out.sort(key=lambda x: (x[0], x[1], x[2]))
with open(dst, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f, delimiter=";")
    w.writerow(["nome", "empresa", "telefone", "cidade", "uf", "bairro", "cnpj"])
    for _, _, _, p, r in out[:LIMIT]:
        w.writerow([r["nome"].strip(), nice(r["nome"]) or "farmácia", "55" + p, r["cidade"], r["uf"], r["bairro"], r["cnpj"]])
print("candidatas", len(out), "gravadas", min(LIMIT, len(out)), dst)
print("por prioridade:", collections.Counter("perto" if x[0] < 100 else "DDD 64" if x[0] == 100 else "DDD 34" for x in out[:LIMIT]))
