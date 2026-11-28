/**
 * errorMonitorIssueShape -- the public GitHub issue carries SHAPE ONLY.
 *
 * Operator ruling (2026-11-28, via Pi): the issue title and body name the
 * function(s), the error CLASS (+ code prefix), the deployment, first/last
 * seen, the count and the repo file:line of the throw. Never a message
 * sentence, a "Path:"/"Value:" echo, an argument object, a row, an id, or a
 * stack message line. The full raw text stays in the private errorLogs row.
 */
import { describe, expect, test } from "vitest";
import {
	classifyError,
	redactIssueBody,
	redactIssueTitle,
	shapeIssue,
} from "../errorMonitorIssueShape";

const T0 = Date.UTC(2026, 10, 27, 10, 0, 0);
const T1 = Date.UTC(2026, 10, 28, 9, 30, 0);

const base = {
	functionNames: ["rooms:join"],
	deployment: "prod",
	firstSeen: T0,
	lastSeen: T1,
	count: 7,
};

function whole(s: { title: string; body: string }): string {
	return `${s.title}\n${s.body}`;
}

describe("shapeIssue -- poles", () => {
	test("ArgumentValidationError with Path/Value: neither appears", () => {
		const s = shapeIssue({
			...base,
			errorMessage:
				"[Request ID: abc123] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .roomId\nValue: \"jd7f3k2h9x8m4n5p6q7r8s9t0\"\nValidator: v.id(\"rooms\")",
			stackTrace: "",
		});
		const all = whole(s);
		expect(all).toContain("ArgumentValidationError");
		expect(all).toContain("rooms:join");
		expect(all).not.toMatch(/Path:|Value:|Validator:|\.roomId|jd7f3k2h9x8/);
		expect(all).not.toContain("abc123");
	});

	test("Uncaught Error with a sentence: only the class and the file:line", () => {
		const s = shapeIssue({
			...base,
			errorMessage:
				"Uncaught Error: Cannot charge Dupont Immobilier for invoice 4412\n    at handler (../convex/billing.ts:88:13)",
			stackTrace: "",
		});
		const all = whole(s);
		expect(all).toContain("Uncaught Error");
		expect(all).toContain("convex/billing.ts:88");
		expect(all).not.toContain("Dupont");
		expect(all).not.toContain("4412");
		expect(all).not.toContain("Cannot charge");
	});

	test("ConvexError RBAC_DENIED with a JSON payload: class + code only", () => {
		const s = shapeIssue({
			...base,
			functionNames: ["issues:getStats"],
			errorMessage:
				'Uncaught ConvexError: RBAC_DENIED: not a fleet master {"door":"issues:getStats","orgSlug":"acme-corp","subject":"user_2abc"}',
			stackTrace: "",
		});
		const all = whole(s);
		expect(all).toContain("ConvexError");
		expect(all).toContain("RBAC_DENIED");
		expect(all).not.toMatch(/acme-corp|user_2abc|not a fleet master|orgSlug/);
	});

	test("an email and a client name in the message are absent; file:line from the stack is kept", () => {
		const s = shapeIssue({
			...base,
			errorMessage:
				"Uncaught Error: no mapping for marie.curie@laboratoire-curie.fr (client Laboratoire Curie)",
			stackTrace: "at lookup (../convex/lib/auth.ts:301:9)\nclient Laboratoire Curie",
		});
		const all = whole(s);
		expect(all).not.toMatch(/marie|curie|Laboratoire|@/i);
		expect(all).toContain("convex/lib/auth.ts:301");
	});

	test("a path outside the repo is never a throw site", () => {
		const s = shapeIssue({
			...base,
			errorMessage: "Uncaught Error: x\n    at f (/home/alice/secret-client/app.js:3:4)",
			stackTrace: "",
		});
		expect(whole(s)).not.toMatch(/alice|secret-client|app\.js/);
	});

	test("carries deployment, first/last seen and count", () => {
		const s = shapeIssue({
			...base,
			errorMessage: "Uncaught Error: x",
			stackTrace: "",
		});
		expect(s.body).toContain("prod");
		expect(s.body).toContain(new Date(T0).toISOString());
		expect(s.body).toContain(new Date(T1).toISOString());
		expect(s.body).toMatch(/Count:\*\*\s*7/);
	});

	test("an unsafe function identifier is replaced, never echoed", () => {
		const s = shapeIssue({
			...base,
			functionNames: ["rooms:join", "x y\nValue: secret"],
			errorMessage: "Uncaught Error: x",
			stackTrace: "",
		});
		expect(whole(s)).not.toContain("secret");
		expect(whole(s)).toContain("rooms:join");
	});

	test("the recurring prefix survives in the title", () => {
		const s = shapeIssue({
			...base,
			errorMessage: "Uncaught Error: x",
			stackTrace: "",
			titlePrefix: "[RECURRING 24h+ — root cause not fixed]",
		});
		expect(s.title.startsWith("[RECURRING 24h+")).toBe(true);
		expect(s.title).toContain("[Auto]");
	});
});

