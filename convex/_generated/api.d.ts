/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _helpers_normalizeOrchestratorId from "../_helpers/normalizeOrchestratorId.js";
import type * as agentCredentials from "../agentCredentials.js";
import type * as agentRelations from "../agentRelations.js";
import type * as agents from "../agents.js";
import type * as briefingNotes from "../briefingNotes.js";
import type * as businessUnits from "../businessUnits.js";
import type * as clientOrgMapping from "../clientOrgMapping.js";
import type * as components_ from "../components.js";
import type * as credentials from "../credentials.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as diary from "../diary.js";
import type * as episodes from "../episodes.js";
import type * as errorMonitor from "../errorMonitor.js";
import type * as errorMonitorActions from "../errorMonitorActions.js";
import type * as errorMonitorAutoResolver from "../errorMonitorAutoResolver.js";
import type * as errorMonitorDeployWindow from "../errorMonitorDeployWindow.js";
import type * as errorMonitorFilters from "../errorMonitorFilters.js";
import type * as errorMonitorGroupKey from "../errorMonitorGroupKey.js";
import type * as errorMonitorKillSwitch from "../errorMonitorKillSwitch.js";
import type * as errorMonitorRecurrence from "../errorMonitorRecurrence.js";
import type * as fixPatterns from "../fixPatterns.js";
import type * as githubComments from "../githubComments.js";
import type * as githubDeployGate from "../githubDeployGate.js";
import type * as githubRepoMapping from "../githubRepoMapping.js";
import type * as gumroadWebhook from "../gumroadWebhook.js";
import type * as http from "../http.js";
import type * as iframeEmbedSessions from "../iframeEmbedSessions.js";
import type * as improvisationDigest from "../improvisationDigest.js";
import type * as issueClosedSweep from "../issueClosedSweep.js";
import type * as issueClosedSweepDb from "../issueClosedSweepDb.js";
import type * as issueStats from "../issueStats.js";
import type * as issueStatsQueries from "../issueStatsQueries.js";
import type * as issues from "../issues.js";
import type * as kb from "../kb.js";
import type * as kbMutations from "../kbMutations.js";
import type * as kbShared from "../kbShared.js";
import type * as lib_agentIdentity from "../lib/agentIdentity.js";
import type * as lib_aiClient from "../lib/aiClient.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_ids from "../lib/ids.js";
import type * as lib_license from "../lib/license.js";
import type * as lib_taskClosureGate from "../lib/taskClosureGate.js";
import type * as lib_tenantSlug from "../lib/tenantSlug.js";
import type * as licenses from "../licenses.js";
import type * as mandates from "../mandates.js";
import type * as mcpTenants from "../mcpTenants.js";
import type * as memories from "../memories.js";
import type * as memoriesScoped from "../memoriesScoped.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as migrations_backfill_review_task_origin from "../migrations/backfill_review_task_origin.js";
import type * as migrations_c2_normalize_orchestrator_ids from "../migrations/c2_normalize_orchestrator_ids.js";
import type * as migrations_dedup_stale_deploy_tasks from "../migrations/dedup_stale_deploy_tasks.js";
import type * as migrations_diary_backfill_createdBy from "../migrations/diary_backfill_createdBy.js";
import type * as migrations_patch_marie_iris_rh_scope from "../migrations/patch_marie_iris_rh_scope.js";
import type * as migrations_populateOrgIds from "../migrations/populateOrgIds.js";
import type * as migrations_reindexMemoriesByPeriod from "../migrations/reindexMemoriesByPeriod.js";
import type * as migrations_seed_task_closure_config from "../migrations/seed_task_closure_config.js";
import type * as missionTemplates from "../missionTemplates.js";
import type * as missions from "../missions.js";
import type * as oauth from "../oauth.js";
import type * as oauthDcr from "../oauthDcr.js";
import type * as oauthMigrations from "../oauthMigrations.js";
import type * as okfBundle from "../okfBundle.js";
import type * as okfBundleDurable from "../okfBundleDurable.js";
import type * as okfBundleNode from "../okfBundleNode.js";
import type * as okfSerializer from "../okfSerializer.js";
import type * as okfValidator from "../okfValidator.js";
import type * as orgRoster from "../orgRoster.js";
import type * as prMonitor from "../prMonitor.js";
import type * as profiles from "../profiles.js";
import type * as ragSync from "../ragSync.js";
import type * as recurringTasks from "../recurringTasks.js";
import type * as search from "../search.js";
import type * as stats from "../stats.js";
import type * as tasks from "../tasks.js";
import type * as tenantOrgSeed from "../tenantOrgSeed.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "_helpers/normalizeOrchestratorId": typeof _helpers_normalizeOrchestratorId;
  agentCredentials: typeof agentCredentials;
  agentRelations: typeof agentRelations;
  agents: typeof agents;
  briefingNotes: typeof briefingNotes;
  businessUnits: typeof businessUnits;
  clientOrgMapping: typeof clientOrgMapping;
  components: typeof components_;
  credentials: typeof credentials;
  crons: typeof crons;
  dashboard: typeof dashboard;
  diary: typeof diary;
  episodes: typeof episodes;
  errorMonitor: typeof errorMonitor;
  errorMonitorActions: typeof errorMonitorActions;
  errorMonitorAutoResolver: typeof errorMonitorAutoResolver;
  errorMonitorDeployWindow: typeof errorMonitorDeployWindow;
  errorMonitorFilters: typeof errorMonitorFilters;
  errorMonitorGroupKey: typeof errorMonitorGroupKey;
  errorMonitorKillSwitch: typeof errorMonitorKillSwitch;
  errorMonitorRecurrence: typeof errorMonitorRecurrence;
  fixPatterns: typeof fixPatterns;
  githubComments: typeof githubComments;
  githubDeployGate: typeof githubDeployGate;
  githubRepoMapping: typeof githubRepoMapping;
  gumroadWebhook: typeof gumroadWebhook;
  http: typeof http;
  iframeEmbedSessions: typeof iframeEmbedSessions;
  improvisationDigest: typeof improvisationDigest;
  issueClosedSweep: typeof issueClosedSweep;
  issueClosedSweepDb: typeof issueClosedSweepDb;
  issueStats: typeof issueStats;
  issueStatsQueries: typeof issueStatsQueries;
  issues: typeof issues;
  kb: typeof kb;
  kbMutations: typeof kbMutations;
  kbShared: typeof kbShared;
  "lib/agentIdentity": typeof lib_agentIdentity;
  "lib/aiClient": typeof lib_aiClient;
  "lib/auth": typeof lib_auth;
  "lib/ids": typeof lib_ids;
  "lib/license": typeof lib_license;
  "lib/taskClosureGate": typeof lib_taskClosureGate;
  "lib/tenantSlug": typeof lib_tenantSlug;
  licenses: typeof licenses;
  mandates: typeof mandates;
  mcpTenants: typeof mcpTenants;
  memories: typeof memories;
  memoriesScoped: typeof memoriesScoped;
  messages: typeof messages;
  migrations: typeof migrations;
  "migrations/backfill_review_task_origin": typeof migrations_backfill_review_task_origin;
  "migrations/c2_normalize_orchestrator_ids": typeof migrations_c2_normalize_orchestrator_ids;
  "migrations/dedup_stale_deploy_tasks": typeof migrations_dedup_stale_deploy_tasks;
  "migrations/diary_backfill_createdBy": typeof migrations_diary_backfill_createdBy;
  "migrations/patch_marie_iris_rh_scope": typeof migrations_patch_marie_iris_rh_scope;
  "migrations/populateOrgIds": typeof migrations_populateOrgIds;
  "migrations/reindexMemoriesByPeriod": typeof migrations_reindexMemoriesByPeriod;
  "migrations/seed_task_closure_config": typeof migrations_seed_task_closure_config;
  missionTemplates: typeof missionTemplates;
  missions: typeof missions;
  oauth: typeof oauth;
  oauthDcr: typeof oauthDcr;
  oauthMigrations: typeof oauthMigrations;
  okfBundle: typeof okfBundle;
  okfBundleDurable: typeof okfBundleDurable;
  okfBundleNode: typeof okfBundleNode;
  okfSerializer: typeof okfSerializer;
  okfValidator: typeof okfValidator;
  orgRoster: typeof orgRoster;
  prMonitor: typeof prMonitor;
  profiles: typeof profiles;
  ragSync: typeof ragSync;
  recurringTasks: typeof recurringTasks;
  search: typeof search;
  stats: typeof stats;
  tasks: typeof tasks;
  tenantOrgSeed: typeof tenantOrgSeed;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rag: import("@convex-dev/rag/_generated/component.js").ComponentApi<"rag">;
  agentEngine: import("@vantageos/agent-engine/_generated/component.js").ComponentApi<"agentEngine">;
};
