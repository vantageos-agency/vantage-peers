import { defineApp } from "convex/server";
import rag from "@convex-dev/rag/convex.config.js";
// Durable long-task engine (I1 — long-task survival). Verified real (not
// the empty-shell alpha.1 dist-tag): dist/component/engine/durableJob.js
// exports start/getStatus/cancel/getJobInternal/runStepInternal. Pinned
// exactly at 0.1.0-alpha.2 in package.json — do NOT loosen to `^`/`@alpha`,
// `latest` still resolves to the empty shell.
import agentEngine from "@vantageos/agent-engine/convex.config";

const app = defineApp();
app.use(rag);
app.use(agentEngine); // registered under the default name "agentEngine"

export default app;
