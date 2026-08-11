"""TDD suite for enforce-no-claude-trailer hook (written BEFORE the hook)."""

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile

import pytest

import pathlib

# The hook lives one level up, in .claude/hooks/ — this file is in .claude/hooks/tests/.
# Resolving against HERE alone points at a file that does not exist, and `python3 <missing>`
# exits 2, so every `rc == 0` assertion fails while the hook itself is fine. Same shape as
# the three sibling suites, which all use .parent.parent.
HOOK_PATH = str(pathlib.Path(__file__).resolve().parent.parent / "enforce-no-claude-trailer.py")


def load_hook():
    """Load the hook module by file path (hyphenated filename)."""
    spec = importlib.util.spec_from_file_location("enforce_no_claude_trailer", HOOK_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_stdin(payload):
    """End-to-end: pipe a stdin payload string to the hook file, return exit code."""
    proc = subprocess.run(
        [sys.executable, HOOK_PATH],
        input=payload,
        capture_output=True,
        text=True,
    )
    return proc.returncode


def payload_for(command):
    return json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})


# ---- module-level API used by most tests ----

def evaluate(command):
    """Return exit code for a given bash command via the module's core function."""
    mod = load_hook()
    return mod.evaluate_command(command)


# ---------- BLOCK cases ----------

def test_block_co_authored_by_claude_inline():
    cmd = 'git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
    assert evaluate(cmd) == 2


def test_block_noreply_anthropic_anywhere():
    cmd = 'git commit -m "fix stuff noreply@anthropic.com trailing"'
    assert evaluate(cmd) == 2


def test_block_generated_with_claude_heredoc():
    cmd = (
        "git commit -F - <<'EOF'\n"
        "feat: thing\n\n"
        "🤖 Generated with [Claude Code]\n"
        "EOF"
    )
    assert evaluate(cmd) == 2


def test_block_commit_F_file(tmp_path):
    f = tmp_path / "msg.txt"
    f.write_text("feat: y\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n")
    cmd = f'git commit -F {f}'
    assert evaluate(cmd) == 2


def test_block_gh_pr_create_body():
    cmd = 'gh pr create --title t --body "desc...Co-Authored-By: Claude <x>"'
    assert evaluate(cmd) == 2


def test_block_gh_pr_edit_body():
    cmd = 'gh pr edit 5 --body "Generated with Claude Code"'
    assert evaluate(cmd) == 2


def test_block_gh_pr_merge_subject():
    cmd = 'gh pr merge 5 --subject "merge Co-Authored-By: Anthropic team"'
    assert evaluate(cmd) == 2


def test_block_gh_pr_body_file(tmp_path):
    f = tmp_path / "body.md"
    f.write_text("Body\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n")
    cmd = f'gh pr create --title t --body-file {f}'
    assert evaluate(cmd) == 2


# ---------- v1.0.1 global-git-options scope holes (now blocked) ----------

def test_block_git_C_dir_commit():
    cmd = 'git -C /root/repo commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
    assert evaluate(cmd) == 2


def test_block_git_no_pager_commit():
    cmd = 'git --no-pager commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
    assert evaluate(cmd) == 2


def test_block_git_c_config_commit():
    cmd = 'git -c user.name=z commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
    assert evaluate(cmd) == 2


# ---------- v1.0.1 negative controls (widened pattern must not over-match) ----------

def test_allow_git_log_oneline_grep_trailer():
    cmd = 'git log --oneline --grep "Co-Authored-By: Claude"'
    assert evaluate(cmd) == 0


def test_allow_gitlab_commit_not_git():
    cmd = 'gitlab commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
    assert evaluate(cmd) == 0


def test_allow_git_C_dir_clean_commit():
    assert evaluate('git -C /root/repo commit -m "feat: x"') == 0


# ---------- v1.0.2 tokenizer-based scope: quoted-path + more bypasses (blocked) ----------

TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>"


def test_block_git_C_dir_with_space_commit():
    cmd = f'git -C "dir with space" commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_git_C_quoted_path_space_with_config():
    cmd = f"git -C '/path with space/repo' -c user.name=z commit -m \"x\n\n{TRAILER}\""
    assert evaluate(cmd) == 2


