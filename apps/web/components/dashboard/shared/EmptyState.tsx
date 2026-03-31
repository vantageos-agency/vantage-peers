"use client";

import {
	Bell,
	FileText,
	Film,
	FolderOpen,
	ImageIcon,
	Inbox,
	Music,
	Package,
	Settings,
	Share2,
	Users,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useDevice } from "@/contexts/DeviceContext";

interface EmptyStateProps {
	icon?: string;
	title: string;
	description: string;
	actionLabel?: string;
	actionHref?: string;
	onAction?: () => void;
}

const iconMap = {
	film: Film,
	image: ImageIcon,
	music: Music,
	file: FileText,
	users: Users,
	folder: FolderOpen,
	package: Package,
	bell: Bell,
	settings: Settings,
	inbox: Inbox,
	share: Share2,
};

export function EmptyState({
	icon = "inbox",
	title,
	description,
	actionLabel,
	actionHref,
	onAction,
}: EmptyStateProps) {
	const { isMobile } = useDevice();
	const Icon = iconMap[icon as keyof typeof iconMap] || Inbox;

	return (
		<Card className="bg-card border-border">
			<div className="flex flex-col items-center justify-center py-12 md:py-16 px-4 md:px-6 text-center">
				<div className="mb-4 md:mb-6">
					<Icon className="h-12 w-12 md:h-16 md:w-16 text-muted-foreground" />
				</div>

				<h3 className="text-lg md:text-xl font-semibold text-foreground mb-2">
					{title}
				</h3>

				<p className="text-sm md:text-base text-muted-foreground leading-relaxed mb-6 md:mb-8 max-w-md">
					{description}
				</p>

				{actionLabel &&
					(actionHref || onAction) &&
					(actionHref ? (
						<Link href={actionHref}>
							<Button
								variant="default"
								className={`min-h-[44px] min-w-[44px] ${isMobile ? "active:scale-98" : "hover:scale-105"} transition-transform`}
							>
								{actionLabel}
							</Button>
						</Link>
					) : (
						<Button
							variant="default"
							onClick={onAction}
							className={`min-h-[44px] min-w-[44px] ${isMobile ? "active:scale-98" : "hover:scale-105"} transition-transform`}
						>
							{actionLabel}
						</Button>
					))}
			</div>
		</Card>
	);
}
