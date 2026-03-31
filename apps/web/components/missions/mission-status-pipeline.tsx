"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

type MissionStatus =
	| "brainstorm"
	| "plan"
	| "execute"
	| "validate"
	| "complete";

const STEPS: MissionStatus[] = [
	"brainstorm",
	"plan",
	"execute",
	"validate",
	"complete",
];

const STEP_LABEL_KEYS: Record<MissionStatus, string> = {
	brainstorm: "status_brainstorm",
	plan: "status_plan",
	execute: "status_execute",
	validate: "status_validate",
	complete: "status_complete",
};

interface MissionStatusPipelineProps {
	status: MissionStatus;
	compact?: boolean;
}

export function MissionStatusPipeline({
	status,
	compact = false,
}: MissionStatusPipelineProps) {
	const t = useTranslations("missions_page");
	const currentIndex = STEPS.indexOf(status);

	if (compact) {
		return (
			<div className="flex items-center gap-1">
				{STEPS.map((step, i) => (
					<div
						key={step}
						className={cn(
							"h-1 rounded-full transition-all flex-1",
							i < currentIndex
								? "bg-[oklch(0.65_0.15_145)]"
								: i === currentIndex
									? "bg-[oklch(0.65_0.15_232)]"
									: "bg-muted",
						)}
						aria-hidden="true"
					/>
				))}
			</div>
		);
	}

	return (
		<ol
			className="flex items-center gap-1"
			aria-label="Mission status pipeline"
		>
			{STEPS.map((step, i) => {
				const isDone = i < currentIndex;
				const isCurrent = i === currentIndex;
				return (
					<li key={step} className="flex flex-col items-center gap-1">
						<div
							className={cn(
								"size-2 rounded-full transition-colors",
								isDone
									? "bg-[oklch(0.65_0.15_145)]"
									: isCurrent
										? "bg-[oklch(0.65_0.15_232)] ring-2 ring-[oklch(0.65_0.15_232)]/30"
										: "bg-muted",
							)}
							aria-hidden="true"
						/>
						<span
							className={cn(
								"text-[9px] font-medium uppercase tracking-wider",
								isDone
									? "text-[oklch(0.65_0.15_145)]"
									: isCurrent
										? "text-[oklch(0.65_0.15_232)]"
										: "text-muted-foreground/50",
							)}
						>
							{t(STEP_LABEL_KEYS[step] as Parameters<typeof t>[0])}
						</span>
					</li>
				);
			})}
		</ol>
	);
}