def test_block_absolute_git_binary_commit():
    cmd = f'/usr/bin/git commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_git_C_c_no_pager_commit():
    cmd = f'git -C /a -c u=z --no-pager commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_git_gitdir_equals_commit():
    cmd = f'git --git-dir=/x/.git commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_cd_then_git_C_commit_segment():
    cmd = f'cd /x && git -C /y commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_git_commit_amend():
    cmd = f'git commit --amend -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_gh_pr_create_title_body():
    cmd = f'gh pr create --title t --body "{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_gh_pr_edit_5_body():
    cmd = f'gh pr edit 5 --body "{TRAILER}"'
    assert evaluate(cmd) == 2


# ---------- v1.0.2 tokenizer-based scope: must NOT over-match (allowed) ----------

def test_allow_git_show_format_trailer():
    assert evaluate('git show --format="Co-Authored-By: Claude"') == 0


def test_allow_mygit_commit_not_git():
    cmd = f'mygit commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 0


def test_allow_git_status():
    assert evaluate("git status") == 0


def test_allow_gh_pr_list_search_trailer():
    assert evaluate('gh pr list --search "Co-Authored-By: Claude"') == 0


def test_allow_git_C_dir_with_space_clean_commit():
    assert evaluate('git -C "dir with space" commit -m "feat: x"') == 0


# ---------- ALLOW cases ----------

def test_allow_clean_commit():
    assert evaluate('git commit -m "feat: x"') == 0


def test_allow_unrelated_command_ls():
    assert evaluate("ls -la") == 0


def test_allow_unrelated_command_npm():
    assert evaluate("npm test") == 0


def test_allow_commit_mentioning_anthropic_word_only():
    # "Anthropic" without attribution pattern is fine
    assert evaluate('git commit -m "feat: integrate Anthropic API client"') == 0


def test_allow_override_valid_reason():
    cmd = (
        'git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
        ' // allow-claude-trailer: quoting history verbatim'
    )
    assert evaluate(cmd) == 0


def test_block_override_too_short_reason():
    cmd = (
        'git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
        ' // allow-claude-trailer: x'
    )
    assert evaluate(cmd) == 2


def test_commit_F_file_unreadable_does_not_crash():
    cmd = 'git commit -F /nonexistent/path/to/nowhere-xyz.txt'
    assert evaluate(cmd) == 0


# ---------- v1.0.2 newline / wrapper / keyword bypasses (now blocked) ----------

def test_block_newline_separator_after_cd():
    cmd = f'cd /x\ngit commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_if_then_newline_keyword_head():
    cmd = f'if true; then\n  git commit -m "x\n\n{TRAILER}"\nfi'
    assert evaluate(cmd) == 2


def test_block_env_wrapper_commit():
    cmd = f'env FOO=1 git commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_sudo_wrapper_commit():
    cmd = f'sudo git commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_command_wrapper_commit():
    cmd = f'command git commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_time_wrapper_commit():
    cmd = f'time git commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_nohup_wrapper_commit():
    cmd = f'nohup git commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


# ---------- v1.0.2 widened head-stripping must NOT over-match (allowed) ----------

def test_allow_newline_git_log_grep_trailer():
    cmd = 'cd /x\ngit log --grep "Co-Authored-By: Claude"'
    assert evaluate(cmd) == 0


def test_allow_newline_echo_trailer_then_ls():
    cmd = 'echo "Co-Authored-By: Claude"\nls'
    assert evaluate(cmd) == 0


def test_allow_sudo_rm():
    assert evaluate("sudo rm -rf /tmp/x") == 0


def test_allow_env_wrapper_npm_test():
    assert evaluate("env FOO=1 npm test") == 0


def test_allow_time_git_log():
    assert evaluate("time git log --oneline") == 0


def test_allow_newline_clean_commit():
    assert evaluate('cd /x\ngit commit -m "feat: y"') == 0


# ---------- stdin / robustness (fail-open) ----------

def test_stdin_empty_exit0():
    assert run_stdin("") == 0


def test_stdin_malformed_json_exit0():
    assert run_stdin("{not json") == 0


def test_stdin_non_dict_exit0():
    assert run_stdin(json.dumps(["a", "list"])) == 0


# ---------- end-to-end subprocess ----------

def test_e2e_block_exit2():
    cmd = 'git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
    assert run_stdin(payload_for(cmd)) == 2


def test_e2e_allow_exit0():
    assert run_stdin(payload_for('git commit -m "feat: clean"')) == 0


