"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import Image from "next/image";
import { useTheme } from "next-themes";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@/components/ui/sidebar";

export function SidebarUserNav() {
	const { user, isLoaded } = useUser();
	const { signOut } = useClerk();
	const { setTheme, resolvedTheme } = useTheme();

	if (!isLoaded) {
		return (
			<SidebarMenu>
				<SidebarMenuItem>
					<SidebarMenuButton className="h-10 min-h-[44px] justify-between">
						<div className="flex flex-row gap-2 items-center">
							<div className="animate-pulse bg-muted rounded-full size-6" />
							<div className="animate-pulse bg-muted rounded h-4 w-24" />
						</div>
					</SidebarMenuButton>
				</SidebarMenuItem>
			</SidebarMenu>
		);
	}

	if (!user) return null;

	const displayName =
		user.fullName || user.primaryEmailAddress?.emailAddress || "User";
	const avatarUrl =
		user.imageUrl ||
		`https://avatar.vercel.sh/${user.primaryEmailAddress?.emailAddress || user.id}`;

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground h-10 min-h-[44px]"
							aria-label="User account menu"
						>
							<Image
								src={avatarUrl}
								alt={displayName}
								width={24}
								height={24}
								className="rounded-full"
							/>
							<span className="truncate text-sm">{displayName}</span>
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								className="ml-auto shrink-0"
								aria-hidden="true"
							>
								<path d="M18 15l-6-6-6 6" />
							</svg>
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						side="top"
						className="w-[--radix-popper-anchor-width]"
					>
						<DropdownMenuItem
							className="cursor-pointer"
							onSelect={() =>
								setTheme(resolvedTheme === "dark" ? "light" : "dark")
							}
						>
							{`Toggle ${resolvedTheme === "light" ? "dark" : "light"} mode`}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem asChild>
							<button
								type="button"
								className="w-full cursor-pointer text-destructive focus:text-destructive"
								onClick={() => signOut({ redirectUrl: "/" })}
							>
								Sign out
							</button>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}
