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
import type { OrchestratorProfile } from "./orchestrator-card";

type OnlineStatus = "online" | "idle" | "offline";

function getStatus(lastSeen: number): OnlineStatus {
	const diff = Date.now() - lastSeen;
	if (diff < 5 * 60 * 1000) return "online";
	if (diff < 30 * 60 * 1000) return "idle";
	return "offline";
}

function formatTimestamp(ts: number): string {
	return new Date(ts).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

const STATUS_STYLES: Record<
	OnlineStatus,
	{ dot: string; label: string; labelStyle: React.CSSProperties }
> = {
	online: {
		dot: "bg-[oklch(0.65_0.15_145)]",
		label: "Online",
		labelStyle: { color: "oklch(0.65 0.15 145)" },
	},
	idle: {
		dot: "bg-[oklch(0.75_0.18_85)]",
		label: "Idle",
		labelStyle: { color: "oklch(0.75 0.18 85)" },
	},
	offline: {
		dot: "bg-muted-foreground/40",
		label: "Offline",
		labelStyle: {},
	},
};

interface OrchestratorDetailProps {
	profile: OrchestratorProfile | null;
	onClose: () => void;
}

export function OrchestratorDetail({
	profile,
	onClose,
}: OrchestratorDetailProps) {
	const t = useTranslations("orchestrators_page");

	if (!profile) return null;

	const status = getStatus(profile.dynamic.lastSeen);
	const statusStyle = STATUS_STYLES[status];

	return (
		<Sheet open={profile !== null} onOpenChange={(open) => !open && onClose()}>
			<SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
				<SheetHeader className="mb-4">
					<div className="flex items-center gap-2">
						<span
							className={cn("w-2 h-2 rounded-full shrink-0", statusStyle.dot)}
							aria-hidden="true"
						/>
						<span
							className="text-xs font-medium"
							style={statusStyle.labelStyle}
						>
							{t(
								`status_${status}` as
									| "status_online"
									| "status_idle"
									| "status_offline",
							)}
						</span>
					</div>
					<SheetTitle className="text-base font-semibold text-foreground mt-2">
						{profile.name}
					</SheetTitle>
					<SheetDescription className="font-mono text-[11px] text-muted-foreground/60">
						{profile.orchestratorId}
						{profile.instanceId && ` · ${profile.instanceId}`}
					</SheetDescription>
				</SheetHeader>

				<div className="flex flex-col gap-5">
					{/* Static info */}
					<div>
						<p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
							{t("static_info_label")}
						</p>
						<div className="rounded-lg border border-border bg-muted/30 p-3 flex flex-col gap-2">
							<div className="flex items-start justify-between gap-2 text-xs">
								<span className="text-muted-foreground/70 shrink-0">
									{t("role_label")}
								</span>
								<span className="text-foreground font-medium text-right">
									{profile.static.role}
								</span>
							</div>
							<div className="flex items-start justify-between gap-2 text-xs">
								<span className="text-muted-foreground/70 shrink-0">
									{t("workspace_label")}
								</span>
								<span className="text-muted-foreground font-mono text-[10px] text-right break-all">
									{profile.static.workspace}
								</span>
							</div>
						</div>
					</div>

					{/* Capabilities */}
					{profile.static.capabilities.length > 0 && (
						<div>
							<p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
								{t("capabilities_label")}
							</p>
							<div className="flex flex-wrap gap-1.5">
								{profile.static.capabilities.map((cap) => (
									<span
										key={cap}
										className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground"
									>
										{cap}
									</span>
								))}
							</div>
						</div>
					)}

					{/* Dynamic info */}
					<div>
						<p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
							{t("dynamic_info_label")}
						</p>
						<div className="rounded-lg border border-border bg-muted/30 p-3 flex flex-col gap-2">
							<div className="flex items-center justify-between text-xs">
								<span className="text-muted-foreground/70">
									{t("sessions_label")}
								</span>
								<span className="text-foreground font-semibold tabular-nums">
									{profile.dynamic.sessionCount}
								</span>
							</div>
							<div className="flex items-center justify-between text-xs">
								<span className="text-muted-foreground/70">
									{t("last_seen_label")}
								</span>
								<span className="text-muted-foreground tabular-nums">
									{formatTimestamp(profile.dynamic.lastSeen)}
								</span>
							</div>
							{profile.dynamic.currentTask && (
								<div className="flex flex-col gap-1 pt-2 border-t border-border/50">
									<span className="text-[10px] text-muted-foreground/70">
										{t("current_task_label")}
									</span>
									<p className="text-xs text-foreground leading-relaxed">
										{profile.dynamic.currentTask}
									</p>
								</div>
							)}
						</div>
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}
