"use client";

import { useEffect, useState } from "react";
import { BREAKPOINTS, type Breakpoint } from "@/config/responsive";

// Stub: replaced VantageStarter-specific analytics module
function debugResponsive(label: string, value: string) {
	if (process.env.NODE_ENV === "development") {
		console.debug(`[responsive] ${label}:`, value);
	}
}

export function useBreakpoint(breakpoint: Breakpoint): boolean {
	const [matches, setMatches] = useState(false);

	useEffect(() => {
		// Handle SSR
		if (typeof window === "undefined") return;

		const mediaQuery = window.matchMedia(
			`(min-width: ${BREAKPOINTS[breakpoint]}px)`,
		);

		// Set initial value
		setMatches(mediaQuery.matches);

		// Debug in development
		if (process.env.NODE_ENV === "development") {
			debugResponsive(
				`useBreakpoint(${breakpoint})`,
				`matches: ${mediaQuery.matches}`,
			);
		}

		const handler = (event: MediaQueryListEvent) => {
			setMatches(event.matches);
			if (process.env.NODE_ENV === "development") {
				debugResponsive(
					`useBreakpoint(${breakpoint}) changed`,
					`matches: ${event.matches}`,
				);
			}
		};

		// Use modern addEventListener if available, fallback to deprecated addListener
		if (mediaQuery.addEventListener) {
			mediaQuery.addEventListener("change", handler);
			return () => mediaQuery.removeEventListener("change", handler);
		} else {
			// Fallback for older browsers
			mediaQuery.addListener(handler);
			return () => mediaQuery.removeListener(handler);
		}
	}, [breakpoint]);

	return matches;
}

// Convenience hooks for common breakpoints
const useIsMobile = () => {
	const isMd = useBreakpoint("md");
	return !isMd;
};

const useIsTablet = () => {
	const isMd = useBreakpoint("md");
	const isLg = useBreakpoint("lg");
	return isMd && !isLg;
};

const useIsDesktop = () => {
	const isLg = useBreakpoint("lg");
	return isLg;
};

export { useIsMobile, useIsTablet, useIsDesktop };
