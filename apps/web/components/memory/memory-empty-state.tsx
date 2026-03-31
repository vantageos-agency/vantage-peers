"use client";

import { useTranslations } from "next-intl";

export function MemoryEmptyState() {
	const t = useTranslations("memory_page");

	return (
		<div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
			{/* Brain icon */}
			<svg
				className="mx-auto mb-3 text-muted-foreground/40"
				width="32"
				height="32"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				aria-hidden="true"
			>
				<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
				<path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
			</svg>
			<p className="text-sm font-medium text-foreground">{t("empty_title")}</p>
			<p className="mt-1 text-xs text-muted-foreground max-w-xs mx-auto">
				{t("empty_description")}
			</p>
		</div>
	);
}
