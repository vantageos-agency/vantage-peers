# VantagePeers UI refonte-mosaic Day-114 — T0 PREFLIGHT inventory

Mission: k5746m50s9pf7fh758kpa2bma989f507
Task: k172g1zes2tf6x5c2jqsnhvmr189fmcq
Generated: 2026-06-27
Scope: 4 consumer-facing repos.

---

## Cross-repo totals

| Repo | UI components | MDX blocks | Shell/layout | Auth-gated | Multi-tenant aware |
| --- | --- | --- | --- | --- | --- |
| vantage-peers (npm pkg + Convex) | 0 | 0 | 0 | 0 | 0 |
| vantage-peers-dashboard | 106 | 0 | 11 | 9 | 5 |
| vantage-peers-site | 39 | 0 | 3 | 0 | 0 |
| vantage-peers-example | 0 | 0 | 0 | 0 | 0 |
| **TOTAL** | **145** | **0** | **14** | **9** | **5** |

Notes on totals:
- "MDX blocks" counts custom React components defined _in this repo_ and used inside `.mdx` files. The site's docs content exclusively uses Fumadocs built-in components (`Callout`, `Tabs`, `Tab`, `Steps`, `Step`, `Card`, `Cards`, `Accordion`, `Accordions`, `TypeTable`) — none are locally authored React components; count is 0.
- MDX _content files_ in site: 153 total (80 EN + 73 FR duplicates). These are content, not React component files.
- Auth-gated = file imports or consumes `useUser`, `useOrganization`, `useClerk`, `SignIn`, `OrganizationSwitcher`, or `useActiveOrg` from Clerk.
- Multi-tenant aware = file reads `orgId`, `namespacePrefix`, or `orgSlug` from `useActiveOrg` context.

---

## vantage-peers-dashboard

### Shell + layout (high-priority Mosaic targets)

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/layout.tsx` | `RootLayout` | .tsx | Root Next.js layout: font injection, ClerkProvider via `ClientProviders`, sets `lang` attribute | layout, auth-wiring | — |
| `app/[locale]/layout.tsx` | `LocaleLayout` (implicit — re-exports `ClientProviders`) | .tsx | Locale-aware root layout: next-intl, `ConvexClientProvider`, `ActiveOrgProvider`, Toaster | layout, i18n | — |
| `app/[locale]/dashboard/layout.tsx` | `DashboardLayout` | .tsx | Dashboard shell: `SidebarProvider` + `AppSidebar` + `SidebarInset` + `MosaicDashboardNavbar` + top-bar with `SidebarTrigger` + `MosaicColorThemeSwitcher`; wraps all dashboard routes | layout, shell | MosaicNavbar (via `MosaicDashboardNavbar`) |
| `components/app-sidebar.tsx` | `AppSidebar` | .tsx | Left-nav sidebar: grouped nav links (CORE + MEMORY & COMMS), unread badge from Convex query, mobile Sheet mode via `useSidebar`. Mounts `OrgSwitcher` and `SidebarUserNav`. | shell, navigation, multi-tenant-aware | — |
| `components/org-switcher.tsx` | `OrgSwitcher` | .tsx | Wraps Clerk `<OrganizationSwitcher />` in sidebar header; exposes `data-org-id`; multi-tenant org selection | shell, auth-gated, multi-tenant-aware | — |
| `components/sidebar-user-nav.tsx` | `SidebarUserNav` | .tsx | Bottom sidebar user profile: avatar + name from Clerk `useUser`, theme toggle, sign-out | shell, auth-gated, navigation | — |
| `components/mosaic/MosaicDashboardNavbar.tsx` | `MosaicDashboardNavbar` | .tsx | Wires `@vantageos/mosaic-blocks` `MosaicNavbar` (scroll-aware) for dashboard; hardcoded VP Cloud nav links | shell, navigation | **MosaicNavbar** (already adopted) |
| `components/mosaic/MosaicColorThemeSwitcher.tsx` | `MosaicColorThemeSwitcher` | .tsx | Bridges `@vantageos/mosaic-blocks` `MosaicThemeToggle` with `next-themes`; syncs `data-theme` attribute and class | shell, presentational | **MosaicThemeToggle** (already adopted) |
| `components/dashboard/shell.tsx` | `DashboardCardGrid` | .tsx | Responsive CSS grid wrapper for dashboard home widgets | layout, presentational | MosaicGrid |
| `components/dashboard/shell.tsx` | `DashboardSkeleton` | .tsx | Skeleton loading state for dashboard card grid | presentational | MosaicSkeleton |
| `components/dashboard/shell.tsx` | `DashboardEmptyState` | .tsx | Generic empty-state card for dashboard home | presentational | MosaicEmptyState |

### Auth + multi-tenant

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/sign-in/[[...sign-in]]/page.tsx` | `SignInPage` | .tsx | Renders Clerk `<SignIn />` component inside a centered layout | auth-gated, marketing | — |
| `app/[locale]/sign-in/[[...sign-in]]/layout.tsx` | `SignInLayout` | .tsx | Thin layout shell for sign-in route; carries metadata | layout, auth-gated | — |
| `app/[locale]/sign-up/[[...sign-up]]/page.tsx` | `SignUpPage` | .tsx | Renders Clerk `<SignUp />` component inside a centered layout | auth-gated, marketing | — |
| `app/[locale]/sign-up/[[...sign-up]]/layout.tsx` | `SignUpLayout` | .tsx | Thin layout shell for sign-up route; carries metadata | layout, auth-gated | — |
| `app/[locale]/auth/extension-callback/page.tsx` | `ExtensionCallbackPage` | .tsx | Handles browser-extension OAuth callback; polls Clerk session token; multi-step status display | auth-gated, multi-tenant-aware | — |
| `app/[locale]/auth/extension-callback/layout.tsx` | `ExtensionCallbackLayout` | .tsx | Minimal layout for extension callback route | layout, auth-gated | — |
| `app/ClientProviders.tsx` | `ClientProviders` | .tsx | Root client providers: `ClerkProvider` (dark theme), `ConvexClientProvider`, `ActiveOrgProvider`, `Toaster` | auth-wiring, multi-tenant-aware | — |
| `contexts/active-org.tsx` | `ActiveOrgProvider` | .tsx | Context provider: exposes `orgId`, `orgRole`, `orgSlug`, `namespacePrefix()` from Clerk `useOrganization`; all dashboard Convex calls scope via this | multi-tenant-aware, auth-gated | — |
| `providers/ConvexClientProvider.tsx` | `ConvexClientProvider` | .tsx | Wraps `ConvexProviderWithClerk`; wires Convex real-time client to Clerk auth | auth-wiring | — |

