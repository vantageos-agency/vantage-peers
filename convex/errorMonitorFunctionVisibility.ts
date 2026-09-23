// ─────────────────────────────────────────────────────────────────────────────
// errorMonitorFunctionVisibility
// ─────────────────────────────────────────────────────────────────────────────
// Runtime (not type-level) lookup of whether a Convex function identifier
// ("module:function", the shape carried in Convex's stream_function_logs
// `identifier` field -- see pollDeploymentLogs in errorMonitorActions.ts) is
// registered public or internal in THIS repo's own source.
//
// WHY NOT convex/_generated/api.d.ts: `api` and `internal` are the exact
// SAME `anyApi` proxy at runtime (see convex/_generated/api.js -- both
// `export const api = anyApi` and `export const internal = anyApi`). The
// public/internal split exists ONLY as a TypeScript type parameter on
// `FunctionReference<..., "public" | "internal">` -- it is erased at
// compile time and carries no runtime value. Depending on api.d.ts for this
// decision would depend on something that, at runtime, does not exist.
//
// WHAT DOES EXIST AT RUNTIME: `query()`/`mutation()`/`action()` set
// `.isPublic = true` on the function object they return; `internalQuery()`/
// `internalMutation()`/`internalAction()` set `.isInternal = true`
// (convex/server's registration_impl.ts, confirmed by reading
// node_modules/convex/dist/esm/server/impl/registration_impl.js). Reading
// that value requires importing the actual SOURCE module -- not the
// generated api surface.
//
// WHY A STATIC, EXPLICIT REGISTRY -- NOT A DYNAMIC `import(moduleName)`:
// `moduleName` is derived from a Convex log entry's `identifier` field,
// which is influenced by whatever function name a caller's request
// happened to hit. Building an import() specifier from that string, however
// narrowly sanitized, is a dynamic-path-from-untrusted-input pattern this
// repo does not otherwise use (the one existing `await import(...)` call,
// in http.ts, is a static string literal). A static `import * as X from
// "./X"` below is resolved at build time and can never be pointed anywhere
// this file does not itself name.
//
// COVERAGE IS INTENTIONALLY PARTIAL, AND THAT IS SAFE BY CONSTRUCTION: a
// module/export not yet listed in REGISTRY resolves to "unknown", and
// errorMonitorRefusalClassifier.ts's `classifyRefusal` treats "unknown"
// exactly like "internal" -- it NEVER downgrades an unknown function to a
// working refusal. An incomplete registry can only ever produce MORE
// escalations (noise), never fewer (a hidden defect) -- the same
// fail-toward-the-safe-pole asymmetry this repo's auth rules apply to
// fail-toward-deny (see .claude/rules/authority-attached-to-anonymous-
// object.md: "a lookup failure is a DENY, never an implicit ALLOW" --
// mirrored here as "a lookup failure is an ESCALATE, never an implicit
// SKIP"). Extend REGISTRY as more modules need their public
// ArgumentValidationError refusals recognised.
// ─────────────────────────────────────────────────────────────────────────────

import * as errorMonitor from "./errorMonitor";
import * as errorMonitorFilters from "./errorMonitorFilters";
import type { FunctionVisibility } from "./errorMonitorRefusalClassifier";
import * as tasks from "./tasks";

interface RegisteredConvexFunction {
	isPublic?: true;
	isInternal?: true;
}

type ConvexModuleNamespace = Record<string, unknown>;

// module identifier (as it appears before the ":" in a Convex log
// `identifier` field) -> the statically-imported source module namespace.
const REGISTRY: Record<string, ConvexModuleNamespace> = {
	tasks,
	errorMonitor,
	errorMonitorFilters,
};

/**
 * Resolve whether `functionName` ("module:function", e.g. "tasks:get")
 * names a public or internal Convex function, per THIS repo's own source --
 * never per anything the caller/log entry claims.
 *
 * Splits on the FIRST colon only. Convex identifiers for functions nested
 * under a subdirectory look like "_helpers/foo:bar" -- the module segment
 * itself never contains a colon, so splitting on the first occurrence is
 * safe for every identifier shape this repo produces.
 *
 * Returns "unknown" (never throws) when the module is not in REGISTRY, the
 * export does not exist on that module, or the export is not itself a
 * registered Convex function (no `.isPublic`/`.isInternal`). See the
 * module-level comment above for why "unknown" is a safe default.
 */
export function resolveFunctionVisibility(
	functionName: string,
): FunctionVisibility {
	const colonIndex = functionName.indexOf(":");
	if (colonIndex === -1) return "unknown";
	const moduleName = functionName.slice(0, colonIndex);
	const exportName = functionName.slice(colonIndex + 1);
	if (!moduleName || !exportName) return "unknown";

	const mod = REGISTRY[moduleName];
	if (!mod) return "unknown";

	// Registered Convex functions are exported as FUNCTIONS with extra
	// properties attached (registration_impl.ts patches `.isPublic`/
	// `.isInternal` directly onto the function object) -- typeof is
	// "function", never "object". Accept either shape defensively; reject
	// only primitives/undefined, which cannot carry those properties.
	const candidate = mod[exportName] as RegisteredConvexFunction | undefined;
	if (
		candidate == null ||
		(typeof candidate !== "function" && typeof candidate !== "object")
	) {
		return "unknown";
	}
	if (candidate.isInternal === true) return "internal";
	if (candidate.isPublic === true) return "public";
	return "unknown";
}
