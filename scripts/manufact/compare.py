#!/usr/bin/env python3
"""Compare two Manufact per-tool reviews, tool by tool.

Usage: compare.py decode <page.html> <out.json>
       compare.py diff <old.json> <new.json>

A tool's text counts as unchanged only when both sides are readable and equal.
A long string the page writes once as a text row and references as "$9f" is
resolved at decode; one that still cannot be resolved is reported as
unreadable, never as changed or unchanged.
"""
import collections
import json
import re
import statistics as st
import sys

DIMS = ["title", "description", "schema", "annotations", "output"]
REF = re.compile(r"\$[0-9a-z]+")


ROW = re.compile(rb"([0-9a-f]+):")
TEXT_ROW = re.compile(rb"T([0-9a-f]+),")


def text_rows(blob):
    """The page's length-delimited text rows ("<id>:T<hex byte length>,<text>").

    A long string is not inlined in the payload: it is written once as such a
    row and referenced as "$<id>". The length counts UTF-8 bytes, so the scan
    runs on bytes; a JSON row ends at its newline.
    """
    b, rows, i = blob.encode("utf-8"), {}, 0
    while i < len(b):
        m = ROW.match(b, i)
        if not m:
            j = b.find(b"\n", i)
            i = len(b) if j < 0 else j + 1
            continue
        rid, i = m.group(1).decode(), m.end()
        t = TEXT_ROW.match(b, i)
        if t:
            start = i + t.end() - t.start()
            end = start + int(t.group(1), 16)
            rows[rid] = b[start:end].decode("utf-8", "replace")
            i = end
        else:
            j = b.find(b"\n", i)
            i = len(b) if j < 0 else j + 1
    return rows


def resolve(value, texts):
    """Replace every "$<id>" string that names a text row by that row's text."""
    if isinstance(value, dict):
        return {k: resolve(v, texts) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v, texts) for v in value]
    if isinstance(value, str) and REF.fullmatch(value) and value[1:] in texts:
        return texts[value[1:]]
    return value


def decode(page, out):
    html = open(page, encoding="utf-8", errors="replace").read()
    chunks = re.findall(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)', html)
    blob = "".join(json.loads('"' + c + '"') for c in chunks)
    texts = text_rows(blob)
    dec, seen = json.JSONDecoder(), {}
    for m in re.finditer(r'\{"tool":\{', blob):
        try:
            obj, _ = dec.raw_decode(blob[m.start():])
        except ValueError:
            continue
        if isinstance(obj, dict) and "result" in obj:
            seen[obj["tool"].get("name")] = resolve(obj, texts)
    if not seen:
        sys.exit("COULD-NOT-JUDGE: no tool entry decoded from the page")
    json.dump(list(seen.values()), open(out, "w", encoding="utf-8"), ensure_ascii=False)
    print("decoded tools:", len(seen))


def load(path):
    return {o["tool"]["name"]: o for o in json.load(open(path, encoding="utf-8"))}


def score(o, k):
    return o["result"]["dimensions"].get(k, {}).get("score")


def unreadable(o):
    d = o["tool"].get("description")
    return isinstance(d, str) and REF.fullmatch(d) is not None


def summary(label, rows):
    if not rows:
        print(f"{label}: none")
        return
    print(f"{label}: {len(rows)} tools, mean {st.mean(rows):+.2f}, min {min(rows):+d}, max {max(rows):+d}, moved {sum(x != 0 for x in rows)}")


def diff(old_path, new_path):
    old, new = load(old_path), load(new_path)
    both = [n for n in new if n in old]
    print("tools old", len(old), "new", len(new), "only new", sorted(set(new) - set(old)), "only old", sorted(set(old) - set(new)))
    for k in DIMS:
        a = [score(o, k) for o in old.values() if score(o, k) is not None]
        b = [score(o, k) for o in new.values() if score(o, k) is not None]
        print(f"{k}: mean {st.mean(a):.2f} -> {st.mean(b):.2f}, at 100: {sum(x == 100 for x in a)} -> {sum(x == 100 for x in b)}")
    bad = [n for n in both if unreadable(old[n]) or unreadable(new[n])]
    print("unreadable text, not classified:", bad)
    clean = [n for n in both if n not in bad]
    sets = {
        "text changed": [n for n in clean if old[n]["tool"] != new[n]["tool"]],
        "text unchanged": [n for n in clean if old[n]["tool"] == new[n]["tool"]],
    }
    for k in DIMS:
        for label, names in sets.items():
            summary(f"{k} / {label}", [score(new[n], k) - score(old[n], k) for n in names if score(new[n], k) is not None and score(old[n], k) is not None])
    print("--- every regression on a tool whose text changed")
    for k in DIMS:
        rows = [(score(new[n], k) - score(old[n], k), n) for n in sets["text changed"] if score(new[n], k) is not None and score(old[n], k) is not None]
        for delta, n in sorted(r for r in rows if r[0] < 0):
            fb = new[n]["result"]["dimensions"][k].get("feedback", "")[:90]
            print(f"{delta:+d} {k} {n}: {score(old[n], k)} -> {score(new[n], k)} | {fb}")
    print("--- feedback under 100, today")
    c = collections.Counter()
    for o in new.values():
        for k in DIMS:
            d = o["result"]["dimensions"].get(k)
            if d and d["score"] < 100:
                c[(k, d.get("feedback", "")[:90])] += 1
    for (k, f), v in c.most_common():
        print(v, k, "|", f)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "decode":
        decode(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 4 and sys.argv[1] == "diff":
        diff(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