### Widgets / dashboard home

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/dashboard/page.tsx` | `DashboardPage` | .tsx | Dashboard home; mounts `CriticalBlockersWidget`, stats charts, `TaskBoard`, Convex live queries | dashboard widget | — |
| `components/dashboard/critical-blockers-widget.tsx` | `CriticalBlockersWidget` | .tsx | Fetches and displays blocked tasks via Convex; uses Card + Badge + Skeleton | dashboard widget, list | MosaicCard |
| `components/ui/dashboard-subheader.tsx` | `DashboardSubheader` | .tsx | Reusable page subheader: title + optional action slot | presentational, layout | MosaicPageHeader |

### Tasks

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/dashboard/tasks/page.tsx` | `TasksPage` | .tsx | Tasks route page; mounts `TaskBoard` | presentational | — |
| `components/tasks/task-board.tsx` | `TaskBoard` | .tsx | Kanban board: columns per status, drag/drop implied, `initialStatusFocus` prop | dashboard widget, list, board | MosaicKanbanBoard |
| `components/tasks/task-column.tsx` | `TaskColumn` | .tsx | Single kanban column: status label + task card list | list | MosaicKanbanColumn |
| `components/tasks/task-card.tsx` | `TaskCard` | .tsx | Task kanban card: title, priority badge, assignee, status | list, presentational | MosaicKanbanCard |
| `components/tasks/task-detail-sheet.tsx` | `TaskDetailSheet` | .tsx | Slide-over sheet for full task detail; uses `<Sheet>` primitive | dialog/modal | MosaicDetailSheet |
| `components/tasks/task-filters.tsx` | `TaskFilters` | .tsx | Filter bar: status + priority + assignee selects | form, list | MosaicFilterBar |
| `components/tasks/tasks-empty-state.tsx` | `TasksEmptyState` | .tsx | Empty state illustration + CTA for tasks view | presentational | MosaicEmptyState |

### Missions

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/dashboard/missions/page.tsx` | `MissionsPage` | .tsx | Missions route page | presentational | — |
| `components/missions/mission-board.tsx` | `MissionBoard` | .tsx | Mission list/board view with Convex live data | dashboard widget, list | MosaicBoard |
| `components/missions/mission-card.tsx` | `MissionCard` | .tsx | Mission card: name, status badge, pilot, priority | list, presentational | MosaicCard |
| `components/missions/mission-filters.tsx` | `MissionFilters` | .tsx | Filter bar: status + priority + pilot | form, list | MosaicFilterBar |
| `components/missions/mission-status-pipeline.tsx` | `MissionStatusPipeline` | .tsx | Horizontal pipeline visualization of mission status stages | dashboard widget, presentational | MosaicStatusPipeline |
| `components/missions/missions-empty-state.tsx` | `MissionsEmptyState` | .tsx | Empty state for missions view | presentational | MosaicEmptyState |

### Activity

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/dashboard/activity/page.tsx` | `ActivityPage` | .tsx | Activity feed route page | presentational | — |
| `components/activity/activity-feed.tsx` | `ActivityFeed` | .tsx | Scrollable live activity feed from Convex | list, dashboard widget | MosaicFeed |
| `components/activity/unified-activity-feed.tsx` | `UnifiedActivityFeed` | .tsx | Unified feed merging multiple event types; virtualized | list, dashboard widget | MosaicFeed |
| `components/activity/activity-row.tsx` | `ActivityRow` | .tsx | Single activity event row: icon + description + timestamp | list, presentational | MosaicListItem |
| `components/activity/activity-type-badge.tsx` | `ActivityTypeBadge` | .tsx | Color-coded badge for activity type (task, memory, message, etc.) | presentational | MosaicBadge |
| `components/activity/activity-type-filter.tsx` | `ActivityTypeFilter` | .tsx | Toggle-group filter by activity type | form, list | MosaicFilterBar |

