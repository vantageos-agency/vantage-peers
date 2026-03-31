"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { MandateCard, type MandateCardData } from "./mandate-card";

export type MandateStatus =
	| "requested"
	| "accepted"
	| "in_progress"
	| "delivered"
	| "settled";

const STATUS_STYLES: Record<
	MandateStatus,
	{ header: string; dot: string; labelKey: string }
> = {
	requested: {
		header: "bg-muted/60 text-muted-foreground",
		dot: "bg-muted-foreground",
		labelKey: "column_requested",
	},
	accepted: {
		header: "bg-[oklch(0.65_0.15_232)]/10 text-[oklch(0.65_0.15_232)]",
		dot: "bg-[oklch(0.65_0.15_232)]",
		labelKey: "column_accepted",
	},
	in_progress: {
		header: "bg-[oklch(0.75_0.18_55)]/10 text-[oklch(0.75_0.18_55)]",
		dot: "bg-[oklch(0.75_0.18_55)]",
		labelKey: "column_in_progress",
	},
	delivered: {
		header: "bg-[oklch(0.65_0.15_290)]/10 text-[oklch(0.65_0.15_290)]",
		dot: "bg-[oklch(0.65_0.15_290)]",
		labelKey: "column_delivered",
	},
	settled: {
		header: "bg-[oklch(0.65_0.15_145)]/10 text-[oklch(0.65_0.15_145)]",
		dot: "bg-[oklch(0.65_0.15_145)]",
		labelKey: "column_settled",
	},
};

interface MandateColumnProps {
	status: MandateStatus;
	mandates: MandateCardData[];
	onMandateClick: (mandate: MandateCardData) => void;
}

export function MandateColumn({
	status,
	mandates,
	onMandateClick,
}: MandateColumnProps) {
	const t = useTranslations("mandates_page");
	const style = STATUS_STYLES[status];

	return (
		<section
			aria-label={`${t(style.labelKey as Parameters<typeof t>[0])} column`}
			className="flex flex-col min-w-[260px] max-w-[300px] shrink-0"
		>
			{/* Column header */}
			<div
				className={cn(
					"flex items-center gap-2 px-3 py-2 rounded-lg mb-3",
					style.header,
				)}
			>
				<span
					className={cn("size-2 rounded-full shrink-0", style.dot)}
					aria-hidden="true"
				/>
				<span className="text-xs font-semibold uppercase tracking-wider">
					{t(style.labelKey as Parameters<typeof t>[0])}
				</span>
				<span className="ml-auto text-xs font-medium bg-background/50 px-1.5 py-0.5 rounded-full tabular-nums">
					{mandates.length}
				</span>
			</div>

			{/* Card list */}
			<ul className="flex flex-col gap-2 flex-1 overflow-y-auto min-h-[80px]">
				{mandates.length === 0 ? (
					<li className="flex items-center justify-center h-20 border border-dashed border-border rounded-lg text-xs text-muted-foreground/60">
						—
					</li>
				) : (
					mandates.map((mandate) => (
						<li key={mandate._id}>
							<MandateCard
								mandate={mandate}
								onClick={() => onMandateClick(mandate)}
							/>
						</li>
					))
				)}
			</ul>
		</section>
	);
}
