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
import type { TaskCardData } from "./task-card";

interface TaskDetailSheetProps {
	task: TaskCardData | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
	todo: { bg: "bg-muted", text: "text-muted-foreground" },
	in_progress: {
		bg: "bg-[oklch(0.65_0.15_232)]/10",
		text: "text-[oklch(0.65_0.15_232)]",
	},
	review: {
		bg: "bg-[oklch(0.65_0.15_290)]/10",
		text: "text-[oklch(0.65_0.15_290)]",
	},
	blocked: { bg: "bg-destructive/10", text: "text-destructive" },
	done: {
		bg: "bg-[oklch(0.65_0.15_145)]/10",
		text: "text-[oklch(0.65_0.15_145)]",
	},
};

const PRIORITY_STYLES: Record<string, { bg: string; text: string }> = {
	urgent: { bg: "bg-destructive/10", text: "text-destructive" },
	high: {
		bg: "bg-[oklch(0.65_0.15_50)]/10",
		text: "text-[oklch(0.65_0.15_50)]",
	},
	medium: {
		bg: "bg-[oklch(0.65_0.15_90)]/10",
		text: "text-[oklch(0.65_0.15_90)]",
	},
	low: {
		bg: "bg-[oklch(0.65_0.15_145)]/10",
		text: "text-[oklch(0.65_0.15_145)]",
	},
};

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="flex items-start gap-3 py-2 border-b border-border/50 last:border-0">
			<span className="text-xs text-muted-foreground w-28 shrink-0 pt-0.5">
				{label}
			</span>
			<span className="text-xs text-foreground flex-1">{value}</span>
		</div>
	);
}

function Badge({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium capitalize",
				className,
			)}
		>
			{children}
		</span>
	);
}

export function TaskDetailSheet({
	task,
	open,
	onOpenChange,
}: TaskDetailSheetProps) {
	const t = useTranslations("tasks_page");

	if (!task) return null;

	const statusStyle = STATUS_STYLES[task.status] ?? STATUS_STYLES.todo;
	const priorityStyle =
		PRIORITY_STYLES[task.priority] ?? PRIORITY_STYLES.medium;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
				<SheetHeader className="mb-6">
					<SheetTitle className="text-base font-semibold leading-snug pr-6">
						{task.title}
					</SheetTitle>
					<SheetDescription className="sr-only">
						{t("detail_status")}: {task.status}
					</SheetDescription>
				</SheetHeader>

				<div className="space-y-0">
					<MetaRow
						label={t("detail_status")}
						value={
							<Badge className={cn(statusStyle.bg, statusStyle.text)}>
								{task.status.replace("_", " ")}
							</Badge>
						}
					/>
					<MetaRow
						label={t("detail_priority")}
						value={
							<Badge className={cn(priorityStyle.bg, priorityStyle.text)}>
								{task.priority}
							</Badge>
						}
					/>
					<MetaRow label={t("detail_assignee")} value={task.assignedTo} />
					{task.project && (
						<MetaRow label={t("detail_project")} value={task.project} />
					)}
					{task.claimedByInstance && (
						<MetaRow
							label={t("detail_claimed_by")}
							value={task.claimedByInstance}
						/>
					)}
					{task.estimatedMinutes !== undefined && (
						<MetaRow
							label={t("detail_estimated")}
							value={t("detail_minutes", { n: task.estimatedMinutes })}
						/>
					)}
					{task.actualMinutes !== undefined && (
						<MetaRow
							label={t("detail_actual")}
							value={t("detail_minutes", { n: task.actualMinutes })}
						/>
					)}
					<MetaRow
						label={t("detail_created")}
						value={new Date(task.createdAt).toLocaleString()}
					/>
					<MetaRow
						label={t("detail_updated")}
						value={new Date(task.updatedAt).toLocaleString()}
					/>
				</div>

				{task.description && (
					<div className="mt-6">
						<h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
							{t("detail_description")}
						</h4>
						<p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
							{task.description}
						</p>
					</div>
				)}

				{task.completionNote && (
					<div className="mt-6">
						<h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
							{t("detail_completion_note")}
						</h4>
						<div className="rounded-lg border border-[oklch(0.65_0.15_145)]/30 bg-[oklch(0.65_0.15_145)]/5 p-3">
							<p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
								{task.completionNote}
							</p>
						</div>
					</div>
				)}

				{task.dependsOn && task.dependsOn.length > 0 && (
					<div className="mt-6">
						<h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
							{t("detail_depends_on")}
						</h4>
						<div className="flex flex-col gap-1">
							{task.dependsOn.map((depId) => (
								<span
									key={depId}
									className="text-xs font-mono text-muted-foreground bg-muted px-2 py-1 rounded"
								>
									{depId}
								</span>
							))}
						</div>
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}
