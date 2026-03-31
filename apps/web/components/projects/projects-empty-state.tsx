"use client";

import { useTranslations } from "next-intl";

export function ProjectsEmptyState() {
	const t = useTranslations("projects_page");

	return (
		<div className="flex flex-col items-center justify-center py-20 px-4 text-center">
			{/* Folder icon */}
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
					<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
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
