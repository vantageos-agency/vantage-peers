import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { clerkLocalizations } from "@/i18n/clerk-localization";
import { ConvexClientProvider } from "@/providers/ConvexClientProvider";

// Monochrome grayscale palette — pure achromatic equivalents
// Clerk appearance API does not accept oklch() — using verified hex approximations.
// oklch(0.95 0 0) → #f0f0f0 (near white — primary button bg)
// oklch(0.08 0 0) → #141414 (gray-950 — deep background)
// oklch(0.12 0 0) → #1f1f1f (gray-900 — card/modal/popover surface)
// oklch(0.16 0 0) → #292929 (gray-850 — input background)
// oklch(0.22 0 0) → #383838 (between gray-800/700 — border)
// oklch(0.95 0 0) → #f0f0f0 (near white — primary text)
// oklch(0.65 0 0) → #a3a3a3 (gray-400 — secondary text / muted)

const CLERK_PRIMARY = "#e8e8e8"; // light gray button (like bg-gray-100)
const CLERK_BG = "#141414"; // oklch(0.08 0 0) — gray-950
const CLERK_CARD = "#1f1f1f"; // oklch(0.12 0 0) — gray-900
const CLERK_INPUT_BG = "#292929"; // oklch(0.16 0 0) — gray-850
const CLERK_BORDER = "#383838"; // oklch(0.22 0 0) — between gray-800 and gray-700
const CLERK_TEXT = "#f0f0f0"; // oklch(0.95 0 0) — near white
const CLERK_TEXT_MUTED = "#a3a3a3"; // oklch(0.65 0 0) — gray-400
const CLERK_DANGER = "#c0392b"; // keep red for danger

// ClerkProvider in @clerk/nextjs v6 is typed as an async Server Component
// (Promise<React.JSX.Element>), which is incompatible with @types/react 18.0.x JSX.
// This is a known TS compatibility gap — the runtime behavior is correct.
// See: https://clerk.com/changelog/2024-04-19#nextjs-app-router-server-components
// biome-ignore lint/suspicious/noExplicitAny: cast required for Clerk v6 + @types/react 18 compat
const ClerkProviderCompat = ClerkProvider as any;

