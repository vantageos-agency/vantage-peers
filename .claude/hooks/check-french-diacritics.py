#!/usr/bin/env python3
"""PostToolUse hook: detect missing French diacritics in .md files.
Warns (does not block) when French content has suspected missing accents.
"""
import json
import re
import sys

# Maps unaccented form (lowercase) to the correct accented form.
# Ordered longest-first to avoid partial matches when iterating.
DIACRITICS_PATTERNS = [
    ("responsabilite", "responsabilité"),
    ("fonctionnalite", "fonctionnalité"),
    ("disponibilite", "disponibilité"),
    ("referencement", "référencement"),
    ("particuliere", "particulière"),
    ("interessant", "intéressant"),
    ("amelioration", "amélioration"),
    ("developpement", "développement"),
    ("financiere", "financière"),
    ("communaute", "communauté"),
    ("possibilite", "possibilité"),
    ("opportunite", "opportunité"),
    ("regularite", "régularité"),
    ("specialite", "spécialité"),
    ("regulariere", "régulière"),
    ("reguliere", "régulière"),
    ("etrangere", "étrangère"),
    ("creativite", "créativité"),
    ("necessite", "nécessité"),
    ("activite", "activité"),
    ("identite", "identité"),
    ("autorite", "autorité"),
    ("integrite", "intégrité"),
    ("visibilite", "visibilité"),
    ("fiabilite", "fiabilité"),
    ("propriete", "propriété"),
    ("capacite", "capacité"),
    ("strategie", "stratégie"),
    ("categorie", "catégorie"),
    ("societe", "société"),
    ("liberte", "liberté"),
    ("realite", "réalité"),
    ("securite", "sécurité"),
    ("qualite", "qualité"),
    ("ameliorer", "améliorer"),
    ("developper", "développer"),
    ("experience", "expérience"),
    ("evenement", "événement"),
    ("different", "différent"),
    ("etrangere", "étrangère"),
    ("derniere", "dernière"),
    ("premiere", "première"),
    ("maniere", "manière"),
    ("matiere", "matière"),
    ("lumiere", "lumière"),
    ("carriere", "carrière"),
    ("riviere", "rivière"),
    ("entiere", "entière"),
    ("prefere", "préféré"),
    ("preferee", "préférée"),
    ("generee", "générée"),
    ("genere", "généré"),
    ("creee", "créée"),
    ("element", "élément"),
    ("systeme", "système"),
    ("probleme", "problème"),
    ("memoire", "mémoire"),
    ("methode", "méthode"),
    ("modele", "modèle"),
    ("reponse", "réponse"),
    ("reseau", "réseau"),
    ("resume", "résumé"),
    ("etait", "était"),
    ("etais", "étais"),
    ("cree", "créé"),
    ("deja", "déjà"),
    ("ete", "été"),
]

# French detection: presence of at least 3 of these common French words
FRENCH_MARKERS = [
    "le", "la", "les", "des", "une", "est", "dans", "pour",
    "avec", "qui", "que", "sur", "par", "nous", "vous", "sont",
    "mais", "aussi", "cette", "entre",
]


def is_likely_french(text: str) -> bool:
    """Return True if text contains at least 3 common French words."""
    text_lower = text.lower()
    hits = 0
    for marker in FRENCH_MARKERS:
        if re.search(r"\b" + re.escape(marker) + r"\b", text_lower):
            hits += 1
            if hits >= 3:
                return True
    return False


def find_missing_diacritics(text: str) -> list[str]:
    """Return a list of warning strings, one per finding (max 20)."""
    lines = text.splitlines()
    findings: list[str] = []

    for lineno, line in enumerate(lines, start=1):
        line_lower = line.lower()
        for wrong, correct in DIACRITICS_PATTERNS:
            pattern = r"\b" + re.escape(wrong) + r"\b"
            if re.search(pattern, line_lower, re.IGNORECASE):
                # Find the actual token as it appears in the original line
                match = re.search(pattern, line, re.IGNORECASE)
                actual = match.group(0) if match else wrong
                findings.append(f"  - Line {lineno}: '{actual}' → '{correct}'")
                if len(findings) >= 20:
                    return findings

    return findings


def main() -> None:
    try:
        input_data = json.load(sys.stdin)

        tool_name = input_data.get("tool_name", "")
        if tool_name not in ("Write", "Edit"):
            print(json.dumps({}))
            sys.exit(0)

        tool_input = input_data.get("tool_input", {})
        file_path: str = tool_input.get("file_path", "")
        if not file_path.endswith(".md"):
            print(json.dumps({}))
            sys.exit(0)

        # Choose the right field depending on the tool
        if tool_name == "Write":
            content = tool_input.get("content", "")
        else:
            content = tool_input.get("new_string", "")

        if not content:
            print(json.dumps({}))
            sys.exit(0)

        if not is_likely_french(content):
            print(json.dumps({}))
            sys.exit(0)

        findings = find_missing_diacritics(content)
        if not findings:
            print(json.dumps({}))
            sys.exit(0)

        # Count total matches to report truncation
        total = len(findings)
        displayed = findings[:20]

        short_name = file_path.split("/")[-1]
        header = f"[French Diacritics Warning] Found {total} suspected missing accent(s) in {short_name}:"
        body = "\n".join(displayed)
        if total > 20:
            body += f"\n  ...and {total - 20} more"

        result = {
            "hookSpecificOutput": {
                "additionalContext": f"{header}\n{body}"
            }
        }
        print(json.dumps(result))

    except Exception:
        print(json.dumps({}))

    sys.exit(0)


if __name__ == "__main__":
    main()
