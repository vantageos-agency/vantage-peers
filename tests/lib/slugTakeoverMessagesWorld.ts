// TEST FIXTURE ONLY. The slug-takeover world for the messages family (task
// k1783fk8r6p795x9fxrzyt9evd8hcxm7, PR (2b), sweep sites A-6..A-19).
//
// Org A (permanent id X) held SLUG, was renamed to RENAMED; org B (id Y) now holds
// SLUG. Rows A stamped at the time carry tenantId SLUG and tenantOrgId X. The same
// slug string now names B, so a read keyed on the slug serves B the rows of A.
//
// Row shapes seeded for messages AND receipts (Pi ruling 2):
//   a  noSlug      no tenantId, no tenantOrgId   (fleet shape; 426 messages in prod)
//   b  absentSlug  tenantId SLUG, no tenantOrgId (14 prod rows)
//   c  stamped     A's rows (SLUG, X) and B's own rows (SLUG, Y)

import { testClerkOrgId } from "../fixtures/testClerkOrgId";
import type { Id } from "../../convex/_generated/dataModel";

export const SLUG = "shared-slug";
export const RENAMED = "renamed-a";
export const ORG_A = testClerkOrgId("org-a-permanent") as string;
export const ORG_B = testClerkOrgId("org-b-permanent") as string;

export const TEXT = {
	a: "probe A-secret",
	b: "probe B-own",
	fleet: "probe fleet-msg",
	absent: "probe absent-slug-msg",
} as const;

type Db = {
	// biome-ignore lint/suspicious/noExplicitAny: a structural handle on the test db writer
	insert: (table: any, doc: any) => Promise<any>;
	// biome-ignore lint/suspicious/noExplicitAny: a structural handle on the test db writer
	patch: (id: any, doc: any) => Promise<void>;
};

export type Seeded = {
	messages: Record<keyof typeof TEXT, Id<"messages">>;
	receipts: Record<keyof typeof TEXT, Id<"messageReceipts">>;
};

const SCOPES = [
	"view-own-tasks",
	"view-own-missions",
	"view-stats-aggregated",
	"vantage:read",
	"vantage:write",
];

/** A (X) held SLUG and was renamed; B (Y) holds SLUG now. Rosters both name "sigma". */
export async function seedTakeoverOrgs(db: Db): Promise<void> {
	const mappingA = await db.insert("client_org_mapping", {
		clerkOrgSlug: SLUG,
		clerkOrgId: ORG_A,
		allowedOrchestrators: ["sigma", "nadia-a"],
		scopes: SCOPES,
		displayName: "A",
		isActive: true,
		createdAt: 1,
	});
	await db.patch(mappingA, { clerkOrgSlug: RENAMED });
	await db.insert("client_org_mapping", {
		clerkOrgSlug: SLUG,
		clerkOrgId: ORG_B,
		allowedOrchestrators: ["sigma", "bruno-b"],
		scopes: SCOPES,
		displayName: "B",
		isActive: true,
		createdAt: 2,
	});
}

/**
 * One message and one unread receipt per shape, all addressed to `recipient` on
 * channel `channel`. `now` spaces createdAt so ordering is deterministic.
 */
export async function seedShapes(
	db: Db,
	opts: { channel?: string; recipient?: string; from?: string } = {},
): Promise<Seeded> {
	const channel = opts.channel ?? "sigma";
	const recipient = opts.recipient ?? "sigma";
	const from = opts.from ?? "sigma";
	const base = Date.now();
	const shapes: Array<[keyof typeof TEXT, string | undefined, string | undefined]> =
		[
			["a", SLUG, ORG_A],
			["b", SLUG, ORG_B],
			["fleet", undefined, undefined],
			["absent", SLUG, undefined],
		];
	const messages = {} as Seeded["messages"];
	const receipts = {} as Seeded["receipts"];
	let i = 0;
	for (const [key, tenantId, tenantOrgId] of shapes) {
		const stamp = {
			...(tenantId !== undefined ? { tenantId } : {}),
			...(tenantOrgId !== undefined ? { tenantOrgId } : {}),
		};
		messages[key] = await db.insert("messages", {
			from,
			channel,
			content: TEXT[key],
			createdAt: base + i,
			...stamp,
		});
		receipts[key] = await db.insert("messageReceipts", {
			messageId: messages[key],
			recipient,
			readAt: undefined,
			...stamp,
		});
		i++;
	}
	return { messages, receipts };
}

type Identity = {
	subject: string;
	org_slug: string;
	org_id: string;
	org_role: string;
};

/** The session of a member of A (its CURRENT label is RENAMED). */
export const memberA = (subject = "user-a"): Identity => ({
	subject,
	org_slug: RENAMED,
	org_id: ORG_A,
	org_role: "org:admin",
});

/** The session of a member of B (the new holder of SLUG). */
export const memberB = (subject = "user-b"): Identity => ({
	subject,
	org_slug: SLUG,
	org_id: ORG_B,
	org_role: "org:admin",
});
