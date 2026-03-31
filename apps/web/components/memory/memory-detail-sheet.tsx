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
import { EpisodeDetail } from "./episode-detail";
import type { MemoryCardData, MemoryType, RelationType } from "./memory-card";

const TYPE_STYLES: Record<MemoryType, { bg: string; text: string }> = {
	user: {
		bg: "bg-[oklch(0.65_0.15_232)]/15",
		text: "text-[oklch(0.65_0.15_232)]",
	},
	feedback: {
		bg: "bg-[oklch(0.65_0.15_50)]/15",
		text: "text-[oklch(0.65_0.15_50)]",
	},
	project: {
		bg: "bg-[oklch(0.65_0.15_290)]/15",
		text: "text-[oklch(0.65_0.15_290)]",
	},
	reference: {
		bg: "bg-[oklch(0.75_0.18_85)]/15",
		text: "text-[oklch(0.75_0.18_85)]",
	},
	episode: {
		bg: "bg-destructive/10",
		text: "text-destructive",
	},
};

const RELATION_STYLES: Record<RelationType, { bg: string; text: string }> = {
	updates: {
		bg: "bg-[oklch(0.65_0.15_50)]/10",
		text: "text-[oklch(0.65_0.15_50)]",
	},
	extends: {
		bg: "bg-[oklch(0.65_0.15_232)]/10",
		text: "text-[oklch(0.65_0.15_232)]",
	},
	derives: {
		bg: "bg-[oklch(0.65_0.15_290)]/10",
		text: "text-[oklch(0.65_0.15_290)]",
	},
};

interface MemoryDetailSheetProps {
	memory: MemoryCardData | null;
	onClose: () => void;
}

export function MemoryDetailSheet({ memory, onClose }: MemoryDetailSheetProps) {
	const t = useTranslations("memory_page");

	if (!memory) return null;

	const typeStyle = TYPE_STYLES[memory.type] ?? TYPE_STYLES.project;

	return (
		<Sheet open={memory !== null} onOpenChange={(open) => !open && onClose()}>
			<SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
				<SheetHeader className="mb-4">
					<div className="flex items-center gap-2 flex-wrap">
						<span
							className={cn(
								"inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide",
								typeStyle.bg,
								typeStyle.text,
							)}
						>
							{memory.type}
						</span>
						{memory.isLatest && (
							<span className="flex items-center gap-1 text-[10px] text-[oklch(0.65_0.15_145)] font-medium">
								<span
									className="inline-block w-1.5 h-1.5 rounded-full bg-[oklch(0.65_0.15_145)]"
									aria-hidden="true"
								/>
								{t("latest")}
							</span>
						)}
					</div>
					<SheetTitle className="text-base font-semibold text-foreground mt-2">
						{t("detail_title")}
					</SheetTitle>
					<SheetDescription className="font-mono text-[11px] text-muted-foreground/60 break-all">
						{memory.namespace}
					</SheetDescription>
				</SheetHeader>

				<div className="flex flex-col gap-5">
					{/* Full content */}
					<div>
						<p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
							{t("content_label")}
						</p>
						<pre className="text-xs text-foreground leading-relaxed whitespace-pre-wrap font-sans break-words">
							{memory.content}
						</pre>
					</div>

					{/* Episode details */}
					{memory.episode && <EpisodeDetail episode={memory.episode} />}

					{/* Relations */}
					{memory.relations.length > 0 && (
						<div>
							<p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
								{t("relations_label")}
							</p>
							<div className="flex flex-col gap-2">
								{memory.relations.map((rel) => {
									const relStyle =
										RELATION_STYLES[rel.type] ?? RELATION_STYLES.derives;
									return (
										<div
											key={rel.targetId}
											className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2"
										>
											<span
												className={cn(
													"inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide",
													relStyle.bg,
													relStyle.text,
												)}
											>
												{rel.type}
											</span>
											<span className="text-[10px] text-muted-foreground font-mono truncate">
												{rel.targetId}
											</span>
										</div>
									);
								})}
							</div>
						</div>
					)}

					{/* Metadata */}
					<div className="border-t border-border pt-4 flex flex-col gap-1.5">
						<div className="flex items-center justify-between text-[10px]">
							<span className="text-muted-foreground/70 uppercase tracking-wide font-medium">
								{t("meta_created_by")}
							</span>
							<span className="text-muted-foreground font-mono">
								{memory.createdBy}
							</span>
						</div>
						{memory.ttl && (
							<div className="flex items-center justify-between text-[10px]">
								<span className="text-muted-foreground/70 uppercase tracking-wide font-medium">
									{t("meta_ttl")}
								</span>
								<span className="text-muted-foreground font-mono">
									{memory.ttl}
								</span>
							</div>
						)}
						<div className="flex items-center justify-between text-[10px]">
							<span className="text-muted-foreground/70 uppercase tracking-wide font-medium">
								{t("meta_id")}
							</span>
							<span className="text-muted-foreground/50 font-mono truncate max-w-[200px]">
								{memory._id}
							</span>
						</div>
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}
