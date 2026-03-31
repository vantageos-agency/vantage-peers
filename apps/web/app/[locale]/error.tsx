"use client";

import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";

export default function LocaleError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error(error);
	}, [error]);

	return (
		<div className="min-h-screen flex items-center justify-center bg-background px-4">
			<Card className="w-full max-w-md border-[oklch(0.75_0.15_75/0.4)] shadow-lg">
				<CardHeader className="flex flex-col items-center gap-3 pb-2 pt-8">
					<div className="flex h-14 w-14 items-center justify-center rounded-full bg-[oklch(0.75_0.15_75/0.12)]">
						<AlertCircle
							className="h-7 w-7 text-[oklch(0.72_0.16_75)]"
							aria-hidden="true"
						/>
					</div>
					<h1 className="text-xl font-semibold text-foreground text-center">
						Something went wrong
					</h1>
				</CardHeader>

				<CardContent className="text-center pb-2">
					<p className="text-sm text-muted-foreground leading-relaxed">
						{error.message || "An unexpected error occurred. Please try again."}
					</p>
					{error.digest && (
						<p className="mt-2 text-xs text-muted-foreground/60 font-mono">
							{error.digest}
						</p>
					)}
				</CardContent>

				<CardFooter className="flex flex-col gap-2 pb-8">
					<Button
						onClick={reset}
						className="w-full bg-[oklch(0.72_0.16_75)] hover:bg-[oklch(0.65_0.16_75)] text-white"
					>
						Try again
					</Button>
					<Button variant="ghost" className="w-full" asChild>
						<Link href="/dashboard">Go to dashboard</Link>
					</Button>
				</CardFooter>
			</Card>
		</div>
	);
}
