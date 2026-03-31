import type { Metadata } from "next";
import type React from "react";
import "./globals.css";

const BASE_URL =
	process.env.NEXT_PUBLIC_SITE_URL || "https://vantagestarter.ai";

export const metadata: Metadata = {
	metadataBase: new URL(BASE_URL),
	title: {
		default: "VantageStarter",
		template: "%s | VantageStarter",
	},
	description:
		"The AI SaaS starter kit that ships with Convex, Clerk, Polar billing, credits system, i18n, and accessibility built-in.",
	alternates: {
		canonical: BASE_URL,
		languages: {
			en: BASE_URL,
			fr: `${BASE_URL}/fr`,
		},
	},
	openGraph: {
		type: "website",
		siteName: "VantageStarter",
		url: BASE_URL,
		images: [
			{
				url: `${BASE_URL}/opengraph-image.png`,
				width: 1200,
				height: 630,
				alt: "VantageStarter — AI SaaS Starter Kit",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		images: [`${BASE_URL}/opengraph-image.png`],
	},
	robots: { index: true, follow: true },
};

// Root layout: renders children directly — <html>/<body> are owned by app/[locale]/layout.tsx.
// The JSON-LD <script> that was previously here caused hydration errors (#418/#423) because
// it rendered as a sibling to <html>, producing invalid document structure.
// It now lives inside <head> in app/[locale]/layout.tsx.
export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return children;
}

// Required for next-intl to work with non-locale routes
export function generateStaticParams() {
	return [];
}
