import { type OAuthContext, seatAgentOf } from "./auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// verifiedActor - the agent's unique ID, forwarded to the Convex doors that take
// an actor (Pi ruling k174d95s5qqy8t2r5rdrz3pr3d8fqv82: the MCP forwards IDs
// only).
//
// The ID comes from exactly two places, both resolved by Convex and read here
// off the verified context, never from a tool argument:
//   - a presented agent credential: `ctx.actor.agentId`
//     (agentCredentials:resolveAgentCredential);
//   - a one-agent seat token: `ctx.seatAgent` (oauth:getAccessTokenByHash).
// Nothing is forwarded when no ID was resolved - which is also what makes the
// reader-first deploy safe: an older Convex returns neither, so the MCP sends
// nothing a door would reject as an unknown argument.
//
// The Convex side (convex/lib/auth.ts requireVerifiedActorMatch) believes the
// claim from the fleet service account only, loads the agents row BY ID,
// requires it active and in the stated org, and checks any asserted name
// resolves to that same row.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every Convex door that declares `verifiedActor` AND is called by an MCP tool.
 * The sweep in test/agent-id-on-seat.test.ts proves each name here really
 * declares it; a door added to Convex with the argument and called from a tool
 * is added here on purpose.
 */
export const VERIFIED_ACTOR_DOORS: ReadonlySet<string> = new Set([
	"messages:sendMessage",
	"tasks:create",
	"tasks:update",
	"tasks:complete",
	"tasks:failTask",
	"tasks:start",
	"tasks:pause",
	"tasks:resume",
	"tasks:correctSegment",
	"tasks:checkout",
	"tasks:deleteTask",
	"tasks:blockTask",
	"tasks:bulkComplete",
]);

export type VerifiedActorArg = { agentId: string; orgSlug: string };

/**
 * The acting agent's ID and org for this request, or undefined.
 *
 * A Clerk-JWT session is excluded: its Convex client carries the caller's OWN
 * identity, not the service account, and the door believes `verifiedActor` from
 * the service account only. A master / stdio context holds no agent ID.
 */
export function verifiedActorOf(
	ctx: OAuthContext | undefined,
): VerifiedActorArg | undefined {
	if (!ctx || ctx.clerkJwt !== undefined) return undefined;
	if (ctx.actor?.agentId !== undefined) {
		return { agentId: ctx.actor.agentId, orgSlug: ctx.actor.orgSlug };
	}
	const seat = seatAgentOf(ctx);
	if (seat !== undefined && ctx.principal === undefined) {
		return { agentId: seat.agentId, orgSlug: seat.orgId };
	}
	return undefined;
}

type MutatingClient = {
	mutation: (name: never, args: never, ...rest: never[]) => unknown;
};

/**
 * Wraps a Convex client so every call to a {@link VERIFIED_ACTOR_DOORS} door
 * carries the resolved agent's `verifiedActor`. Returns the SAME client object
 * when no agent ID was resolved, so a caller without one is byte-for-byte
 * unchanged.
 *
 * Left alone: a call that already carries a proof (`verifiedActor`,
 * `verifiedPerson`, `agentCredentialSecret`: one proof per call), and
 * `messages:sendMessage` without a sender, which is the PERSON path of that door
 * and refuses an agent proof as a contradiction.
 */
export function withVerifiedActor<T extends MutatingClient>(
	convex: T,
	ctx: OAuthContext | undefined,
): T {
	const actor = verifiedActorOf(ctx);
	if (actor === undefined) return convex;
	return new Proxy(convex, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target) as unknown;
			if (prop === "mutation") {
				return (name: string, args: unknown, ...rest: unknown[]) => {
					const call = target.mutation as unknown as (
						...a: unknown[]
					) => unknown;
					if (
						VERIFIED_ACTOR_DOORS.has(name) &&
						typeof args === "object" &&
						args !== null
					) {
						const a = args as Record<string, unknown>;
						const carriesProof =
							a.verifiedActor !== undefined ||
							a.verifiedPerson !== undefined ||
							a.agentCredentialSecret !== undefined;
						const senderless =
							name === "messages:sendMessage" &&
							(a.from === undefined || a.from === null);
						if (!carriesProof && !senderless) {
							return call.call(target, name, { ...a, verifiedActor: actor }, ...rest);
						}
					}
					return call.call(target, name, args, ...rest);
				};
			}
			return typeof value === "function"
				? (value as (...a: unknown[]) => unknown).bind(target)
				: value;
		},
	});
}
