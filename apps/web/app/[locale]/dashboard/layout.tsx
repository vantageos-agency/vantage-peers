import type React from "react";
import { AppSidebar } from "@/components/app-sidebar";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar";

export default function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<SidebarProvider>
			<div className="flex min-h-screen w-full bg-background">
				{/*
          AppSidebar:
          - Desktop (md+): visible as persistent left panel
          - Mobile (<md): hidden, opens as Sheet drawer via SidebarTrigger
        */}
				<AppSidebar />

				{/* Main area: header + content */}
				<SidebarInset className="flex flex-col flex-1 min-w-0">
					{/* Top bar — mobile hamburger + breadcrumb area */}
					<header className="flex h-14 items-center gap-3 border-b border-border px-4 md:px-6">
						<SidebarTrigger className="md:hidden -ml-1" />
						<div className="flex-1" />
					</header>

					{/* Main Content */}
					<main id="main-content" className="flex-1 min-h-[calc(100vh-3.5rem)]">
						{children}
					</main>
				</SidebarInset>
			</div>
		</SidebarProvider>
	);
}
