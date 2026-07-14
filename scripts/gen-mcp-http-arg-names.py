#!/usr/bin/env python3
"""
Generate `docs/canonical/vantage-peers-mcp-http-arg-names.json` — canonical
HTTP-API arg-names + public-function-names map auto-derived from `convex/*.ts`.

Why: callers (fleet hooks, MCP clients, npx convex run, HTTP fetch) need an
authoritative source of `{path, args}` shapes. Without it, callers invent
shapes (e.g. `{id}` instead of `{taskId}`, or `tasks:getByTitle` which never
existed) and trip Convex validators → auto-IRP cascade.

Output shape:
  {
    "version": "1.0.0",
    "generatedAt": "<UTC ISO>",
    "generatedFromCommit": "<git SHA at gen time>",
    "modules": {
      "<module>": {
        "file": "convex/<module>.ts",
        "publicFunctions": ["fn1", "fn2", ...],
        "internalFunctions": ["fn3", ...],
        "functions": {
          "<fn>": {
            "kind": "query|mutation|action|internalMutation|internalQuery|internalAction",
            "public": true|false,
            "args": "<raw args block, normalized whitespace>",
            "argNames": ["arg1", "arg2", ...],
            "file": "convex/<module>.ts:<line>",
            "errorCodes": ["CODE_A", "CODE_B"]
          }
        }
      }
    },
    "errorCodes": {
      "<CODE>": [{"module": "<m>", "function": "<f>", "file": "convex/<m>.ts:<line>", "message": "<msg>"}]
    }
  }

Usage:
  python3 scripts/gen-mcp-http-arg-names.py
  # writes docs/canonical/vantage-peers-mcp-http-arg-names.json

Re-generation discipline: run after every PR that touches `convex/*.ts` public
exports or arg validators. CI gate optional follow-up.
"""

import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONVEX_DIR = REPO_ROOT / "convex"
OUTPUT_PATH = REPO_ROOT / "docs" / "canonical" / "vantage-peers-mcp-http-arg-names.json"

# Match `export const <name> = <kind>({ ... })` where kind is one of the
# Convex factory names. We need balanced-brace handling for the body, so we
# parse with a small state machine after the initial regex hit.
EXPORT_RE = re.compile(
    r"^export\s+const\s+(?P<name>\w+)\s*=\s*"
    r"(?P<kind>query|mutation|action|internalQuery|internalMutation|internalAction)\s*\(",
    re.MULTILINE,
)

# Match `args: { ... }` block inside a Convex factory call. We capture the
# raw block (with balanced braces) because args can be simple or complex
# (v.object, v.union, nested v.optional, etc).
ARGS_HEAD_RE = re.compile(r"\bargs\s*:\s*\{")

# Match arg names at the top level of an args block. After we isolate the
# block, find leading identifiers: `<ident>:` at the start of a line or after
# a comma (whitespace + maybe `// comment`).
ARG_NAME_RE = re.compile(r"(?:^|[\n,]\s*)(?://[^\n]*\n\s*)?(\w+)\s*:")

# Match ConvexError emissions to harvest the catalogue of structured codes.
# We only capture the immediate `code: "..."` pair, not the full payload.
CONVEX_ERROR_RE = re.compile(
    r"throw\s+new\s+ConvexError\s*\(\s*\{\s*"
    r"code\s*:\s*[\"']([A-Z][A-Z0-9_]*)[\"']"
    r"[^}]*?message\s*:\s*[\"`]([^\"`]+)[\"`]?",
    re.DOTALL,
)


