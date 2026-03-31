// hooks/useDateFormatter.ts
import { useFormatter, useLocale } from "next-intl";

export function useDateFormatter() {
	const format = useFormatter();
	const locale = useLocale();

	return {
		// Short date: "Dec 16, 2025"
		formatShort: (date: Date | number) => {
			const d = typeof date === "number" ? new Date(date) : date;
			return format.dateTime(d, {
				month: "short",
				day: "numeric",
				year: "numeric",
			});
		},

		// Long date: "December 16, 2025"
		formatLong: (date: Date | number) => {
			const d = typeof date === "number" ? new Date(date) : date;
			return format.dateTime(d, {
				month: "long",
				day: "numeric",
				year: "numeric",
			});
		},

		// Relative: "2 days ago", "in 3 hours"
		formatRelative: (date: Date | number) => {
			const d = typeof date === "number" ? new Date(date) : date;
			return format.relativeTime(d);
		},

		// Time: "3:45 PM"
		formatTime: (date: Date | number) => {
			const d = typeof date === "number" ? new Date(date) : date;
			return format.dateTime(d, {
				hour: "numeric",
				minute: "2-digit",
			});
		},

		locale,
	};
}
