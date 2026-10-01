import { createHmac } from "node:crypto";

/** Secret the webhook tests configure for GITHUB_WEBHOOK_SECRET. */
export const TEST_WEBHOOK_SECRET = "test-github-webhook-secret";

/** GitHub-style `x-hub-signature-256` header value for a raw body. */
export function signGithubBody(
	body: string,
	secret: string = TEST_WEBHOOK_SECRET,
): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
