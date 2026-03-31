"use client";

import { DiaryEntryCard, type DiaryEntryData } from "./diary-entry-card";

function formatDateHeading(dateStr: string): string {
	// dateStr is "YYYY-MM-DD"
	const [year, month, day] = dateStr.split("-").map(Number);
	const date = new Date(year, month - 1, day);
	return date.toLocaleDateString("en-US", {
		weekday: "long",
		month: "long",
		day: "numeric",
	});
}

interface DiaryDateGroupProps {
	date: string;
	entries: DiaryEntryData[];
	onEntryClick: (entry: DiaryEntryData) => void;
}

export function DiaryDateGroup({
	date,
	entries,
	onEntryClick,
}: DiaryDateGroupProps) {
	return (
		<div className="flex flex-col gap-3">
			{/* Date header */}
			<div className="flex items-center gap-3">
				<h2 className="text-sm font-semibold text-foreground">
					{formatDateHeading(date)}
				</h2>
				<div className="flex-1 h-px bg-border" aria-hidden="true" />
				<span className="text-[10px] text-muted-foreground/60 tabular-nums">
					{entries.length}
				</span>
			</div>

			{/* Entries */}
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				{entries.map((entry) => (
					<DiaryEntryCard
						key={entry._id}
						entry={entry}
						onClick={() => onEntryClick(entry)}
					/>
				))}
			</div>
		</div>
	);
}
