#!/usr/bin/env python3
"""enforce-full-ids.py — bloque les IDs VP/Convex tronques dans les sorties peer-facing.

INCIDENT (criterion 1): Day 127 (2026-07-10) — 50 issues auto-ouvertes
ArgumentValidationError tasks:getById (#996 -> #1063, du 2026-06-27 au 2026-07-10).
Cause racine: des IDs abreges dans les messages inter-orchestrateurs
("k173j35p", 8 caracteres au lieu des 32 exiges par v.id("tasks")), copies-colles
tels quels dans les tools par le lecteur. L'abrege ne coute rien a l'emetteur,
il plante le lecteur. Verbatim Laurent: "un message ne fixe rien!" +
"c'est stupide d'abrege un ID unique!!!". Root-fix cote frontiere MCP: task
Sigma k179ytke9kzm2671pd6h8kr8hh8a9k9t. Ce hook couvre le cote EMETTEUR.
Memoire feedback: j570qt80dbs64c6dc94nft1sj18a8d9n.

POLITIQUE: tout token qui ressemble a un ID VP/Convex (prefixes observes
k17/k57/k97/j57/js7/jn7/jx7/m97/k9 + alnum) mais fait MOINS de 32 caracteres
est un ID tronque -> BLOCK (exit 2). Les IDs complets (32) passent. Les SHAs
git (hex pur), numeros de PR, ratios, mots normaux ne matchent pas.

OVERRIDE (criterion 3): `// allow-truncated-id: <raison >= 6 chars>` dans le
meme champ — reserve aux citations verbatim de logs/messages historiques.

Wired (criterion 4, pas d'overlap sur cette sous-politique): PreToolUse sur
send_message, create_task, update_task, complete_task, create_briefing_note,
store_memory, create_mission, block_task.
"""
import json
import re
import sys

# Prefixes reels observes sur les IDs Convex VP (tables tasks/memories/messages/
# briefings/missions/components). Un ID complet fait exactement 32 chars alnum.
ID_PREFIX = r"(?:k(?:1|5|9)[0-9]|j(?:5|s|n|x)[0-9]|m9[0-9])"
# Candidat: commence comme un ID VP, longueur totale 6..31 -> tronque.
TRUNCATED_RE = re.compile(
    r"\b" + ID_PREFIX + r"[a-z0-9]{3,28}\b"
)
FULL_LEN = 32

OVERRIDE_RE = re.compile(r"//\s*allow-truncated-id:\s*\S{6,}")

# Champs texte a inspecter selon le tool.
TEXT_FIELDS = ("content", "description", "completionNote", "brief", "title",
               "reason", "note", "summary", "objective")


def find_truncated(text: str):
    hits = []
    for m in TRUNCATED_RE.finditer(text):
        token = m.group(0)
        if len(token) == FULL_LEN:
            continue  # ID complet — legal
        # Exclure les tokens purement hexadecimaux (SHAs git) : un SHA court
        # comme "e0db4fd" ou "542136f" ne contient que [0-9a-f].
        if re.fullmatch(r"[0-9a-f]+", token):
            continue
        hits.append(token)
    return hits


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # fail-open sur payload illisible

    tool_input = payload.get("tool_input") or {}
    blob = "\n".join(str(tool_input.get(f, "")) for f in TEXT_FIELDS)

    if OVERRIDE_RE.search(blob):
        sys.exit(0)

    hits = find_truncated(blob)
    if not hits:
        sys.exit(0)

    uniq = sorted(set(hits))
    sys.stderr.write(
        "BLOCKED: ID(s) VP/Convex tronque(s) detecte(s): "
        + ", ".join(uniq)
        + f". Un ID complet fait {FULL_LEN} caracteres — copie-le depuis la "
        "sortie d'un tool, ne le retape jamais, ne l'abrege jamais "
        "(Day 127: 50 issues ArgumentValidationError causees par des IDs "
        "abreges repasses aux tools). Si citation verbatim d'un log "
        "historique: `// allow-truncated-id: <raison>`.\n"
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
