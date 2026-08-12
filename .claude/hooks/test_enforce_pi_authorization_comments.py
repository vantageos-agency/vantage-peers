#!/usr/bin/env python3
"""Suite adversariale — bypass par COMMENTAIRE sur enforce-pi-authorization-before-prod-deploy.

BLOCKER remonte par Eta (Day 128), reproduit de la main de Pi contre le CANONIQUE VR
@26a4bb26dda34a1341b15a2081af62822579747a77a3794df077e82d8edc21c3 (v1.0.7) :

    npx convex deploy --yes # --dev                      -> exit 0   BYPASS
    convex deploy # --dev                                -> exit 0   BYPASS
    npx convex deploy --yes # ...ne pas utiliser --dev   -> exit 0   BYPASS

RACINE : les patterns bare-deploy portent un lookahead negatif `(?![^|;&]*--dev\\b)` qui
scanne TOUTE la ligne. `is_prod_deploy` retire les heredocs et les chaines citees, mais
PAS les commentaires shell. Un `# --dev` — ou n'importe quelle PROSE contenant `--dev` —
desamorce donc le lookahead : le deploy n'est plus reconnu comme prod, et un VRAI deploy
production passe SANS autorisation Pi.

Meme classe que le bypass `# convex dev` de block-deploy-without-qa (corrige le meme
jour) : DECIDER SUR LE TEXTE AU LIEU DE L'ACTION.

Ordre impose par hook-doctrine : les FAIL-OPEN (vraies violations qui doivent bloquer)
AVANT les faux positifs.
"""
import json
import pathlib
import subprocess
import sys

HOOK = pathlib.Path(__file__).with_name("enforce-pi-authorization-before-prod-deploy.py")


def rc(command: str) -> int:
    p = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}),
        capture_output=True, text=True)
    return p.returncode


# ---------------------------------------------------------------------------
# FAIL-OPEN D'ABORD — un VRAI deploy prod sans autorisation DOIT bloquer (exit 2).
# ---------------------------------------------------------------------------

def test_deploy_nu_bloque():
    assert rc("npx convex deploy --yes") == 2


def test_bypass_commentaire_dev():
    """LE BUG. `# --dev` en commentaire desamorcait le lookahead."""
    assert rc("npx convex deploy --yes # --dev") == 2


def test_bypass_commentaire_dev_sans_npx():
    assert rc("convex deploy # --dev") == 2


def test_bypass_prose_contenant_dev():
    """N'importe quelle PROSE contenant --dev suffisait."""
    assert rc("npx convex deploy --yes # deploying to production, do not use --dev here") == 2


def test_bypass_commentaire_apres_chaine():
    assert rc("cd apps && npx convex deploy --yes # --dev") == 2


def test_bypass_sudo_avec_commentaire():
    assert rc("sudo npx convex deploy --yes # --dev") == 2


# ---------------------------------------------------------------------------
# FAUX POSITIFS ENSUITE — ce qui ne DOIT PAS bloquer.
# ---------------------------------------------------------------------------

def test_vrai_dev_passe():
    """Un VRAI `--dev` (pas dans un commentaire) reste autorise."""
    assert rc("npx convex deploy --dev") == 0


def test_grep_lecture_seule_passe():
    assert rc('grep -rn "convex deploy" CLAUDE.md') == 0


def test_prose_dans_commit_passe():
    assert rc('git commit -m "note: convex deploy a faire apres la QA"') == 0


def test_override_laurent_passe():
    assert rc("npx convex deploy --yes # laurent-direct-deploy") == 0


# ---------------------------------------------------------------------------
# FAIL-OPEN STRUCTUREL — un hook fleet ne casse JAMAIS une session.
# ---------------------------------------------------------------------------

def test_stdin_malforme_ne_casse_pas():
    p = subprocess.run([sys.executable, str(HOOK)], input="pas du json",
                       capture_output=True, text=True)
    assert p.returncode == 0