### Messages

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/dashboard/messages/page.tsx` | `MessagesPage` | .tsx | Messages live feed route page | presentational | — |
| `app/[locale]/dashboard/messages/history/page.tsx` | `MessagesHistoryPage` | .tsx | Message history with filters route | presentational | — |
| `components/messages/message-timeline.tsx` | `MessageTimeline` | .tsx | Chronological messages timeline with Convex live data | list, dashboard widget | MosaicTimeline |
| `components/messages/message-history-view.tsx` | `MessageHistoryView` | .tsx | Composite view: `HistoryFiltersBar` + `MessageHistoryTable` | list | — |
| `components/messages/message-history-table.tsx` | `MessageHistoryTable` | .tsx | Paginated table of historical messages; column headers + rows | table | MosaicTable |
| `components/messages/message-row.tsx` | `MessageRow` | .tsx | Table row for a single message: sender, channel, content excerpt, unread dot, mark-read action | table, list | MosaicListItem |
| `components/messages/history-filters.tsx` | `HistoryFiltersBar` | .tsx | Filter bar for message history: from/to/channel/date | form | MosaicFilterBar |
| `components/messages/channel-filter.tsx` | `ChannelFilterBar` | .tsx | Chip-style channel selector for live message feed | form, list | MosaicChipGroup |
| `components/messages/messages-empty-state.tsx` | `MessagesEmptyState` | .tsx | Empty state for messages view | presentational | MosaicEmptyState |

### Memory

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/dashboard/memory/page.tsx` | `MemoryPage` | .tsx | Memory list route page | presentational | — |
| `components/memory/memory-list.tsx` | `MemoryList` | .tsx | Grid/list of memory cards with Convex live data + pagination | list, dashboard widget | MosaicList |
| `components/memory/memory-card.tsx` | `MemoryCard` | .tsx | Memory entry card: namespace chip, content excerpt, date | list, presentational | MosaicCard |
| `components/memory/memory-detail-sheet.tsx` | `MemoryDetailSheet` | .tsx | Slide-over sheet for full memory entry | dialog/modal | MosaicDetailSheet |
| `components/memory/memory-filters.tsx` | `MemoryFilters` | .tsx | Filter bar: namespace + type + search | form | MosaicFilterBar |
| `components/memory/memory-empty-state.tsx` | `MemoryEmptyState` | .tsx | Empty state for memory view | presentational | MosaicEmptyState |
| `components/memory/episode-detail.tsx` | `EpisodeDetail` | .tsx | Detail view for a memory episode inside the sheet | presentational | — |

### Diary

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/dashboard/diary/page.tsx` | `DiaryPage` | .tsx | Diary feed route page | presentational | — |
| `components/diary/diary-feed.tsx` | `DiaryFeed` | .tsx | Scrollable diary entries grouped by date from Convex | list, dashboard widget | MosaicFeed |
| `components/diary/diary-date-group.tsx` | `DiaryDateGroup` | .tsx | Date-grouped section header + entries | list | MosaicGroupHeader |
| `components/diary/diary-entry-card.tsx` | `DiaryEntryCard` | .tsx | Single diary entry card: timestamp + content preview | list, presentational | MosaicCard |
| `components/diary/diary-full-entry-sheet.tsx` | `DiaryFullEntrySheet` | .tsx | Slide-over sheet for full diary entry text | dialog/modal | MosaicDetailSheet |
| `components/diary/diary-empty-state.tsx` | `DiaryEmptyState` | .tsx | Empty state for diary view | presentational | MosaicEmptyState |

### Mandates

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/dashboard/mandates/page.tsx` | `MandatesPage` | .tsx | Mandates kanban route page | presentational | — |
| `components/mandates/mandate-board.tsx` | `MandateBoard` | .tsx | Mandate kanban board with Convex live data | dashboard widget, board | MosaicKanbanBoard |
| `components/mandates/mandate-column.tsx` | `MandateColumn` | .tsx | Single mandate column by status | list | MosaicKanbanColumn |
| `components/mandates/mandate-card.tsx` | `MandateCard` | .tsx | Mandate card: title, status, assignee, priority | list, presentational | MosaicKanbanCard |
| `components/mandates/mandate-detail-sheet.tsx` | `MandateDetailSheet` | .tsx | Slide-over sheet for full mandate detail | dialog/modal | MosaicDetailSheet |
| `components/mandates/mandates-empty-state.tsx` | `MandatesEmptyState` | .tsx | Empty state for mandates view | presentational | MosaicEmptyState |