export function ClientProviders({
	children,
	locale,
}: {
	children: ReactNode;
	locale: string;
}) {
	const localization = clerkLocalizations[locale] || {};

	return (
		<ClerkProviderCompat
			dynamic
			afterSignOutUrl="/sign-in"
			signInFallbackRedirectUrl="/dashboard"
			signUpFallbackRedirectUrl="/dashboard"
			localization={localization}
			appearance={{
				baseTheme: dark,
				variables: {
					colorPrimary: CLERK_PRIMARY,
					colorBackground: CLERK_BG,
					colorInputBackground: CLERK_INPUT_BG,
					colorInputText: CLERK_TEXT,
					colorText: CLERK_TEXT,
					colorTextSecondary: CLERK_TEXT_MUTED,
					colorDanger: CLERK_DANGER,

					// Space Grotesk — inherits from page CSS via "inherit"
					fontFamily: '"Space Grotesk", system-ui, sans-serif',
					fontSize: "0.9375rem",
					fontWeight: { normal: 400, medium: 500, bold: 700 },

					// Sharp corners everywhere — editorial design system
					// Rounded corners — matches landing card style (rounded-2xl)
					borderRadius: "16px",

					spacingUnit: "1rem",
				},
				elements: {
					// --- Global containers ---
					rootBox: {
						margin: "0",
					},
					card: {
						backgroundColor: CLERK_CARD,
						borderColor: CLERK_BORDER,
						borderWidth: "1px",
						borderStyle: "solid",
						borderRadius: "16px",
						boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
					},

					// --- OrganizationSwitcher popover ---
					organizationSwitcherPopoverCard: {
						backgroundColor: CLERK_CARD,
						borderColor: CLERK_BORDER,
						borderWidth: "1px",
						borderStyle: "solid",
						borderRadius: "16px",
						boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
					},
					organizationSwitcherPopoverActionButton: {
						color: CLERK_TEXT,
						borderRadius: "16px",
					},
					organizationSwitcherPopoverActionButton__createOrganization: {
						color: CLERK_TEXT,
					},
					organizationSwitcherPopoverActionButton__manageOrganization: {
						color: CLERK_TEXT,
					},
					organizationPreviewMainIdentifier: {
						color: CLERK_TEXT,
					},
					organizationPreviewSecondaryIdentifier: {
						color: CLERK_TEXT_MUTED,
					},
					// Trigger button — styled in DashboardHeader; keep minimal here
					organizationSwitcherTrigger: {
						borderRadius: "16px",
					},
					organizationSwitcherTriggerIcon: {
						color: CLERK_TEXT_MUTED,
					},

					// --- UserButton / UserProfile popover ---
					userButtonPopoverCard: {
						backgroundColor: CLERK_CARD,
						borderColor: CLERK_BORDER,
						borderWidth: "1px",
						borderStyle: "solid",
						borderRadius: "16px",
						boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
					},
					userButtonPopoverActionButton: {
						color: CLERK_TEXT,
						borderRadius: "16px",
					},
					userPreviewMainIdentifier: {
						color: CLERK_TEXT,
					},
					userPreviewSecondaryIdentifier: {
						color: CLERK_TEXT_MUTED,
					},

					// --- Create Organization / profile modals ---
					modalContent: {
						backgroundColor: CLERK_CARD,
						borderColor: CLERK_BORDER,
						borderWidth: "1px",
						borderStyle: "solid",
						borderRadius: "16px",
						boxShadow: "0 16px 48px rgba(0,0,0,0.7)",
					},
					modalBackdrop: {
						backgroundColor: "rgba(0,0,0,0.75)",
						backdropFilter: "blur(4px)",
					},
					// CreateOrganization modal specifically
					createOrganizationBox: {
						backgroundColor: CLERK_CARD,
					},
					profileSection: {
						backgroundColor: CLERK_CARD,
					},
					profileSectionTitle: {
						color: CLERK_TEXT,
					},
					profileSectionContent: {
						color: CLERK_TEXT_MUTED,
					},
					navbar: {
						backgroundColor: CLERK_BG,
						borderColor: CLERK_BORDER,
					},
					navbarButton: {
						color: CLERK_TEXT_MUTED,
					},
					navbarButtonIcon: {
						color: CLERK_TEXT_MUTED,
					},
					// Active nav item
					"navbarButton:focus": {
						color: CLERK_TEXT,
					},

					// --- Form elements ---
					headerTitle: {
						color: CLERK_TEXT,
						fontWeight: "700",
					},
					headerSubtitle: {
						color: CLERK_TEXT_MUTED,
					},
					socialButtonsBlockButton: {
						minHeight: "44px",
						backgroundColor: CLERK_INPUT_BG,
						borderColor: CLERK_BORDER,
						borderRadius: "16px",
						color: CLERK_TEXT,
						fontWeight: "500",
					},
					formButtonPrimary: {
						minHeight: "44px",
						backgroundColor: CLERK_TEXT,
						borderRadius: "16px",
						color: CLERK_BG,
						fontWeight: "600",
					},
					formButtonReset: {
						borderRadius: "16px",
						color: CLERK_TEXT_MUTED,
					},
					formFieldInput: {
						minHeight: "48px",
						backgroundColor: CLERK_INPUT_BG,
						borderColor: CLERK_BORDER,
						borderRadius: "16px",
						color: CLERK_TEXT,
					},
					formFieldLabel: {
						color: CLERK_TEXT_MUTED,
					},
					footerActionLink: {
						color: CLERK_PRIMARY,
					},
					footerActionText: {
						color: CLERK_TEXT_MUTED,
					},
					identityPreviewText: {
						color: CLERK_TEXT,
					},
					identityPreviewEditButton: {
						color: CLERK_PRIMARY,
					},
					otpCodeFieldInput: {
						backgroundColor: CLERK_INPUT_BG,
						borderColor: CLERK_BORDER,
						borderRadius: "16px",
						color: CLERK_TEXT,
					},
					alternativeMethodsBlockButton: {
						borderColor: CLERK_BORDER,
						borderRadius: "16px",
						color: CLERK_TEXT_MUTED,
					},
					formResendCodeLink: {
						color: CLERK_PRIMARY,
					},
					dividerLine: {
						backgroundColor: CLERK_BORDER,
					},
					dividerText: {
						color: CLERK_TEXT_MUTED,
					},

					// --- Hide Clerk branding only ---
					// IMPORTANT: Do NOT hide `footer` — in Clerk v6 it is the action/nav bar
					// inside OrganizationProfile modals (save changes, section nav, member invite).
					// Hiding it breaks all org management flows.
					// Only hide the specific branding sub-elements below.

					// Development mode badge
					badge: {
						display: "none",
					},
					// "Secured by Clerk" page links (sign-in/up cards)
					footerPages: {
						display: "none",
					},
				},
			}}
		>
			<ConvexClientProvider>
				{children}
				<Toaster position="top-right" richColors />
			</ConvexClientProvider>
		</ClerkProviderCompat>
	);
}
