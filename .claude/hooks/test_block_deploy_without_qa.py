#!/usr/bin/env python3
"""Suite adversariale de block-deploy-without-qa.

Ordre imposé par hook-doctrine.md : les cas FAIL-OPEN (vraies violations qui
DOIVENT bloquer) viennent AVANT les cas faux-positif. Une suite qui ne teste
que la classe d'erreur que l'auteur veut corriger ne mesure rien.
"""
import importlib.util
import json
import os
import subprocess
import sys
import time
import pathlib

HOOK = pathlib.Path(__file__).with_name("block-deploy-without-qa.py")
BREADCRUMB = "/tmp/.qa-passed"


def run(cmd, qa_ok=False):
    """Retourne le code de sortie du hook pour une commande Bash donnée."""
    if qa_ok:
        pathlib.Path(BREADCRUMB).touch()
    else:
        try:
            os.remove(BREADCRUMB)
        except FileNotFoundError:
            pass
    p = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}}),
        capture_output=True,
        text=True,
    )
    return p.returncode


# ---------------------------------------------------------------------------
# FAIL-OPEN D'ABORD — vraies violations : un deploy prod sans QA DOIT bloquer.
# ---------------------------------------------------------------------------

def test_deploy_nu_bloque():
    assert run("npx convex deploy --yes") == 2


def test_bypass_par_commentaire_convex_dev():
    """LE BUG. `# convex dev` en commentaire ouvrait le garde-fou (rc=0)."""
    assert run("npx convex deploy --yes # convex dev") == 2


def test_bypass_par_commentaire_dry_run():
    assert run("npx convex deploy --yes # --dry-run") == 2


def test_bypass_par_commentaire_preview():
    assert run("npx convex deploy --yes  # --preview plus tard") == 2


def test_bypass_par_chaine_dans_une_autre_chaine():
    assert run('npx convex deploy --yes --note "convex dev"') == 2


def test_bypass_sudo():
    assert run("sudo npx convex deploy --yes") == 2


def test_bypass_env_prefix():
    assert run("CONVEX_DEPLOY_KEY=x npx convex deploy --yes") == 2


def test_bypass_bash_c():
    assert run('bash -c "npx convex deploy --yes"') == 2


def test_bypass_eval():
    assert run('eval "npx convex deploy --yes"') == 2


def test_bypass_chaine_and():
    assert run("touch /tmp/x && npx convex deploy --yes") == 2


def test_bypass_chaine_semicolon():
    assert run("echo hop ; npx convex deploy --yes") == 2


def test_bypass_subshell():
    assert run("(cd apps/web && npx convex deploy --yes)") == 2


# ---------------------------------------------------------------------------
# FAUX POSITIFS ENSUITE — ce qui ne DOIT PAS bloquer.
# ---------------------------------------------------------------------------

def test_grep_lecture_seule_passe():
    """LE 2e BUG. Une recherche en lecture seule était bloquée (rc=2)."""
    assert run('grep -rn "convex deploy --prod" CLAUDE.md') == 0


def test_rg_lecture_seule_passe():
    assert run('rg "convex deploy" docs/') == 0


def test_cat_passe():
    assert run("cat runbooks/deploy.md") == 0


def test_echo_passe():
    assert run('echo "pense a lancer convex deploy apres la QA"') == 0


def test_vrai_convex_dev_passe():
    assert run("npx convex dev --once") == 0


# ---------------------------------------------------------------------------
# REDIRECT DEV DANS LE MESSAGE DE BLOCAGE (friction Laurent Day 156).
# La protection prod NE FAIBLIT PAS : un deploy prod sans QA bloque toujours.
# Le message nomme desormais la porte DEV `npx convex dev --once`.
# ---------------------------------------------------------------------------

def run_out(cmd, qa_ok=False):
    if qa_ok:
        pathlib.Path(BREADCRUMB).touch()
    else:
        try:
            os.remove(BREADCRUMB)
        except FileNotFoundError:
            pass
    p = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}}),
        capture_output=True,
        text=True,
    )
    return p.returncode, p.stderr + p.stdout


def test_message_de_blocage_nomme_la_porte_dev():
    rc, out = run_out("npx convex deploy --yes")
    assert rc == 2, "un deploy prod sans QA doit toujours bloquer"
    assert "convex dev --once" in out, f"le message doit nommer la porte DEV, out={out}"


def test_vrai_dry_run_passe():
    assert run("npx convex deploy --dry-run") == 0


def test_deploy_avec_QA_recente_passe():
    assert run("npx convex deploy --yes", qa_ok=True) == 0


def test_override_documente_passe():
    assert run("npx convex deploy --yes # allow-no-qa: hotfix client incident 42") == 0


# ---------------------------------------------------------------------------
# FAIL-OPEN STRUCTUREL — un hook fleet ne casse JAMAIS une session.
# ---------------------------------------------------------------------------

def test_stdin_malforme_ne_casse_pas():
    p = subprocess.run([sys.executable, str(HOOK)], input="pas du json",
                       capture_output=True, text=True)
    assert p.returncode == 0


def test_autre_outil_ignore():
    p = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps({"tool_name": "Read", "tool_input": {"file_path": "x"}}),
        capture_output=True, text=True)
    assert p.returncode == 0