### Briefings

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/dashboard/briefings/page.tsx` | `BriefingsPage` | .tsx | Briefings list+detail split-pane route page | presentational | — |
| `app/[locale]/dashboard/briefings/new/page.tsx` | `NewBriefingPage` | .tsx | New briefing form route page | form | — |
| `components/briefings/briefing-list.tsx` | `BriefingList` | .tsx | Scrollable list of briefing notes; selection state | list | MosaicList |
| `components/briefings/briefing-detail.tsx` | `BriefingDetail` | .tsx | Right-pane detail for selected briefing note | presentational | — |
| `components/briefings/briefing-form.tsx` | `BriefingForm` | .tsx | Create briefing form: title + markdown content textarea + submit | form | MosaicForm |

### Stats / Charts

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/dashboard/stats/page.tsx` | `StatsPage` | .tsx | Stats route page; mounts all chart components | dashboard widget | — |
| `components/stats/throughput-chart.tsx` | `ThroughputChart` | .tsx | Recharts bar chart: task throughput over time window; Convex data | dashboard widget | MosaicChart |
| `components/stats/throughput-chart-inner.tsx` | `ThroughputChartInner` | .tsx | Pure chart sub-component receiving data props | presentational | MosaicChart |
| `components/stats/completion-rate-donut.tsx` | `CompletionRateDonut` | .tsx | Recharts donut chart: task completion rate | dashboard widget | MosaicChart |
| `components/stats/completion-rate-donut-inner.tsx` | `CompletionRateDonutInner` | .tsx | Pure donut sub-component | presentational | MosaicChart |
| `components/stats/queue-size-chart.tsx` | `QueueSizeChart` | .tsx | Recharts line chart: task queue size trend | dashboard widget | MosaicChart |
| `components/stats/queue-size-chart-inner.tsx` | `QueueSizeChartInner` | .tsx | Pure line chart sub-component | presentational | MosaicChart |
| `components/stats/blocker-count-chart.tsx` | `BlockerCountChart` | .tsx | Recharts bar chart: blocker count over time | dashboard widget | MosaicChart |
| `components/stats/blocker-count-chart-inner.tsx` | `BlockerCountChartInner` | .tsx | Pure blocker chart sub-component | presentational | MosaicChart |
| `components/stats/stale-in-progress-table.tsx` | `StaleInProgressTable` | .tsx | Table of stale in-progress tasks: title + age + assignee | table | MosaicTable |
| `components/stats/stats-time-window.tsx` | `StatsTimeWindow` | .tsx | Time window selector (7d / 30d / 90d toggle) for stats | form | MosaicSegmentedControl |

### Orchestrators + Projects

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/dashboard/orchestrators/page.tsx` | `OrchestratorsPage` | .tsx | Orchestrators grid route page | presentational | — |
| `components/orchestrators/orchestrators-grid.tsx` | `OrchestratorsGrid` | .tsx | Grid of orchestrator profile cards from Convex | list, dashboard widget | MosaicGrid |
| `components/orchestrators/orchestrator-card.tsx` | `OrchestratorCard` | .tsx | Card: avatar + name + status + last-seen | list, presentational | MosaicCard |
| `components/orchestrators/orchestrator-detail.tsx` | `OrchestratorDetail` | .tsx | Detail panel/sheet for orchestrator profile | presentational | — |
| `components/orchestrators/orchestrators-empty-state.tsx` | `OrchestratorsEmptyState` | .tsx | Empty state for orchestrators view | presentational | MosaicEmptyState |
| `app/[locale]/dashboard/projects/page.tsx` | `ProjectsPage` | .tsx | Projects route page | presentational | — |
| `components/projects/projects-overview.tsx` | `ProjectsOverview` | .tsx | Projects summary grid from Convex | list, dashboard widget | MosaicGrid |
| `components/projects/project-card.tsx` | `ProjectCard` | .tsx | Project card: name + BU + task count | list, presentational | MosaicCard |
| `components/projects/projects-empty-state.tsx` | `ProjectsEmptyState` | .tsx | Empty state for projects view | presentational | MosaicEmptyState |

### Settings

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/[locale]/dashboard/settings/okf/page.tsx` | `OKFSettingsPage` | .tsx | OKF bundle settings route: import + export + validate panels | form | — |
| `components/settings/okf/okf-import-panel.tsx` | `OKFImportPanel` | .tsx | Panel: JSON textarea + import action for OKF bundle | form | MosaicPanel |
| `components/settings/okf/okf-export-panel.tsx` | `OKFExportPanel` | .tsx | Panel: download OKF bundle export | form | MosaicPanel |
| `components/settings/okf/okf-validate-panel.tsx` | `OKFValidatePanel` | .tsx | Panel: validate pasted OKF bundle JSON; shows validation errors | form | MosaicPanel |

