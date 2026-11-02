import { defineApp } from "convex/server";
import rag from "@convex-dev/rag/convex.config.js";
// Durable long-task engine (I1 — long-task survival). Verified real (not
// the empty-shell alpha.1 dist-tag): dist/component/engine/durableJob.js
// exports start/getStatus/cancel/getJobInternal/runStepInternal. Pinned
// exactly at 0.1.0-alpha.2 in package.json — do NOT loosen to `^`/`@alpha`,
// `latest` still resolves to the empty shell.
import agentEngine from "@vantageos/agent-engine/convex.config";

const app = defineApp();

// SEAM: rag. Authority tier: fleet-internal. The component owns its tables
// and no public function exposes them; every read and write goes through
// convex/search.ts and convex/ragSync.ts. Boundary key: the entry `namespace`
// (also a RAG filter). A search runs on the namespace that
// `resolveSearchNamespace` (convex/search.ts) derived from the verified caller,
// never one taken from an argument, so a tenant's vectors are reachable only
// under that tenant's namespace.
app.use(rag);

// SEAM: agentEngine. The engine is driven only by internal functions in
// convex/okfBundleDurable.ts, entered through a public mutation that first
// resolves the caller with `withOrgScope`; it never reads our tables.
// Authority tier: fleet-internal. Boundary key: `orgId`, the resolved tenant,
// passed to `durableJob.start` and to every step, which re-checks it against
// its own `okfDurableExportProgress` row (OKF_DURABLE_CROSS_TENANT).
app.use(agentEngine); // registered under the default name "agentEngine"

export default app;
