"use client";

import { useTranslations } from "next-intl";
import { ProjectsOverview } from "@/components/projects/projects-overview";

export default function ProjectsPage() {
	const t = useTranslations("projects_page");

	return (
		<div className="flex flex-col">
			{/* Page header */}
			<div className="px-4 md:px-6 pt-6 pb-4 border-b border-border">
				<h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
				<p className="text-sm text-muted-foreground mt-0.5">{t("subtitle")}</p>
			</div>

			{/* Projects overview */}
			<ProjectsOverview />
		</div>
	);
}
