"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useState,
} from "react";

interface DashboardBreadcrumbContextValue {
	/** Template name for breadcrumb when on /dashboard/templates/[id] (set by TemplateDetail to avoid duplicate query) */
	templateName: string | null;
	setTemplateName: (name: string | null) => void;
}

const DashboardBreadcrumbContext =
	createContext<DashboardBreadcrumbContextValue | null>(null);

export function DashboardBreadcrumbProvider({
	children,
}: {
	children: ReactNode;
}) {
	const [templateName, setTemplateName] = useState<string | null>(null);
	const setTemplateNameStable = useCallback((name: string | null) => {
		setTemplateName(name);
	}, []);
	return (
		<DashboardBreadcrumbContext.Provider
			value={{ templateName, setTemplateName: setTemplateNameStable }}
		>
			{children}
		</DashboardBreadcrumbContext.Provider>
	);
}

export function useDashboardBreadcrumb() {
	const ctx = useContext(DashboardBreadcrumbContext);
	return ctx;
}
