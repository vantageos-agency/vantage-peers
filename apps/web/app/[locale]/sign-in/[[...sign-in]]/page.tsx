"use client";

import { SignIn } from "@clerk/nextjs";
import { useTranslations } from "next-intl";

export default function SignInPage() {
	const t = useTranslations("sign_in_page");

	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-950 px-4">
			<div className="w-full max-w-md">
				<div className="mb-6 text-center md:mb-8">
					<h1 className="mb-2 text-2xl font-bold leading-tight text-gray-100 md:text-3xl lg:text-4xl">
						{t("title")}
					</h1>
					<p className="text-sm leading-relaxed text-gray-400 md:text-base">
						{t("subtitle")}
					</p>
				</div>

				<SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
			</div>
		</div>
	);
}
