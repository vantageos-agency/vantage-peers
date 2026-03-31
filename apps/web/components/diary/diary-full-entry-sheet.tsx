"use client";

import { useTranslations } from "next-intl";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { DiaryEntryData, DiaryOrchestrator } from "./diary-entry-card";

const ORCHESTRATOR_COLORS: Record<DiaryOrchestrator, string> = {
	pi: "bg-[oklch(0.65_0.15_232)]/20 text-[oklch(0.65_0.15_232)]",
	tau: "bg-[oklch(0.65_0.15_290)]/20 text-[oklch(0.65_0.15_290)]",
	phi: "bg-[oklch(0.65_0.15_145)]/20 text-[oklch(0.65_0.15_145)]",
	sigma: "bg-[oklch(0.65_0.15_50)]/20 text-[oklch(0.65_0.15_50)]",
	system: "bg-muted text-muted-foreground",
};

function formatDateLong(dateStr: string): string {
	const [year, month, day] = dateStr.split("-").map(Number);
	const date = new Date(year, month - 1, day);
	return date.toLocaleDateString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

interface DiaryFullEntrySheetProps {
	entry: DiaryEntryData | null;
	onClose: () => void;
}

export function DiaryFullEntrySheet({
	entry,
	onClose,
}: DiaryFullEntrySheetProps) {
	const t = useTranslations("diary_page");

	if (!entry) return null;

	const orchestratorColor =
		ORCHESTRATOR_COLORS[entry.orchestrator] ?? ORCHESTRATOR_COLORS.system;

	return (
		<Sheet open={entry !== null} onOpenChange={(open) => !open && onClose()}>
			<SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
				<SheetHeader className="mb-4">
					<div className="flex items-center gap-2 flex-wrap">
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
					<SheetTitle className="text-base font-semibold text-foreground mt-2">
						{formatDateLong(entry.date)}
					</SheetTitle>
					<SheetDescription className="sr-only">
						{t("sheet_description")}
					</SheetDescription>
				</SheetHeader>

				<div className="flex flex-col gap-5">
					{/* Full content — rendered as formatted text */}
					<div>
						<p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
							{t("content_label")}
						</p>
						<div className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">
							{entry.content}
						</div>
					</div>

					{/* Highlights */}
					{entry.highlights && entry.highlights.length > 0 && (
						<div>
							<p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
								{t("highlights_label")}
							</p>
							<ul className="flex flex-col gap-1.5">
								{entry.highlights.map((highlight) => (
									<li
										key={highlight}
										className="flex items-start gap-2 text-xs text-foreground"
									>
										<span
											className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[oklch(0.65_0.15_145)] shrink-0"
											aria-hidden="true"
										/>
										{highlight}
									</li>
								))}
							</ul>
						</div>
					)}

					{/* Blockers */}
					{entry.blockers && entry.blockers.length > 0 && (
						<div>
							<p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
								{t("blockers_label")}
							</p>
							<ul className="flex flex-col gap-1.5">
								{entry.blockers.map((blocker) => (
									<li
										key={blocker}
										className="flex items-start gap-2 text-xs text-destructive"
									>
										<span
											className="mt-1.5 w-1.5 h-1.5 rounded-full bg-destructive shrink-0"
											aria-hidden="true"
										/>
										{blocker}
									</li>
								))}
							</ul>
						</div>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