### Global / Shared

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `components/search-modal.tsx` | `SearchModal` | .tsx | Global search modal: fuzzy search over tasks + missions + memory | dialog/modal | MosaicSearchModal |
| `components/theme-provider.tsx` | `ThemeProvider` | .tsx | Thin wrapper re-exporting `next-themes` ThemeProvider | layout | — |
| `components/shared/RouteAnnouncer.tsx` | `RouteAnnouncer` | .tsx | Accessibility: announces route changes to screen readers | presentational, a11y | — |
| `components/shared/SkipLink.tsx` | `SkipLink` | .tsx | Accessibility: skip-to-main-content link | presentational, a11y | — |
| `lib/monitoring/errorBoundary.tsx` | `ErrorBoundary` | .tsx | React error boundary with Sentry reporting | layout | — |
| `contexts/DashboardBreadcrumbContext.tsx` | `DashboardBreadcrumbProvider` | .tsx | Context: provides breadcrumb state for dashboard pages | layout | — |
| `app/[locale]/error.tsx` | `LocaleError` | .tsx | Next.js error boundary page for locale routes | layout | — |
| `app/[locale]/dashboard/error.tsx` | `DashboardError` | .tsx | Next.js error boundary page for dashboard routes | layout | — |
| `app/[locale]/dashboard/loading.tsx` | `DashboardLoading` | .tsx | Next.js loading skeleton for dashboard shell | presentational | MosaicSkeleton |
| `app/not-found.tsx` | `NotFound` | .tsx | 404 page | presentational | — |
| `app/[locale]/page.tsx` | `Home` | .tsx | Root locale page — redirects to dashboard for authenticated users, to sign-in for unauthenticated | presentational | — |

### Primitives (shadcn/ui wrappers)

All files under `components/ui/` are local wrappers around Radix UI / shadcn primitives. Listed for completeness — these are the primary replacement targets for Mosaic primitives.

| Path | Exports | Tags | Mosaic candidate |
| --- | --- | --- | --- |
| `components/ui/accordion.tsx` | `Accordion`, `AccordionItem`, `AccordionTrigger`, `AccordionContent` | presentational | MosaicAccordion |
| `components/ui/alert-dialog.tsx` | `AlertDialog*` family | dialog/modal | MosaicAlertDialog |
| `components/ui/avatar.tsx` | `Avatar`, `AvatarImage`, `AvatarFallback` | presentational | MosaicAvatar |
| `components/ui/badge.tsx` | `Badge` | presentational | MosaicBadge |
| `components/ui/button.tsx` | `Button` | presentational | MosaicButton |
| `components/ui/card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardContent`, `CardFooter` | presentational | MosaicCard |
| `components/ui/carousel.tsx` | `Carousel*` family | presentational | — |
| `components/ui/checkbox.tsx` | `Checkbox` | form | MosaicCheckbox |
| `components/ui/collapsible.tsx` | `Collapsible*` | presentational | — |
| `components/ui/dashboard-subheader.tsx` | `DashboardSubheader` | layout | MosaicPageHeader |
| `components/ui/dialog.tsx` | `Dialog*` family | dialog/modal | MosaicDialog |
| `components/ui/drawer.tsx` | `Drawer*` family | dialog/modal | — |
| `components/ui/dropdown-menu.tsx` | `DropdownMenu*` family | navigation | MosaicDropdownMenu |
| `components/ui/input.tsx` | `Input` | form | MosaicInput |
| `components/ui/label.tsx` | `Label` | form | MosaicLabel |
| `components/ui/progress.tsx` | `Progress` | presentational | MosaicProgress |
| `components/ui/radio-group.tsx` | `RadioGroup`, `RadioGroupItem` | form | MosaicRadioGroup |
| `components/ui/scroll-area.tsx` | `ScrollArea`, `ScrollBar` | layout | — |
| `components/ui/select.tsx` | `Select*` family | form | MosaicSelect |
| `components/ui/separator.tsx` | `Separator` | presentational | MosaicSeparator |
| `components/ui/sheet.tsx` | `Sheet*` family | dialog/modal | MosaicSheet |
| `components/ui/sidebar.tsx` | `Sidebar*` family (20+ exports) | shell, layout | MosaicSidebar |
| `components/ui/skeleton.tsx` | `Skeleton` | presentational | MosaicSkeleton |
| `components/ui/slider.tsx` | `Slider` | form | — |
| `components/ui/status-badge.tsx` | `StatusBadge` | presentational | MosaicStatusBadge |
| `components/ui/switch.tsx` | `Switch` | form | MosaicSwitch |
| `components/ui/tabs.tsx` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | presentational | MosaicTabs |
| `components/ui/textarea.tsx` | `Textarea` | form | MosaicTextarea |
| `components/ui/tooltip.tsx` | `Tooltip*` family | presentational | MosaicTooltip |

### Top 10 most-imported components (dashboard)

Grep command used:
```
grep -rEn "from ['\"]@/components/([^'\"]+)['\"]" /root/coding/vantage-peers-dashboard --include="*.tsx" \
  | grep -v "node_modules" | grep -v "\.test\." \
  | grep -oP "from ['\"]@/components/[^'\"]+['\"]" \
  | sort | uniq -c | sort -rn
```

