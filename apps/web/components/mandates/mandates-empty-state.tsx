"use client";

import { useTranslations } from "next-intl";

export function MandatesEmptyState() {
	const t = useTranslations("mandates_page");

	return (
		<div className="flex flex-col items-center justify-center py-20 px-4 text-center">
			<div className="mb-4 text-muted-foreground/40">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="48"
					height="48"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
				</svg>
			</div>
			<h3 className="text-base font-semibold text-foreground mb-1">
				{t("empty_title")}
			</h3>
			<p className="text-sm text-muted-foreground max-w-xs">
				{t("empty_description")}
			</p>
		</div>
	);
}
