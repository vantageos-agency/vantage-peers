"use client";

import { useTranslations } from "next-intl";
import { OrchestratorsGrid } from "@/components/orchestrators/orchestrators-grid";

export default function OrchestratorsPage() {
	const t = useTranslations("orchestrators_page");

	return (
		<div className="flex flex-col h-full">
			{/* Page header */}
			<div className="px-4 md:px-6 pt-6 pb-4 border-b border-border">
				<h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
				<p className="text-sm text-muted-foreground mt-0.5">{t("subtitle")}</p>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto px-4 md:px-6 py-6">
				<OrchestratorsGrid />
			</div>
		</div>
	);
}