# ---------- v1.0.3 fail-closed backstop: wrapper class (now blocked) ----------

def test_block_backslash_continuation_git_commit():
    cmd = f'git \\\n  commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_backtick_git_commit():
    cmd = f'`git commit -m "x {TRAILER}"`'
    assert evaluate(cmd) == 2


def test_block_xargs_git_commit():
    cmd = f'echo x | xargs -I{{}} git commit -m "{{}} {TRAILER}"'
    assert evaluate(cmd) == 2


def test_block_eval_git_commit():
    cmd = f'eval "git commit -m \'x {TRAILER}\'"'
    assert evaluate(cmd) == 2


def test_block_bash_c_git_commit():
    cmd = f'bash -c "git commit -m \'x {TRAILER}\'"'
    assert evaluate(cmd) == 2


def test_block_sh_c_git_commit():
    cmd = f'sh -c \'git commit -m "x {TRAILER}"\''
    assert evaluate(cmd) == 2


def test_block_ssh_host_git_commit():
    cmd = f'ssh host "git commit -m \'x {TRAILER}\'"'
    assert evaluate(cmd) == 2


# ---------- v1.0.3 backstop must NOT become a catch-all (allowed) ----------

def test_allow_backstop_git_log_grep_no_commit_word():
    assert evaluate('git log --grep "Co-Authored-By: Claude"') == 0


def test_allow_backstop_git_log_grep_continuation_no_commit_word():
    cmd = 'git log \\\n  --grep "Co-Authored-By: Claude"'
    assert evaluate(cmd) == 0


def test_allow_backstop_git_show_format_trailer():
    assert evaluate('git show --format="Co-Authored-By: Claude"') == 0


def test_allow_backstop_echo_backtick_date():
    assert evaluate("echo `date`") == 0


def test_allow_backstop_xargs_rm():
    assert evaluate("xargs rm") == 0


def test_allow_backstop_gitlab_commit_word_boundary():
    cmd = f'gitlab commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 0


def test_allow_backstop_mygit_commit_word_boundary():
    cmd = f'mygit commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 0


def test_allow_backstop_gh_pr_list_no_verb():
    assert evaluate('gh pr list --search "Co-Authored-By: Claude"') == 0


def test_allow_backstop_clean_commit():
    assert evaluate('git commit -m "feat: x"') == 0


def test_allow_backstop_cd_newline_clean_commit():
    assert evaluate('cd /x\ngit commit -m "feat: y"') == 0


def test_allow_backstop_git_C_space_clean_commit():
    assert evaluate('git -C "dir with space" commit -m "feat: x"') == 0


def test_allow_backstop_commit_word_anthropic_only():
    assert evaluate('git commit -m "feat: integrate Anthropic API client"') == 0


def test_block_override_wins_over_backstop():
    cmd = (
        f'eval "git commit -m \'x {TRAILER}\'"'
        ' // allow-claude-trailer: quoting history verbatim'
    )
    assert evaluate(cmd) == 0


def test_block_override_too_short_over_backstop():
    cmd = (
        f'eval "git commit -m \'x {TRAILER}\'"'
        ' // allow-claude-trailer: x'
    )
    assert evaluate(cmd) == 2


def test_block_newline_inside_message_non_regression():
    cmd = f'git commit -m "x\n\n{TRAILER}"'
    assert evaluate(cmd) == 2


# ---------- v1.0.4 accepted false positive: trailer-audit / forensic tooling ----------

AUDIT_OVERRIDE = " // allow-claude-trailer: audit forensique du trailer"

# The three accepted false positives — the very commands used to FIND offending
# commits. They contain the words git/commit + the trailer, so the fail-closed
# backstop blocks them. This is accepted; the auditor rescues with the override.

FP_GH_API_GREP = (
    "gh api repos/$R/commits/$sha -q .commit.message "
    "| grep -c 'Co-Authored-By: Claude' ; git log --oneline"
)
FP_GIT_LOG_GREP = 'git log --grep "commit Co-Authored-By: Claude"'
FP_ECHO_COMMIT_TRAILER = (
    'echo "git commit"; echo "Co-Authored-By: Claude <noreply@anthropic.com>"'
)


def test_accepted_false_positive_gh_api_grep_audit_tooling_blocks():
    assert evaluate(FP_GH_API_GREP) == 2


