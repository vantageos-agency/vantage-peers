"use client";

import { useTranslations } from "next-intl";

export function MissionsEmptyState() {
	const t = useTranslations("missions_page");

	return (
		<div className="flex flex-col items-center justify-center py-20 px-4 text-center">
			{/* Target/mission icon */}
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
					<circle cx="12" cy="12" r="10" />
					<circle cx="12" cy="12" r="6" />
					<circle cx="12" cy="12" r="2" />
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
