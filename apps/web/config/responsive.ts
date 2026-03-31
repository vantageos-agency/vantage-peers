export const BREAKPOINTS = {
	sm: 640,
	md: 768,
	lg: 1024,
	xl: 1280,
} as const;

export const ORIENTATIONS = ["portrait", "landscape"] as const;

export type Breakpoint = keyof typeof BREAKPOINTS;
export type Orientation = (typeof ORIENTATIONS)[number];
