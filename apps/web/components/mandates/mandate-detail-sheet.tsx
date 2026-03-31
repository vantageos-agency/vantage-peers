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
import { formatTokens, type MandateCardData } from "./mandate-card";

interface MandateDetailSheetProps {
	mandate: MandateCardData | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
	requested: { bg: "bg-muted", text: "text-muted-foreground" },
	accepted: {
		bg: "bg-[oklch(0.65_0.15_232)]/10",
		text: "text-[oklch(0.65_0.15_232)]",
	},
	in_progress: {
		bg: "bg-[oklch(0.75_0.18_55)]/10",
		text: "text-[oklch(0.75_0.18_55)]",
	},
	delivered: {
		bg: "bg-[oklch(0.65_0.15_290)]/10",
		text: "text-[oklch(0.65_0.15_290)]",
	},
	settled: {
		bg: "bg-[oklch(0.65_0.15_145)]/10",
		text: "text-[oklch(0.65_0.15_145)]",
	},
};

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="flex items-start gap-3 py-2 border-b border-border/50 last:border-0">
			<span className="text-xs text-muted-foreground w-32 shrink-0 pt-0.5">
				{label}
			</span>
			<span className="text-xs text-foreground flex-1">{value}</span>
		</div>
	);
}

function StatusBadge({ status }: { status: string }) {
	const style = STATUS_STYLES[status] ?? STATUS_STYLES.requested;
	return (
		<span
			className={cn(
				"inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium capitalize",
				style.bg,
				style.text,
			)}
		>
			{status.replace("_", " ")}
		</span>
	);
}

export function MandateDetailSheet({
	mandate,
	open,
	onOpenChange,
}: MandateDetailSheetProps) {
	const t = useTranslations("mandates_page");

	if (!mandate) return null;

	const budgetUsedPct =
		mandate.tokensCost !== undefined && mandate.budget > 0
			? Math.min((mandate.tokensCost / mandate.budget) * 100, 100)
			: 0;

	const isOverBudget =
		mandate.tokensCost !== undefined && mandate.tokensCost > mandate.budget;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
				<SheetHeader className="mb-6">
					<SheetTitle className="text-base font-semibold leading-snug pr-6">
						{t("detail_title")}
					</SheetTitle>
					<SheetDescription className="sr-only">
						{t("detail_status")}: {mandate.status}
					</SheetDescription>
				</SheetHeader>

				{/* Meta rows */}
				<div className="space-y-0">
					<MetaRow
						label={t("detail_status")}
						value={<StatusBadge status={mandate.status} />}
					/>
					<MetaRow
						label={t("detail_requested_by")}
						value={mandate.requestedBy}
					/>
					<MetaRow
						label={t("detail_fulfilled_by")}
						value={mandate.fulfilledBy}
					/>
					<MetaRow
						label={t("detail_budget")}
						value={
							<span className="font-mono tabular-nums">
								{formatTokens(mandate.budget)} tokens
							</span>
						}
					/>
					{mandate.tokensCost !== undefined && (
						<MetaRow
							label={t("detail_tokens_cost")}
							value={
								<span
									className={cn(
										"font-mono tabular-nums",
										isOverBudget ? "text-destructive" : "",
									)}
								>
									{formatTokens(mandate.tokensCost)} tokens
									{isOverBudget && (
										<span className="ml-1 text-destructive">
											({t("detail_over_budget")})
										</span>
									)}
								</span>
							}
						/>
					)}
					{mandate.linkedTaskIds && mandate.linkedTaskIds.length > 0 && (
						<MetaRow
							label={t("detail_linked_tasks")}
							value={`${mandate.linkedTaskIds.length} task${mandate.linkedTaskIds.length !== 1 ? "s" : ""}`}
						/>
					)}
					<MetaRow
						label={t("detail_created")}
						value={new Date(mandate.createdAt).toLocaleString()}
					/>
					<MetaRow
						label={t("detail_updated")}
						value={new Date(mandate.updatedAt).toLocaleString()}
					/>
					{mandate.completedAt !== undefined && (
						<MetaRow
							label={t("detail_completed")}
							value={new Date(mandate.completedAt).toLocaleString()}
						/>
					)}
				</div>

				{/* Budget progress */}
				{mandate.tokensCost !== undefined && mandate.budget > 0 && (
					<div className="mt-6">
						<h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
							{t("detail_budget_usage")}
						</h4>
						<div className="flex items-center justify-between mb-1.5 text-xs">
							<span className="text-muted-foreground">
								{formatTokens(mandate.tokensCost)} /{" "}
								{formatTokens(mandate.budget)}
							</span>
							<span
								className={cn(
									"font-medium tabular-nums",
									isOverBudget ? "text-destructive" : "text-foreground",
								)}
							>
								{budgetUsedPct.toFixed(0)}%
							</span>
						</div>
						<div className="h-2 rounded-full bg-muted overflow-hidden">
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
					</div>
				)}

				{/* Service description */}
				<div className="mt-6">
					<h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
						{t("detail_service")}
					</h4>
					<p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
						{mandate.service}
					</p>
				</div>

				{/* Mandate document */}
				{mandate.mandateDocument && (
					<div className="mt-6">
						<h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
							{t("detail_document")}
						</h4>
						<div className="rounded-lg border border-border bg-muted/30 p-3">
							<p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap font-mono">
								{mandate.mandateDocument}
							</p>
						</div>
					</div>
				)}

				{/* Approved categories */}
				{mandate.approvedCategories &&
					mandate.approvedCategories.length > 0 && (
						<div className="mt-6">
							<h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
								{t("detail_approved_categories")}
							</h4>
							<div className="flex flex-wrap gap-1.5">
								{mandate.approvedCategories.map((cat) => (
									<span
										key={cat}
										className="text-[10px] font-medium bg-muted text-muted-foreground px-2 py-0.5 rounded"
									>
										{cat}
									</span>
								))}
							</div>
						</div>
					)}

				{/* Spending limits */}
				{mandate.spendingLimits && (
					<div className="mt-6">
						<h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
							{t("detail_spending_limits")}
						</h4>
						<div className="space-y-0">
							<MetaRow
								label={t("detail_max_per_transaction")}
								value={
									<span className="font-mono tabular-nums">
										{formatTokens(mandate.spendingLimits.maxPerTransaction)}
									</span>
								}
							/>
							<MetaRow
								label={t("detail_max_per_period")}
								value={
									<span className="font-mono tabular-nums">
										{formatTokens(mandate.spendingLimits.maxPerPeriod)}
									</span>
								}
							/>
							{mandate.spendingLimits.periodDays !== undefined && (
								<MetaRow
									label={t("detail_period_days")}
									value={`${mandate.spendingLimits.periodDays}d`}
								/>
							)}
						</div>
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}
