/**
 * In-memory mirror of the two Convex doors the /token refresh grant calls
 * (convex/oauth.ts): `getRefreshTokenForGrant` and `rotateRefreshToken`. One
 * implementation for every test that fakes the Convex client, so the fake keeps
 * the contract the real door has: a live token rotates, a spent token is a
 * replay that revokes the whole family, an unknown / expired token or a wrong
 * client is invalid and spends nothing.
 */
export type FakeRefreshRow = {
	clientId: string;
	userId: string;
	scopeProfile: string;
	expiresAt: number;
	revokedAt?: number;
	familyId?: string;
};

export type FakeAccessRow = {
	tokenHash: string;
	refreshTokenHash?: string;
	familyId?: string;
	revokedAt?: number;
};

export type RotationStore = {
	/** Refresh rows keyed by token HASH. */
	refresh: Map<string, FakeRefreshRow>;
	/** Access rows minted by a rotation. */
	access: FakeAccessRow[];
};

export function fakeGetRefreshTokenForGrant(
	store: RotationStore,
	args: Record<string, unknown>,
) {
	const row = store.refresh.get(args.tokenHash as string);
	if (!row) return null;
	const spent = row.revokedAt !== undefined;
	if (!spent && row.expiresAt < Date.now()) return null;
	return {
		clientId: row.clientId,
		userId: row.userId,
		scopeProfile: row.scopeProfile,
		expiresAt: row.expiresAt,
		spent,
	};
}

export function fakeRotateRefreshToken(
	store: RotationStore,
	args: Record<string, unknown>,
): { status: "ok" | "reused" | "invalid" } {
	const presented = args.presentedHash as string;
	const row = store.refresh.get(presented);
	if (!row) return { status: "invalid" };
	const familyId = row.familyId ?? presented;
	if (row.revokedAt !== undefined) {
		const now = Date.now();
		for (const r of store.refresh.values()) {
			if (r.familyId === familyId && r.revokedAt === undefined) r.revokedAt = now;
		}
		for (const a of store.access) {
			if (a.familyId === familyId && a.revokedAt === undefined) a.revokedAt = now;
		}
		return { status: "reused" };
	}
	if (row.expiresAt < Date.now()) return { status: "invalid" };
	if (row.clientId !== args.clientId) return { status: "invalid" };
	row.revokedAt = Date.now();
	store.refresh.set(args.newRefreshTokenHash as string, {
		clientId: row.clientId,
		userId: row.userId,
		scopeProfile: args.scopeProfile as string,
		expiresAt: args.refreshExpiresAt as number,
		familyId,
	});
	store.access.push({
		tokenHash: args.newAccessTokenHash as string,
		refreshTokenHash: args.newRefreshTokenHash as string,
		familyId,
	});
	return { status: "ok" };
}
