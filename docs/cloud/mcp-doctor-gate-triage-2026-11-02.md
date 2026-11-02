# VantagePeers Cloud MCP server — mcp-doctor `--gate` refusal triage (2026-11-02)

Task k177c3g4wmvxzawk0znz28f54x8he7wx (Pi ruling: a total is not a debt until triaged; no gate wiring and no fix campaign before this table).

## Measurement

```
mcp-doctor @ main b34f68a (elpiarthera/mcp-doctor; npm latest is 0.18.0, without #131/#132)
node dist/doctor.js /root/coding/vantage-memory/mcp-server --gate \
  --backend=/root/coding/vantage-memory/convex --json
-> exitCode 1, gate.passed false
-> 118 results: present 26, non-conforming 23, could-not-judge 27, absent 42
-> gate.refusals: 23 of kind "violation" (the 23 non-conforming), the rest "undeclared"
```

Tree judged: vantage-peers `main` @ 04c0fcce5e4e51ce88515bd571482e1c4c065265 (includes #1680, D8 present).

The "undeclared" refusals (D3, D4, C12, C21, C31, C29, C30, E8, E9, E12, C32, A2, A7, S12, A8, DExt1, C27, …) are owed declarations (`--owed <file>`), not part of the 23, and are not triaged here.

## Verdict per detector

Classes:
- **VIOLATION**: the artifact the rule requires is proven absent where it lives, with no written exemption.
- **INSTRUMENT DEFECT**: the detector looked in the wrong place or cannot read the shape.
- **COULD-NOT-JUDGE**: owed, with the reason.

Evidence lines are this station's command output on the tree above. A `grep -c` of 0 is run over `mcp-server/src` + `server-http.ts`, tests excluded.

| # | Detector (rule) | Verdict | Evidence | Route |
|---|---|---|---|---|
| 1 | D10 bilingual (C-1) | VIOLATION | `ls mcp-server/README.fr.md` -> absent; `grep description_fr mcp-server/package.json` -> none | fix: FR description + README.fr.md |
| 2 | C7 artifact-verifiable (C-7b) | VIOLATION | README.md:352 install `npx vantage-peers-mcp` carries no `@<version>` pin | fix: document the pinned install + rollback |
| 3 | C8 authority-declared (C-8) | VIOLATION | `authRead` -> 0 files; first tool `export_okf_bundle` src/tools/exportOkfBundle.ts:115 | fix: (authRead, authWrite) per tool |
| 4 | C9 verb-declared (C-9) | VIOLATION | `annotations.verb` / `verb:` -> 0 files | fix: annotations.verb per tool |
| 5 | C10 mechanism-declared (C-10) | VIOLATION | `searchMechanism` -> 0 files; first list tool `list_episodes` src/tools.ts:2932 | fix: annotations.searchMechanism on list/search tools |
| 6 | C11 pagination-declared-applied (C-11) | VIOLATION | detector: 24 of 24 paginable tools miss cursor/default declarations (first: src/tools.ts:2932) | fix: declare pagination per paginable tool |
| 7 | C13 context-ceiling (C-13) | VIOLATION | `contextCeiling\|CONTEXT_CEILING` -> 0 files; no mcp.json / mcp-server.json | fix: manifest contextCeiling {global, perTool} |
| 8 | C15 annotations-untrusted (C-15) | VIOLATION | `idempotentHint` -> 0 files | fix: the four behavioural hints per tool |
| 9 | C18 structure-manifest (C-18) | VIOLATION | `ls mcp-server/mcp.json mcp-server/mcp-server.json` -> both absent | fix: server manifest |
| 10 | S5 authz-elements (g) (S-5) | VIOLATION | server-http.ts:388-391 deliberately does NOT advertise `client_id_metadata_document_supported` ("until both endpoints fetch and validate the document (SSRF-safe)") | product decision: implement CIMD (SSRF-safe fetch at /authorize and /token) or file a written exemption |
| 11 | S17 forward-auth (S-17) | VIOLATION | same cause as row 10; DCR offered at server-http.ts:374 | same as row 10 (one delivery) |
| 12 | C33 identity-tool (C-33) | VIOLATION | `whoamiOutputSchema` src/tools.ts:1095 keys: scope_profile_name, suggested_orchestrator_id, actor, agent_id, agent_unresolved_reason, caller_id, org_slug, role, acting_name — no `id` | fix: additive opaque stable `id` (outputSchema stays loose / additive) |
| 13 | DToolRoles tool-roles | VIOLATION | `decideToolRole\|filterGrantedTools` -> 0 files | fix: tools/call + tools/list through @vantageos/cloud-identity decideToolRole |
| 14 | A11 sandbox-domain-derived (A-11) | VIOLATION | `claudemcpcontent` -> 0 files; 3 ui:// resources src/ui-resources/apps.ts:45 served over HTTP (server-http.ts:309) | fix: derive `_meta.ui.domain` from the served URL |
| 15 | S22 origin-validation (S-22) | VIOLATION | no Origin read with an allowlist / 403 in server-http.ts or src (grep of origin header reads -> none); Streamable HTTP at server-http.ts:2255 | fix: Origin allowlist + 403 (DNS rebinding) |
| 16 | S24 tool-rate-limit (S-24) | VIOLATION | the only limiter is POST /register (server-http.ts:396-412); `rateLimit` on tool paths -> 0 files; detector: 116 of 116 tools unguarded | fix: per-caller tool rate guard |
| 17 | S13 progress-cancel (timeouts) | VIOLATION | `AbortSignal.timeout` -> 0 files; detector: src/authorize.ts:166 fetch with no signal/timeout | fix: a timeout on every outbound request |
| 18 | S39 upstream-error (S-39) | VIOLATION | src/serviceAccountAuth.ts:116 fetch with no time budget; server-http.ts:1744/2172/2233 pass upstream content into `convexFailureText` | fix: timeout + error text not built from upstream content (same delivery as row 17) |
| 19 | S38 bounded-upstream-call (S-38) | VIOLATION | src/serviceAccountAuth.ts:116: URL not compared to declared origins; redirects followed by default | fix: origin check + `redirect: "error"` |
| 20 | S37 upstream-settings (S-37) | VIOLATION | detector: server-http.ts:111 PUBLIC_BASE_URL, :811 CLERK_SECRET_KEY, :812 CLERK_PUBLISHABLE_KEY … read via `process.env` and absent from a declaration | fix: declare every env read in the start-up check |
| 21 | DLocalIdentity no-local-identity | VIOLATION | detector: 32 local identity primitives, ceiling 0 (first server-http.ts:1196, src/auth.ts:226) | fix: move each to @vantageos/cloud-identity (identity-by-id track); likely several deliveries |
| 22 | S-28 claim-forwarded (S-28) | COULD-NOT-JUDGE | detector: conform 44 / non-conforming 73 / could-not-judge 25. The 73 include "the door accepts no claim argument, so R-54 must add one" (e.g. src/state-tokens.ts:287 tasks:get): a backend-side prerequisite, not a per-site MCP violation this station has verified. Owed: a per-site review of the 73 | sigma: per-site review; shape questions -> mcp-doctor reader-limit task k176r3t4x4r9xs0n88y5bvxffh8hfag1 |
| 23 | S35 scope-in-read (S-35) | COULD-NOT-JUDGE | detector: src/tools.ts:2575 `scopeFilterGet` after memories:getMemory, :4298 `scopeFilterList` after profiles:listProfiles, :5172 … Whether each narrowing is a defect (scope belongs in the read's arguments) or an accepted second layer behind a Convex-scoped door is not established here. Owed: per-site review against the door's own scoping | sigma: per-site review; shape questions -> k176r3t4x4r9xs0n88y5bvxffh8hfag1 |

## Totals

- **VIOLATION: 21** (rows 1-21)
- **INSTRUMENT DEFECT: 0**. No detector was shown to read the wrong place: every row checked by hand found the artifact absent.
- **COULD-NOT-JUDGE: 2** (rows 22-23), owed per-site reviews.

## Grouping for dispatch (Pi)

1. **Declarations** (rows 3-9, 13): per-tool authority, verb, search mechanism, pagination, hints, plus a server manifest with contextCeiling and the tool-role decision. One shape change across 117 tools, mechanical once the vocabulary is fixed.
2. **Release hygiene** (rows 1, 2): README.fr.md, description_fr, pinned install.
3. **HTTP hardening** (rows 15-19): Origin allowlist, tool rate guard, timeouts, origin-bounded upstream calls without redirects, error text not built from upstream content.
4. **Identity** (rows 12, 21): whoami `id`; local identity primitives moved to cloud-identity.
5. **OAuth** (rows 10, 11): CIMD (SSRF-safe document fetch) or a written exemption. This is a product decision.
6. **Apps** (row 14): sandbox domain derived from the served URL.
7. **Per-site reviews** (rows 22, 23) before any S-28 / S35 fix.

## not_measured

- No fix was attempted and none is proposed in code.
- The 27 could-not-judge results and the "undeclared" refusals outside the 23 are not triaged.
- Rows 6, 16, 18, 19, 20, 21 rely on the detector's own site lists, spot-checked on their first sites only.
- mcp-doctor run from main b34f68a, not a published release.
