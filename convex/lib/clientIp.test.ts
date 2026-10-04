import { describe, expect, test } from "vitest";
import { clientIpFromHeaders } from "./clientIp";

const h = (o: Record<string, string>) => new Headers(o);

describe("clientIpFromHeaders", () => {
	test("spoofed first + real last -> last", () => {
		expect(
			clientIpFromHeaders(h({ "x-forwarded-for": "6.6.6.6, 1.1.1.1" })),
		).toBe("1.1.1.1");
	});
	test("three entries -> rightmost", () => {
		expect(
			clientIpFromHeaders(
				h({ "x-forwarded-for": "6.6.6.6, 7.7.7.7 ,1.1.1.1" }),
			),
		).toBe("1.1.1.1");
	});
	test("single entry -> that entry", () => {
		expect(clientIpFromHeaders(h({ "x-forwarded-for": "1.1.1.1" }))).toBe(
			"1.1.1.1",
		);
	});
	test("x-forwarded-for wins over a client-writable x-real-ip", () => {
		expect(
			clientIpFromHeaders(
				h({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "9.9.9.9" }),
			),
		).toBe("1.1.1.1");
	});
	test("x-real-ip only -> fallback", () => {
		expect(clientIpFromHeaders(h({ "x-real-ip": " 2.2.2.2 " }))).toBe(
			"2.2.2.2",
		);
	});
	test("empty / blank entries -> fallback, then undefined", () => {
		expect(
			clientIpFromHeaders(h({ "x-forwarded-for": " , " })),
		).toBeUndefined();
		expect(clientIpFromHeaders(h({}))).toBeUndefined();
	});
});
