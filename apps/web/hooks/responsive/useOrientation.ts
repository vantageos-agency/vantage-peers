"use client";

import { useEffect, useState } from "react";
import type { Orientation } from "@/config/responsive";

// Stub: replaced VantageStarter-specific analytics module
function debugResponsive(label: string, value: string) {
	if (process.env.NODE_ENV === "development") {
		console.debug(`[responsive] ${label}:`, value);
	}
}

export function useOrientation(): Orientation {
	const [orientation, setOrientation] = useState<Orientation>("portrait");

	useEffect(() => {
		// Handle SSR
		if (typeof window === "undefined") return;

		const updateOrientation = () => {
			const newOrientation =
				window.innerHeight > window.innerWidth ? "portrait" : "landscape";
			setOrientation(newOrientation);

			if (process.env.NODE_ENV === "development") {
				debugResponsive(
					"useOrientation",
					`${newOrientation} (${window.innerWidth}x${window.innerHeight})`,
				);
			}
		};

		// Set initial orientation
		updateOrientation();

		// Listen for orientation changes
		window.addEventListener("resize", updateOrientation);
		window.addEventListener("orientationchange", updateOrientation);

		return () => {
			window.removeEventListener("resize", updateOrientation);
			window.removeEventListener("orientationchange", updateOrientation);
		};
	}, []);

	return orientation;
}
