import { cva, type VariantProps } from "class-variance-authority";

/**
 * Badge variant styles for model cards
 * Provides consistent styling for HD, TURBO, FAST, PRO, etc.
 */
export const badgeVariants = cva(
	"rounded px-1.5 py-0.5 text-xs font-medium uppercase",
	{
		variants: {
			variant: {
				primary: "bg-primary/20 text-primary",
				hd: "bg-primary/20 text-primary",
				pro: "bg-primary/20 text-primary",
				fast: "bg-accent/20 text-accent-foreground",
				turbo: "bg-accent/20 text-accent-foreground",
				new: "bg-accent/20 text-accent-foreground",
				multilingual: "bg-secondary/20 text-secondary-foreground",
				cost_effective: "bg-muted/20 text-muted-foreground",
				voice_cloning: "bg-primary/20 text-primary",
				custom_voice: "bg-primary/20 text-primary",
			},
		},
		defaultVariants: {
			variant: "primary",
		},
	},
);

export type BadgeVariantProps = VariantProps<typeof badgeVariants>;

/**
 * Maps badge text to variant (normalize to lowercase with underscores)
 */
export function getBadgeVariant(badge: string): BadgeVariantProps["variant"] {
	const normalized = badge.toLowerCase().replace(/[^a-z0-9]+/g, "_");

	// Map common badge patterns to variants
	const variantMap: Record<string, BadgeVariantProps["variant"]> = {
		hd: "hd",
		pro: "pro",
		fast: "fast",
		turbo: "turbo",
		new: "new",
		multilingual: "multilingual",
		cost_effective: "cost_effective",
		voice_cloning: "voice_cloning",
		custom_voice: "custom_voice",
	};

	return variantMap[normalized] || "primary";
}
