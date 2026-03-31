"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useDevice } from "@/contexts/DeviceContext";

interface ErrorStateProps {
	title?: string;
	description?: string;
	actionLabel?: string;
	onAction?: () => void;
}

export function ErrorState({
	title,
	description,
	actionLabel,
	onAction,
}: ErrorStateProps) {
	const t = useTranslations("errors");
	const { isMobile } = useDevice();

	const translatedTitle = title ?? t("something_went_wrong");
	const translatedDescription = description ?? t("loading_error_description");
	const translatedActionLabel = actionLabel ?? t("try_again_button");

	return (
		<Card className="bg-card border-border">
			<div className="flex flex-col items-center justify-center py-12 md:py-16 px-4 md:px-6 text-center">
				<div className="mb-4 md:mb-6">
					<AlertCircle className="h-12 w-12 md:h-16 md:w-16 text-destructive" />
				</div>

				<h3 className="text-lg md:text-xl font-semibold text-white mb-2">
					{translatedTitle}
				</h3>

				<p className="text-sm md:text-base text-muted-foreground mb-6 md:mb-8 max-w-md">
					{translatedDescription}
				</p>

				{onAction && (
					<Button
						onClick={onAction}
						variant="outline"
						className={`
              min-h-[44px] min-w-[44px]
              ${isMobile ? "active:scale-98" : "hover:scale-105"}
              transition-transform
              border-destructive/30 text-destructive hover:bg-destructive/10
            `}
					>
						<RefreshCw className="h-4 w-4 mr-2" />
						{translatedActionLabel}
					</Button>
				)}
			</div>
		</Card>
	);
}
