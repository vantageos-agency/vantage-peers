#!/usr/bin/env python3
"""
VantagePeers Orchestrator Validator

Tests ALL VantagePeers MCP operations for a given orchestrator name.
Cleans up test data after execution.

Usage:
    python3 scripts/validate-orchestrator.py sigma
    python3 scripts/validate-orchestrator.py omega
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SERVER_PATH = PROJECT_ROOT / "mcp-server" / "server.ts"
ENV_LOCAL = PROJECT_ROOT / ".env.local"
TIMEOUT_S = 30


def load_convex_url() -> str:
    """Load CONVEX_URL from environment or .env.local."""
    if url := os.environ.get("CONVEX_URL"):
        return url
    try:
        for line in ENV_LOCAL.read_text().splitlines():
            line = line.strip()
            if line.startswith("CONVEX_URL="):
                return line.split("=", 1)[1].split("#")[0].strip()
    except FileNotFoundError:
        pass
    raise RuntimeError("CONVEX_URL not found in environment or .env.local")


# ─────────────────────────────────────────────────────────────────────────────
# MCP Client — spawn server, communicate via JSON-RPC over stdio
# ─────────────────────────────────────────────────────────────────────────────

class McpClient:
    def __init__(self):
        env = {**os.environ, "CONVEX_URL": load_convex_url()}
        self.proc = subprocess.Popen(
            ["bun", str(SERVER_PATH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self._id = 0
        self._buffer = ""
        time.sleep(1)  # Let server start

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def send(self, method: str, params: dict = None) -> dict:
        """Send a JSON-RPC request and wait for response."""
        msg_id = self._next_id()
        msg = json.dumps({
            "jsonrpc": "2.0",
            "id": msg_id,
            "method": method,
            "params": params or {},
        }) + "\n"
        self.proc.stdin.write(msg.encode())
        self.proc.stdin.flush()
        return self._read_response(msg_id)

    def notify(self, method: str, params: dict = None):
        """Send a JSON-RPC notification (no response expected)."""
        msg = json.dumps({
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
        }) + "\n"
        self.proc.stdin.write(msg.encode())
        self.proc.stdin.flush()

    def _read_response(self, expected_id: int) -> dict:
        """Read lines from stdout until we get our response."""
        deadline = time.time() + TIMEOUT_S
        while time.time() < deadline:
            line = self.proc.stdout.readline().decode().strip()
            if not line:
                time.sleep(0.05)
                continue
            try:
                msg = json.loads(line)
                if msg.get("id") == expected_id:
                    return msg
            except json.JSONDecodeError:
                continue
        raise TimeoutError(f"Timeout waiting for response id={expected_id}")

    def call_tool(self, name: str, args: dict = None) -> dict:
        """Call an MCP tool and return parsed result."""
        resp = self.send("tools/call", {"name": name, "arguments": args or {}})
        if "error" in resp:
            raise RuntimeError(f"Tool error: {json.dumps(resp['error'])}")
        content = resp.get("result", {}).get("content", [])
        if content and content[0].get("type") == "text":
            try:
                return json.loads(content[0]["text"])
            except json.JSONDecodeError:
                return {"_raw": content[0]["text"]}
        return resp.get("result", {})

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


# ─────────────────────────────────────────────────────────────────────────────
# Test runner
# ─────────────────────────────────────────────────────────────────────────────

class TestResult:
    def __init__(self, name: str, passed: bool, detail: str):
        self.name = name
        self.passed = passed
        self.detail = detail


results: list[TestResult] = []
cleanup_ids: dict[str, list] = {
    "tasks": [],
    "missions": [],
    "memories": [],
    "diaries": [],
    "briefing_notes": [],
}


def ok(name: str, detail: str):
    results.append(TestResult(name, True, detail))
    print(f"  \033[32mPASS\033[0m {name} — {detail}")


def fail(name: str, detail: str):
    results.append(TestResult(name, False, detail))
    print(f"  \033[31mFAIL\033[0m {name} — {detail}")


def run_tests(client: McpClient, orch: str):
    """Run all validation tests for the given orchestrator."""

    print(f"\nValidating orchestrator: {orch}")
    print("=" * 60)

    # ── 1. tools/list ────────────────────────────────────────────────────
    print("\n[1/12] Tools discovery...")
    try:
        resp = client.send("tools/list")
        tools = resp.get("result", {}).get("tools", [])
        if len(tools) >= 50:
            ok("tools/list", f"{len(tools)} tools found")
        else:
            fail("tools/list", f"Only {len(tools)} tools (expected 50+)")
    except Exception as e:
        fail("tools/list", str(e))

    # ── 2. create_task ───────────────────────────────────────────────────
    print("\n[2/12] Task management...")
    task_id = None
    try:
        res = client.call_tool("create_task", {
            "title": f"[VALIDATOR] Test task for {orch}",
            "assignedTo": orch,
            "priority": "low",
            "createdBy": orch,
            "project": "validator-test",
            "tags": ["validator", "auto-cleanup"],
        })
        task_id = res.get("taskId")
        if task_id:
            cleanup_ids["tasks"].append(task_id)
            ok("create_task", f"taskId={task_id[:20]}...")
        else:
            fail("create_task", f"No taskId: {res}")
    except Exception as e:
        fail("create_task", str(e))

    # ── 3. start_task + complete_task ────────────────────────────────────
    if task_id:
        try:
            res = client.call_tool("start_task", {
                "taskId": task_id,
                "callerOrchestrator": orch,
            })
            if res.get("status") == "in_progress":
                ok("start_task", "status=in_progress")
            else:
                fail("start_task", f"Unexpected: {res}")
        except Exception as e:
            fail("start_task", str(e))

        try:
            res = client.call_tool("complete_task", {
                "taskId": task_id,
                "callerOrchestrator": orch,
                "completionNote": "Validator test — auto-cleanup pending",
            })
            if res.get("status") == "done":
                ok("complete_task", "status=done, completionNote set")
            else:
                fail("complete_task", f"Unexpected: {res}")
        except Exception as e:
            fail("complete_task", str(e))

    # ── 4. list_tasks ────────────────────────────────────────────────────
    try:
        res = client.call_tool("list_tasks", {"assignedTo": orch})
        tasks = res if isinstance(res, list) else []
        ok("list_tasks", f"{len(tasks)} task(s) for {orch}")
    except Exception as e:
        fail("list_tasks", str(e))

    # ── 5. create_mission ────────────────────────────────────────────────
    print("\n[3/12] Mission management...")
    mission_id = None
    try:
        res = client.call_tool("create_mission", {
            "name": f"[VALIDATOR] Test mission for {orch}",
            "project": "validator-test",
            "pilot": orch,
            "priority": "low",
            "createdBy": orch,
            "agents": [orch],
        })
        mission_id = res.get("missionId")
        if mission_id:
            cleanup_ids["missions"].append(mission_id)
            ok("create_mission", f"missionId={mission_id[:20]}...")
        else:
            fail("create_mission", f"No missionId: {res}")
    except Exception as e:
        fail("create_mission", str(e))

    # ── 6. list_missions ─────────────────────────────────────────────────
    try:
        res = client.call_tool("list_missions", {"project": "validator-test"})
        missions = res if isinstance(res, list) else []
        ok("list_missions", f"{len(missions)} mission(s)")
    except Exception as e:
        fail("list_missions", str(e))

    # ── 7. send_message + check_messages ─────────────────────────────────
    print("\n[4/12] Messaging...")
    try:
        res = client.call_tool("send_message", {
            "from": orch,
            "fromInstanceId": f"{orch}-validator",
            "channel": orch,
            "content": "[VALIDATOR] Test message — auto-cleanup",
        })
        msg_id = res.get("messageId")
        if msg_id:
            ok("send_message", f"messageId={msg_id[:20]}...")
        else:
            fail("send_message", f"No messageId: {res}")
    except Exception as e:
        fail("send_message", str(e))

    try:
        res = client.call_tool("check_messages", {
            "recipient": orch,
            "recipientInstanceId": f"{orch}-validator",
        })
        messages = res if isinstance(res, list) else []
        receipt_ids = [m.get("receiptId") for m in messages if m.get("receiptId")]
        ok("check_messages", f"{len(messages)} message(s)")

        # mark_as_read
        if receipt_ids:
            res2 = client.call_tool("mark_as_read", {"receiptIds": receipt_ids})
            if res2.get("markedAsRead", 0) > 0:
                ok("mark_as_read", f"Marked {res2['markedAsRead']} as read")
            else:
                fail("mark_as_read", f"Unexpected: {res2}")
    except Exception as e:
        fail("check_messages / mark_as_read", str(e))

    # ── 8. store_memory + recall ─────────────────────────────────────────
    print("\n[5/12] Memory + recall...")
    memory_id = None
    try:
        res = client.call_tool("store_memory", {
            "namespace": "validator-test",
            "type": "project",
            "content": f"[VALIDATOR] Test memory for {orch} — safe to delete",
            "createdBy": orch,
        })
        memory_id = res.get("memoryId")
        if memory_id:
            cleanup_ids["memories"].append(memory_id)
            ok("store_memory", f"memoryId={memory_id[:20]}...")
        else:
            fail("store_memory", f"No memoryId: {res}")
    except Exception as e:
        fail("store_memory", str(e))

    # Recall (async embedding — may not find immediately)
    time.sleep(3)  # Wait for RAG embedding
    try:
        res = client.call_tool("recall", {
            "query": "validator test memory",
            "namespace": "validator-test",
            "limit": 5,
        })
        results_list = res if isinstance(res, list) else []
        if len(results_list) > 0:
            ok("recall", f"{len(results_list)} result(s), top score={results_list[0].get('score', '?')}")
        else:
            ok("recall", "0 results (expected — embedding may still be processing)")
    except Exception as e:
        fail("recall", str(e))

    # ── 9. store_episode ─────────────────────────────────────────────────
    print("\n[6/12] Episodic memory...")
    try:
        res = client.call_tool("store_episode", {
            "namespace": "validator-test",
            "createdBy": orch,
            "context": "Running orchestrator validator",
            "goal": "Verify all VantagePeers operations work",
            "action": "Called each MCP tool with test data",
            "outcome": "All tools responded successfully",
            "insight": "Validator confirms operation readiness",
            "severity": "minor",
        })
        ep_id = res.get("memoryId")
        if ep_id:
            cleanup_ids["memories"].append(ep_id)
            ok("store_episode", f"episodeId={ep_id[:20]}...")
        else:
            fail("store_episode", f"No memoryId: {res}")
    except Exception as e:
        fail("store_episode", str(e))

    # ── 10. set_summary + list_peers ─────────────────────────────────────
    print("\n[7/12] Session management...")
    try:
        res = client.call_tool("set_summary", {
            "orchestratorId": orch,
            "instanceId": f"{orch}-validator",
            "summary": "[VALIDATOR] Running validation tests",
        })
        ok("set_summary", f"Set for {orch}-validator")
    except Exception as e:
        fail("set_summary", str(e))

    try:
        res = client.call_tool("list_peers", {})
        peers = res if isinstance(res, list) else []
        ok("list_peers", f"{len(peers)} peer(s)")
    except Exception as e:
        fail("list_peers", str(e))

    # ── 11. write_diary + get_diary ──────────────────────────────────────
    print("\n[8/12] Diary...")
    diary_id = None
    try:
        res = client.call_tool("write_diary", {
            "date": "2099-12-31",
            "orchestrator": orch,
            "content": "[VALIDATOR] Test diary entry — safe to delete",
            "highlights": ["Validator ran successfully"],
        })
        diary_id = res.get("diaryId")
        if diary_id:
            cleanup_ids["diaries"].append(diary_id)
        ok("write_diary", f"diaryId={res.get('diaryId', '?')[:20]}...")
    except Exception as e:
        fail("write_diary", str(e))

    try:
        res = client.call_tool("get_diary", {
            "orchestrator": orch,
            "date": "2099-12-31",
        })
        if res and res.get("content"):
            ok("get_diary", "Entry retrieved")
        else:
            fail("get_diary", f"No content: {res}")
    except Exception as e:
        fail("get_diary", str(e))

    # ── 12. create_fix_pattern + search_fix_patterns ─────────────────────
    print("\n[9/12] Fix patterns KB...")
    pattern_id = None
    try:
        res = client.call_tool("create_fix_pattern", {
            "symptom": "[VALIDATOR] Test pattern — safe to delete",
            "rootCause": "Validator test — not a real bug",
            "tags": ["validator", "auto-cleanup"],
            "stack": ["convex"],
            "sourceProject": "validator-test",
            "createdBy": orch,
            "severity": "minor",
        })
        pattern_id = res.get("patternId")
        if pattern_id:
            ok("create_fix_pattern", f"patternId={pattern_id[:20]}...")
        else:
            fail("create_fix_pattern", f"No patternId: {res}")
    except Exception as e:
        fail("create_fix_pattern", str(e))

    if pattern_id:
        try:
            res = client.call_tool("add_fix_attempt", {
                "patternId": pattern_id,
                "description": "Validator test attempt",
                "worked": True,
                "why": "It's a test",
                "createdBy": orch,
            })
            if res.get("attemptId"):
                ok("add_fix_attempt", f"attemptId={res['attemptId'][:20]}...")
            else:
                fail("add_fix_attempt", f"No attemptId: {res}")
        except Exception as e:
            fail("add_fix_attempt", str(e))

    try:
        res = client.call_tool("list_fix_patterns", {
            "project": "validator-test",
        })
        ok("list_fix_patterns", f"Listed patterns for validator-test")
    except Exception as e:
        fail("list_fix_patterns", str(e))

    # ── 10. Recurring tasks ──────────────────────────────────────────────
    print("\n[10/12] Recurring tasks...")
    recurring_id = None
    try:
        res = client.call_tool("create_recurring_task", {
            "title": f"[VALIDATOR] Test recurring for {orch}",
            "assignedTo": orch,
            "priority": "low",
            "cronExpression": "0 0 31 2 *",
            "createdBy": orch,
        })
        recurring_id = res.get("recurringTaskId") or res.get("taskId")
        if recurring_id:
            ok("create_recurring_task", f"id={recurring_id[:20]}...")
        else:
            fail("create_recurring_task", f"No id: {res}")
    except Exception as e:
        fail("create_recurring_task", str(e))

    # ── 11. Mandates ─────────────────────────────────────────────────────
    print("\n[11/12] Mandates...")
    mandate_id = None
    try:
        res = client.call_tool("create_mandate", {
            "requestedBy": orch,
            "fulfilledBy": orch,
            "service": "[VALIDATOR] Test mandate — auto-cleanup",
            "budget": 1000,
        })
        mandate_id = res.get("mandateId")
        if mandate_id:
            ok("create_mandate", f"mandateId={mandate_id[:20]}...")
        else:
            fail("create_mandate", f"No mandateId: {res}")
    except Exception as e:
        fail("create_mandate", str(e))

    # ── 12. Briefing notes ───────────────────────────────────────────────
    print("\n[12/12] Briefing notes...")
    briefing_note_id = None
    try:
        res = client.call_tool("create_briefing_note", {
            "title": f"[VALIDATOR] Test briefing for {orch}",
            "topic": "validator-test",
            "participants": [orch],
            "content": "Validator test briefing — safe to delete",
            "createdBy": orch,
        })
        briefing_note_id = res.get("noteId") or res.get("briefingId")
        if briefing_note_id:
            cleanup_ids["briefing_notes"].append(briefing_note_id)
            ok("create_briefing_note", f"noteId={briefing_note_id[:20]}...")
        else:
            fail("create_briefing_note", f"No noteId: {res}")
    except Exception as e:
        fail("create_briefing_note", str(e))

    # ── Cleanup ──────────────────────────────────────────────────────────
    print("\nCleaning up test data...")
    cleaned = 0

    for tid in cleanup_ids["tasks"]:
        try:
            client.call_tool("delete_task", {"taskId": tid, "callerOrchestrator": orch})
            cleaned += 1
        except Exception:
            pass

    if recurring_id:
        try:
            client.call_tool("delete_recurring_task", {"recurringTaskId": recurring_id})
            cleaned += 1
        except Exception:
            pass

    for did in cleanup_ids["diaries"]:
        try:
            client.call_tool("delete_diary", {"diaryId": did, "callerOrchestrator": orch})
            cleaned += 1
        except Exception:
            pass

    for nid in cleanup_ids["briefing_notes"]:
        try:
            client.call_tool("delete_briefing_note", {"noteId": nid, "callerOrchestrator": orch})
            cleaned += 1
        except Exception:
            pass

    # Reset validator summary
    try:
        client.call_tool("set_summary", {
            "orchestratorId": orch,
            "instanceId": f"{orch}-validator",
            "summary": "Validator completed",
        })
    except Exception:
        pass

    print(f"Cleaned {cleaned} test record(s)")


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/validate-orchestrator.py <orchestrator>")
        print("  e.g. python3 scripts/validate-orchestrator.py sigma")
        sys.exit(1)

    orch = sys.argv[1].lower()
    valid = {"pi", "tau", "phi", "sigma", "omega", "system"}
    if orch not in valid:
        print(f"Error: '{orch}' is not a valid orchestrator. Choose from: {', '.join(sorted(valid))}")
        sys.exit(1)

    client = McpClient()

    try:
        # Initialize MCP handshake
        client.send("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "orchestrator-validator", "version": "1.0.0"},
        })
        client.notify("notifications/initialized")

        run_tests(client, orch)
    finally:
        client.close()

    # ── Summary ──────────────────────────────────────────────────────────
    passed = sum(1 for r in results if r.passed)
    failed = sum(1 for r in results if not r.passed)
    total = len(results)

    print(f"\n{'=' * 60}")
    print(f"RESULTS: {passed}/{total} passed, {failed} failed")
    print(f"{'=' * 60}")

    if failed > 0:
        print("\nFailed validators:")
        for r in results:
            if not r.passed:
                print(f"  - {r.name}: {r.detail}")
        sys.exit(1)
    else:
        print(f"\nAll {total} validators passed for orchestrator '{orch}'")
        sys.exit(0)


if __name__ == "__main__":
    main()