| Rank | Component path | Import count |
| --- | --- | --- |
| 1 | `@/components/ui/skeleton` | 26 |
| 2 | `@/components/ui/button` | 16 |
| 3 | `@/components/ui/card` | 11 |
| 4 | `@/components/ui/sheet` | 6 |
| 5 | `@/components/ui/select` | 6 |
| 6 | `@/components/ui/sidebar` | 4 |
| 7 | `@/components/ui/tooltip` | 3 |
| 8 | `@/components/ui/separator` | 2 |
| 9 | `@/components/ui/input` | 2 |
| 10 | `@/components/ui/dropdown-menu` | 2 |

---

## vantage-peers-site

### Layout + app-level

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `app/layout.tsx` | `RootLayout` | .tsx | Root layout for entire site | layout | — |
| `app/[locale]/layout.tsx` | `LocaleLayout` | .tsx | Locale layout: next-intl + ThemeProvider + LandingStructuredData; serves landing + docs | layout, i18n, marketing | — |
| `app/docs/[lang]/layout.tsx` | docs layout (Fumadocs) | .tsx | Fumadocs `DocsLayout` wrapper: tree source, nav, i18n | layout, docs | — |
| `components/theme-provider.tsx` | `ThemeProvider` | .tsx | `next-themes` ThemeProvider wrapper for dark/light | layout | — |
| `app/voice/page.tsx` | `VoicePage` | .tsx | Browser speech-to-text client; polls VP API for orchestrator response; plays TTS audio | dashboard widget, interactive | — |

### Landing page components

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `components/landing/landing-page.tsx` | `LandingPage` | .tsx | Root landing page compositor; mounts all section components in order | marketing | MosaicPage |
| `components/landing/peers-header.tsx` | `PeersHeader` | .tsx | Top navigation bar: logo + links + locale toggle + CTA button | navigation, marketing | MosaicNavbar |
| `components/landing/peers-hero.tsx` | `PeersHero` | .tsx | Hero section: headline + subhead + CTA buttons + lottie/motion | marketing | MosaicHero |
| `components/landing/peers-problem.tsx` | `PeersProblem` | .tsx | Problem statement section with icon + copy | marketing | MosaicSection |
| `components/landing/peers-features.tsx` | `PeersFeatures` | .tsx | Features grid: icon tiles describing MCP capabilities | marketing | MosaicFeatureGrid |
| `components/landing/peers-how-it-works.tsx` | `PeersHowItWorks` | .tsx | Numbered steps: how agents interact via VantagePeers | marketing | MosaicSteps |
| `components/landing/peers-code.tsx` | `PeersCode` | .tsx | Animated code block section showing MCP tool usage | marketing | MosaicCodeBlock |
| `components/landing/peers-comparison.tsx` | `PeersComparison` | .tsx | Comparison table: VantagePeers vs alternatives | marketing | MosaicComparisonTable |
| `components/landing/peers-pricing.tsx` | `PeersPricing` | .tsx | Pricing cards: Cloud vs Self-host tiers | marketing | MosaicPricingCard |
| `components/landing/peers-cta.tsx` | `PeersCta` | .tsx | Bottom CTA banner section | marketing | MosaicCTA |
| `components/landing/peers-faq.tsx` | `PeersFaq` | .tsx | FAQ accordion section | marketing | MosaicFAQ |
| `components/landing/peers-footer.tsx` | `PeersFooter` | .tsx | Footer: links + locale toggle + copyright | marketing, navigation | MosaicFooter |
| `components/landing/structured-data.tsx` | `LandingStructuredData` | .tsx | JSON-LD structured data injection (non-visual) | marketing | — |

