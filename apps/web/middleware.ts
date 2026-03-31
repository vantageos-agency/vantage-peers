import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";

// Create the intl middleware
const intlMiddleware = createIntlMiddleware(routing);

// Clerk requires https://challenges.cloudflare.com for Turnstile CAPTCHA:
//   - script-src: to load the Turnstile JS
//   - frame-src: to render the Turnstile iframe
// script-src-elem must explicitly mirror script-src to suppress "not explicitly set" browser warnings.
// This is set in middleware (not just next.config.mjs) so it is applied on every Vercel Edge response,
// including cases where Next.js skips the config headers() for static/rewrite paths.
const SCRIPT_SRC_HOSTS = [
	"'self'",
	"'unsafe-eval'",
	"'unsafe-inline'",
	"https://*.clerk.accounts.dev",
	"https://clerk.myreeldream.ai",
	"https://challenges.cloudflare.com",
	"https://vercel.live",
].join(" ");

const CSP = [
	"default-src 'self'",
	`script-src ${SCRIPT_SRC_HOSTS}`,
	`script-src-elem ${SCRIPT_SRC_HOSTS}`,
	"worker-src 'self' blob:",
	"style-src 'self' 'unsafe-inline' https:",
	"img-src 'self' data: blob: https:",
	"media-src 'self' blob: data: https:",
	"font-src 'self' data: https:",
	"connect-src 'self' blob: https: wss: https://r.resend.com https://click.resend.com",
	"frame-src 'self' https://challenges.cloudflare.com https://clerk.myreeldream.ai https://*.clerk.accounts.dev https://vercel.live https://polar.sh https://sandbox.polar.sh",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self' https:",
	"frame-ancestors 'self'",
	"upgrade-insecure-requests",
].join("; ");

function applyCSP(response: NextResponse): NextResponse {
	response.headers.set("Content-Security-Policy", CSP);
	return response;
}

// Define public routes (include locale prefixes explicitly to avoid broad matching)
const isPublicRoute = createRouteMatcher([
	"/",
	"/(en|fr|de|it|es|pt|ru)",
	"/(en|fr|de|it|es|pt|ru)/sign-in(.*)",
	"/sign-in(.*)",
	"/(en|fr|de|it|es|pt|ru)/sign-up(.*)",
	"/sign-up(.*)",
	"/api/webhooks(.*)", // Webhooks are public (Clerk validates signatures)
	"/(en|fr|de|it|es|pt|ru)/watch(.*)", // Public video sharing page
	"/watch(.*)", // Public video sharing page (fallback without locale)
	"/(en|fr|de|it|es|pt|ru)/shared(.*)", // Public shared link redirect page
	"/shared(.*)", // Public shared link redirect page (fallback without locale)
	// Note: /api/chat and other protected API routes are NOT listed here
	// They will be authenticated by Clerk middleware before the route handler runs
]);

// Check if this is an API route - should NOT go through intl middleware
const isApiRoute = (pathname: string) => pathname.startsWith("/api");

export default clerkMiddleware(
	async (auth, request) => {
		const pathname = request.nextUrl.pathname;
		const isPublic = isPublicRoute(request);
		const method = request.method;

		// Skip intl middleware for API routes - they should NOT be locale-prefixed
		if (isApiRoute(pathname)) {
			// Protect non-public API routes
			if (!isPublic) {
				await auth.protect();
			}
			return applyCSP(NextResponse.next());
		}

		// Protect non-public routes BEFORE intl middleware
		if (!isPublic) {
			const url = new URL(request.url);
			const signUpUrl = new URL("/sign-up", request.url);
			signUpUrl.searchParams.set("redirect_url", url.toString());

			await auth.protect({
				unauthenticatedUrl: signUpUrl.toString(),
			});
		}

		// Skip intl middleware for non-GET requests to pages
		// This handles Clerk's internal POST requests for session syncing
		// which might otherwise be interfered with by next-intl's rewrites/redirects.
		if (method !== "GET") {
			return applyCSP(NextResponse.next());
		}

		// Run i18n middleware for locale detection and routing (pages only)
		const response = intlMiddleware(request);
		return applyCSP(response);
	},
	{
		signInUrl: "/sign-in",
		signUpUrl: "/sign-up",
	},
);

export const config = {
	matcher: [
		"/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
		"/(api|trpc)(.*)",
	],
};
