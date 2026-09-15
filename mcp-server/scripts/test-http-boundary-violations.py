#!/usr/bin/env python3
"""Test harness: verify check-http-boundary-derives-from-principal catches violations."""

import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
MCP_ROOT = SCRIPT_DIR.parent
AUTH_TS = MCP_ROOT / "src" / "auth.ts"

# ANSI colors
RED = "\033[0;31m"
GREEN = "\033[0;32m"
YELLOW = "\033[1;33m"
NC = "\033[0m"


def test_violation(test_name: str, injection_code: str, expected_exit: int) -> bool:
	"""Inject violation, verify it's caught, restore original."""
	print(f"{YELLOW}Testing: {test_name}{NC}")

	# Read original
	original_text = AUTH_TS.read_text(encoding="utf-8")

	# Inject at line 754 (end of Clerk JWT branch, before terminal refuse)
	lines = original_text.split("\n")
	insertion_point = 754 - 1  # 0-indexed
	lines.insert(insertion_point, injection_code)
	modified_text = "\n".join(lines)

	# Write modified
	AUTH_TS.write_text(modified_text, encoding="utf-8")

	# Verify injection landed
	if injection_code not in AUTH_TS.read_text(encoding="utf-8"):
		print(f"  {RED}ERROR: Injection did not land{NC}")
		AUTH_TS.write_text(original_text, encoding="utf-8")
		return False

	print(f"  Injection landed: {injection_code[:70]}...")

	# Run the guard script
	result = subprocess.run(
		[sys.executable, str(SCRIPT_DIR / "check-http-boundary-derives-from-principal.py")],
		cwd=str(MCP_ROOT),
		capture_output=True,
		text=True,
	)

	# Restore original
	AUTH_TS.write_text(original_text, encoding="utf-8")

	# Check result
	if result.returncode == expected_exit:
		print(f"  {GREEN}✓ Exit code {result.returncode} (expected {expected_exit}){NC}")
		return True
	else:
		print(f"  {RED}✗ Exit code {result.returncode} (expected {expected_exit}){NC}")
		print("\nScript output:")
		print(result.stdout)
		if result.stderr:
			print("Stderr:", result.stderr)
		return False


def test_with_auth_ts_path(test_name: str, auth_ts_path: Path, expected_exit: int) -> bool:
	"""Test the guard against a specific auth.ts file."""
	print(f"{YELLOW}Testing: {test_name}{NC}")

	if not auth_ts_path.exists():
		print(f"  {RED}ERROR: auth.ts file not found at {auth_ts_path}{NC}")
		return False

	# Run the guard script against the specified auth.ts
	result = subprocess.run(
		[
			sys.executable,
			str(SCRIPT_DIR / "check-http-boundary-derives-from-principal.py"),
			"--auth-ts",
			str(auth_ts_path),
		],
		cwd=str(MCP_ROOT),
		capture_output=True,
		text=True,
	)

	if result.returncode == expected_exit:
		print(f"  {GREEN}✓ Exit code {result.returncode} (expected {expected_exit}){NC}")
		print(f"  Output summary: {result.stdout.split(chr(10))[-2]}")  # Last meaningful line
		return True
	else:
		print(f"  {RED}✗ Exit code {result.returncode} (expected {expected_exit}){NC}")
		print("\nScript output:")
		print(result.stdout)
		if result.stderr:
			print("Stderr:", result.stderr)
		return False