describe("classifyError", () => {
	test("class and code", () => {
		expect(classifyError("Uncaught Error: hello")).toEqual({
			errorClass: "Uncaught Error",
			code: null,
		});
		expect(
			classifyError("Uncaught ConvexError: ORG_MISMATCH: other org"),
		).toEqual({ errorClass: "ConvexError", code: "ORG_MISMATCH" });
		expect(classifyError("[Request ID: z] Server Error\nArgumentValidationError: v")
			.errorClass).toBe("ArgumentValidationError");
	});
	test("unrecognised text yields the neutral class, never the text", () => {
		expect(classifyError("john@acme.com did a thing")).toEqual({
			errorClass: "Unclassified",
			code: null,
		});
	});
});

describe("redactIssueBody / redactIssueTitle -- existing auto issues", () => {
	const oldBody = [
		"## Auto-detected Error",
		"",
		"**Deployment:** prod",
		"**Function:** `rooms:join`",
		"**Detected:** 2026-11-27T10:00:00.000Z",
		"",
		"### Error Message",
		"```",
		"[Request ID: abc123] Server Error",
		"ArgumentValidationError: Value does not match validator.",
		"Path: .roomId",
		'Value: "jd7f3k2h9x8m4n5p6q7r8s9t0"',
		"```",
		"",
		"### Stack Trace",
		"```",
		"at handler (../convex/rooms.ts:41:7)",
		"client Laboratoire Curie called with marie@curie.fr",
		"```",
		"",
		"---",
		"*Auto-created by VantagePeers Error Monitor. Orchestrator: Sigma — VantageOS Team | 2026-11-27*",
	].join("\n");

	test("maps to the shape-only form", () => {
		const out = redactIssueBody(oldBody);
		expect(out).toContain("ArgumentValidationError");
		expect(out).toContain("rooms:join");
		expect(out).toContain("convex/rooms.ts:41");
		expect(out).toContain("2026-11-27T10:00:00.000Z");
		expect(out).not.toMatch(
			/Path:|Value:|\.roomId|jd7f3k|Curie|marie|abc123|### Error Message|### Stack Trace/,
		);
	});

	test("is idempotent", () => {
		const once = redactIssueBody(oldBody);
		expect(redactIssueBody(once)).toBe(once);
	});

	test("an unrecognised body yields a shape-only body, never the input", () => {
		const out = redactIssueBody("Dear all, client Dupont's invoice 4412 broke");
		expect(out).not.toMatch(/Dupont|4412|Dear/);
		expect(out).toContain("Unclassified");
	});

	test("the old title (80 chars of message) is rebuilt from the shape", () => {
		const t = redactIssueTitle(
			"[Auto] Error in rooms:join: [Request ID: abc123] Server Error ArgumentValidationError: Va",
			oldBody,
		);
		expect(t).toBe("[Auto] ArgumentValidationError in rooms:join");
	});

	test("the recurring prefix is kept when the old title had it", () => {
		const t = redactIssueTitle(
			"[RECURRING 24h+ — root cause not fixed] [Auto] Error in rooms:join: zzz",
			oldBody,
		);
		expect(t.startsWith("[RECURRING 24h+ — root cause not fixed] [Auto]")).toBe(true);
		expect(t).not.toContain("zzz");
	});
});
