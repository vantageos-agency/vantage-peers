"use client";

import { api } from "@convex/_generated/api";
import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";

// ── Types ────────────────────────────────────────────────────────────────────

type BuStatus = "idea" | "building" | "live" | "revenue";

function StatusBadge({ status }: { status: BuStatus }) {
	const t = useTranslations("peers_dashboard.status");
	const label = t(status);

	if (status === "idea") {
		return (
			<span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
				{label}
			</span>
		);
	}
	if (status === "building") {
		return (
			<span
				className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
				style={{
					backgroundColor: "oklch(0.75 0.18 85 / 0.15)",
					color: "oklch(0.75 0.18 85)",
				}}
			>
				{label}
			</span>
		);
	}
	if (status === "live") {
		return (
			<span
				className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
				style={{
					backgroundColor: "oklch(0.65 0.15 232 / 0.15)",
					color: "oklch(0.65 0.15 232)",
				}}
			>
				{label}
			</span>
		);
	}
	// revenue
	return (
		<span
			className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
			style={{
				backgroundColor: "oklch(0.65 0.15 145 / 0.15)",
				color: "oklch(0.65 0.15 145)",
			}}
		>
			{label}
		</span>
	);
}

function ActivityTypeBadge({ type }: { type: "task" | "message" | "mandate" }) {
	const t = useTranslations("peers_dashboard.activity");

	const config = {
		task: {
			label: t("type_task"),
			style: {
				backgroundColor: "oklch(0.65 0.15 232 / 0.15)",
				color: "oklch(0.65 0.15 232)",
			},
		},
		message: {
			label: t("type_message"),
			style: {
				backgroundColor: "oklch(0.75 0.18 85 / 0.15)",
				color: "oklch(0.75 0.18 85)",
			},
		},
		mandate: {
			label: t("type_mandate"),
			style: {
				backgroundColor: "oklch(0.65 0.15 145 / 0.15)",
				color: "oklch(0.65 0.15 145)",
			},
		},
	};

	const { label, style } = config[type];

	return (
		<span
			className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
			style={style}
		>
			{label}
		</span>
	);
}

// ── SummaryBar ────────────────────────────────────────────────────────────────

interface SummaryBarProps {
	tasksInProgress: number;
	activeOrchestrators: number;
	unreadMessages: number;
	openMandates: number;
}

function SummaryBar({
	tasksInProgress,
	activeOrchestrators,
	unreadMessages,
	openMandates,
}: SummaryBarProps) {
	const t = useTranslations("peers_dashboard.summary");

	const stats = [
		{ label: t("tasks_in_progress"), value: tasksInProgress },
		{ label: t("active_orchestrators"), value: activeOrchestrators },
		{ label: t("unread_messages"), value: unreadMessages },
		{ label: t("open_mandates"), value: openMandates },
	];

	return (
		<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
			{stats.map((stat) => (
				<div
					key={stat.label}
					className="rounded-xl border border-border bg-card px-4 py-4 flex flex-col gap-1"
				>
					<span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
						{stat.label}
					</span>
					<span className="text-2xl font-bold tracking-tight text-foreground tabular-nums">
						{stat.value}
					</span>
				</div>
			))}
		</div>
	);
}

function SummaryBarSkeleton() {
	return (
		<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
			{(["a", "b", "c", "d"] as const).map((k) => (
				<div
					key={k}
					className="rounded-xl border border-border bg-card px-4 py-4 flex flex-col gap-1"
				>
					<Skeleton className="h-3 w-24" />
					<Skeleton className="h-8 w-12 mt-1" />
				</div>
			))}
		</div>
	);
}

// ── BusinessUnitGrid ──────────────────────────────────────────────────────────

interface BusinessUnit {
	_id: string;
	name: string;
	description: string;
	status: BuStatus;
	domain?: string;
	orchestratorId: string;
	revenueProjections: { y1: number; y2: number; y3: number };
}

