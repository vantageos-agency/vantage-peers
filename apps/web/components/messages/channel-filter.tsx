"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

export type ChannelFilter =
	| "all"
	| "broadcast"
	| "pi"
	| "tau"
	| "phi"
	| "sigma";

const CHANNELS: ChannelFilter[] = [
	"all",
	"broadcast",
	"pi",
	"tau",
	"phi",
	"sigma",
];

interface ChannelFilterProps {
	value: ChannelFilter;
	onChange: (value: ChannelFilter) => void;
}

export function ChannelFilterBar({ value, onChange }: ChannelFilterProps) {
	const t = useTranslations("messages_page");

	return (
		<fieldset
			className="flex items-center gap-1.5 flex-wrap border-0 p-0 m-0"
			aria-label={t("filter_label")}
		>
			{CHANNELS.map((channel) => (
				<button
					key={channel}
					type="button"
					onClick={() => onChange(channel)}
					className={cn(
						"inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						value === channel
							? "bg-[oklch(0.65_0.15_232)] text-white"
							: "bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80",
					)}
					aria-pressed={value === channel}
				>
					{channel === "all" ? t("filter_all") : channel}
				</button>
			))}
		</fieldset>
	);
}
