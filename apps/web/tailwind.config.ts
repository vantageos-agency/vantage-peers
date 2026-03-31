import type { Config } from "tailwindcss";
import { fontFamily } from "tailwindcss/defaultTheme";

const config: Config = {
	darkMode: ["class"],
	content: [
		"./pages/**/*.{js,ts,jsx,tsx,mdx}",
		"./components/**/*.{js,ts,jsx,tsx,mdx}",
		"./app/**/*.{js,ts,jsx,tsx,mdx}",
		"*.{js,ts,jsx,tsx,mdx}",
	],
	theme: {
		screens: {
			xs: "480px",
			sm: "640px",
			md: "768px",
			lg: "1024px",
			xl: "1280px",
			"2xl": "1536px",
		},
		extend: {
			fontFamily: {
				sans: ["var(--font-sans)", ...fontFamily.sans],
				heading: ["var(--font-heading)", ...fontFamily.sans],
				mono: ["Geist Mono", "monospace"],
			},
			colors: {
				gray: {
					50: "oklch(0.98 0 0)",
					100: "oklch(0.95 0 0)",
					200: "oklch(0.88 0 0)",
					300: "oklch(0.78 0 0)",
					400: "oklch(0.62 0 0)",
					500: "oklch(0.50 0 0)",
					600: "oklch(0.40 0 0)",
					700: "oklch(0.28 0 0)",
					800: "oklch(0.20 0 0)",
					850: "oklch(0.16 0 0)",
					900: "oklch(0.12 0 0)",
					950: "oklch(0.08 0 0)",
				},
				white: "oklch(1 0 0)",
				background: "var(--background)",
				foreground: "var(--foreground)",
				"accent-warm": "var(--accent-warm)",
				"card-hover": "var(--card-hover)",
				"border-hover": "var(--border-hover)",
				card: {
					DEFAULT: "var(--card)",
					foreground: "var(--card-foreground)",
				},
				popover: {
					DEFAULT: "var(--popover)",
					foreground: "var(--popover-foreground)",
				},
				primary: {
					DEFAULT: "var(--primary)",
					foreground: "var(--primary-foreground)",
				},
				secondary: {
					DEFAULT: "var(--secondary)",
					foreground: "var(--secondary-foreground)",
				},
				muted: {
					DEFAULT: "var(--muted)",
					foreground: "var(--muted-foreground)",
				},
				accent: {
					DEFAULT: "var(--accent)",
					foreground: "var(--accent-foreground)",
				},
				destructive: {
					DEFAULT: "var(--destructive)",
					foreground: "var(--destructive-foreground)",
				},
				success: "var(--success)",
				warning: "var(--warning)",
				border: "var(--border)",
				input: "var(--input)",
				ring: "var(--ring)",
				chart: {
					"1": "var(--chart-1)",
					"2": "var(--chart-2)",
					"3": "var(--chart-3)",
					"4": "var(--chart-4)",
					"5": "var(--chart-5)",
				},
				sidebar: {
					DEFAULT: "var(--sidebar-background)",
					foreground: "var(--sidebar-foreground)",
					primary: "var(--sidebar-primary)",
					"primary-foreground": "var(--sidebar-primary-foreground)",
					accent: "var(--sidebar-accent)",
					"accent-foreground": "var(--sidebar-accent-foreground)",
					border: "var(--sidebar-border)",
					ring: "var(--sidebar-ring)",
				},
			},
			borderRadius: {
				DEFAULT: "12px",
				sm: "6px",
				md: "8px",
				lg: "8px",
				xl: "12px",
				"2xl": "16px",
				full: "9999px",
			},
			keyframes: {
				"accordion-down": {
					from: {
						height: "0",
					},
					to: {
						height: "var(--radix-accordion-content-height)",
					},
				},
				"accordion-up": {
					from: {
						height: "var(--radix-accordion-content-height)",
					},
					to: {
						height: "0",
					},
				},
			},
			animation: {
				"accordion-down": "accordion-down 0.2s ease-out",
				"accordion-up": "accordion-up 0.2s ease-out",
			},
			transitionTimingFunction: {
				"out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
			},
			boxShadow: {
				xs: "0 1px 2px oklch(0 0 0 / 5%)",
				sm: "0 1px 3px oklch(0 0 0 / 8%), 0 1px 2px oklch(0 0 0 / 5%)",
				md: "0 4px 8px oklch(0 0 0 / 8%), 0 2px 4px oklch(0 0 0 / 5%)",
				lg: "0 8px 24px oklch(0 0 0 / 10%), 0 4px 8px oklch(0 0 0 / 6%)",
				xl: "0 16px 48px oklch(0 0 0 / 12%), 0 8px 16px oklch(0 0 0 / 8%)",
				"amber-sm": "0 2px 8px oklch(0.62 0.16 44 / 25%)",
				"amber-md": "0 4px 16px oklch(0.62 0.16 44 / 20%)",
				"amber-lg": "0 8px 32px oklch(0.62 0.16 44 / 25%)",
				"amber-dark-sm": "0 2px 8px oklch(0.72 0.16 44 / 15%)",
				"amber-dark-lg": "0 8px 32px oklch(0.72 0.16 44 / 12%)",
			},
		},
	},
	plugins: [require("tailwindcss-animate")],
};
export default config;