function BusinessUnitCard({ bu }: { bu: BusinessUnit }) {
	const t = useTranslations("peers_dashboard.bu_grid");

	const formattedRevenue = new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(bu.revenueProjections.y1);

	return (
		<div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3 hover:border-border/80 transition-colors">
			<div className="flex items-start justify-between gap-2">
				<span className="font-semibold text-sm text-foreground leading-tight">
					{bu.name}
				</span>
				<StatusBadge status={bu.status} />
			</div>
			<p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
				{bu.description}
			</p>
			<div className="flex flex-col gap-1.5 mt-auto pt-1 border-t border-border/50">
				{bu.domain && (
					<div className="flex items-center justify-between text-xs">
						<span className="text-muted-foreground/70">{t("domain")}</span>
						<span className="text-muted-foreground font-medium truncate max-w-[120px]">
							{bu.domain}
						</span>
					</div>
				)}
				<div className="flex items-center justify-between text-xs">
					<span className="text-muted-foreground/70">{t("orchestrator")}</span>
					<span className="text-muted-foreground font-medium font-mono">
						{bu.orchestratorId}
					</span>
				</div>
				<div className="flex items-center justify-between text-xs">
					<span className="text-muted-foreground/70">{t("revenue_y1")}</span>
					<span className="text-foreground font-semibold tabular-nums">
						{formattedRevenue}
					</span>
				</div>
			</div>
		</div>
	);
}

function BusinessUnitGridSkeleton() {
	return (
		<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{(["a", "b", "c"] as const).map((k) => (
				<div
					key={k}
					className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3"
				>
					<div className="flex items-start justify-between gap-2">
						<Skeleton className="h-4 w-32" />
						<Skeleton className="h-5 w-16 rounded-full" />
					</div>
					<Skeleton className="h-3 w-full" />
					<Skeleton className="h-3 w-3/4" />
					<div className="flex flex-col gap-1.5 mt-2 pt-2 border-t border-border/50">
						<div className="flex justify-between">
							<Skeleton className="h-3 w-16" />
							<Skeleton className="h-3 w-20" />
						</div>
						<div className="flex justify-between">
							<Skeleton className="h-3 w-16" />
							<Skeleton className="h-3 w-14" />
						</div>
					</div>
				</div>
			))}
		</div>
	);
}

interface BusinessUnitGridProps {
	units: BusinessUnit[];
}

function BusinessUnitGrid({ units }: BusinessUnitGridProps) {
	const t = useTranslations("peers_dashboard.bu_grid");

	if (units.length === 0) {
		return (
			<div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-10 text-center">
				<p className="text-sm font-medium text-foreground">
					{t("empty_title")}
				</p>
				<p className="mt-1 text-xs text-muted-foreground max-w-sm mx-auto">
					{t("empty_description")}
				</p>
			</div>
		);
	}

	return (
		<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{units.map((bu) => (
				<BusinessUnitCard key={bu._id} bu={bu} />
			))}
		</div>
	);
}

// ── RecentActivityPanel ────────────────────────────────────────────────────────

interface ActivityEvent {
	type: "task" | "message" | "mandate";
	id: string;
	actor: string;
	excerpt: string;
	status?: string;
	updatedAt: number;
}

