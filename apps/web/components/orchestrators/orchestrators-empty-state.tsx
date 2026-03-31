"use client";

import { useTranslations } from "next-intl";

export function OrchestratorsEmptyState() {
	const t = useTranslations("orchestrators_page");

	return (
		<div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center">
			{/* Network icon */}
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
				<circle cx="12" cy="5" r="2" />
				<circle cx="5" cy="19" r="2" />
				<circle cx="19" cy="19" r="2" />
				<path d="M12 7v4M12 11l-5 6M12 11l5 6" />
			</svg>
			<p className="text-sm font-medium text-foreground">{t("empty_title")}</p>
			<p className="mt-1 text-xs text-muted-foreground max-w-xs mx-auto">
				{t("empty_description")}
			</p>
		</div>
	);
}
