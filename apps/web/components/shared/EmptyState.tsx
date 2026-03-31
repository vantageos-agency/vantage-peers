"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
	icon?: ReactNode;
	title: string;
	description: string;
	actionLabel?: string;
	onAction?: () => void;
}

export function EmptyState({
	icon,
	title,
	description,
	actionLabel,
	onAction,
}: EmptyStateProps) {
	return (
		<div className="flex flex-col items-center justify-center py-12 px-4 text-center">
			{icon && <div className="mb-4 text-muted-foreground">{icon}</div>}
			<h3 className="text-lg md:text-xl font-semibold text-primary-foreground mb-2">
				{title}
			</h3>
			<p className="text-sm md:text-base text-muted-foreground mb-6 max-w-md">
				{description}
			</p>
			{actionLabel && onAction && (
				<Button onClick={onAction} className="min-h-[44px] min-w-[44px]">
					{actionLabel}
				</Button>
			)}
		</div>
	);
}