function RecentActivityPanel({ events }: { events: ActivityEvent[] }) {
	const t = useTranslations("peers_dashboard.activity");

	if (events.length === 0) {
		return (
			<div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-8 text-center">
				<p className="text-sm font-medium text-foreground">
					{t("empty_title")}
				</p>
				<p className="mt-1 text-xs text-muted-foreground">
					{t("empty_description")}
				</p>
			</div>
		);
	}

	return (
		<div className="rounded-xl border border-border bg-card overflow-hidden">
			<div className="divide-y divide-border/60">
				{events.map((event) => (
					<div
						key={event.id}
						className="flex items-start gap-3 px-4 py-3 hover:bg-muted/30 transition-colors"
					>
						<ActivityTypeBadge type={event.type} />
						<div className="flex-1 min-w-0">
							<p className="text-xs text-foreground leading-relaxed line-clamp-1">
								{event.excerpt}
							</p>
							<p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
								{event.actor}
								{event.status && (
									<span className="ml-2 opacity-60">· {event.status}</span>
								)}
							</p>
						</div>
						<span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">
							{formatRelativeTime(event.updatedAt)}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

function RecentActivitySkeleton() {
	return (
		<div className="rounded-xl border border-border bg-card overflow-hidden">
			<div className="divide-y divide-border/60">
				{(["a", "b", "c", "d", "e"] as const).map((k) => (
					<div key={k} className="flex items-start gap-3 px-4 py-3">
						<Skeleton className="h-4 w-14 rounded shrink-0" />
						<div className="flex-1 flex flex-col gap-1">
							<Skeleton className="h-3 w-full" />
							<Skeleton className="h-2.5 w-24" />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

// ── WelcomeBanner ─────────────────────────────────────────────────────────────

function WelcomeBanner() {
	const t = useTranslations("peers_dashboard.welcome_banner");
	const [dismissed, setDismissed] = React.useState(false);

	React.useEffect(() => {
		if (typeof window !== "undefined") {
			const isDismissed =
				localStorage.getItem("vp_onboarding_dismissed") === "true";
			setDismissed(isDismissed);
		}
	}, []);

	const handleDismiss = () => {
		localStorage.setItem("vp_onboarding_dismissed", "true");
		setDismissed(true);
	};

	if (dismissed) return null;

	return (
		<div
			className="rounded-xl border px-5 py-4 flex items-start gap-4"
			style={{
				borderColor: "oklch(0.65 0.15 232 / 0.4)",
				backgroundColor: "oklch(0.65 0.15 232 / 0.06)",
			}}
		>
			<div className="flex-1 min-w-0">
				<p className="text-sm font-semibold text-foreground">{t("title")}</p>
				<p className="mt-0.5 text-xs text-muted-foreground">
					{t("description")}
				</p>
			</div>
			<button
				type="button"
				onClick={handleDismiss}
				className="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground border border-border hover:text-foreground hover:border-border/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				aria-label={t("dismiss")}
			>
				{t("dismiss")}
			</button>
		</div>
	);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const minutes = Math.floor(diff / 60_000);
	const hours = Math.floor(diff / 3_600_000);
	const days = Math.floor(diff / 86_400_000);

	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	if (hours < 24) return `${hours}h`;
	return `${days}d`;
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
	const t = useTranslations("peers_dashboard");
	const tBu = useTranslations("peers_dashboard.bu_grid");
	const tActivity = useTranslations("peers_dashboard.activity");

	const summary = useQuery(api.dashboard.getDashboardSummary);
	const businessUnits = useQuery(api.businessUnits.list, {});

	const isLoading = summary === undefined || businessUnits === undefined;
	const showWelcomeBanner = !isLoading && businessUnits.length === 0;

	return (
		<div className="flex flex-col gap-6 p-4 md:p-6 max-w-7xl mx-auto w-full">
			{/* Page header */}
			<div className="flex flex-col gap-0.5">
				<h1 className="text-xl font-bold tracking-tight text-foreground">
					{t("title")}
				</h1>
				<p className="text-sm text-muted-foreground">{t("subtitle")}</p>
			</div>

			{/* Welcome banner — empty state only */}
			{showWelcomeBanner && <WelcomeBanner />}

			{/* Summary bar */}
			{isLoading ? (
				<SummaryBarSkeleton />
			) : (
				<SummaryBar
					tasksInProgress={summary.tasksInProgress}
					activeOrchestrators={summary.activeOrchestrators.length}
					unreadMessages={summary.unreadMessages}
					openMandates={summary.openMandates}
				/>
			)}

			{/* Business Units */}
			<section>
				<h2 className="mb-3 text-sm font-semibold text-foreground">
					{tBu("title")}
				</h2>
				{isLoading ? (
					<BusinessUnitGridSkeleton />
				) : (
					<BusinessUnitGrid
						units={businessUnits as unknown as BusinessUnit[]}
					/>
				)}
			</section>

			{/* Recent Activity */}
			<section>
				<h2 className="mb-3 text-sm font-semibold text-foreground">
					{tActivity("title")}
				</h2>
				{isLoading ? (
					<RecentActivitySkeleton />
				) : (
					<RecentActivityPanel events={summary.recentActivity} />
				)}
			</section>
		</div>
	);
}
