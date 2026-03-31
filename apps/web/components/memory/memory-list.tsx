"use client";

import { api } from "@convex/_generated/api";
import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
	MemoryCard,
	type MemoryCardData,
	type MemoryType,
} from "./memory-card";
import { MemoryDetailSheet } from "./memory-detail-sheet";
import { MemoryEmptyState } from "./memory-empty-state";
import { MemoryFilters, type MemoryTypeFilter } from "./memory-filters";

function MemoryListSkeleton() {
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
			{(["a", "b", "c", "d", "e", "f"] as const).map((k) => (
				<div
					key={k}
					className="rounded-xl border border-border bg-card p-4 flex flex-col gap-2"
				>
					<div className="flex items-center gap-2">
						<Skeleton className="h-4 w-16 rounded" />
						<Skeleton className="h-3 w-10 rounded ml-auto" />
					</div>
					<Skeleton className="h-2.5 w-32" />
					<Skeleton className="h-3 w-full" />
					<Skeleton className="h-3 w-3/4" />
					<Skeleton className="h-4 w-12 rounded mt-1" />
				</div>
			))}
		</div>
	);
}

export function MemoryList() {
	const t = useTranslations("memory_page");

	// Filter state
	const [namespace, setNamespace] = React.useState("global");
	const [typeFilter, setTypeFilter] = React.useState<MemoryTypeFilter>("all");
	const [isLatest, setIsLatest] = React.useState(true);

	// Selected memory for detail sheet
	const [selectedMemory, setSelectedMemory] =
		React.useState<MemoryCardData | null>(null);

	// Debounced namespace to avoid re-querying on every keystroke
	const [debouncedNamespace, setDebouncedNamespace] = React.useState("global");
	React.useEffect(() => {
		const timer = setTimeout(
			() => setDebouncedNamespace(namespace || "global"),
			400,
		);
		return () => clearTimeout(timer);
	}, [namespace]);

	const queryArgs = {
		namespace: debouncedNamespace,
		...(typeFilter !== "all" ? { type: typeFilter as MemoryType } : {}),
		includeSuperseded: !isLatest,
	};

	const memories = useQuery(api.memories.listMemories, queryArgs);
	const isLoading = memories === undefined;

	return (
		<div className="flex flex-col gap-4">
			{/* Filters */}
			<MemoryFilters
				namespace={namespace}
				type={typeFilter}
				isLatest={isLatest}
				onNamespaceChange={setNamespace}
				onTypeChange={setTypeFilter}
				onIsLatestChange={setIsLatest}
			/>

			{/* Count */}
			{!isLoading && memories.length > 0 && (
				<p className="text-xs text-muted-foreground">
					{t("count", { count: memories.length })}
				</p>
			)}

			{/* Content */}
			{isLoading ? (
				<MemoryListSkeleton />
			) : memories.length === 0 ? (
				<MemoryEmptyState />
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					{memories.map((memory) => (
						<MemoryCard
							key={memory._id}
							memory={memory as unknown as MemoryCardData}
							onClick={() =>
								setSelectedMemory(memory as unknown as MemoryCardData)
							}
						/>
					))}
				</div>
			)}

			{/* Detail sheet */}
			<MemoryDetailSheet
				memory={selectedMemory}
				onClose={() => setSelectedMemory(null)}
			/>
		</div>
	);
}
