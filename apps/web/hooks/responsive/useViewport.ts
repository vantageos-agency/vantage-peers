"use client";

import { useEffect, useState } from "react";
// Stub: replaced VantageStarter-specific analytics module
function debugResponsive(label: string, value: string) {
	if (process.env.NODE_ENV === "development") {
		console.debug(`[responsive] ${label}:`, value);
	}
}

interface ViewportSize {
	width: number;
	height: number;
}

export function useViewport(): ViewportSize {
	const [size, setSize] = useState<ViewportSize>({ width: 0, height: 0 });

	useEffect(() => {
		// Handle SSR
		if (typeof window === "undefined") return;

		const updateSize = () => {
			const newSize = {
				width: window.innerWidth,
				height: window.innerHeight,
			};
			setSize(newSize);

			if (process.env.NODE_ENV === "development") {
				debugResponsive("useViewport", `${newSize.width}x${newSize.height}`);
			}
		};

		// Set initial size
		updateSize();

		// Debounce resize events to improve performance
		let timeoutId: NodeJS.Timeout;
		const debouncedUpdateSize = () => {
			clearTimeout(timeoutId);
			timeoutId = setTimeout(updateSize, 100);
		};

		window.addEventListener("resize", debouncedUpdateSize);
		return () => {
			window.removeEventListener("resize", debouncedUpdateSize);
			clearTimeout(timeoutId);
		};
	}, []);

	return size;
}
