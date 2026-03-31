"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * RouteAnnouncer — aria-live region for route changes (WCAG 2.4.2)
 *
 * Screen readers do not announce client-side navigations by default.
 * This component announces the new page title after every route change.
 *
 * Place inside ThemeProvider, before children, in layout.tsx.
 */
export function RouteAnnouncer() {
	const pathname = usePathname();
	const announcerRef = useRef<HTMLParagraphElement>(null);
	const firstRender = useRef(true);

	useEffect(() => {
		// Skip the initial render — screen reader already announced on first load
		if (firstRender.current) {
			firstRender.current = false;
			return;
		}

		// Small delay ensures the DOM has updated before we announce
		const timer = setTimeout(() => {
			if (announcerRef.current) {
				// Use document title if available, fallback to pathname
				const title =
					document.title?.split(" — ")[0] ||
					document.title ||
					`Page: ${pathname}`;
				announcerRef.current.textContent = `Navigated to ${title}`;
			}
		}, 100);

		return () => clearTimeout(timer);
	}, [pathname]);

	return (
		<p
			ref={announcerRef}
			aria-live="polite"
			aria-atomic="true"
			className="sr-only"
			// Persisted in DOM so screen readers register the live region on first load
		/>
	);
}