def test_accepted_false_positive_git_log_grep_audit_tooling_blocks():
    assert evaluate(FP_GIT_LOG_GREP) == 2


def test_accepted_false_positive_echo_commit_trailer_tooling_blocks():
    assert evaluate(FP_ECHO_COMMIT_TRAILER) == 2


def test_accepted_false_positive_gh_api_grep_rescued_by_override():
    assert evaluate(FP_GH_API_GREP + AUDIT_OVERRIDE) == 0


def test_accepted_false_positive_git_log_grep_rescued_by_override():
    assert evaluate(FP_GIT_LOG_GREP + AUDIT_OVERRIDE) == 0


def test_accepted_false_positive_echo_commit_trailer_rescued_by_override():
    assert evaluate(FP_ECHO_COMMIT_TRAILER + AUDIT_OVERRIDE) == 0


def test_audit_command_without_commit_word_stays_allowed():
    # Reviewer's other audit command: no `commit` word -> backstop never fires.
    cmd = "git log -1 --format='%B' $sha | grep -ci 'Co-Authored-By: Claude'"
    assert evaluate(cmd) == 0


def test_block_message_names_audit_class_and_canonical_override_line():
    # Capture stderr of a blocked command; assert the self-service guidance.
    proc = subprocess.run(
        [sys.executable, HOOK_PATH],
        input=payload_for(FP_GIT_LOG_GREP),
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 2
    assert "allow-claude-trailer: audit forensique du trailer" in proc.stderr
    lowered = proc.stderr.lower()
    assert "audit" in lowered
    assert "forensic" in lowered or "forensique" in lowered


# ---------- reviewer re-probes: lock them in as blocking (== 2) ----------

def test_reprobe_eval_printf_git_commit_blocks():
    cmd = 'eval $(printf \'git commit -m "x Co-Authored-By: Claude"\')'
    assert evaluate(cmd) == 2


def test_reprobe_alias_gc_git_commit_blocks():
    cmd = 'alias gc=\'git commit\'; gc -m "x Co-Authored-By: Claude"'
    assert evaluate(cmd) == 2


def test_reprobe_printf_file_then_git_commit_F_blocks():
    cmd = (
        "printf 'x Co-Authored-By: Claude' > /tmp/m.txt "
        "&& git commit -F /tmp/m.txt"
    )
    assert evaluate(cmd) == 2


# ---------- v1.3.0 leak (A): no separator at all now blocks by trailer-key ------

def test_leak_coauthoredby_no_separator_now_blocks():
    # `CoAuthoredBy: Claude` — no separator between the words. Normalization
    # COLLAPSES separators, it never INSERTS one, so the old `\bco ?authored\b by`
    # could never match the glued key. Shape 1 has no \b between verb stem and by.
    assert evaluate('git commit -m "x\n\nCoAuthoredBy: Claude"') == 2


# ---------- v1.3.0 (B): named negative controls — agent-of-connector is NOT the
# entity. These are ORDINARY commit messages; blocking them would disarm the hook.

def test_negative_control_agent_of_connector_is_not_the_entity_script():
    cmd = 'git commit -m "chore: auto-generated by script for Anthropic API"'
    assert evaluate(cmd) == 0


def test_negative_control_agent_of_connector_is_not_the_entity_ci():
    cmd = 'git commit -m "docs: generated by CI, references Anthropic client"'
    assert evaluate(cmd) == 0


def test_negative_control_agent_of_connector_is_not_the_entity_fixture():
    cmd = 'git commit -m "test: file created by fixture, mocks Anthropic"'
    assert evaluate(cmd) == 0


# ---------- v1.3.0 full still-blocking set (re-probe: all == 2) ----------

def test_still_blocks_coauthored_space_before_colon():
    assert evaluate('git commit -m "x\n\nCo-Authored-By : Claude"') == 2


def test_still_blocks_coauthored_underscores():
    assert evaluate('git commit -m "x\n\nCo_Authored_By: Claude"') == 2


def test_still_blocks_coauthored_runaway_separators():
    assert evaluate('git commit -m "x\n\nCo---Authored___By:  Claude"') == 2


def test_still_blocks_generated_underscore_claude():
    assert evaluate('git commit -m "x\n\ngenerated_by_claude"') == 2


def test_still_blocks_generated_newline_claude():
    assert evaluate('git commit -m "x\n\nGenerated by\nClaude Code"') == 2


def test_still_blocks_uppercase_coauthored():
    assert evaluate('git commit -m "x\n\nCO-AUTHORED-BY: CLAUDE"') == 2


def test_still_blocks_tab_separated_coauthored():
    assert evaluate('git commit -m "x\n\nx\tCo-Authored-By:\tClaude"') == 2


def test_still_blocks_noreply_anthropic_com():
    assert evaluate('git commit -m "x noreply@anthropic.com"') == 2


def test_still_blocks_on_behalf_of_anthropic():
    assert evaluate('git commit -m "x\n\nOn behalf of Anthropic"') == 2


def test_still_blocks_git_cherry_pick_x_m_trailer():
    cmd = 'git cherry-pick -x -m 1 -e -m "x\n\nCo-Authored-By: Claude <a@b>"'
    assert evaluate(cmd) == 2


def test_still_blocks_git_revert_no_edit_F_file(tmp_path):
    f = tmp_path / "msg.txt"
    f.write_text("revert\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n")
    assert evaluate(f'git revert --no-edit -m 1 -F {f}') == 2


# ---------- v1.3.0 full clean-negative set (re-probe: all == 0) ----------

def test_neg_integrate_anthropic_api_client():
    assert evaluate('git commit -m "feat: integrate Anthropic API client"') == 0


def test_neg_created_anthropic_client_wrapper():
    assert evaluate('git commit -m "feat: created Anthropic client wrapper"') == 0


def test_neg_written_approval_from_anthropic_legal():
    assert evaluate('git commit -m "feat: written approval from Anthropic legal"') == 0


def test_neg_clean_merge_no_ff():
    assert evaluate('git merge --no-ff -m "merge branch"') == 0


def test_neg_git_log_grep_trailer():
    assert evaluate('git log --grep "Co-Authored-By: Claude"') == 0


def test_neg_git_show_format():
    assert evaluate('git show --format="Co-Authored-By: Claude"') == 0


def test_neg_gitlab_commit():
    assert evaluate('gitlab commit -m "x Co-Authored-By: Claude"') == 0


def test_neg_mygit_commit():
    assert evaluate('mygit commit -m "x Co-Authored-By: Claude"') == 0


def test_neg_gh_pr_list_search():
    assert evaluate('gh pr list --search "Co-Authored-By: Claude"') == 0


def test_neg_gh_pr_comment_body():
    cmd = 'gh pr comment 5 --body "still carries Co-Authored-By: Claude"'
    assert evaluate(cmd) == 0


def test_neg_git_commit_feat_x():
    assert evaluate('git commit -m "feat: x"') == 0


def test_neg_git_log_format_grep_ci():
    cmd = "git log -1 --format='%B' $sha | grep -ci 'Co-Authored-By: Claude'"
    assert evaluate(cmd) == 0


def test_neg_echo_date():
    assert evaluate("echo `date`") == 0


def test_neg_xargs_rm():
    assert evaluate("xargs rm") == 0


# ---------- v1.3.0 COUNTER-MATRIX: verb + connector + <other agent> + entity == 0
# The mirror image of the positive property matrix. When some OTHER agent sits
# between the connector and the entity, the entity is NOT the agent of the
# connector -> ordinary prose -> allowed. This is the property that separates
# attribution from prose.

_CTR_VERBS = ["Generated", "Made", "Created", "Written", "Authored", "Assisted"]
_CTR_PREPS = ["by", "with", "via", "using"]
_CTR_AGENTS = ["script", "CI", "fixture", "make"]
_CTR_ENTITIES = ["Claude", "Anthropic"]


@pytest.mark.parametrize("verb", _CTR_VERBS)
@pytest.mark.parametrize("prep", _CTR_PREPS)
@pytest.mark.parametrize("agent", _CTR_AGENTS)
@pytest.mark.parametrize("entity", _CTR_ENTITIES)
def test_counter_matrix_other_agent_between_connector_and_entity_allows(
    verb, prep, agent, entity
):
    # COUNTER-INVARIANT: <verb> <connector> <other-agent> ... <entity> is prose,
    # not attribution, because the entity is not the agent of the connector.
    phrase = f"{verb} {prep} {agent} for {entity} API"
    cmd = f'git commit -m "chore: {phrase}"'
    assert evaluate(cmd) == 0


# ---------- mutation control: prove the Anthropic regex is load-bearing ----------

# ---------- v1.1.0 PREDICATE inversion: the reviewer's 8 leaks now block ----------
# One word apart from a case that already blocked, same attribution, in scope.

def test_leak_generated_by_claude_code_now_blocks():
    assert evaluate('git commit -m "x\n\nGenerated by Claude Code"') == 2


def test_leak_generated_with_claude_code_stays_blocked():
    assert evaluate('git commit -m "x\n\nGenerated with Claude Code"') == 2


def test_leak_made_with_claude_code_now_blocks():
    assert evaluate('git commit -m "x\n\nMade with Claude Code"') == 2


def test_leak_commit_trailer_flag_assisted_by_now_blocks():
    cmd = "git commit -m x --trailer 'Assisted-By: Claude Opus 4.8'"
    assert evaluate(cmd) == 2


def test_leak_co_authored_by_space_before_colon_now_blocks():
    assert evaluate('git commit -m "x\n\nCo-Authored-By : Claude <c@d.com>"') == 2


def test_leak_git_merge_no_ff_inline_trailer_now_blocks():
    cmd = 'git merge --no-ff -m "feat\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
    assert evaluate(cmd) == 2


def test_leak_git_merge_no_ff_F_file_now_blocks(tmp_path):
    f = tmp_path / "msg.txt"
    f.write_text("merge\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n")
    assert evaluate(f'git merge --no-ff -F {f}') == 2


def test_leak_git_tag_a_inline_trailer_now_blocks():
    cmd = 'git tag -a v1 -m "rel\n\nCo-Authored-By: Claude <x@y>"'
    assert evaluate(cmd) == 2


# ---------- reviewer's announced next probes must also block ----------

def test_nextprobe_generated_via_claude_blocks():
    assert evaluate('git commit -m "x\n\nGenerated via Claude"') == 2


def test_nextprobe_powered_by_claude_blocks():
    assert evaluate('git commit -m "x\n\nPowered by Claude"') == 2


def test_nextprobe_assisted_by_anthropic_blocks():
    assert evaluate('git commit -m "x\n\nassisted by Anthropic"') == 2


def test_nextprobe_git_rebase_exec_trailer_blocks():
    cmd = 'git rebase --exec "git commit -m \'x\n\nCo-Authored-By: Claude <x@y>\'"'
    assert evaluate(cmd) == 2


# ---------- v1.2.0 separator/whitespace-class leaks now block by construction --

def test_leak_newline_between_preposition_and_entity_now_blocks():
    # `[^\n]{0,40}` could not cross a newline; normalization makes the newline a
    # single space so `.` spans it.
    assert evaluate('git commit -m "x\n\nGenerated by\nClaude Code"') == 2


def test_leak_underscore_separators_now_blocks():
    # `Co_Authored_By` normalizes to `co authored by`.
    assert evaluate('git commit -m "x\n\nCo_Authored_By: Claude"') == 2


def test_leak_signed_off_by_claude_now_blocks():
    # DELIBERATE scope decision: a Signed-off-by trailer naming Claude is
    # attribution/endorsement of the commit.
    cmd = 'git commit -m "x\n\nSigned-off-by: Claude <c@a.com>"'
    assert evaluate(cmd) == 2


def test_leak_on_behalf_of_anthropic_now_blocks():
    # DELIBERATE scope decision: on-behalf-of is an attribution form with no
    # single family verb.
    assert evaluate('git commit -m "x\n\nOn behalf of Anthropic"') == 2


def test_multiple_spaces_between_verb_and_prep_stays_blocked():
    assert evaluate('git commit -m "x\n\nGenerated   by    Claude"') == 2


def test_distant_prose_attribution_deliberately_not_blocked():
    # DELIBERATE TRADE-OFF (v1.3.0 agent-adjacency): the entity must be the AGENT
    # of the connector (adjacent, modulo article/bracket). A contrived prose form
    # where `the model known as` sits between the connector and the entity is NOT
    # blocked. This is the exchange that kills the false positives below: a guard
    # that blocks routine work gets disarmed, and a disarmed guard protects nobody.
    cmd = 'git commit -m "x\n\nGenerated by the model known as Claude"'
    assert evaluate(cmd) == 0


# ---------- v1.1.0 PREDICATE must NOT become a catch-all (negative controls) ----------

def test_allow_integrate_anthropic_api_client_no_verb():
    # Family verb absent -> ordinary prose, not attribution.
    assert evaluate('git commit -m "feat: integrate Anthropic API client"') == 0


def test_allow_created_anthropic_client_wrapper_no_preposition():
    # Family verb present ("created") but NO connector -> not attribution.
    # This is THE negative control that proves the mandatory connector works.
    assert evaluate('git commit -m "feat: created Anthropic client wrapper"') == 0


def test_allow_written_approval_from_anthropic_legal_connector_not_in_set():
    # Family verb "written" + entity "Anthropic", but connector `from` is NOT in
    # the mandatory set {by,with,via,using} -> stays allowed. Guards the
    # connector requirement against normalization collapse.
    assert evaluate('git commit -m "feat: written approval from Anthropic legal"') == 0


def test_allow_clean_merge_no_ff():
    assert evaluate('git merge --no-ff -m "merge branch"') == 0


# ---------- v1.1.0 SCOPE decision: gh pr comment is OUT of scope on purpose ----------

def test_allow_gh_pr_comment_quoting_trailer_out_of_scope():
    # A comment is not authorship; a reviewer posts a verdict quoting the
    # trailer. Guarding it would block the review that catches the leak.
    cmd = 'gh pr comment 5 --body "this commit still carries Co-Authored-By: Claude"'
    assert evaluate(cmd) == 0


# ---------- v1.1.0 PROPERTY test: name the invariant, not the list ----------
# INVARIANT: any Claude/Anthropic attribution in a commit message written by git
# is blocked, whatever the authoring subcommand and whatever the phrasing.
# A future mutant swapping a preposition (e.g. by->via) turns a cell red.

_PROP_VERBS = [
    "Co-Authored", "Generated", "Made", "Created", "Written",
    "Authored", "Assisted", "Powered",
]
_PROP_PREPS = ["by", "with", "via", "using"]
_PROP_ENTITIES = ["Claude", "Anthropic"]
_PROP_SUBCMDS = ["commit", "merge", "tag", "revert", "cherry-pick"]
# Separator dimension — the invariant is INDEPENDENT of which separator glues
# the tokens together (space / underscore / hyphen / newline), because the
# predicate normalizes them all to a single space before matching. A regex that
# ENUMERATED separators would leak one of these; normalize-then-match cannot.
_PROP_SEPARATORS = [" ", "_", "-", "\n"]


@pytest.mark.parametrize("sep", _PROP_SEPARATORS)
@pytest.mark.parametrize("verb", _PROP_VERBS)
@pytest.mark.parametrize("prep", _PROP_PREPS)
@pytest.mark.parametrize("entity", _PROP_ENTITIES)
@pytest.mark.parametrize("sub", _PROP_SUBCMDS)
def test_property_any_attribution_phrasing_any_separator_any_subcommand_blocks(
    sep, verb, prep, entity, sub
):
    # INVARIANT: a family verb + a mandatory connector + Claude/Anthropic, glued
    # by ANY whitespace/underscore/hyphen separator, in ANY commit-authoring
    # subcommand, is blocked. Separators are a normalized-away detail, not an
    # enumerated list.
    phrase = f"{verb}{sep}{prep}{sep}{entity}"
    cmd = f'git {sub} -m "x\n\n{phrase}"'
    assert evaluate(cmd) == 2


def test_mutation_removing_anthropic_pattern_makes_case_pass():
    mod = load_hook()
    cmd = 'git commit -m "note noreply@anthropic.com"'
    # With the pattern present -> blocked
    assert mod.evaluate_command(cmd) == 2
    # Remove the anthropic-email pattern from the pattern list
    original = list(mod.VIOLATION_PATTERNS)
    try:
        mod.VIOLATION_PATTERNS = [
            p for p in mod.VIOLATION_PATTERNS
            if "anthropic" not in p.pattern.lower()
        ]
        # Now nothing matches -> previously RED case goes green (exit 0)
        assert mod.evaluate_command(cmd) == 0
    finally:
        mod.VIOLATION_PATTERNS = original


# ---------------------------------------------------------------------------
# NAMED-ENTITY BOUNDARY tests (architect decision, Day 123 doctrine).
#
# These assert a WRITTEN BOUNDARY, NOT an oversight: an entity referred to
# WITHOUT its name ("the model", "the assistant", "an AI") is deliberately OUT
# of scope. The doctrine forbids NOMINATIVE attribution to the named third
# party Anthropic/Claude; an unnamed reference promotes no named brand, and
# covering it would need an open-ended semantic predicate that false-positives
# on ordinary text. If a future change widens scope to unnamed entities, one of
# these named tests turns red on purpose — making the widening a deliberate act.
# The named companion pins the other side of the line: `Claude` still blocks.
# ---------------------------------------------------------------------------

def test_named_entity_boundary_unnamed_assistant_not_blocked():
    assert evaluate('git commit -m "x\n\nGenerated by the assistant"') == 0


def test_named_entity_boundary_unnamed_model_not_blocked():
    assert evaluate('git commit -m "x\n\nGenerated by the model"') == 0


def test_named_entity_boundary_unnamed_an_ai_not_blocked():
    assert evaluate('git commit -m "x\n\nCo-Authored-By: an AI"') == 0


def test_named_entity_boundary_generated_by_ai_not_blocked():
    assert evaluate('git commit -m "x\n\nGenerated by AI"') == 0


# ---------------------------------------------------------------------------
# LOUD FAIL-OPEN (mode 3) — a guard that does not block MUST say why.
#
# Three modes, only two of which speak:
#   - BLOCKS (exit 2, full report on stderr)
#   - ALLOWS NOMINALLY (exit 0, stderr SILENT — nothing to flag)
#   - ALLOWS BECAUSE IT COULD NOT LOOK (exit 0, ANNOUNCED on stderr — mode 3)
# The property under test: mode 3 announces itself so a mute fail-open can
# never be mistaken for a clean pass, while mode 2 (incl. empty stdin) stays
# silent by design.
# ---------------------------------------------------------------------------

def run_stdin_full(payload):
    """Pipe a stdin payload to the real hook file; return (returncode, stderr)."""
    proc = subprocess.run(
        [sys.executable, HOOK_PATH],
        input=payload,
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stderr


def test_fail_open_announces_itself_on_invalid_json():
    rc, err = run_stdin_full("{not json")
    assert rc == 0
    assert "FAIL-OPEN" in err
    assert "not valid JSON" in err


def test_fail_open_announces_itself_on_non_dict_payload():
    rc, err = run_stdin_full(json.dumps(["a", "list"]))
    assert rc == 0
    assert "FAIL-OPEN" in err


def test_empty_stdin_stays_silent_by_design():
    # Pin the design: empty stdin is the harness no-op, mode 2, NOT mode 3.
    rc, err = run_stdin_full("")
    assert rc == 0
    assert err == ""


def test_whitespace_only_stdin_stays_silent_by_design():
    rc, err = run_stdin_full("   \n\t  ")
    assert rc == 0
    assert err == ""


def test_nominal_allow_stays_silent():
    rc, err = run_stdin_full(payload_for('git commit -m "feat: x"'))
    assert rc == 0
    assert err == ""


def test_nominal_block_has_no_fail_open_line():
    cmd = 'git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'
    rc, err = run_stdin_full(payload_for(cmd))
    assert rc == 2
    assert "FAIL-OPEN" not in err
    # The full block report is still produced.
    assert "BLOCKED by enforce-no-claude-trailer" in err


def test_fail_open_announces_itself_on_unexpected_exception(monkeypatch, capsys):
    # Drive the REAL main() with a module function forced to raise DURING
    # evaluation, proving the outer except announces mode 3 on stderr.
    mod = load_hook()

    def boom(_command):
        raise RuntimeError("forced failure during evaluation")

    monkeypatch.setattr(mod, "gather_scan_text", boom)
    monkeypatch.setattr(
        mod.sys, "stdin", io.StringIO(payload_for('git commit -m "x"'))
    )
    rc = mod.main()
    captured = capsys.readouterr()
    assert rc == 0
    assert "FAIL-OPEN" in captured.err
    assert "unexpected error" in captured.err
    # Exception class name is surfaced; traceback is NOT printed to stderr.
    assert "RuntimeError" in captured.err
    assert "Traceback" not in captured.err


def test_named_entity_boundary_named_claude_is_blocked():
    assert evaluate('git commit -m "x\n\nGenerated by Claude"') == 2
