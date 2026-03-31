"use client";

import { cn } from "@/lib/utils";

type MandateStatus =
	| "requested"
	| "accepted"
	| "in_progress"
	| "delivered"
	| "settled";

export interface MandateCardData {
	_id: string;
	requestedBy: string;
	fulfilledBy: string;
	service: string;
	budget: number;
	status: MandateStatus;
	linkedTaskIds?: string[];
	tokensCost?: number;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	mandateDocument?: string;
	spendingLimits?: {
		maxPerTransaction: number;
		maxPerPeriod: number;
		periodDays?: number;
	};
	approvedCategories?: string[];
}

const ORCHESTRATOR_COLORS: Record<string, { bg: string; text: string }> = {
	pi: {
		bg: "bg-[oklch(0.65_0.15_232)]/15",
		text: "text-[oklch(0.65_0.15_232)]",
	},
	tau: {
		bg: "bg-[oklch(0.65_0.15_145)]/15",
		text: "text-[oklch(0.65_0.15_145)]",
	},
	phi: {
		bg: "bg-[oklch(0.65_0.15_290)]/15",
		text: "text-[oklch(0.65_0.15_290)]",
	},
	sigma: {
		bg: "bg-[oklch(0.65_0.15_50)]/15",
		text: "text-[oklch(0.65_0.15_50)]",
	},
};

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

function OrchestratorBadge({ id }: { id: string }) {
	const colors = ORCHESTRATOR_COLORS[id] ?? {
		bg: "bg-muted",
		text: "text-muted-foreground",
	};
	return (
		<span
			className={cn(
				"inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
				colors.bg,
				colors.text,
			)}
		>
			{id}
		</span>
	);
}

interface MandateCardProps {
	mandate: MandateCardData;
	onClick: () => void;
}

export function MandateCard({ mandate, onClick }: MandateCardProps) {
	const budgetUsedPct =
		mandate.tokensCost !== undefined && mandate.budget > 0
			? Math.min((mandate.tokensCost / mandate.budget) * 100, 100)
			: 0;

	const isOverBudget =
		mandate.tokensCost !== undefined && mandate.tokensCost > mandate.budget;

	return (
		<button
			type="button"
			className="w-full text-left rounded-xl border border-border bg-card p-3 cursor-pointer hover:bg-accent/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			onClick={onClick}
			aria-label={`Mandate: ${mandate.service}`}
		>
			{/* Requestor → fulfiller */}
			<div className="flex items-center gap-1.5 mb-2 flex-wrap">
				<OrchestratorBadge id={mandate.requestedBy} />
				<span
					className="text-[10px] text-muted-foreground/50"
					aria-hidden="true"
				>
					→
				</span>
				<OrchestratorBadge id={mandate.fulfilledBy} />
			</div>

			{/* Service (truncated) */}
			<p className="text-xs font-medium text-foreground line-clamp-2 mb-3">
				{mandate.service.length > 50
					? `${mandate.service.slice(0, 50)}…`
					: mandate.service}
			</p>

			{/* Budget bar */}
			{mandate.budget > 0 && (
				<div className="mb-2">
					<div className="flex items-center justify-between mb-0.5">
						<span className="text-[10px] text-muted-foreground">
							Budget: {formatTokens(mandate.budget)}
						</span>
						{mandate.tokensCost !== undefined && (
							<span
								className={cn(
									"text-[10px] font-medium",
									isOverBudget ? "text-destructive" : "text-muted-foreground",
								)}
							>
								Used: {formatTokens(mandate.tokensCost)}
							</span>
						)}
					</div>
					{mandate.tokensCost !== undefined && (
						<div className="h-1 rounded-full bg-muted overflow-hidden">
							<div
								className={cn(
									"h-full rounded-full transition-all",
									isOverBudget ? "bg-destructive" : "bg-[oklch(0.65_0.15_145)]",
								)}
								style={{ width: `${budgetUsedPct}%` }}
								role="progressbar"
								aria-valuenow={mandate.tokensCost}
								aria-valuemax={mandate.budget}
								aria-label="Budget used"
							/>
						</div>
					)}
				</div>
			)}

			{/* Footer: linked tasks count */}
			{mandate.linkedTaskIds && mandate.linkedTaskIds.length > 0 && (
				<div className="flex items-center gap-1 mt-1">
					<svg
						width="10"
						height="10"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						className="text-muted-foreground/60"
						aria-hidden="true"
					>
						<polyline points="9 11 12 14 22 4" />
						<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
					</svg>
					<span className="text-[10px] text-muted-foreground/70">
						{mandate.linkedTaskIds.length} task
						{mandate.linkedTaskIds.length !== 1 ? "s" : ""}
					</span>
				</div>
			)}
		</button>
	);
}
