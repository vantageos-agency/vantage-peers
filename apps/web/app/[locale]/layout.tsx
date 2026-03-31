import { Geist, Geist_Mono } from "next/font/google";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import type React from "react";
import { RouteAnnouncer } from "@/components/shared/RouteAnnouncer";
import { SkipLink } from "@/components/shared/SkipLink";
import { ThemeProvider } from "@/components/theme-provider";
import { routing } from "@/i18n/routing";
import { ClientProviders } from "../ClientProviders";

const BASE_URL =
	process.env.NEXT_PUBLIC_SITE_URL || "https://vantagestarter.ai";

// SoftwareApplication JSON-LD — lives here so it's inside <html><head>, not outside <html>
const softwareApplicationSchema = {
	"@context": "https://schema.org",
	"@type": "SoftwareApplication",
	"@id": `${BASE_URL}/#software`,
	name: "VantageStarter",
	url: BASE_URL,
	applicationCategory: "DeveloperApplication",
	operatingSystem: "Web",
	description:
		"AI SaaS starter kit with Convex backend, Clerk auth, Polar billing, credit system, multi-language support, and RGAA accessibility.",
	offers: {
		"@type": "Offer",
		price: "0",
		priceCurrency: "USD",
	},
};

const geist = Geist({
	subsets: ["latin"],
	variable: "--font-sans",
	display: "swap",
});

const geistMono = Geist_Mono({
	subsets: ["latin"],
	variable: "--font-mono",
	display: "swap",
});

type Props = {
	children: React.ReactNode;
	params: Promise<{ locale: string }>;
};

export function generateStaticParams() {
	return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, params }: Props) {
	const { locale } = await params;

	// Validate locale
	if (!routing.locales.includes(locale as (typeof routing.locales)[number])) {
		notFound();
	}

	// Enable static rendering
	setRequestLocale(locale);

	// Load messages for the current locale
	const messages = await getMessages();

	return (
		<html
			lang={locale}
			className={`${geist.variable} ${geistMono.variable} antialiased`}
			suppressHydrationWarning
		>
			<head>
				<script
					type="application/ld+json"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: server-only static JSON-LD, no user input
					dangerouslySetInnerHTML={{
						__html: JSON.stringify(softwareApplicationSchema),
					}}
				/>
				{/* Prefetch all 7 color presets — eliminates flash on runtime preset switch */}
				<link
					rel="prefetch"
					as="style"
					href="/styles/presets/dark-electric-blue.css"
				/>
				<link rel="prefetch" as="style" href="/styles/presets/amber.css" />
				<link rel="prefetch" as="style" href="/styles/presets/mono.css" />
				<link rel="prefetch" as="style" href="/styles/presets/blue.css" />
				<link rel="prefetch" as="style" href="/styles/presets/rose.css" />
				<link rel="prefetch" as="style" href="/styles/presets/emerald.css" />
				<link rel="prefetch" as="style" href="/styles/presets/arctic.css" />
			</head>
			<body>
				<SkipLink />
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					enableSystem
					disableTransitionOnChange
				>
					<RouteAnnouncer />
					<NextIntlClientProvider messages={messages}>
						<ClientProviders locale={locale}>
							{children}
						</ClientProviders>
					</NextIntlClientProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