def main() -> int:
	print("Test harness for check-http-boundary-derives-from-principal")
	print("=" * 60)
	print()

	all_ok = True

	# ────────────────────────────────────────────────────────────────────────
	# MV1: Verify guard detects dead-table references in old auth.ts (main)
	# ────────────────────────────────────────────────────────────────────────
	print("=== MV1 Test: Dead-Table Detection (old auth.ts from main) ===")
	print()

	# Extract the old auth.ts from main commit 335791f
	old_auth_result = subprocess.run(
		["git", "show", "335791f:mcp-server/src/auth.ts"],
		cwd=str(MCP_ROOT.parent),
		capture_output=True,
		text=True,
	)

	if old_auth_result.returncode != 0:
		print(f"  {RED}ERROR: Could not extract old auth.ts from commit 335791f{NC}")
		all_ok = False
	else:
		# Write to temp file
		with tempfile.NamedTemporaryFile(
			mode="w", suffix=".ts", delete=False, dir="/tmp"
		) as f:
			f.write(old_auth_result.stdout)
			old_auth_path = Path(f.name)

		try:
			# Grep-assert the removed functions are present
			if (
				"mcpTenants:getTenantByTokenHash" in old_auth_result.stdout
				and "oauthDcr:validateAccessToken" in old_auth_result.stdout
			):
				print("  ✓ Old auth.ts contains both removed function references")
				print("    - Found: mcpTenants:getTenantByTokenHash")
				print("    - Found: oauthDcr:validateAccessToken")
			else:
				print(
					f"  {RED}ERROR: Old auth.ts missing expected references{NC}"
				)
				all_ok = False

			# Test that the guard FAILS (exit 1) on old auth.ts
			mv1_ok = test_with_auth_ts_path(
				"MV1: guard detects dead-table references",
				old_auth_path,
				1,
			)
			all_ok = all_ok and mv1_ok
		finally:
			old_auth_path.unlink()

	print()

	# ────────────────────────────────────────────────────────────────────────
	# MUST_PASS: head as-is (exit 0)
	# ────────────────────────────────────────────────────────────────────────
	print("=== MUST_PASS Test ===")
	print()
	print(f"{YELLOW}Testing: MUST_PASS — head as-is{NC}")
	result = subprocess.run(
		[sys.executable, str(SCRIPT_DIR / "check-http-boundary-derives-from-principal.py")],
		cwd=str(MCP_ROOT),
		capture_output=True,
		text=True,
	)
	if result.returncode == 0:
		print(f"  {GREEN}✓ Exit code 0 (expected 0){NC}")
	else:
		print(f"  {RED}✗ Exit code {result.returncode} (expected 0){NC}")
		print(result.stdout)
		all_ok = False
	print()

	# ────────────────────────────────────────────────────────────────────────
	# MUST_BLOCK cases
	# ────────────────────────────────────────────────────────────────────────
	print("=== MUST_BLOCK Tests (Dead-Table Reintroduction) ===")
	print()

	# Case 1: Tenant-token lookup with populated grant
	case1_ok = test_violation(
		"Case 1: tenant-token lookup reintroduced",
		'''		// DANGEROUS: reintroduced tenant lookup with populated grant
		const tenant = await internalClient().query(
			"legacyTenant:getByToken" as any,
			{ token: tenantToken },
		);
		if (tenant) {
			c.set("oauthContext", {
				clientId: `legacy:${tenant.tenantName}`,
				userId: `legacy:${tenant.tenantName}`,
				scopes: ["mcp:full"],
				scopeProfile: "legacy-tenant",
				fromAllowList: ["*"],
				namespaceReadPrefixes: ["*"],
				namespaceWritePrefixes: ["*"],
				expiresAt: Date.now() + 3600 * 1000,
				isMaster: false,
			});
			await next();
			return;
		}''',
		1,
	)
	all_ok = all_ok and case1_ok
	print()

	# Case 2: DCR via inline helper (with regex-safe characters)
	case2_ok = test_violation(
		"Case 2: DCR exchange with hardcoded grant",
		'''		// DANGEROUS: reintroduced DCR validation with hardcoded grant
		const dcrValid = { clientId: "dcr-test", scopes: ["mcp:full"], allowedOrchestrators: [] };
		if (dcrValid) {
			c.set("oauthContext", {
				clientId: dcrValid.clientId,
				userId: dcrValid.clientId,
				scopes: ["mcp:full"],
				scopeProfile: "dcr-client",
				fromAllowList: dcrValid.allowedOrchestrators,
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: Date.now() + 3600 * 1000,
				isMaster: false,
			});
			await next();
			return;
		}''',
		1,
	)
	all_ok = all_ok and case2_ok
	print()

	# Case 3: Fallthrough grant on lookup miss
	case3_ok = test_violation(
		"Case 3: fallthrough grant on lookup miss",
		'''		// DANGEROUS: fallthrough grant when mapping lookup fails
		let dcrMapping = null;
		if (dcrMapping || true) {
			c.set("oauthContext", {
				clientId: "default",
				userId: "default",
				scopes: dcrMapping?.scopes ?? ["vantage:read"],
				scopeProfile: "dcr-default",
				fromAllowList: dcrMapping?.allowedOrchestrators ?? ["*"],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: Date.now() + 3600 * 1000,
				isMaster: false,
			});
			await next();
			return;
		}''',
		1,
	)
	all_ok = all_ok and case3_ok
	print()

	# ────────────────────────────────────────────────────────────────────────
	# MV2: Deny-by-default reintroduction (should STILL fail)
	# ────────────────────────────────────────────────────────────────────────
	print("=== MV2 Test: Deny-by-Default Reintroduction ===")
	print()

	# Test a call to a removed function that grants nothing (deny-by-default)
	# This should STILL fail because the presence of the call is the defect,
	# not just the grant size.
	mv2_ok = test_violation(
		"MV2: deny-by-default call to removed function",
		'''		// DANGEROUS: calling removed function with empty grant is still wrong
		const tenant = await internalClient().query(
			"mcpTenants:getTenantByTokenHash" as any,
			{ tokenHash },
		);
		if (tenant) {
			c.set("oauthContext", {
				clientId: `legacy:${tenant.tenantName}`,
				userId: `legacy:${tenant.tenantName}`,
				scopes: [],
				scopeProfile: "legacy-tenant-generic",
				fromAllowList: [],
				namespaceReadPrefixes: [],
				namespaceWritePrefixes: [],
				expiresAt: Date.now() + 3600 * 1000,
				isMaster: false,
			});
			await next();
			return;
		}''',
		1,
	)
	all_ok = all_ok and mv2_ok
	print()

	# Summary
	if all_ok:
		print(f"{GREEN}All tests passed!{NC}")
		return 0
	else:
		print(f"{RED}Some tests failed!{NC}")
		return 1


if __name__ == "__main__":
	sys.exit(main())
