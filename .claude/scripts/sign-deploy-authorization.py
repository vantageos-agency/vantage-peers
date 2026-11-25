#!/usr/bin/env python3
"""Sign a prod-deploy authorisation, offline-verifiable by the prod-deploy guard.

Prints ONE line of two shell comments to append after `# pi-authorized: k<task>`:

    # pi-auth-payload: <base64url canonical JSON> # pi-auth-sig: <base64url Ed25519 signature>

The private key is read ONLY from the environment variable
DEPLOY_AUTHORITY_SIGNING_KEY_<ISSUER> (issuer upper-cased, '-' -> '_'), injected by
`infisical run`. It is never read from a file, never taken from argv, never printed,
never logged. There is no flag that accepts one.

Sign (inside `infisical run`, so the value exists only in this process):

    infisical run --domain https://eu.infisical.com --projectId <ma-fabrique id> \\
      --env prod --path /shared -- \\
      python3 .claude/scripts/sign-deploy-authorization.py --issuer pi \\
      --task k<token-task-id> --floor <40-hex commit> --deployment <deployment-name> \\
      --orchestrator <who deploys>

Create a keypair (the private key goes straight into the vault, never to a terminal
or a file; the public key goes into .claude/config/deploy-authority-pubkeys.json):

    infisical secrets set --domain https://eu.infisical.com --projectId <ma-fabrique id> \\
      --env prod --path /shared \\
      --file <(python3 .claude/scripts/sign-deploy-authorization.py --generate-keypair --issuer pi)

--generate-keypair writes exactly one line, `DEPLOY_AUTHORITY_SIGNING_KEY_<ISSUER>=<base64
32-byte seed>`, to STDOUT (for the pipe above) and the public key to STDERR. It is the
only place a private key is ever printed. The full procedure is in
runbooks/prod-deploy-offline-signature.md.

Exit 0 = printed; exit 2 = refused (the reason is on stderr, never a key).
"""
import argparse
import base64
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "hooks"))

PAYLOAD_VERSION = 1
PAYLOAD_PURPOSE = "PROD-DEPLOY-AUTHORIZED"
ISSUER_RE = re.compile(r"[a-z][a-z0-9_-]{1,31}")
TASK_RE = re.compile(r"k[a-z0-9]{15,40}")
FLOOR_RE = re.compile(r"[0-9a-f]{40}")
NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{1,62}")
ORCHESTRATOR_RE = re.compile(r"[a-z][a-z0-9_-]{1,31}")


def refuse(message: str) -> "None":
    print(f"REFUSED: {message}", file=sys.stderr)
    sys.exit(2)


def env_name(issuer: str) -> str:
    return "DEPLOY_AUTHORITY_SIGNING_KEY_" + issuer.upper().replace("-", "_")


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def load_verifier_module():
    try:
        from _lib import ed25519_offline  # noqa: PLC0415
    except ImportError as error:
        refuse(f"the Ed25519 module .claude/hooks/_lib/ed25519_offline.py cannot be loaded ({error})")
    return ed25519_offline


def generate_keypair(issuer: str) -> int:
    lib = load_verifier_module()
    seed = os.urandom(32)
    public = base64.b64encode(lib.public_key(seed)).decode("ascii")
    # The ONE place a private key is printed, and only as the env line the vault takes.
    sys.stdout.write(f"{env_name(issuer)}={base64.b64encode(seed).decode('ascii')}\n")
    sys.stdout.flush()
    print(
        f"public key for {issuer!r} (add to .claude/config/deploy-authority-pubkeys.json):\n"
        f'  "{issuer}": ["{public}"]\n'
        "The private key was written to stdout only. If it was not piped into the vault, "
        "discard this keypair and generate another.",
        file=sys.stderr,
    )
    return 0


def sign(args) -> int:
    variable = env_name(args.issuer)
    raw = os.environ.get(variable, "")
    if not raw:
        refuse(
            f"{variable} is not set. The signing key is read only from that environment "
            "variable, injected by `infisical run` (see the docstring of this script and "
            "runbooks/prod-deploy-offline-signature.md)."
        )
    try:
        seed = base64.b64decode(raw.strip(), validate=True)
    except ValueError:
        seed = b""
    if len(seed) != 32:
        refuse(f"{variable} is not a base64 32-byte Ed25519 seed.")

    checks = (
        ("task", args.task, TASK_RE, "a task id (k + 15-40 lowercase alphanumerics)"),
        ("floor", args.floor, FLOOR_RE, "a FULL 40-hex lowercase commit SHA"),
        ("deployment", args.deployment, NAME_RE, "a deployment name (lowercase, digits, hyphens)"),
        ("orchestrator", args.orchestrator, ORCHESTRATOR_RE, "an orchestrator name"),
    )
    for field, value, pattern, wanted in checks:
        if not pattern.fullmatch(value or ""):
            refuse(f"--{field} must be {wanted}; got {value!r}.")

    lib = load_verifier_module()
    payload = {
        "v": PAYLOAD_VERSION,
        "purpose": PAYLOAD_PURPOSE,
        "task": args.task,
        "floor": args.floor,
        "deployment": args.deployment,
        "issuer": args.issuer,
        "orchestrator": args.orchestrator,
        "iat": int(args.iat if args.iat is not None else time.time()),
    }
    canonical = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    signature = lib.sign(seed, canonical)
    print(f"# pi-auth-payload: {b64url(canonical)} # pi-auth-sig: {b64url(signature)}")
    return 0


def main(argv) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--issuer", required=True)
    parser.add_argument("--generate-keypair", action="store_true")
    parser.add_argument("--task")
    parser.add_argument("--floor")
    parser.add_argument("--deployment")
    parser.add_argument("--orchestrator")
    parser.add_argument("--iat", type=int, help="issued-at, unix seconds (default: now)")
    args = parser.parse_args(argv)
    if not ISSUER_RE.fullmatch(args.issuer):
        refuse(f"--issuer must match {ISSUER_RE.pattern}; got {args.issuer!r}.")
    if args.generate_keypair:
        return generate_keypair(args.issuer)
    missing = [f for f in ("task", "floor", "deployment", "orchestrator") if not getattr(args, f)]
    if missing:
        refuse("missing " + ", ".join(f"--{f}" for f in missing) + ".")
    return sign(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
