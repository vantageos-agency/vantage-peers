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

import { convexTest as plainConvexTest } from "convex-test";
import { type Runner, seedServiceAccount } from "./seedServiceAccount";

type Fn = (...args: unknown[]) => unknown;
const CALLS = new Set(["query", "mutation", "action", "run"]);

function isServiceSubject(identity: unknown): identity is { subject: string } {
	const serviceSubject = process.env.CLERK_SERVICE_ACCOUNT_USER_ID;
	return (
		!!serviceSubject &&
		typeof identity === "object" &&
		identity !== null &&
		(identity as { subject?: unknown }).subject === serviceSubject
	);
}

function wrapIdentity(client: object, root: Runner, identity: unknown): object {
	return new Proxy(client, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target) as unknown;
			if (typeof value !== "function") return value;
			if (prop === "withIdentity") {
				return (next: unknown) =>
					wrapIdentity((value as Fn).call(target, next) as object, root, next);
			}
			if (typeof prop === "string" && CALLS.has(prop)) {
				return async (...args: unknown[]) => {
					if (isServiceSubject(identity)) {
						await seedServiceAccount(root, identity.subject);
					}
					return (value as Fn).apply(target, args);
				};
			}
			return (value as Fn).bind(target);
		},
	});
}

export const convexTest = ((...args: Parameters<typeof plainConvexTest>) => {
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
					);
			}
			return (value as Fn).bind(target);
		},
	});
}) as unknown as typeof plainConvexTest;
