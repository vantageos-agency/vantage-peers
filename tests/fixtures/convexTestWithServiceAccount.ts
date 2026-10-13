// TEST FIXTURE ONLY. `convexTest` for a test file that authenticates as the fleet
// service account (identity `{ subject: CLERK_SERVICE_ACCOUNT_USER_ID }`, the
// value the root vitest.config.ts sets).
//
// The service account is stored data (module M2 part 2), not an env value, so a
// test that calls Convex as that account needs the chain seeded first
// (tests/fixtures/seedServiceAccount.ts). A file opts in EXPLICITLY by importing
// `convexTest` from here instead of from "convex-test"; before the first call a
// test makes with that identity, `seedServiceAccount` runs. Files that do not
// import this get the plain package, so their fail-closed behaviour is the real
// one (e.g. convex/__tests__/serviceAccountById.test.ts seeds each pole itself).
//
// THE FLEET STATION'S CLAIM (backend standard R-54). A door in
// FLEET_STATION_CLAIM_DOORS refuses a service-account call that names no
// organisation; in production the MCP transport adds the OPERATOR organisation's
// claim to every such call made by the fleet's own stations (the master bearer,
// mcp-server/src/operatorClaim.ts), the operator organisation being the stored
// `orgKind: "operator"` row. `convexTest` (this export) models that station: a
// service-account call to one of those doors that carries no `verifiedOrg` gets
// the stored operator organisation's. `convexTestStrict` does not: it is the
// service account with no transport in front of it, and is what a test uses to
// pin the claimless REFUSAL (claimlessServiceAccountRefused.test.ts).

import { convexTest as plainConvexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { FLEET_STATION_CLAIM_DOORS } from "./fleetStationDoors";
import { type Runner, seedServiceAccount } from "./seedServiceAccount";

type Fn = (...args: unknown[]) => unknown;
const CALLS = new Set(["query", "mutation", "action", "run"]);
const DOOR_CALLS = new Set(["query", "mutation", "action"]);

function isServiceSubject(identity: unknown): identity is { subject: string } {
	const serviceSubject = process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
	return (
		!!serviceSubject &&
		typeof identity === "object" &&
		identity !== null &&
		(identity as { subject?: unknown }).subject === serviceSubject
	);
}

function doorNameOf(ref: unknown): string | undefined {
	try {
		return getFunctionName(ref as never);
	} catch {
		return undefined;
	}
}

// The operator organisation as the transport would name it: the stored active row
// whose kind is "operator". None: no claim is added and the door refuses.
async function operatorSlugOf(root: Runner): Promise<string | undefined> {
	return (await root.run(async (ctx: unknown) => {
		const rows = await (
			ctx as {
				db: {
					query: (t: string) => { collect: () => Promise<Array<Record<string, unknown>>> };
				};
			}
		).db
			.query("client_org_mapping")
			.collect();
		const operator = rows.find(
			(r) => r.orgKind === "operator" && r.isActive === true,
		);
		return typeof operator?.clerkOrgSlug === "string"
			? operator.clerkOrgSlug
			: undefined;
	})) as string | undefined;
}

async function withStationClaim(root: Runner, args: unknown[]): Promise<unknown[]> {
	const name = doorNameOf(args[0]);
	if (name === undefined || !FLEET_STATION_CLAIM_DOORS.has(name)) return args;
	const given = args[1];
	if (given !== undefined && (typeof given !== "object" || given === null)) {
		return args;
	}
	const a = (given ?? {}) as Record<string, unknown>;
	if (a.verifiedOrg !== undefined || a.verifiedPerson !== undefined) return args;
	const orgSlug = await operatorSlugOf(root);
	if (orgSlug === undefined) return args;
	return [args[0], { ...a, verifiedOrg: { orgSlug } }, ...args.slice(2)];
}

function wrapIdentity(
	client: object,
	root: Runner,
	identity: unknown,
	stationClaims: boolean,
): object {
	return new Proxy(client, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target) as unknown;
			if (typeof value !== "function") return value;
			if (prop === "withIdentity") {
				return (next: unknown) =>
					wrapIdentity(
						(value as Fn).call(target, next) as object,
						root,
						next,
						stationClaims,
					);
			}
			if (typeof prop === "string" && CALLS.has(prop)) {
				return async (...args: unknown[]) => {
					let callArgs = args;
					if (isServiceSubject(identity)) {
						await seedServiceAccount(root, identity.subject);
						if (stationClaims && DOOR_CALLS.has(prop)) {
							callArgs = await withStationClaim(root, args);
						}
					}
					return (value as Fn).apply(target, callArgs);
				};
			}
			return (value as Fn).bind(target);
		},
	});
}

function makeConvexTest(stationClaims: boolean): typeof plainConvexTest {
	return ((...args: Parameters<typeof plainConvexTest>) => {
		const root = (plainConvexTest as unknown as (...a: unknown[]) => object)(
			...args,
		);
		return new Proxy(root, {
			get(target, prop) {
				const value = Reflect.get(target, prop, target) as unknown;
				if (typeof value !== "function") return value;
				if (prop === "withIdentity") {
					return (identity: unknown) =>
						wrapIdentity(
							(value as Fn).call(target, identity) as object,
							target as Runner,
							identity,
							stationClaims,
						);
				}
				return (value as Fn).bind(target);
			},
		});
	}) as unknown as typeof plainConvexTest;
}

export const convexTest = makeConvexTest(true);
export const convexTestStrict = makeConvexTest(false);
