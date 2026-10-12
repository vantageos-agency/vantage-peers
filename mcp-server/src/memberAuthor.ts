import { personActorName } from "@vantageos/cloud-identity";
import { isMasterScope, type OAuthContext } from "./auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// memberAuthor - a Clerk-JWT member writes a memory or an episode in its OWN name.
//
// A person using VantagePeers Cloud from Claude.ai, ChatGPT or Claude Code
// reaches Convex with its own verified Clerk JWT (OAuthContext.clerkJwt). The
// Convex memory-table doors (memories:storeMemory, memoriesScoped:storeMemoryScoped,
// episodes:storeEpisode) record that caller as "user:<verified subject>" and
// refuse any other author. So for such a caller the author the client typed
// (an agent name, "claude", whatever the client likes) is not a claim anybody
// can honour: it is dropped here and nothing is forwarded; Convex stamps the
// verified subject. The label shown back to the caller is that same actor.
//
// Not this population: the fleet service account (master scope), a seat token
// and a person's OAuth access token, which reach Convex as the service account
// and keep stating the label of the seat they authenticated.
// ─────────────────────────────────────────────────────────────────────────────

/** True for a caller whose own verified Clerk JWT is what Convex resolves. */
export function isClerkMember(ctx: OAuthContext | undefined): boolean {
	return (
		ctx !== undefined &&
		ctx.clerkJwt !== undefined &&
		ctx.userId !== "" &&
		!isMasterScope(ctx)
	);
}

/** The author Convex will record for a Clerk-JWT member, or undefined for any other caller. */
export function memberAuthorLabel(
	ctx: OAuthContext | undefined,
): string | undefined {
	return ctx !== undefined && isClerkMember(ctx)
		? personActorName(ctx.userId)
		: undefined;
}
