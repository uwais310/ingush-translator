#!/usr/bin/env python3
"""Download open Ingush–Russian sources and save them as data/sources/*.json.

Only sources with an open license (CC0, CC BY, CC BY-SA) are used. Nothing here is generated
by an AI: every pair is copied from the source and carries its source and license.
Run:  python3 scripts/fetch-open-sources.py [cache_dir]     (needs ~1 GB of free disk for the cache)
then: node scripts/build-phrases.js                          (merges, cleans and checks everything)

Sources (see SOURCES.md):
  panlex      PanLex (via huggingface.co/datasets/cointegrated/panlex-meanings), CC0
  ruwikt      Russian Wiktionary: Ingush entries (kaikki.org extract) + Ingush translations
              in Russian entries (ruwiktionary dump), CC BY-SA 4.0
  inhwiki     Ingush Wikipedia article titles linked to Russian Wikipedia, CC BY-SA 4.0
  wikidata    Wikidata items whose Ingush label differs from the Russian one (qlever.dev), CC0
  translatewiki  MediaWiki interface messages (OPUS translatewiki en-inh + en-ru, pivot on the
              same English message), CC BY 3.0
"""
import bz2, csv, gzip, json, os, re, sys, time, urllib.parse, urllib.request, zipfile
from collections import Counter, defaultdict
from xml.etree.ElementTree import iterparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "sources")
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, ".cache-sources")
UA = {"User-Agent": "ingush-translator-dictionary-builder/1.0 (github.com/uwais310/ingush-translator)"}
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)
CYR = re.compile(r"[А-Яа-яЁёӀӏ]")
LAT = re.compile(r"[A-Za-z]")


def get(url, name):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print("download", url, flush=True)
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=600) as r, open(path + ".part", "wb") as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
        os.rename(path + ".part", path)
    return path


def clean(s):
    s = re.sub(r"<!--.*?-->", " ", str(s or ""))
    s = s.replace("\u00ad", "").replace("\u200b", "").replace("\u0301", "")
    return re.sub(r"\s+", " ", s).strip()


LOOK = "1Il|ІіΙⅠǀ"
PAL = re.compile("([\u0400-\u04FF])[" + LOOK + "]|[" + LOOK + "](?=[\u0400-\u04FF])")


NOT_INH = re.compile("[іїєўґЇЄЎҐђћјљњџѓќЂЋЈЉЊЏЃЌ]|[сцз]ьк[аиоийяу]")


def fix_pal(s):
    """Palochka look-alikes (1, I, l, |, Ukrainian і …) next to Cyrillic letters -> Ӏ (U+04C0)."""
    s = s.replace("ӏ", "Ӏ")
    return PAL.sub(lambda m: (m.group(1) or "") + "Ӏ", s)


def save(name, source, license_, url, pairs, note=""):
    seen, out = set(), []
    for p in pairs:
        if NOT_INH.search(p["inh"]):  # Ukrainian/Belarusian letters: a label copied from another language
            continue
        ru, inh = clean(p["ru"]), fix_pal(clean(p["inh"]))
        if not ru or not inh or not CYR.search(inh) or not CYR.search(ru):
            continue
        if LAT.search(inh) or len(inh) > 300 or len(ru) > 300:
            continue
        k = (ru.lower(), inh.lower())
        if k in seen:
            continue
        seen.add(k)
        q = {"kind": p.get("kind", "word"), "ru": ru, "inh": inh}
        if p.get("note"):
            q["note"] = clean(p["note"])
        out.append(q)
    data = {"source": source, "license": license_, "url": url, "note": note, "pairs": out}
    with open(os.path.join(OUT, name + ".json"), "w", encoding="utf-8") as f:
        f.write("{\n" + ",\n".join(f"{json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}" for k, v in data.items() if k != "pairs"))
        f.write(',\n"pairs": [\n' + ",\n".join(json.dumps(x, ensure_ascii=False) for x in out) + "\n]}\n")
    print(f"{name}: {len(out)} pairs", Counter(x["kind"] for x in out), flush=True)


def is_name(ru, inh):
    return ru[:1].isupper() and inh[:1].isupper()


# ---------------- PanLex (CC0) ----------------
def panlex():
    base = "https://huggingface.co/datasets/cointegrated/panlex-meanings/resolve/main/data/"
    inh = [r for r in csv.DictReader(open(get(base + "inh.tsv", "panlex-inh.tsv"), encoding="utf-8"), delimiter="\t")
           if r["langvar_uid"] == "inh-000" and CYR.search(r["txt"])]
    meanings = {r["meaning"] for r in inh}
    rus = defaultdict(list)
    for r in csv.DictReader(open(get(base + "rus.tsv", "panlex-rus.tsv"), encoding="utf-8"), delimiter="\t"):
        if r["meaning"] in meanings and r["langvar_uid"] == "rus-000" and CYR.search(r["txt"]):
            rus[r["meaning"]].append(r["txt"])
    pairs = []
    for r in inh:
        for t in rus.get(r["meaning"], []):
            pairs.append({"kind": "name" if is_name(t, r["txt"]) else "word", "ru": t, "inh": r["txt"]})
    save("panlex", "PanLex", "CC0 1.0", "https://panlex.org (dump 2024-03-01 via huggingface.co/datasets/cointegrated/panlex-meanings)", pairs,
         "Ingush (inh-000) and Russian (rus-000) expressions that share a PanLex meaning id.")


