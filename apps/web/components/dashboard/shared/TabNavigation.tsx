"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Tab {
	value: string;
	label: string;
	count?: number;
}

interface TabNavigationProps {
	tabs: Tab[];
	activeTab: string;
	onTabChange: (value: string) => void;
}

export function TabNavigation({
	tabs,
	activeTab,
	onTabChange,
}: TabNavigationProps) {
	return (
		<Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
			<TabsList
				className="
          w-full bg-card border-border
          flex overflow-x-auto scrollbar-hide
          md:grid md:overflow-x-visible
        "
				style={{
					gridTemplateColumns:
						tabs.length > 0 ? `repeat(${tabs.length}, 1fr)` : undefined,
				}}
			>
				{tabs.map((tab) => (
					<TabsTrigger
						key={tab.value}
						value={tab.value}
						className="
              text-white 
              data-[state=active]:bg-primary
              data-[state=active]:text-white
              min-h-[44px] min-w-[44px]
              px-4 md:px-6
              text-sm md:text-base
              whitespace-nowrap flex-shrink-0
              md:flex-shrink md:whitespace-normal
            "
					>
						<span className="hidden sm:inline">{tab.label}</span>
						<span className="sm:hidden">{tab.label.split(" ")[0]}</span>
						{tab.count !== undefined && (
							<span className="ml-2 text-xs opacity-70">({tab.count})</span>
						)}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}
