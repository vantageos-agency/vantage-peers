import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
	return (
		<div className="flex flex-col gap-6 p-4 md:p-6">
			{/* Page header */}
			<div className="flex flex-col gap-2">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-4 w-72" />
			</div>

			{/* Stats row */}
			<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
				{(["revenue", "users", "orders", "growth"] as const).map((stat) => (
					<div
						key={stat}
						className="rounded-xl border border-border bg-card p-4 flex flex-col gap-2"
					>
						<Skeleton className="h-4 w-20" />
						<Skeleton className="h-8 w-16" />
					</div>
				))}
			</div>

			{/* Content area */}
			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
					<Skeleton className="h-5 w-32" />
					{(["item-1", "item-2", "item-3", "item-4"] as const).map((item) => (
						<Skeleton key={item} className="h-12 w-full" />
					))}
				</div>
				<div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
					<Skeleton className="h-5 w-32" />
					<Skeleton className="h-48 w-full" />
				</div>
			</div>
		</div>
	);
}
