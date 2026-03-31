"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

export type DiaryOrchestrator = "pi" | "tau" | "phi" | "sigma" | "system";

export interface DiaryEntryData {
	_id: string;
	date: string;
	orchestrator: DiaryOrchestrator;
	instanceId?: string;
	content: string;
	highlights?: string[];
	blockers?: string[];
	createdAt: number;
}

const ORCHESTRATOR_COLORS: Record<DiaryOrchestrator, string> = {
	pi: "bg-[oklch(0.65_0.15_232)]/20 text-[oklch(0.65_0.15_232)]",
	tau: "bg-[oklch(0.65_0.15_290)]/20 text-[oklch(0.65_0.15_290)]",
	phi: "bg-[oklch(0.65_0.15_145)]/20 text-[oklch(0.65_0.15_145)]",
	sigma: "bg-[oklch(0.65_0.15_50)]/20 text-[oklch(0.65_0.15_50)]",
	system: "bg-muted text-muted-foreground",
};

interface DiaryEntryCardProps {
	entry: DiaryEntryData;
	onClick: () => void;
}

export function DiaryEntryCard({ entry, onClick }: DiaryEntryCardProps) {
	const t = useTranslations("diary_page");
	const orchestratorColor =
		ORCHESTRATOR_COLORS[entry.orchestrator] ?? ORCHESTRATOR_COLORS.system;

	return (
		<button
			type="button"
			className="w-full text-left rounded-xl border border-border bg-card p-4 hover:bg-accent/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			onClick={onClick}
			aria-label={`${entry.orchestrator} diary entry for ${entry.date}`}
		>
			{/* Header: orchestrator badge + instanceId */}
			<div className="flex items-center gap-2 mb-3 flex-wrap">
				<span
					className={cn(
						"inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider",
						orchestratorColor,
					)}
				>
					{entry.orchestrator}
				</span>
				{entry.instanceId && (
					<span className="text-[10px] text-muted-foreground/60 font-mono">
						{entry.instanceId}
					</span>
				)}
			</div>

			{/* Highlights */}
			{entry.highlights && entry.highlights.length > 0 ? (
				<ul className="flex flex-col gap-1 mb-3">
					{entry.highlights.slice(0, 3).map((highlight) => (
						<li
							key={highlight}
							className="flex items-start gap-1.5 text-xs text-foreground"
						>
							<span
								className="mt-1.5 w-1 h-1 rounded-full bg-[oklch(0.65_0.15_145)] shrink-0"
								aria-hidden="true"
							/>
							<span className="line-clamp-1">{highlight}</span>
						</li>
					))}
					{entry.highlights.length > 3 && (
						<li className="text-[10px] text-muted-foreground pl-2.5">
							{t("more_highlights", { count: entry.highlights.length - 3 })}
						</li>
					)}
				</ul>
			) : (
				<p className="text-xs text-muted-foreground mb-3 italic">
					{t("no_highlights")}
				</p>
			)}

			{/* Blockers */}
			{entry.blockers && entry.blockers.length > 0 && (
				<div className="flex flex-col gap-1">
					<span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide font-medium">
						{t("blockers_label")}
					</span>
					<ul className="flex flex-col gap-1">
						{entry.blockers.slice(0, 2).map((blocker) => (
							<li
								key={blocker}
								className="flex items-start gap-1.5 text-xs text-destructive"
							>
								<span
									className="mt-1.5 w-1 h-1 rounded-full bg-destructive shrink-0"
									aria-hidden="true"
								/>
								<span className="line-clamp-1">{blocker}</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</button>
	);
}
