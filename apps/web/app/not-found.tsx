import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";

export default function NotFound() {
	return (
		<html lang="en">
			<body className="min-h-screen flex items-center justify-center bg-[oklch(0.13_0.02_240)] px-4">
				<Card className="w-full max-w-md border-[oklch(0.75_0.15_75/0.4)] shadow-lg bg-[oklch(0.18_0.02_240)]">
					<CardHeader className="flex flex-col items-center gap-3 pb-2 pt-8">
						<div className="flex h-14 w-14 items-center justify-center rounded-full bg-[oklch(0.75_0.15_75/0.12)]">
							<AlertCircle
								className="h-7 w-7 text-[oklch(0.72_0.16_75)]"
								aria-hidden="true"
							/>
						</div>
						<p className="text-6xl font-bold text-[oklch(0.72_0.16_75)]">404</p>
						<h1 className="text-xl font-semibold text-white text-center">
							Page not found
						</h1>
					</CardHeader>

					<CardContent className="text-center pb-2">
						<p className="text-sm text-[oklch(0.65_0.03_240)] leading-relaxed">
							The page you are looking for does not exist or has been moved.
						</p>
					</CardContent>

					<CardFooter className="pb-8">
						<Button
							className="w-full bg-[oklch(0.72_0.16_75)] hover:bg-[oklch(0.65_0.16_75)] text-white"
							asChild
						>
							<Link href="/">Go home</Link>
						</Button>
					</CardFooter>
				</Card>
			</body>
		</html>
	);
}
