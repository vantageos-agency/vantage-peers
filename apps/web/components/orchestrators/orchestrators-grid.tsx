"use client";

import { api } from "@convex/_generated/api";
import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
	OrchestratorCard,
	type OrchestratorProfile,
} from "./orchestrator-card";
import { OrchestratorDetail } from "./orchestrator-detail";
import { OrchestratorsEmptyState } from "./orchestrators-empty-state";

function OrchestratorsSkeleton() {
	return (
		<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{(["a", "b", "c"] as const).map((k) => (
				<div
					key={k}
					className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3"
				>
					<div className="flex items-start gap-3">
						<Skeleton className="mt-1 w-2 h-2 rounded-full shrink-0" />
						<div className="flex-1 flex flex-col gap-1">
							<Skeleton className="h-4 w-24" />
							<Skeleton className="h-3 w-32" />
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<div className="flex justify-between">
							<Skeleton className="h-3 w-12" />
							<Skeleton className="h-3 w-20" />
						</div>
						<div className="flex justify-between">
							<Skeleton className="h-3 w-16" />
							<Skeleton className="h-3 w-24" />
						</div>
					</div>
					<Skeleton className="h-3 w-full" />
					<Skeleton className="h-3 w-3/4" />
				</div>
			))}
		</div>
	);
}

export function OrchestratorsGrid() {
	const t = useTranslations("orchestrators_page");
	const [selectedProfile, setSelectedProfile] =
		React.useState<OrchestratorProfile | null>(null);

	const profiles = useQuery(api.profiles.listProfiles, {});
	const isLoading = profiles === undefined;

	return (
		<div className="flex flex-col gap-4">
			{/* Count */}
			{!isLoading && profiles.length > 0 && (
				<p className="text-xs text-muted-foreground">
					{t("count", { count: profiles.length })}
				</p>
			)}

			{/* Content */}
			{isLoading ? (
				<OrchestratorsSkeleton />
			) : profiles.length === 0 ? (
				<OrchestratorsEmptyState />
			) : (
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{profiles.map((profile) => (
						<OrchestratorCard
							key={profile._id}
							profile={profile as unknown as OrchestratorProfile}
							onClick={() =>
								setSelectedProfile(profile as unknown as OrchestratorProfile)
							}
						/>
					))}
				</div>
			)}

			{/* Detail sheet */}
			<OrchestratorDetail
				profile={selectedProfile}
				onClose={() => setSelectedProfile(null)}
			/>
		</div>
	);
}