def find_balanced_block(text: str, open_idx: int) -> int:
    """Given an opening `{` at `open_idx`, return the index of the matching `}`.

    Skips JS string literals (single, double, backtick) AND JS comments
    (`// ...` line comments, `/* ... */` block comments) so apostrophes
    in comments don't trap the parser in pseudo-string mode.
    """
    depth = 0
    i = open_idx
    in_str = False
    str_quote = ""
    n = len(text)
    while i < n:
        ch = text[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == str_quote:
                in_str = False
            i += 1
            continue
        # Comment skip — must come before string detection because `//` and
        # `/* */` can contain quote chars that would otherwise flip in_str.
        if ch == "/" and i + 1 < n:
            nxt = text[i + 1]
            if nxt == "/":
                # Skip to end of line.
                eol = text.find("\n", i)
                i = eol + 1 if eol != -1 else n
                continue
            if nxt == "*":
                end = text.find("*/", i + 2)
                i = end + 2 if end != -1 else n
                continue
        if ch in "\"'`":
            in_str = True
            str_quote = ch
            i += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def line_of(text: str, idx: int) -> int:
    return text.count("\n", 0, idx) + 1


class ModuleUnreadableError(RuntimeError):
    """A convex/*.ts module exists but could not be read as text. Distinct
    from 'the module has zero exported functions' -- that is a valid, clean
    result; this is a measurement failure and must never be reported as one."""


def parse_module(path: Path) -> dict:
    try:
        src = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ModuleUnreadableError(f"{path} could not be read: {exc}") from exc
    except UnicodeDecodeError as exc:
        raise ModuleUnreadableError(f"{path} is not valid UTF-8: {exc}") from exc
    module_name = path.stem
    module_rel = f"convex/{path.name}"

    functions: dict[str, dict] = {}
    public_fns: list[str] = []
    internal_fns: list[str] = []

    for match in EXPORT_RE.finditer(src):
        fn_name = match.group("name")
        kind = match.group("kind")
        is_public = not kind.startswith("internal")

        # Find the `args:` block inside the body that starts after the factory open paren.
        # Search forward from the match end, but only inside the factory call body.
        # The factory call is `<kind>(` — find the matching `)`.
        paren_idx = src.index("(", match.end() - 1)
        # Find balanced { ... } that follows — that's the config object.
        first_brace = src.find("{", paren_idx)
        if first_brace == -1:
            continue
        cfg_end = find_balanced_block(src, first_brace)
        if cfg_end == -1:
            continue
        cfg_body = src[first_brace : cfg_end + 1]

        # Now scan the cfg_body for `args: {`.
        args_match = ARGS_HEAD_RE.search(cfg_body)
        if not args_match:
            args_raw = ""
            arg_names: list[str] = []
        else:
            args_open = first_brace + args_match.end() - 1
            args_close = find_balanced_block(src, args_open)
            if args_close == -1:
                args_raw = ""
                arg_names = []
            else:
                args_raw = src[args_open : args_close + 1]
                inner = args_raw[1:-1]
                arg_names = ARG_NAME_RE.findall("\n" + inner)

        functions[fn_name] = {
            "kind": kind,
            "public": is_public,
            "args": " ".join(args_raw.split()) if args_raw else "",
            "argNames": list(dict.fromkeys(arg_names)),  # dedup, preserve order
            "file": f"{module_rel}:{line_of(src, match.start())}",
            "errorCodes": [],
        }
        (public_fns if is_public else internal_fns).append(fn_name)

    # Harvest ConvexError codes — associate each to the nearest enclosing
    # function by line proximity (cheap heuristic: scan from the throw upward
    # to the nearest `export const`).
    error_catalogue: list[dict] = []
    for err_match in CONVEX_ERROR_RE.finditer(src):
        code = err_match.group(1)
        message = err_match.group(2)
        throw_line = line_of(src, err_match.start())
        # Find owning function: latest export above this line.
        owner = None
        for fn_name, fn_data in functions.items():
            fn_line = int(fn_data["file"].split(":")[1])
            if fn_line <= throw_line:
                if owner is None or int(functions[owner]["file"].split(":")[1]) < fn_line:
                    owner = fn_name
        if owner:
            functions[owner]["errorCodes"].append(code)
        error_catalogue.append(
            {
                "code": code,
                "module": module_name,
                "function": owner,
                "file": f"{module_rel}:{throw_line}",
                "message": message,
            }
        )

    return {
        "file": module_rel,
        "publicFunctions": public_fns,
        "internalFunctions": internal_fns,
        "functions": functions,
        "_errorCatalogue": error_catalogue,
    }


def git_head_sha() -> str:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, text=True
        )
        return out.strip()
    except subprocess.CalledProcessError:
        return "unknown"


