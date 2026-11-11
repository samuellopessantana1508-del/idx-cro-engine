#!/usr/bin/env python3
"""Extrai farmácias ativas com telefone da base aberta de CNPJ da Receita Federal.

Fonte: compartilhamento público da Receita (Nextcloud), via WebDAV:
https://arquivos.receitafederal.gov.br/index.php/s/YggdBLfdninEJX9 (pastas AAAA-MM)
CNAE 4771-7/01 (comércio varejista de produtos farmacêuticos, sem manipulação) e,
opcionalmente, 4771-7/02 (com manipulação). Situação cadastral 02 = ativa.

Saída: CSV UTF-8 (separador ;) com: cnpj;nome;telefone;telefone2;cidade;uf;bairro
Uso: python3 rf-farmacias.py [pasta_saida]
"""
import base64, csv, io, os, re, sys, urllib.request, zipfile

BASE = "https://arquivos.receitafederal.gov.br/public.php/webdav"
SHARE = os.environ.get("RF_SHARE", "YggdBLfdninEJX9")  # código público do compartilhamento (não é segredo)
AUTH = "Basic " + base64.b64encode(f"{SHARE}:".encode()).decode()


def req(url, method="GET"):
    r = urllib.request.Request(url, method=method, headers={"Authorization": AUTH, "Depth": "1", "User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(r, timeout=300)
OUT = sys.argv[1] if len(sys.argv) > 1 else "/opt/idx/rf"
CNAES = {"4771701", "4771702"}
os.makedirs(OUT, exist_ok=True)
csv.field_size_limit(10_000_000)


def log(*a):
    print(*a, flush=True)


def latest_month():
    html = req(BASE + "/", "PROPFIND").read().decode("utf-8", "replace")
    months = sorted(set(re.findall(r"20\d{2}-\d{2}", html)))
    return months[-1]


def download(url, dest):
    tmp = dest + ".part"
    with req(url) as r, open(tmp, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    os.replace(tmp, dest)


def rows(zpath):
    with zipfile.ZipFile(zpath) as z:
        for name in z.namelist():
            with z.open(name) as fh:
                text = io.TextIOWrapper(fh, encoding="latin-1", newline="")
                # alguns arquivos da Receita trazem bytes nulos; o leitor de CSV não aceita
                for row in csv.reader((line.replace("\0", "") for line in text), delimiter=";"):
                    yield row


def phone(ddd, num):
    d = re.sub(r"\D", "", ddd or "")
    n = re.sub(r"\D", "", num or "")
    if not d or len(n) < 8:
        return ""
    return d[-2:] + n


month = os.environ.get("RF_MES") or latest_month()
log("MES", month)

# municípios (código -> nome)
mz = os.path.join(OUT, "Municipios.zip")
download(f"{BASE}/{month}/Municipios.zip", mz)
mun = {r[0]: r[1].title() for r in rows(mz) if len(r) >= 2}
os.remove(mz)
log("MUNICIPIOS", len(mun))

import json
found = {}  # cnpj -> dict
for i in range(10):
    cache = os.path.join(OUT, f"estab{i}-{month}.json")
    if os.path.exists(cache):  # arquivo já processado numa execução anterior
        part = json.load(open(cache, encoding="utf-8"))
        found.update(part)
        log("CACHE", i, len(part), "total", len(found))
        continue
    z = os.path.join(OUT, f"Estab{i}.zip")
    log("BAIXANDO Estabelecimentos", i)
    download(f"{BASE}/{month}/Estabelecimentos{i}.zip", z)
    n = 0
    part = {}
    for r in rows(z):
        if len(r) < 28 or r[11] not in CNAES or r[5] != "02":
            continue
        tel = phone(r[21], r[22])
        tel2 = phone(r[23], r[24])
        if not tel and not tel2:
            continue
        cnpj = r[0] + r[1] + r[2]
        part[cnpj] = {
            "base": r[0], "cnpj": cnpj, "nome": (r[4] or "").strip(), "telefone": tel or tel2,
            "telefone2": tel2 if tel else "", "cidade": mun.get(r[20], ""), "uf": r[19], "bairro": (r[17] or "").strip().title(),
        }
        n += 1
    os.remove(z)
    json.dump(part, open(cache, "w", encoding="utf-8"))
    found.update(part)
    log("ARQUIVO", i, "farmacias", n, "total", len(found))

# razão social para quem não tem nome fantasia
need = {v["base"] for v in found.values() if not v["nome"]}
razao = {}
if need:
    for i in range(10):
        z = os.path.join(OUT, f"Emp{i}.zip")
        log("BAIXANDO Empresas", i)
        download(f"{BASE}/{month}/Empresas{i}.zip", z)
        for r in rows(z):
            if r and r[0] in need:
                razao[r[0]] = r[1].strip()
        os.remove(z)
for v in found.values():
    if not v["nome"]:
        v["nome"] = razao.get(v["base"], "Farmácia")

out = os.path.join(OUT, "farmacias.csv")
with open(out, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f, delimiter=";")
    w.writerow(["cnpj", "nome", "telefone", "telefone2", "cidade", "uf", "bairro"])
    for v in sorted(found.values(), key=lambda x: (x["uf"], x["cidade"], x["nome"])):
        w.writerow([v["cnpj"], v["nome"], v["telefone"], v["telefone2"], v["cidade"], v["uf"], v["bairro"]])
log("PRONTO", out, len(found))
