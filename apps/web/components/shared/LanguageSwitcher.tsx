"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation } from "convex/react";
import { Globe } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/convex/_generated/api";
import { usePathname, useRouter } from "@/i18n/routing";

const locales = [
	{ code: "en", label: "English", flag: "🇺🇸" },
	{ code: "fr", label: "Français", flag: "🇫🇷" },
	{ code: "de", label: "Deutsch", flag: "🇩🇪" },
	{ code: "it", label: "Italiano", flag: "🇮🇹" },
	{ code: "es", label: "Español", flag: "🇪🇸" },
	{ code: "pt", label: "Português", flag: "🇵🇹🇧🇷" },
	{ code: "ru", label: "Русский", flag: "🇷🇺" },
];

export function LanguageSwitcher() {
	const router = useRouter();
	const pathname = usePathname();
	const locale = useLocale();
	const t = useTranslations("common");
	const { isSignedIn } = useAuth();
	const updateLanguagePreference = useMutation(
		api.users.updateLanguagePreference,
	);

	const currentLocale = locales.find((l) => l.code === locale) || locales[0];

	const handleChange = async (newLocale: string) => {
		// Save to Convex if user is signed in
		if (isSignedIn) {
			try {
				await updateLanguagePreference({ language: newLocale });
			} catch (error) {
				console.error("Failed to save language preference:", error);
			}
		}

		// Switch the app locale
		router.replace(pathname, { locale: newLocale });
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="gap-2 min-h-[44px] text-sm"
					aria-label={t("change_language")}
				>
					<Globe className="h-4 w-4" />
					<span className="hidden sm:inline">
						{currentLocale.flag} {currentLocale.code.toUpperCase()}
					</span>
					<span className="sm:hidden">{currentLocale.flag}</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="bg-card border-border">
				{locales.map((loc) => (
					<DropdownMenuItem
						key={loc.code}
						onClick={() => handleChange(loc.code)}
						className={`cursor-pointer ${
							loc.code === locale
								? "bg-secondary text-foreground"
								: "text-muted-foreground hover:bg-secondary hover:text-foreground"
						}`}
					>
						<span className="mr-2">{loc.flag}</span>
						{loc.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
