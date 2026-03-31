"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

export interface OrchestratorProfile {
	_id: string;
	orchestratorId: string;
	instanceId?: string;
	name: string;
	static: {
		role: string;
		workspace: string;
		capabilities: string[];
	};
	dynamic: {
		currentTask?: string;
		lastSeen: number;
		sessionCount: number;
	};
}

type OnlineStatus = "online" | "idle" | "offline";

function getStatus(lastSeen: number): OnlineStatus {
	const diff = Date.now() - lastSeen;
	if (diff < 5 * 60 * 1000) return "online";
	if (diff < 30 * 60 * 1000) return "idle";
	return "offline";
}

function formatLastSeen(lastSeen: number): string {
	const diff = Date.now() - lastSeen;
	const minutes = Math.floor(diff / 60_000);
	const hours = Math.floor(diff / 3_600_000);
	const days = Math.floor(diff / 86_400_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	return `${days}d ago`;
}

const STATUS_DOT: Record<OnlineStatus, string> = {
	online: "bg-[oklch(0.65_0.15_145)]",
	idle: "bg-[oklch(0.75_0.18_85)]",
	offline: "bg-muted-foreground/40",
};

const STATUS_RING: Record<OnlineStatus, string> = {
	online: "ring-[oklch(0.65_0.15_145)]/30",
	idle: "ring-[oklch(0.75_0.18_85)]/30",
	offline: "ring-muted/20",
};

interface OrchestratorCardProps {
	profile: OrchestratorProfile;
	onClick: () => void;
}

export function OrchestratorCard({ profile, onClick }: OrchestratorCardProps) {
	const t = useTranslations("orchestrators_page");
	const status = getStatus(profile.dynamic.lastSeen);
	const dotClass = STATUS_DOT[status];
	const ringClass = STATUS_RING[status];

	return (
		<button
			type="button"
			className="w-full text-left rounded-xl border border-border bg-card p-4 hover:bg-accent/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			onClick={onClick}
			aria-label={`${profile.name} orchestrator, ${status}`}
		>
			{/* Header: status dot + name + instanceId */}
			<div className="flex items-start gap-3 mb-3">
				<span
					className={cn(
						"mt-1 w-2 h-2 rounded-full shrink-0 ring-4",
						dotClass,
						ringClass,
					)}
					role="img"
					aria-label={t(
						`status_${status}` as
							| "status_online"
							| "status_idle"
							| "status_offline",
					)}
				/>
				<div className="flex-1 min-w-0">
					<p className="text-sm font-semibold text-foreground leading-tight">
						{profile.name}
					</p>
					{profile.instanceId && (
						<p className="text-[10px] text-muted-foreground/60 font-mono mt-0.5 truncate">
							{profile.instanceId}
						</p>
					)}
				</div>
				<span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
					{formatLastSeen(profile.dynamic.lastSeen)}
				</span>
			</div>

			{/* Role + workspace */}
			<div className="flex flex-col gap-1.5 mb-3">
				<div className="flex items-center justify-between text-xs">
					<span className="text-muted-foreground/70">{t("role_label")}</span>
					<span className="text-muted-foreground font-medium truncate max-w-[150px]">
						{profile.static.role}
					</span>
				</div>
				<div className="flex items-center justify-between text-xs">
					<span className="text-muted-foreground/70">
						{t("workspace_label")}
					</span>
					<span className="text-muted-foreground font-mono text-[10px] truncate max-w-[150px]">
						{profile.static.workspace}
					</span>
				</div>
				<div className="flex items-center justify-between text-xs">
					<span className="text-muted-foreground/70">
						{t("sessions_label")}
					</span>
					<span className="text-foreground font-semibold tabular-nums">
						{profile.dynamic.sessionCount}
					</span>
				</div>
			</div>

			{/* Capabilities */}
			{profile.static.capabilities.length > 0 && (
				<div className="mb-3">
					<p className="text-[10px] text-muted-foreground/70 mb-1.5">
						{t("capabilities_label")}
					</p>
					<p className="text-[10px] text-muted-foreground line-clamp-2">
						{profile.static.capabilities.join(", ")}
					</p>
				</div>
			)}

			{/* Current task */}
			{profile.dynamic.currentTask && (
				<div className="mt-2 pt-2 border-t border-border/50">
					<p className="text-[10px] text-muted-foreground/70 mb-1">
						{t("current_task_label")}
					</p>
					<p className="text-xs text-foreground line-clamp-2">
						{profile.dynamic.currentTask}
					</p>
				</div>
			)}
		</button>
	);
}
