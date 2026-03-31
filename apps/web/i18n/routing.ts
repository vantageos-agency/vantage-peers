import { createNavigation } from "next-intl/navigation";
import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
	locales: ["en", "fr", "de", "it", "es", "pt", "ru"],
	defaultLocale: "en",
	localePrefix: "as-needed", // Only show prefix for non-default locales
});

// Export navigation utilities for use in Client Components
export const { Link, redirect, usePathname, useRouter } =
	createNavigation(routing);
