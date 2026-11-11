#!/usr/bin/env python3
"""Limpa a saída de rf-farmacias.py e gera a lista pronta para o Discador do CRM.

- descarta DDD inexistente e números com formato inválido;
- celular antigo de 8 dígitos (começando com 6-9) ganha o 9º dígito;
- descarta telefones compartilhados por mais de MAX_SHARED estabelecimentos
  (normalmente escritório de contabilidade ou matriz, não a loja);
- remove números repetidos (fica um registro por telefone);
- formata (DD) NNNN-NNNN / (DD) 9NNNN-NNNN, UTF-8 com BOM e separador ';'
  (abre certo no Excel e importa direto em Discador > Importar números).

Uso: python3 rf-farmacias-lista.py entrada.csv saida.csv [MAX_SHARED=3]
"""
import collections, csv, re, sys

DDDS = {11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49,
        51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89,
        91, 92, 93, 94, 95, 96, 97, 98, 99}
src, dst = sys.argv[1], sys.argv[2]
MAX_SHARED = int(sys.argv[3]) if len(sys.argv) > 3 else 3


def clean(num):
    d = re.sub(r"\D", "", num or "")
    if len(d) not in (10, 11) or int(d[:2]) not in DDDS:
        return None
    local = d[2:]
    if len(local) == 8 and local[0] in "6789":
        # celular cadastrado antes da inclusão do 9º dígito (2012–2016): acrescenta o 9
        local = "9" + local
        d = d[:2] + local
    if len(local) == 9 and local[0] != "9":
        return None
    if len(local) == 8 and local[0] not in "2345":  # fixo começa com 2-5
        return None
    if len(set(local)) == 1:
        return None
    return d


def fmt(d):
    return f"({d[:2]}) {d[2:7]}-{d[7:]}" if len(d) == 11 else f"({d[:2]}) {d[2:6]}-{d[6:]}"


rows = list(csv.DictReader(open(src, encoding="utf-8"), delimiter=";"))
for r in rows:
    r["t1"], r["t2"] = clean(r["telefone"]), clean(r.get("telefone2", ""))
uses = collections.Counter()
for r in rows:
    for t in {r["t1"], r["t2"]} - {None}:
        uses[t] += 1

out, seen = [], set()
stats = collections.Counter(entrada=len(rows))
for r in rows:
    phones = [t for t in (r["t1"], r["t2"]) if t and uses[t] <= MAX_SHARED]
    if not (r["t1"] or r["t2"]):
        stats["formato_invalido"] += 1
        continue
    if not phones:
        stats["telefone_compartilhado"] += 1
        continue
    main = next((t for t in phones if t not in seen), None)
    if not main:
        stats["repetido"] += 1
        continue
    seen.add(main)
    other = next((t for t in phones if t != main), "")
    out.append([r["nome"].strip()[:120], fmt(main), fmt(other) if other else "", r["cidade"], r["uf"], r.get("bairro", ""), r["cnpj"]])

out.sort(key=lambda x: (x[4], x[3], x[0]))
with open(dst, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f, delimiter=";")
    w.writerow(["nome", "telefone", "telefone2", "cidade", "uf", "bairro", "cnpj"])
    w.writerows(out)
stats["saida"] = len(out)
por_uf = collections.Counter(x[4] for x in out)
print("ESTATISTICAS", dict(stats))
print("POR_UF", " ".join(f"{k}:{v}" for k, v in sorted(por_uf.items())))
