"use client";

import { api } from "@convex/_generated/api";
import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { MandateCardData } from "./mandate-card";
import { MandateColumn, type MandateStatus } from "./mandate-column";
import { MandateDetailSheet } from "./mandate-detail-sheet";
import { MandatesEmptyState } from "./mandates-empty-state";

const STATUS_ORDER: MandateStatus[] = [
	"requested",
	"accepted",
	"in_progress",
	"delivered",
	"settled",
];

function BoardSkeleton() {
	return (
		<div className="flex gap-4 overflow-x-auto pb-4">
			{STATUS_ORDER.map((s) => (
				<div key={s} className="min-w-[260px] flex flex-col gap-2">
					<Skeleton className="h-8 w-full rounded-lg" />
					<Skeleton className="h-24 w-full rounded-xl" />
					<Skeleton className="h-24 w-full rounded-xl" />
				</div>
			))}
		</div>
	);
}

export function MandateBoard() {
	const [selectedMandate, setSelectedMandate] =
		useState<MandateCardData | null>(null);
	const [sheetOpen, setSheetOpen] = useState(false);

	const allMandates = useQuery(api.mandates.list, {});

	const mandates = useMemo<MandateCardData[]>(() => {
		if (!allMandates) return [];
		return allMandates.map((m) => ({
			_id: m._id as string,
			requestedBy: m.requestedBy,
			fulfilledBy: m.fulfilledBy,
			service: m.service,
			budget: m.budget,
			status: m.status,
			linkedTaskIds: m.linkedTaskIds as string[] | undefined,
			tokensCost: m.tokensCost,
			createdAt: m.createdAt,
			updatedAt: m.updatedAt,
			completedAt: m.completedAt,
			mandateDocument: m.mandateDocument,
			spendingLimits: m.spendingLimits,
			approvedCategories: m.approvedCategories,
		}));
	}, [allMandates]);

	const mandatesByStatus = useMemo(() => {
		const map = new Map<MandateStatus, MandateCardData[]>();
		for (const s of STATUS_ORDER) map.set(s, []);
		for (const mandate of mandates) {
			map.get(mandate.status as MandateStatus)?.push(mandate);
		}
		return map;
	}, [mandates]);

	const handleMandateClick = (mandate: MandateCardData) => {
		setSelectedMandate(mandate);
		setSheetOpen(true);
	};

	if (allMandates === undefined) {
		return (
			<div className="flex flex-col gap-4 p-4 md:p-6">
				<BoardSkeleton />
			</div>
		);
	}

	const isEmpty = allMandates.length === 0;

	return (
		<>
			<div className="flex flex-col gap-4 p-4 md:p-6 h-full">
				{isEmpty ? (
					<MandatesEmptyState />
				) : (
					<div className="flex gap-4 overflow-x-auto pb-6 flex-1">
						{STATUS_ORDER.map((status) => (
							<MandateColumn
								key={status}
								status={status}
								mandates={mandatesByStatus.get(status) ?? []}
								onMandateClick={handleMandateClick}
							/>
						))}
					</div>
				)}
			</div>

			<MandateDetailSheet
				mandate={selectedMandate}
				open={sheetOpen}
				onOpenChange={setSheetOpen}
			/>
		</>
	);
}
