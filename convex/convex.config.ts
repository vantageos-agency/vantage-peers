import { defineApp } from "convex/server";
import rag from "@convex-dev/rag/convex.config.js";
import dataLake from "../packages/data-lake/convex.config.js";
import agentProtocol from "../packages/agent-protocol/convex.config.js";

const app = defineApp();
app.use(rag);
app.use(dataLake, { name: "dataLake" });
app.use(agentProtocol, { name: "agentProtocol" });

export default app;
