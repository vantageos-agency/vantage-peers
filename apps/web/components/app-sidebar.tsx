"use client";

/**
 * AppSidebar — VantagePeers
 *
 * Groups:
 *   CORE          — Dashboard, Tasks, Missions, Projects, Orchestrators
 *   MEMORY & COMMS — Memory, Diary, Messages (unread badge), Mandates
 *
 * Mobile: hidden at <md, opens as Sheet drawer via hamburger trigger in layout.
 * Touch targets: all nav items min-h-[44px].
 * Active state: subtle bg-sidebar-accent fill, no border accent.
 */

import { api } from "@convex/_generated/api";
import { useQuery } from "convex/react";
import * as React from "react";
import { SidebarUserNav } from "@/components/sidebar-user-nav";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarSeparator,
	useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Link, usePathname } from "@/i18n/routing";
import { cn } from "@/lib/utils";

const navItemClass = cn(
	"h-9 min-h-[44px] rounded-md px-3 text-sm font-medium text-muted-foreground",
	"transition-colors hover:bg-sidebar-accent hover:text-foreground",
	"data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground",
);

const navTransition = "150ms cubic-bezier(0.16, 1, 0.3, 1)";

// ── Inline SVG icons ────────────────────────────────────────────────────────

function IconGrid() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			className="shrink-0"
			aria-hidden="true"
		>
			<rect x="3" y="3" width="7" height="7" rx="1" />
			<rect x="14" y="3" width="7" height="7" rx="1" />
			<rect x="3" y="14" width="7" height="7" rx="1" />
			<rect x="14" y="14" width="7" height="7" rx="1" />
		</svg>
	);
}

function IconCheckSquare() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			className="shrink-0"
			aria-hidden="true"
		>
			<polyline points="9 11 12 14 22 4" />
			<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
		</svg>
	);
}

function IconListOrdered() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			className="shrink-0"
			aria-hidden="true"
		>
			<line x1="10" y1="6" x2="21" y2="6" />
			<line x1="10" y1="12" x2="21" y2="12" />
			<line x1="10" y1="18" x2="21" y2="18" />
			<path d="M4 6h1v4" />
			<path d="M4 10h2" />
			<path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
		</svg>
	);
}

function IconFolder() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			className="shrink-0"
			aria-hidden="true"
		>
			<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
		</svg>
	);
}

function IconActivity() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			className="shrink-0"
			aria-hidden="true"
		>
			<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
		</svg>
	);
}

function IconBrain() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			className="shrink-0"
			aria-hidden="true"
		>
			<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.16Z" />
			<path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.16Z" />
		</svg>
	);
}

function IconBookOpen() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			className="shrink-0"
			aria-hidden="true"
		>
			<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
			<path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
		</svg>
	);
}

function IconMessageSquare() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			className="shrink-0"
			aria-hidden="true"
		>
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
		</svg>
	);
}

function IconHandshake() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			className="shrink-0"
			aria-hidden="true"
		>
			<path d="M20.42 4.58a5.4 5.4 0 0 0-7.65 0l-.77.78-.77-.78a5.4 5.4 0 0 0-7.65 0C1.46 6.7 1.33 10.28 4 13l8 8 8-8c2.67-2.72 2.54-6.3.42-8.42z" />
			<path d="M12 5.36 8.87 8.5a2.13 2.13 0 0 0 0 3l3.13 3.14 3.13-3.14a2.13 2.13 0 0 0 0-3L12 5.36z" />
		</svg>
	);
}

// ── Component ────────────────────────────────────────────────────────────────

