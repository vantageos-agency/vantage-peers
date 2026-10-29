// Test fixture: put a blob in storage AND bind it to an org in kbUploads, the
// state a real caller reaches through generateUploadUrlWithTicket -> POST ->
// claimUpload. kb:storeDocumentChunked refuses a storageId its caller's org has
// not claimed (task k17fh6652a49jw3dc8ns0bgq4x8h6e17), so tests that exercise
// ingest rather than the claim flow seed the claim here. The claim flow itself is
// pinned in convex/__tests__/kbStoreRequiresClaim.test.ts.
import type { Id } from "../../convex/_generated/dataModel";
import type { MutationCtx } from "../../convex/_generated/server";

export async function storeClaimed(
	// convex-test's t.run context adds `storage.store`, absent from the real type.
	ctx: Pick<MutationCtx, "db"> & {
		storage: { store(blob: Blob): Promise<Id<"_storage">> };
	},
	ownerKey: string,
	blob: Blob,
): Promise<Id<"_storage">> {
	const storageId = await ctx.storage.store(blob);
	await ctx.db.insert("kbUploads", {
		storageId,
		orgId: ownerKey,
		createdAt: Date.now(),
	});
	return storageId;
}
