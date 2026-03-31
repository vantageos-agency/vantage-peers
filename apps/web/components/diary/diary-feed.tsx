"use client";

import { api } from "@convex/_generated/api";
import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import * as React from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DiaryDateGroup } from "./diary-date-group";
import { DiaryEmptyState } from "./diary-empty-state";
import type { DiaryEntryData, DiaryOrchestrator } from "./diary-entry-card";
import { DiaryFullEntrySheet } from "./diary-full-entry-sheet";

type OrchestratorFilter = DiaryOrchestrator | "all";

function DiaryFeedSkeleton() {
	return (
		<div className="flex flex-col gap-6">
			{(["a", "b"] as const).map((groupKey) => (
				<div key={groupKey} className="flex flex-col gap-3">
					<div className="flex items-center gap-3">
						<Skeleton className="h-4 w-48" />
						<div className="flex-1 h-px bg-border" />
					</div>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						{(["c", "d", "e"] as const).map((cardKey) => (
							<div
								key={cardKey}
								className="rounded-xl border border-border bg-card p-4 flex flex-col gap-2"
							>
								<div className="flex items-center gap-2">
									<Skeleton className="h-4 w-12 rounded" />
									<Skeleton className="h-3 w-20" />
								</div>
								<Skeleton className="h-3 w-full" />
								<Skeleton className="h-3 w-4/5" />
								<Skeleton className="h-3 w-3/5" />
							</div>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

export function DiaryFeed() {
	const t = useTranslations("diary_page");
	const [orchestratorFilter, setOrchestratorFilter] =
		React.useState<OrchestratorFilter>("all");
	const [selectedEntry, setSelectedEntry] =
		React.useState<DiaryEntryData | null>(null);

	const queryArgs =
		orchestratorFilter !== "all"
			? { orchestrator: orchestratorFilter as DiaryOrchestrator }
			: {};

	const entries = useQuery(api.diary.list, queryArgs);
	const isLoading = entries === undefined;

	// Group entries by date, most recent first
	const grouped = React.useMemo(() => {
		if (!entries) return [];

		const map = new Map<string, DiaryEntryData[]>();
		for (const entry of entries) {
			const existing = map.get(entry.date) ?? [];
			existing.push(entry as unknown as DiaryEntryData);
			map.set(entry.date, existing);
		}

		return Array.from(map.entries())
			.sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
			.map(([date, dateEntries]) => ({ date, entries: dateEntries }));
	}, [entries]);

	return (
		<div className="flex flex-col gap-4">
			{/* Filter bar */}
			<div className="flex items-center gap-2">
				<Select
					value={orchestratorFilter}
					onValueChange={(v) => setOrchestratorFilter(v as OrchestratorFilter)}
				>
					<SelectTrigger className="h-8 text-xs w-40">
						<SelectValue placeholder={t("filter_orchestrator")} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">{t("filter_all")}</SelectItem>
						<SelectItem value="pi">pi</SelectItem>
						<SelectItem value="tau">tau</SelectItem>
						<SelectItem value="phi">phi</SelectItem>
						<SelectItem value="sigma">sigma</SelectItem>
					</SelectContent>
				</Select>

				{!isLoading && entries && entries.length > 0 && (
					<p className="text-xs text-muted-foreground">
						{t("count", { count: entries.length })}
					</p>
				)}
			</div>

			{/* Content */}
			{isLoading ? (
				<DiaryFeedSkeleton />
			) : grouped.length === 0 ? (
				<DiaryEmptyState />
			) : (
				<div className="flex flex-col gap-8">
					{grouped.map(({ date, entries: dateEntries }) => (
						<DiaryDateGroup
							key={date}
							date={date}
							entries={dateEntries}
							onEntryClick={setSelectedEntry}
						/>
					))}
				</div>
			)}

			{/* Full entry sheet */}
			<DiaryFullEntrySheet
				entry={selectedEntry}
				onClose={() => setSelectedEntry(null)}
			/>
		</div>
	);
}
