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


def _current_head_sha() -> str:
    """The hook (v4.0.0) pins QA evidence to the SHA it resolves via
    `git rev-parse HEAD` in the deploy cwd. With no `cwd` in the test
    payload and no leading `cd`, the hook falls back to its own process
    cwd — which subprocess.run inherits from THIS test process. So the
    breadcrumb must name the SAME HEAD this test process sees, not an
    arbitrary placeholder."""
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5,
    )
    return result.stdout.strip()


def run(cmd, qa_ok=False):
    """Retourne le code de sortie du hook pour une commande Bash donnée."""
    if qa_ok:
        # v4.0.0 requires a JSON breadcrumb {"sha": ..., "writer": ...} that
        # NAMES the commit being shipped — an empty touch() is the pre-v4.0.0
        # age-window shape (`qa_is_fresh`) and is now read as MALFORMED JSON,
        # which the hook correctly REFUSES rather than passes.
        pathlib.Path(BREADCRUMB).write_text(
            json.dumps({"sha": _current_head_sha(), "writer": "test-fixture"})
        )
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


# ---------------------------------------------------------------------------
# v4.1.0 — `convex run` + CONVEX_DEPLOY_KEY n'est PAS un deploy (operator ruling
# 2026-09-15). Le repli NON TOKENISABLE decide sur des MOTS, pas des sous-chaines.
# MUST_BLOCK d'abord, MUST_PASS ensuite. Chaque cas verifie que la charge
# contient bien ce qu'il pretend tester (atterrissage asserte).
# ---------------------------------------------------------------------------

_spec = importlib.util.spec_from_file_location("_qa_gate", HOOK)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

FIXTURE = pathlib.Path(__file__).with_name("tests") / "fixtures" / "catalogue-write-convex-run.sh"

MUST_BLOCK = [
    "npx convex deploy --yes",
    "CONVEX_DEPLOY_KEY=x npx convex deploy --yes",
    "bunx convex deploy",
    "echo 'unclosed ; npx convex deploy",
    "npx --yes convex deploy",
    'sh -c "npx convex deploy"',
]

MUST_PASS = [
    "CONVEX_DEPLOY_KEY=x node_modules/.bin/convex run hookContent:upsertHookContent '{\"name\":\"a\"}'",
    "grep CONVEX_DEPLOY_KEY .env.local",
    "npx convex dev --once",
]


def test_must_block_reste_un_deploy():
    for cmd in MUST_BLOCK:
        assert "convex deploy" in cmd
        assert _mod.is_prod_deploy(cmd) is True, cmd
        assert run(cmd) == 2, cmd


def test_must_block_non_tokenisable_passe_bien_par_le_repli():
    cmd = "echo 'unclosed ; npx convex deploy"
    segs = list(_mod.iter_real_commands(cmd))
    assert any(tokens is None for _, tokens in segs), segs


def test_must_pass_convex_run_et_lectures():
    for cmd in MUST_PASS:
        assert _mod.is_prod_deploy(cmd) is False, cmd
        assert run(cmd) == 0, cmd


def test_must_pass_forme_refusee_catalogue_write():
    payload = FIXTURE.read_text()
    assert 'CONVEX_DEPLOY_KEY="${K#*=}"' in payload
    assert "node_modules/.bin/convex run" in payload
    assert "python3 -c '" in payload and "pub()" in payload
    # atterrissage : la forme passe bien par le repli non tokenisable
    assert any(t is None for _, t in _mod.iter_real_commands(payload))
    assert _mod.is_prod_deploy(payload) is False
    assert run(payload) == 0


def test_convex_run_push_non_tokenisable_reste_ferme():
    # `--push` leve l'exemption `run` : avec un mot deploy present, le segment
    # non tokenisable reste ferme.
    cmd = "CONVEX_DEPLOY_KEY=x npx convex run --push fn deploy 'unclosed"
    assert any(t is None for _, t in _mod.iter_real_commands(cmd))
    assert _mod.is_prod_deploy(cmd) is True
    assert _mod.is_prod_deploy(cmd.replace("--push ", "")) is False


def test_must_refuse_stdin_illisible_comportement_inchange():
    for raw in ("pas du json", "pas du json npx convex deploy"):
        p = subprocess.run([sys.executable, str(HOOK)], input=raw,
                           capture_output=True, text=True)
        assert p.returncode == 0, raw
