"use client";

/**
 * SkipLink — WCAG 2.1 AA bypass block (criterion 2.4.1)
 *
 * Usage: place as the very first child of <body>.
 * The main content area must have id="main-content".
 *
 * Visually hidden until focused (keyboard users only).
 * Becomes visible on focus via the :focus-visible styles below.
 */
export function SkipLink() {
	return (
		<a
			href="#main-content"
			className="
        sr-only focus-visible:not-sr-only
        focus-visible:fixed focus-visible:top-4 focus-visible:left-4
        focus-visible:z-[9999]
        focus-visible:inline-flex focus-visible:items-center
        focus-visible:px-4 focus-visible:py-2
        focus-visible:rounded-lg
        focus-visible:bg-primary focus-visible:text-primary-foreground
        focus-visible:text-sm focus-visible:font-medium
        focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
        focus-visible:shadow-lg
        transition-none
      "
		>
			Skip to main content
		</a>
	);
}
