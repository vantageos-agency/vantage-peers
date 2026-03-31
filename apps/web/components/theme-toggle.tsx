"use client";

import { useTheme } from "next-themes";

export function ThemeToggle() {
	const { theme, setTheme } = useTheme();

	const isDark = theme === "dark";

	return (
		<button
			type="button"
			onClick={() => setTheme(isDark ? "light" : "dark")}
			title={isDark ? "Dark mode" : "Light mode"}
			aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
			className="relative p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 transition-all duration-200 focus-ring overflow-hidden"
		>
			{/* Sun icon */}
			<svg
				className={`absolute inset-0 m-auto h-5 w-5 transition-all duration-300 ${
					isDark
						? "rotate-0 scale-100 opacity-100"
						: "rotate-90 scale-0 opacity-0"
				}`}
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				strokeWidth={2}
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
				/>
			</svg>
			{/* Moon icon */}
			<svg
				className={`h-5 w-5 transition-all duration-300 ${
					isDark
						? "-rotate-90 scale-0 opacity-0"
						: "rotate-0 scale-100 opacity-100"
				}`}
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				strokeWidth={2}
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
				/>
			</svg>
		</button>
	);
}
