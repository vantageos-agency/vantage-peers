"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
	variant?:
		| "beta"
		| "orange"
		| "red"
		| "blue"
		| "green"
		| "purple"
		| "yellow"
		| "cyan"
		| "default";
	children: React.ReactNode;
}

const StatusBadge = React.forwardRef<HTMLDivElement, StatusBadgeProps>(
	({ className, variant = "default", children, ...props }, ref) => {
		return (
			<div
				ref={ref}
				className={cn(
					// Base styles
					"inline-flex !rounded-sm items-center justify-center px-2 py-1 text-xs font-medium",
					"border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
					"backdrop-blur-sm",
					// Variant styles
					{
						// Beta/Gold variant (original design)
						"border-[oklch(0.75_0.15_70)] text-[oklch(0.75_0.15_70)] bg-[oklch(0.75_0.15_70)]/10":
							variant === "beta",
						// Orange variant
						"border-orange text-orange bg-orange/20": variant === "orange",
						// Red variant
						"border-red text-red bg-red/20  ": variant === "red",
						// Blue variant
						"border-blue text-blue bg-blue/20 ": variant === "blue",
						// Green variant
						"border-green text-green bg-green/20": variant === "green",
						// Purple variant
						"border-purple text-purple bg-purple/20": variant === "purple",
						// Yellow variant
						"border-yellow text-yellow bg-yellow/20": variant === "yellow",
						// Cyan variant
						"border-cyan text-cyan bg-cyan/20": variant === "cyan",
						// Default variant
						"border-border text-foreground bg-background/95":
							variant === "default",
					},
					className,
				)}
				{...props}
			>
				{children}
			</div>
		);
	},
);
StatusBadge.displayName = "StatusBadge";

export { StatusBadge };