### Team landing page components

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `components/team-landing/team-landing-page.tsx` | `TeamLandingPage` | .tsx | Team/agency landing page compositor | marketing | MosaicPage |
| `components/team-landing/team-header.tsx` | `TeamHeader` | .tsx | Team landing navigation bar | navigation, marketing | MosaicNavbar |
| `components/team-landing/team-hero.tsx` | `TeamHero` | .tsx | Hero for team landing: headline + CTA | marketing | MosaicHero |
| `components/team-landing/team-problem.tsx` | `TeamProblem` | .tsx | Problem section for team/agency audience | marketing | MosaicSection |
| `components/team-landing/team-solution.tsx` | `TeamSolution` | .tsx | Solution overview section | marketing | MosaicSection |
| `components/team-landing/team-how-it-works.tsx` | `TeamHowItWorks` | .tsx | Numbered steps for team onboarding | marketing | MosaicSteps |
| `components/team-landing/team-grid.tsx` | `TeamGrid` | .tsx | Grid of agent/orchestrator role cards | marketing | MosaicGrid |
| `components/team-landing/agent-ticker.tsx` | `AgentTicker` | .tsx | Animated horizontal ticker of agent names | marketing | — |
| `components/team-landing/team-comparison.tsx` | `TeamComparison` | .tsx | Comparison table for team context | marketing | MosaicComparisonTable |
| `components/team-landing/team-pricing.tsx` | `TeamPricing` | .tsx | Pricing section for team plans | marketing | MosaicPricingCard |
| `components/team-landing/team-target-audience.tsx` | `TeamTargetAudience` | .tsx | Target audience section | marketing | MosaicSection |
| `components/team-landing/team-use-cases.tsx` | `TeamUseCases` | .tsx | Use case grid/list | marketing | MosaicSection |
| `components/team-landing/team-cta.tsx` | `TeamCta` | .tsx | Bottom CTA banner | marketing | MosaicCTA |
| `components/team-landing/team-faq.tsx` | `TeamFaq` | .tsx | FAQ accordion | marketing | MosaicFAQ |
| `components/team-landing/team-footer.tsx` | `TeamFooter` | .tsx | Footer for team landing | navigation, marketing | MosaicFooter |
| `components/team-landing/team-founder.tsx` | `TeamFounder` | .tsx | Founder / team bio section | marketing | — |
| `components/team-landing/team-email-privacy.tsx` | `TeamEmailPrivacy` | .tsx | Email privacy notice inline section | marketing | — |
| `components/team-landing/team-structured-data.tsx` | `TeamStructuredData` | .tsx | JSON-LD structured data for team landing (non-visual) | marketing | — |

### Railway / integrations page

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `components/railway/railway-page.tsx` | `RailwayPage` | .tsx | Railway deploy landing page with setup instructions | marketing | MosaicPage |
| `components/railway/railway-structured-data.tsx` | `RailwayStructuredData` | .tsx | JSON-LD for Railway page (non-visual) | marketing | — |

### Docs AI actions

| Path | Component | Kind | Responsibility | Tags | Mosaic candidate |
| --- | --- | --- | --- | --- | --- |
| `components/ai/page-actions.tsx` | `MarkdownCopyButton` | .tsx | Copy-page-as-markdown button for docs pages | docs MDX block | — |
| `components/ai/page-actions.tsx` | `ViewOptionsPopover` | .tsx | Popover with LLM view options (full text, API, etc.) for docs pages | docs MDX block | — |

### Site UI primitives (shadcn/ui wrappers)

| Path | Exports | Tags | Mosaic candidate |
| --- | --- | --- | --- |
| `components/ui/accordion.tsx` | `Accordion`, `AccordionItem`, `AccordionTrigger`, `AccordionContent` | presentational | MosaicAccordion |
| `components/ui/badge.tsx` | `Badge` | presentational | MosaicBadge |
| `components/ui/button.tsx` | `Button` | presentational | MosaicButton |
| `components/ui/card.tsx` | `Card`, `CardHeader`, `CardContent`, `CardFooter` | presentational | MosaicCard |
| `components/ui/collapsible.tsx` | `Collapsible*` | presentational | — |
| `components/ui/popover.tsx` | `Popover`, `PopoverTrigger`, `PopoverContent`, `PopoverClose` | presentational | MosaicPopover |
| `components/ui/separator.tsx` | `Separator` | presentational | MosaicSeparator |
| `components/ui/tabs.tsx` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | presentational | MosaicTabs |

### MDX content blocks used in site docs (fumadocs-ui components)

These are Fumadocs built-in components imported inline in `.mdx` content files. They are not locally authored but are the MDX block surface area for any future custom Mosaic MDX overrides.

| Component | Source package | Usage count (EN+FR files) | Mosaic candidate |
| --- | --- | --- | --- |
| `Callout` | `fumadocs-ui/components/callout` | 61 | MosaicCallout |
| `Steps` / `Step` | `fumadocs-ui/components/steps` | 20 | MosaicSteps |
| `Card` / `Cards` | `fumadocs-ui/components/card` | 12 | MosaicCard |
| `Tabs` / `Tab` | `fumadocs-ui/components/tabs` | 14 | MosaicTabs |
| `Accordion` / `Accordions` | `fumadocs-ui/components/accordion` | 6 | MosaicAccordion |
| `TypeTable` | `fumadocs-ui/components/type-table` | 3 | — |
| `DocsPage` / `DocsBody` / `DocsTitle` / `DocsDescription` | `fumadocs-ui/page` | (layout-level, docs page.tsx) | — |

Note: `vantage-peers-mcp/ui-resources/stream-marker` and `vantage-peers-mcp/ui-resources/schemas` are also imported in MDX code examples — these are TypeScript schema utilities from the npm package, not React UI components.

---

## vantage-peers-example

No React/Preact/MDX UI components. The repo is a CLI configuration example demonstrating two Claude Code agents (`agent-a/`, `agent-b/`) sharing a Convex VantagePeers backend. It contains only `CLAUDE.md` settings files, shell scripts (`setup.sh`, `test.sh`), and a `README.md`. No `.tsx`, `.jsx`, or `.mdx` files are present.

---

## vantage-peers (npm package + Convex backend — `vantage-memory` workspace)

