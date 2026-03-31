"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { cn } from "@/lib/utils";

interface SearchModalProps {
	open: boolean;
	onClose: () => void;
}

const quickLinks = [
	{
		label: "Dashboard",
		href: "/dashboard",
		icon: (
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				aria-hidden="true"
			>
				<rect x="3" y="3" width="7" height="7" rx="1" />
				<rect x="14" y="3" width="7" height="7" rx="1" />
				<rect x="3" y="14" width="7" height="7" rx="1" />
				<rect x="14" y="14" width="7" height="7" rx="1" />
			</svg>
		),
	},
	{
		label: "Chat",
		href: "/dashboard/chat",
		icon: (
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				aria-hidden="true"
			>
				<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
			</svg>
		),
	},
	{
		label: "Missions",
		href: "/dashboard/missions",
		icon: (
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				aria-hidden="true"
			>
				<line x1="8" y1="6" x2="21" y2="6" />
				<line x1="8" y1="12" x2="21" y2="12" />
				<line x1="8" y1="18" x2="21" y2="18" />
				<line x1="3" y1="6" x2="3.01" y2="6" />
				<line x1="3" y1="12" x2="3.01" y2="12" />
				<line x1="3" y1="18" x2="3.01" y2="18" />
			</svg>
		),
	},
	{
		label: "Architect",
		href: "/dashboard/architect",
		icon: (
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				aria-hidden="true"
			>
				<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
				<path d="M19 15l.75 2.25L22 18l-2.25.75L19 21l-.75-2.25L16 18l2.25-.75L19 15z" />
				<path d="M5 3l.5 1.5L7 5l-1.5.5L5 7l-.5-1.5L3 5l1.5-.5L5 3z" />
			</svg>
		),
	},
	{
		label: "Settings",
		href: "/dashboard/account",
		icon: (
			<svg
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="3" />
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
			</svg>
		),
	},
];

export function SearchModal({ open, onClose }: SearchModalProps) {
	const router = useRouter();
	const inputRef = React.useRef<HTMLInputElement>(null);
	const [query, setQuery] = React.useState("");

	// Focus input when modal opens
	React.useEffect(() => {
		if (open) {
			// Small delay to ensure DOM is ready
			const t = setTimeout(() => inputRef.current?.focus(), 10);
			return () => clearTimeout(t);
		}
		setQuery("");
	}, [open]);

	// Escape key closes modal
	React.useEffect(() => {
		if (!open) return;
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [open, onClose]);

	// Prevent body scroll when open
	React.useEffect(() => {
		if (open) {
			document.body.style.overflow = "hidden";
		} else {
			document.body.style.overflow = "";
		}
		return () => {
			document.body.style.overflow = "";
		};
	}, [open]);

	const handleLinkClick = (href: string) => {
		router.push(href);
		onClose();
	};

	const filteredLinks = query
		? quickLinks.filter((l) =>
				l.label.toLowerCase().includes(query.toLowerCase()),
			)
		: quickLinks;

	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center"
			role="dialog"
			aria-modal="true"
			aria-label="Search"
		>
			{/* Backdrop */}
			<div
				className="absolute inset-0 bg-background/80 backdrop-blur-sm"
				onClick={onClose}
				aria-hidden="true"
			/>

			{/* Modal */}
			<div
				className={cn(
					"relative z-10 mt-[18vh] w-full max-w-lg mx-4",
					"bg-card border border-border rounded-xl shadow-lg overflow-hidden",
				)}
			>
				{/* Search input */}
				<div className="flex items-center gap-3 px-4 border-b border-border">
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						className="text-muted-foreground shrink-0"
						aria-hidden="true"
					>
						<circle cx="11" cy="11" r="8" />
						<path d="m21 21-4.35-4.35" />
					</svg>
					<input
						ref={inputRef}
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search pages, sessions, missions..."
						className="flex-1 py-3.5 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
						aria-label="Search"
					/>
					{query && (
						<button
							type="button"
							onClick={() => setQuery("")}
							className="text-muted-foreground hover:text-foreground transition-colors"
							aria-label="Clear search"
						>
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								aria-hidden="true"
							>
								<path d="M18 6L6 18M6 6l12 12" />
							</svg>
						</button>
					)}
					<kbd className="hidden sm:inline-flex items-center gap-0.5 text-[11px] text-muted-foreground border border-border rounded px-1.5 py-0.5 font-mono">
						Esc
					</kbd>
				</div>

				{/* Quick links */}
				<div className="py-2">
					{filteredLinks.length === 0 ? (
						<p className="px-4 py-3 text-sm text-muted-foreground">
							No results for &quot;{query}&quot;
						</p>
					) : (
						<>
							<p className="px-4 pt-1 pb-1 text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
								{query ? "Results" : "Quick access"}
							</p>
							{filteredLinks.map((link) => (
								<button
									key={link.href}
									type="button"
									onClick={() => handleLinkClick(link.href)}
									className={cn(
										"w-full flex items-center gap-3 px-4 py-2.5 text-sm text-muted-foreground",
										"hover:bg-accent hover:text-foreground transition-colors cursor-pointer text-left",
									)}
								>
									<span className="shrink-0">{link.icon}</span>
									<span>{link.label}</span>
								</button>
							))}
						</>
					)}
				</div>

				{/* Footer hint */}
				<div className="px-4 py-2 border-t border-border flex items-center gap-3 text-[11px] text-muted-foreground/60">
					<span className="flex items-center gap-1">
						<kbd className="font-mono border border-border rounded px-1 py-0.5">
							↑↓
						</kbd>
						navigate
					</span>
					<span className="flex items-center gap-1">
						<kbd className="font-mono border border-border rounded px-1 py-0.5">
							↵
						</kbd>
						open
					</span>
					<span className="flex items-center gap-1">
						<kbd className="font-mono border border-border rounded px-1 py-0.5">
							Esc
						</kbd>
						close
					</span>
				</div>
			</div>
		</div>
	);
}