export function AppSidebar() {
	const pathname = usePathname();
	const { setOpenMobile, state, setOpen } = useSidebar();
	const isHoverExpandedRef = React.useRef(false);

	const unreadCount = useQuery(api.messages.getUnreadCount, {
		orchestratorId: "pi",
	});

	const handleNavClick = () => setOpenMobile(false);

	const handleMouseEnter = () => {
		if (state === "collapsed") {
			isHoverExpandedRef.current = true;
			setOpen(true);
		}
	};

	const handleMouseLeave = () => {
		if (isHoverExpandedRef.current) {
			isHoverExpandedRef.current = false;
			setOpen(false);
		}
	};

	return (
		<TooltipProvider delayDuration={0}>
			<Sidebar
				collapsible="icon"
				className="group-data-[side=left]:border-r border-sidebar-border bg-sidebar-background"
				aria-label="Main navigation"
				onMouseEnter={handleMouseEnter}
				onMouseLeave={handleMouseLeave}
			>
				{/* ── Header: Logo ── */}
				<SidebarHeader className="flex flex-col px-4 py-4 h-auto gap-0.5 group-data-[collapsible=icon]:hidden">
					<span className="font-bold tracking-[-0.03em] text-foreground text-base leading-tight">
						VantagePeers
					</span>
					<span className="text-[11px] text-muted-foreground leading-tight">
						Agent Dashboard
					</span>
				</SidebarHeader>

				{/* Collapsed logo: initials */}
				<SidebarHeader className="hidden px-4 py-4 h-14 items-center justify-center group-data-[collapsible=icon]:flex">
					<span className="font-bold text-sm text-foreground">VP</span>
				</SidebarHeader>

				{/* ── Content ── */}
				<SidebarContent>
					{/* ─── CORE ─── */}
					<SidebarGroup>
						<SidebarGroupLabel className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
							Core
						</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								{/* Dashboard */}
								<SidebarMenuItem>
									<SidebarMenuButton
										asChild
										isActive={
											pathname === "/dashboard" ||
											pathname.endsWith("/dashboard")
										}
										className={navItemClass}
										style={{ transition: `color ${navTransition}` }}
									>
										<Link href="/dashboard" onClick={handleNavClick}>
											<IconGrid />
											<span>Dashboard</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>

								{/* Tasks */}
								<SidebarMenuItem>
									<SidebarMenuButton
										asChild
										isActive={pathname.includes("/dashboard/tasks")}
										className={navItemClass}
										style={{ transition: `color ${navTransition}` }}
									>
										<Link href="/dashboard/tasks" onClick={handleNavClick}>
											<IconCheckSquare />
											<span>Tasks</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>

								{/* Missions */}
								<SidebarMenuItem>
									<SidebarMenuButton
										asChild
										isActive={pathname.includes("/dashboard/missions")}
										className={navItemClass}
										style={{ transition: `color ${navTransition}` }}
									>
										<Link href="/dashboard/missions" onClick={handleNavClick}>
											<IconListOrdered />
											<span>Missions</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>

								{/* Projects */}
								<SidebarMenuItem>
									<SidebarMenuButton
										asChild
										isActive={pathname.includes("/dashboard/projects")}
										className={navItemClass}
										style={{ transition: `color ${navTransition}` }}
									>
										<Link href="/dashboard/projects" onClick={handleNavClick}>
											<IconFolder />
											<span>Projects</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>

								{/* Orchestrators */}
								<SidebarMenuItem>
									<SidebarMenuButton
										asChild
										isActive={pathname.includes("/dashboard/orchestrators")}
										className={navItemClass}
										style={{ transition: `color ${navTransition}` }}
									>
										<Link
											href="/dashboard/orchestrators"
											onClick={handleNavClick}
										>
											<IconActivity />
											<span>Orchestrators</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>

					<SidebarSeparator className="mx-3" />

					{/* ─── MEMORY & COMMS ─── */}
					<SidebarGroup>
						<SidebarGroupLabel className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
							Memory &amp; Comms
						</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								{/* Memory */}
								<SidebarMenuItem>
									<SidebarMenuButton
										asChild
										isActive={pathname.includes("/dashboard/memory")}
										className={navItemClass}
										style={{ transition: `color ${navTransition}` }}
									>
										<Link href="/dashboard/memory" onClick={handleNavClick}>
											<IconBrain />
											<span>Memory</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>

								{/* Diary */}
								<SidebarMenuItem>
									<SidebarMenuButton
										asChild
										isActive={pathname.includes("/dashboard/diary")}
										className={navItemClass}
										style={{ transition: `color ${navTransition}` }}
									>
										<Link href="/dashboard/diary" onClick={handleNavClick}>
											<IconBookOpen />
											<span>Diary</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>

								{/* Messages — with unread badge */}
								<SidebarMenuItem>
									<SidebarMenuButton
										asChild
										isActive={pathname.includes("/dashboard/messages")}
										className={navItemClass}
										style={{ transition: `color ${navTransition}` }}
									>
										<Link
											href="/dashboard/messages"
											onClick={handleNavClick}
											aria-label={
												unreadCount
													? `Messages — ${unreadCount} unread`
													: "Messages"
											}
										>
											<span
												className="relative flex shrink-0"
												aria-hidden="true"
											>
												<IconMessageSquare />
												{unreadCount !== undefined && unreadCount > 0 && (
													<span
														className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold leading-none"
														style={{
															backgroundColor: "oklch(0.55 0.22 27)",
															color: "oklch(0.98 0 0)",
														}}
													>
														{unreadCount > 9 ? "9+" : unreadCount}
													</span>
												)}
											</span>
											<span>Messages</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>

								{/* Mandates */}
								<SidebarMenuItem>
									<SidebarMenuButton
										asChild
										isActive={pathname.includes("/dashboard/mandates")}
										className={navItemClass}
										style={{ transition: `color ${navTransition}` }}
									>
										<Link href="/dashboard/mandates" onClick={handleNavClick}>
											<IconHandshake />
											<span>Mandates</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>

				{/* ── Footer: User ── */}
				<SidebarFooter className="px-2 pb-3">
					<SidebarUserNav />
				</SidebarFooter>
			</Sidebar>
		</TooltipProvider>
	);
}