def main() -> int:
    # THREE outcomes: PASS (0, canonical map written), VIOLATION -- there isn't
    # one here, this is a generator, not a gate -- or REFUSAL TO JUDGE (2, an
    # input this script needs to read is absent/unreadable). A missing
    # convex/ directory or an unreadable *.ts module used to print an error
    # and return exit code 1 (CONVEX_DIR case) or crash with an uncaught
    # exception (unreadable-module case, default exit 1 either way) -- both
    # indistinguishable from a genuine tool failure, and both silently wrong
    # if this script's exit code is ever gated on in CI.
    if not CONVEX_DIR.is_dir():
        print(f"REFUSAL: {CONVEX_DIR} not found or is not a directory -- cannot enumerate convex/*.ts modules", file=sys.stderr)
        return 2

    modules: dict[str, dict] = {}
    all_error_codes: dict[str, list[dict]] = {}

    convex_files = sorted(
        p
        for p in CONVEX_DIR.glob("*.ts")
        if not p.name.endswith(".test.ts") and p.name != "schema.ts"
    )

    if not convex_files:
        print(
            f"REFUSAL: {CONVEX_DIR} enumerated ZERO *.ts modules (excluding *.test.ts, schema.ts) "
            "-- that is a broken enumeration, not a clean/empty backend",
            file=sys.stderr,
        )
        return 2

    for path in convex_files:
        try:
            parsed = parse_module(path)
        except ModuleUnreadableError as exc:
            print(f"REFUSAL: {exc}", file=sys.stderr)
            return 2
        if not parsed["functions"]:
            continue
        # Promote per-module error catalogue to top-level catalogue.
        for err in parsed.pop("_errorCatalogue"):
            all_error_codes.setdefault(err["code"], []).append(
                {
                    "module": err["module"],
                    "function": err["function"],
                    "file": err["file"],
                    "message": err["message"],
                }
            )
        modules[path.stem] = parsed

    output = {
        "version": "1.0.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generatedFromCommit": git_head_sha(),
        "generatedBy": "scripts/gen-mcp-http-arg-names.py",
        "purpose": (
            "Canonical HTTP-API arg-names + public-function-names map for "
            "VantagePeers Convex backend. Use this to look up the exact "
            "`{path, args}` shape before invoking any tasks:get / "
            "messages:check / etc. Eliminates the m970x5wzkc family of "
            "caller-side arg-name violations."
        ),
        "modules": modules,
        "errorCodes": all_error_codes,
        "stats": {
            "moduleCount": len(modules),
            "publicFunctionCount": sum(
                len(m["publicFunctions"]) for m in modules.values()
            ),
            "internalFunctionCount": sum(
                len(m["internalFunctions"]) for m in modules.values()
            ),
            "errorCodeCount": len(all_error_codes),
        },
    }

    try:
        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_PATH.write_text(
            json.dumps(output, indent=2, ensure_ascii=False, sort_keys=False) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        print(f"REFUSAL: could not write {OUTPUT_PATH} -- {exc}", file=sys.stderr)
        return 2
    print(f"wrote {OUTPUT_PATH.relative_to(REPO_ROOT)}")
    print(
        f"stats: modules={output['stats']['moduleCount']} "
        f"publicFns={output['stats']['publicFunctionCount']} "
        f"internalFns={output['stats']['internalFunctionCount']} "
        f"errorCodes={output['stats']['errorCodeCount']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
