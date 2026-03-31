"use client";

import { useTranslations } from "next-intl";

export function MessagesEmptyState() {
	const t = useTranslations("messages_page");

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
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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
