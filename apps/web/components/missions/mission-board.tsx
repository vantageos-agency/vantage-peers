"use client";

import { api } from "@convex/_generated/api";
import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { MissionCard, type MissionCardData } from "./mission-card";
import {
	MissionFilters,
	type MissionPriorityFilter,
	type MissionStatusFilter,
} from "./mission-filters";
import { MissionsEmptyState } from "./missions-empty-state";

export function MissionBoard() {
	const [statusFilter, setStatusFilter] = useState<MissionStatusFilter>("all");
	const [priorityFilter, setPriorityFilter] =
		useState<MissionPriorityFilter>("all");

	const allMissions = useQuery(api.missions.list, {});

	const missions = useMemo<MissionCardData[]>(() => {
		if (!allMissions) return [];
		return allMissions
			.filter((m) => statusFilter === "all" || m.status === statusFilter)
			.filter((m) => priorityFilter === "all" || m.priority === priorityFilter)
			.map((m) => ({
				_id: m._id as string,
				name: m.name,
				description: m.description,
				project: m.project,
				status: m.status,
				priority: m.priority,
				pilot: m.pilot,
				agents: m.agents,
				progress: m.progress,
				targetDate: m.targetDate,
			}));
	}, [allMissions, statusFilter, priorityFilter]);

	// Loading state
	if (allMissions === undefined) {
		return (
			<div className="flex flex-col gap-4 p-4 md:p-6">
				<div className="flex gap-2">
					<Skeleton className="h-8 w-36" />
					<Skeleton className="h-8 w-36" />
				</div>
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
					{(["a", "b", "c", "d"] as const).map((k) => (
						<Skeleton key={k} className="h-52 w-full" />
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 p-4 md:p-6">
			{/* Filters */}
			<MissionFilters
				status={statusFilter}
				priority={priorityFilter}
				onStatusChange={setStatusFilter}
				onPriorityChange={setPriorityFilter}
			/>

			{/* Grid or empty state */}
			{missions.length === 0 ? (
				<MissionsEmptyState />
			) : (
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
					{missions.map((mission) => (
						<MissionCard key={mission._id} mission={mission} />
					))}
				</div>
			)}
		</div>
	);
}