# ---------------- Russian Wiktionary (CC BY-SA 4.0) ----------------
LABEL = re.compile(r"^((?:[а-яё]+\.\s*)+)")
NAMEGLOSS = re.compile(r"^(мужское|женское) имя$|^фамилия$")


def gloss_split(g):
    g = clean(g)
    note = ""
    m = LABEL.match(g)
    if m:
        note, g = m.group(1).strip(), g[m.end():].strip()
    g = re.sub(r"\s*\([^()]*\)\s*", " ", g).strip(" ;,.")
    parts = [x.strip(" ,.") for x in re.split(r";", g)]
    out = []
    for p in parts:
        if not p:
            continue
        sub = [x.strip() for x in p.split(",")]
        out += sub if all(len(x.split()) <= 2 for x in sub) else [p]
    return [x for x in out if x], note


def wikilinks(v):
    """'[[кӀай]]; [[сийрда]]' / '[[хи|хьи]]' -> ['кӀай', 'сийрда']"""
    out = []
    for m in re.finditer(r"\[\[([^\[\]]+)\]\]", v):
        t = m.group(1).split("|")[-1].split("#")[0].strip()
        if t:
            out.append(t)
    rest = re.sub(r"\[\[[^\[\]]+\]\]", "", v)
    if not out and not re.search(r"[{}\[\]=]", v):
        out = [x.strip() for x in re.split(r"[;,]", v) if x.strip()]
    elif re.search(r"[{}]", rest):
        return []
    return out


def ruwikt():
    pairs = []
    path = get("https://kaikki.org/ruwiktionary/%D0%98%D0%BD%D0%B3%D1%83%D1%88%D1%81%D0%BA%D0%B8%D0%B9/kaikki.org-dictionary-%D0%98%D0%BD%D0%B3%D1%83%D1%88%D1%81%D0%BA%D0%B8%D0%B9.jsonl", "ruwikt-inh.jsonl")
    names = 0
    for line in open(path, encoding="utf-8"):
        d = json.loads(line)
        w = d["word"]
        for s in d.get("senses", []):
            for g in s.get("glosses", []):
                if NAMEGLOSS.match(clean(g)):
                    names += 1
                    continue
                parts, note = gloss_split(g)
                for p in parts:
                    pairs.append({"kind": "name" if is_name(p, w) else "word", "ru": p, "inh": w, "note": note})
            for e in s.get("examples", []):
                if e.get("text") and e.get("translation"):
                    pairs.append({"kind": "phrase", "ru": e["translation"], "inh": e["text"]})
    print("ruwikt: personal-name entries skipped:", names)
    # translations of Russian headwords into Ingush (перев-блок |inh=...)
    dump = get("https://dumps.wikimedia.org/ruwiktionary/latest/ruwiktionary-latest-pages-articles.xml.bz2", "ruwiktionary.xml.bz2")
    title = ns = None
    for ev, el in iterparse(bz2.open(dump), events=("end",)):
        tag = el.tag.rsplit("}", 1)[-1]
        if tag == "title":
            title = el.text
        elif tag == "ns":
            ns = el.text
        elif tag == "text":
            t = el.text or ""
            if ns == "0" and "|inh=" in t:
                m = re.search(r"=\s*\{\{-ru-\}\}\s*=(.*?)(?=\n=\s*\{\{-[a-z-]+-\}\}\s*=|\Z)", t, re.S)
                for mm in re.finditer(r"^\|inh=(.*)$", m.group(1) if m else "", re.M):
                    v = clean(mm.group(1))
                    for w in wikilinks(v):
                        pairs.append({"kind": "name" if is_name(title, w) else "word", "ru": title, "inh": w})
        elif tag == "page":
            el.clear()
    save("ruwiktionary", "Викисловарь (ru.wiktionary.org)", "CC BY-SA 4.0", "https://ru.wiktionary.org (Категория:Ингушский язык и переводы |inh= в русских статьях)", pairs,
         "Ingush headwords with their Russian definitions, and Ingush translations listed in Russian entries.")


# ---------------- Ingush Wikipedia titles ↔ Russian Wikipedia (CC BY-SA 4.0) ----------------
def strip_title(s):
    s = clean(s)
    m = re.match(r"^(.*?)\s*\(([^()]*)\)$", s)
    return (m.group(1), m.group(2)) if m else (s, "")


