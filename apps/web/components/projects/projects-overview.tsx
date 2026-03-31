"use client";

import { api } from "@convex/_generated/api";
import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectCard, type ProjectCardData } from "./project-card";
import { ProjectsEmptyState } from "./projects-empty-state";

export function ProjectsOverview() {
	const t = useTranslations("projects_page");
	const [activeOnly, setActiveOnly] = useState(false);

	const projectSummary = useQuery(api.dashboard.getProjectSummary, {});

	const projects = useMemo<ProjectCardData[]>(() => {
		if (!projectSummary) return [];
		const all = projectSummary.map((p) => ({
			name: p.name,
			missionCount: p.missionCount,
			tasksByStatus: p.tasksByStatus,
			activeOrchestrators: p.activeOrchestrators,
		}));
		if (!activeOnly) return all;
		return all.filter((p) => {
			const { done, ...rest } = p.tasksByStatus;
			// Active = has at least one non-done task
			return Object.values(rest).some((count) => count > 0);
		});
	}, [projectSummary, activeOnly]);

	// Loading state
	if (projectSummary === undefined) {
		return (
			<div className="flex flex-col gap-4 p-4 md:p-6">
				<Skeleton className="h-8 w-32" />
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
					{(["a", "b", "c"] as const).map((k) => (
						<Skeleton key={k} className="h-40 w-full" />
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 p-4 md:p-6">
			{/* Active only toggle */}
			<div className="flex items-center gap-2">
				<button
					type="button"
					role="switch"
					aria-checked={activeOnly}
					onClick={() => setActiveOnly((v) => !v)}
					className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
						activeOnly ? "bg-[oklch(0.65_0.15_232)]" : "bg-muted"
					}`}
				>
					<span
						className={`inline-block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
							activeOnly ? "translate-x-4" : "translate-x-0.5"
						}`}
					/>
				</button>
				<span className="text-xs text-muted-foreground">
					{t("filter_active_only")}
				</span>
			</div>

			{/* Grid or empty state */}
			{projects.length === 0 ? (
				<ProjectsEmptyState />
			) : (
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
					{projects.map((project) => (
						<ProjectCard key={project.name} project={project} />
					))}
				</div>
			)}
		</div>
	);
}
