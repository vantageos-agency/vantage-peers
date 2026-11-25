import { z } from "zod";

// The agent IDs a repo mapping stores beside its labels (the repo mapping's
// orchestratorAgentId / reviewerAgentId / fallbackReviewerAgentId). A task's
// assignee is compared with THESE when the organisation adopted explicit review
// routing, never with a label. Each is the `agentId` list_peers returns.
export const repoMappingAgentIdShape = {
	orchestratorAgentId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The agent ID (list_peers `agentId`) of the orchestrator above. " +
				"Required for the repo's tasks to be accepted once your organisation adopted explicit review routing. " +
				"Omit it to store none: an update without it clears the stored ID.",
		),
	reviewerAgentId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The agent ID (list_peers `agentId`) of the reviewer above; given only with `reviewer`. " +
				"Required for review tasks to be accepted once your organisation adopted explicit review routing. " +
				"Omit it to store none.",
		),
	fallbackReviewerAgentId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The agent ID (list_peers `agentId`) of the fallbackReviewer above; given only with `fallbackReviewer`. " +
				"Omit it to store none.",
		),
} as const;

/** The IDs to forward: only the ones given, so an old call sends the same arguments as before. */
export function repoMappingAgentIdArgs(ids: {
	orchestratorAgentId?: string;
	reviewerAgentId?: string;
	fallbackReviewerAgentId?: string;
}): Record<string, string> {
	const out: Record<string, string> = {};
	if (ids.orchestratorAgentId !== undefined) {
		out.orchestratorAgentId = ids.orchestratorAgentId;
	}
	if (ids.reviewerAgentId !== undefined) {
		out.reviewerAgentId = ids.reviewerAgentId;
	}
	if (ids.fallbackReviewerAgentId !== undefined) {
		out.fallbackReviewerAgentId = ids.fallbackReviewerAgentId;
	}
	return out;
}