def inhwiki():
    path = os.path.join(CACHE, "inhwiki-ru.json")
    if not os.path.exists(path):
        ll, cont = {}, {}
        while True:
            p = {"action": "query", "generator": "allpages", "gapnamespace": 0, "gapfilterredir": "nonredirects", "gaplimit": "max",
                 "prop": "langlinks", "lllang": "ru", "lllimit": "max", "format": "json", **cont}
            req = urllib.request.Request("https://inh.wikipedia.org/w/api.php?" + urllib.parse.urlencode(p), headers=UA)
            d = json.load(urllib.request.urlopen(req, timeout=60))
            for pg in d.get("query", {}).get("pages", {}).values():
                for l in pg.get("langlinks", []):
                    ll[pg["title"]] = l["*"]
            if "continue" not in d:
                break
            cont = d["continue"]
            time.sleep(0.5)
        json.dump(ll, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    ll = json.load(open(path, encoding="utf-8"))
    pairs = []
    for inh, ru in ll.items():
        i, inote = strip_title(inh)
        r, rnote = strip_title(ru)
        if not r or re.search(r"\d", i + r) or i == r or ":" in i:
            continue
        if "," in r and is_name(r, i):  # «Чахкиев, Саид Идрисович» -> «Саид Идрисович Чахкиев»
            a, b = r.split(",", 1)
            r = f"{b.strip()} {a.strip()}"
        pairs.append({"kind": "name" if is_name(r, i) else "word", "ru": r, "inh": i, "note": rnote or inote})
    save("inhwiki", "Ингушская Википедия (inh.wikipedia.org)", "CC BY-SA 4.0", "https://inh.wikipedia.org (названия статей и межъязыковые ссылки на ru.wikipedia.org)", pairs,
         "Titles of Ingush Wikipedia articles and the titles of the Russian articles they link to.")


# ---------------- Wikidata labels (CC0) ----------------
def wikidata():
    path = os.path.join(CACHE, "wikidata-inh-ru.tsv")
    if not os.path.exists(path):
        q = ('PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> SELECT ?i ?l ?r WHERE { ?i rdfs:label ?l . FILTER(LANG(?l)="inh") '
             '?i rdfs:label ?r . FILTER(LANG(?r)="ru") }')
        req = urllib.request.Request("https://qlever.dev/api/wikidata?" + urllib.parse.urlencode({"query": q}),
                                     headers={**UA, "Accept": "text/tab-separated-values"})
        open(path, "wb").write(urllib.request.urlopen(req, timeout=300).read())
    pairs = []
    for line in open(path, encoding="utf-8").read().split("\n")[1:]:
        p = line.split("\t")
        if len(p) < 3:
            continue
        inh = re.sub(r'^"|"@inh$', "", p[1]).replace('\\"', '"')
        ru = re.sub(r'^"|"@ru$', "", p[2]).replace('\\"', '"')
        if inh == ru or ":" in inh or ":" in ru or re.search(r"\d", inh + ru):
            continue
        i, inote = strip_title(inh)
        r, rnote = strip_title(ru)
        if i == r:
            continue
        if "," in r and is_name(r, i):
            a, b = r.split(",", 1)
            r = f"{b.strip()} {a.strip()}"
        pairs.append({"kind": "name" if is_name(r, i) else "word", "ru": r, "inh": i, "note": rnote or inote})
    save("wikidata", "Викиданные (wikidata.org)", "CC0 1.0", "https://www.wikidata.org (ингушские и русские подписи элементов, через qlever.dev)", pairs,
         "Wikidata items whose Ingush label differs from the Russian label (identical copies are skipped).")


# ---------------- translatewiki.net via OPUS (CC BY 3.0) ----------------
def translatewiki():
    def load(url, name):
        z = zipfile.ZipFile(get(url, name))
        files = {n.rsplit(".", 1)[-1]: z.read(n).decode("utf-8").split("\n") for n in z.namelist() if n.startswith("translatewiki.")}
        return files
    ei = load("https://object.pouta.csc.fi/OPUS-translatewiki/v2026-07-01/moses/en-inh.txt.zip", "tw-en-inh.zip")
    er = load("https://object.pouta.csc.fi/OPUS-translatewiki/v2026-07-01/moses/en-ru.txt.zip", "tw-en-ru.zip")
    ru = defaultdict(Counter)
    for e, r in zip(er["en"], er["ru"]):
        ru[e][r] += 1
    pairs = []
    MARKUP = re.compile(r"[$%{}<>\[\]|=_~#@\\/&]|https?:")
    for e, i in zip(ei["en"], ei["inh"]):
        if e not in ru or len(ru[e]) != 1:  # the English message must have exactly one Russian translation
            continue
        r = next(iter(ru[e]))
        if MARKUP.search(e + i + r) or i == r:
            continue
        kind = "phrase" if len(r.split()) >= 3 or len(i.split()) >= 3 else "word"
        pairs.append({"kind": kind, "ru": r.rstrip(":"), "inh": i.rstrip(":")})
    save("translatewiki", "translatewiki.net (интерфейс MediaWiki)", "CC BY 3.0", "https://translatewiki.net (через OPUS: opus.nlpl.eu/translatewiki, en-inh и en-ru)", pairs,
         "Interface messages; Ingush and Russian are paired through the identical English original.")


if __name__ == "__main__":
    which = sys.argv[2:] or ["panlex", "ruwikt", "inhwiki", "wikidata", "translatewiki"]
    for w in which:
        globals()[w]()