No consumer-facing React/Preact UI components in the package itself. The repo ships:
- Convex backend functions (`convex/` — server-side only)
- MCP server (`mcp-server/src/` — Node.js, TypeScript, no React)
- `mcp-server/src/ui-resources/` — TypeScript schema primitives (`schemas.ts`, `stream-marker.ts`, and `primitives/` folder) used as data contracts by consumer UIs. These are type/schema files, not React components.
- Plugin/skills/hooks (Markdown + Python — not UI)

The `ui-resources` exports (`VpToolResultSchema`, `parseToolResult`, `wrapToolResult`) are design-system-adjacent contracts that Mosaic UI components will consume to render structured MCP tool output — they should be catalogued separately in T1 as the data layer for Mosaic rendering.

---

## Issues to report Gamma (refonte friction channel)

_(empty at PREFLIGHT — populated in T2/T3)_

---

## Method + commands cited

### Discovery

```bash
# Find all UI source files per repo
find <repo> -type f \( -name "*.tsx" -o -name "*.jsx" -o -name "*.mdx" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/.next/*" \
  -not -path "*/dist/*" \
  -not -path "*/.git/*" | sort
```

### Component extraction

```bash
# Extract exported component declarations
grep -rEn "export (default )?function ([A-Z][A-Za-z0-9_]*)|export const ([A-Z][A-Za-z0-9_]*) =" \
  <repo>/components --include="*.tsx" | grep -v "\.test\." | grep -v "\.spec\." | grep -v "\.stories\."
```

### Import frequency (top-imported components)

```bash
grep -rEn "from ['\"]@/components/([^'\"]+)['\"]" <repo> --include="*.tsx" \
  | grep -v "node_modules" | grep -v "\.test\." \
  | grep -oP "from ['\"]@/components/[^'\"]+['\"]" \
  | sort | uniq -c | sort -rn | head -20
```

### Auth/multi-tenant classification

```bash
# Auth-gated
grep -rl "useUser\|useOrganization\|useClerk\|SignIn\|OrganizationSwitcher\|useActiveOrg" \
  <repo>/components <repo>/app --include="*.tsx" | grep -v "\.test\."

# Multi-tenant-aware
grep -rl "orgId\|namespacePrefix\|orgSlug\|useActiveOrg" \
  <repo>/components <repo>/app --include="*.tsx" | grep -v "\.test\."
```

### MDX component enumeration

```bash
# Custom MDX component usage in content
grep -rEh "<[A-Z][A-Za-z]+" <repo>/content/docs --include="*.mdx" \
  | grep -oP "<[A-Z][A-Za-z]+" | sort | uniq -c | sort -rn

# MDX import lines
grep -rEh "^import .* from " <repo>/content/docs --include="*.mdx" \
  | sort | uniq -c | sort -rn
```

---

## Footnote — 39 Mosaic* components from @vantageos/mosaic-blocks@0.2.0-alpha (briefing js7503j46w1w25aa86h7fnjeen89feh6)

Canonical list used for Mosaic candidate column above:

`MosaicAccordion`, `MosaicAlert`, `MosaicAlertDialog`, `MosaicAvatar`, `MosaicBadge`, `MosaicBoard`, `MosaicButton`, `MosaicCallout`, `MosaicCard`, `MosaicChart`, `MosaicCheckbox`, `MosaicChipGroup`, `MosaicCodeBlock`, `MosaicComparisonTable`, `MosaicCTA`, `MosaicDetailSheet`, `MosaicDialog`, `MosaicDropdownMenu`, `MosaicEmptyState`, `MosaicFAQ`, `MosaicFeed`, `MosaicFeatureGrid`, `MosaicFilterBar`, `MosaicFooter`, `MosaicForm`, `MosaicGrid`, `MosaicGroupHeader`, `MosaicHero`, `MosaicInput`, `MosaicKanbanBoard`, `MosaicKanbanCard`, `MosaicKanbanColumn`, `MosaicLabel`, `MosaicList`, `MosaicListItem`, `MosaicNavbar`, `MosaicPage`, `MosaicPageHeader`, `MosaicPanel`, `MosaicPopover`, `MosaicPricingCard`, `MosaicProgress`, `MosaicRadioGroup`, `MosaicSearchModal`, `MosaicSection`, `MosaicSegmentedControl`, `MosaicSelect`, `MosaicSeparator`, `MosaicSheet`, `MosaicSidebar`, `MosaicSkeleton`, `MosaicStatusBadge`, `MosaicStatusPipeline`, `MosaicSteps`, `MosaicSwitch`, `MosaicTable`, `MosaicTabs`, `MosaicTextarea`, `MosaicThemeToggle` (already adopted in dashboard), `MosaicTimeline`, `MosaicTooltip`

Two components are already adopted in the dashboard:
- `MosaicThemeToggle` — via `components/mosaic/MosaicColorThemeSwitcher.tsx`
- `MosaicNavbar` — via `components/mosaic/MosaicDashboardNavbar.tsx`
