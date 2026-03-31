"use client";

import { useTranslations } from "next-intl";

export function DiaryEmptyState() {
	const t = useTranslations("diary_page");

	return (
		<div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
			{/* Book icon */}
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
				<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
				<path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
			</svg>
			<p className="text-sm font-medium text-foreground">{t("empty_title")}</p>
			<p className="mt-1 text-xs text-muted-foreground max-w-xs mx-auto">
				{t("empty_description")}
			</p>
		</div>
	);
}
