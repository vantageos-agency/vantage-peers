/**
 * The route's per-request Convex client (`convex/browser`), replaced in a test by
 * a client that forwards every call to `backend.run` (set by the test's world).
 * Kept apart from the world module so a `vi.mock` factory can import it without
 * importing the server it is mocking for.
 */

export const backend: {
	run: null | ((kind: string, name: string, args: unknown) => Promise<unknown>);
} = { run: null };

function forward(kind: string, name: string, args: unknown): Promise<unknown> {
	if (backend.run === null) {
		throw new Error("forwardingConvex: no backend installed for this test");
	}
	return backend.run(kind, String(name), args);
}

/** Constructed by the route as `new ConvexHttpClient(url)`; the URL is ignored. */
export class ForwardingConvexHttpClient {
	setAuth(_token: string) {}
	clearAuth() {}
	async query(name: string, args: unknown) {
		return await forward("query", name, args);
	}
	async mutation(name: string, args: unknown) {
		return await forward("mutation", name, args);
	}
	async action(name: string, args: unknown) {
		return await forward("action", name, args);
	}
}
