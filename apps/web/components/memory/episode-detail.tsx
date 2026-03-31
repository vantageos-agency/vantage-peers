"use client";

import { useTranslations } from "next-intl";
import type { EpisodeData, Severity } from "./memory-card";

function SeverityBadge({ severity }: { severity: Severity }) {
	const t = useTranslations("memory_page.episode");

	if (severity === "critical") {
		return (
			<span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide bg-destructive/10 text-destructive">
				{t("severity_critical")}
			</span>
		);
	}
	if (severity === "major") {
		return (
			<span
				className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide"
				style={{
					backgroundColor: "oklch(0.75 0.18 55 / 0.15)",
					color: "oklch(0.75 0.18 55)",
				}}
			>
				{t("severity_major")}
			</span>
		);
	}
	return (
		<span
			className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide"
			style={{
				backgroundColor: "oklch(0.65 0.15 232 / 0.15)",
				color: "oklch(0.65 0.15 232)",
			}}
		>
			{t("severity_minor")}
		</span>
	);
}

interface EpisodeDetailProps {
	episode: EpisodeData;
}

const FIELDS: Array<{
	key: keyof Omit<EpisodeData, "severity">;
	labelKey: string;
}> = [
	{ key: "context", labelKey: "context" },
	{ key: "goal", labelKey: "goal" },
	{ key: "action", labelKey: "action" },
	{ key: "outcome", labelKey: "outcome" },
	{ key: "insight", labelKey: "insight" },
];

export function EpisodeDetail({ episode }: EpisodeDetailProps) {
	const t = useTranslations("memory_page.episode");

	return (
		<div className="rounded-lg border border-border bg-muted/30 p-4 flex flex-col gap-4">
			{/* Severity */}
			<div className="flex items-center justify-between">
				<span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
					{t("title")}
				</span>
				<SeverityBadge severity={episode.severity} />
			</div>

			{/* Episode fields */}
			<div className="flex flex-col gap-3">
				{FIELDS.map(({ key, labelKey }) => (
					<div key={key} className="flex flex-col gap-0.5">
						<span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
							{t(
								labelKey as
									| "context"
									| "goal"
									| "action"
									| "outcome"
									| "insight",
							)}
						</span>
						<p className="text-xs text-foreground leading-relaxed">
							{episode[key]}
						</p>
					</div>
				))}
			</div>
		</div>
	);
}
