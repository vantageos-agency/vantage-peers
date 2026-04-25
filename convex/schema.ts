import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Shared validators (reused across tables)
// ─────────────────────────────────────────────────────────────────────────────

export const memoryTypeValidator = v.union(
	v.literal("user"),
	v.literal("feedback"),
	v.literal("project"),
	v.literal("reference"),
	v.literal("episode"),
);

// Open validator — any orchestrator name is accepted.
// Known defaults: pi, tau, phi, sigma, omega, zeta, eta, kappa, system.
// New orchestrators can be added without schema changes (see issue #132).
export const creatorValidator = v.string();

export const relationTypeValidator = v.union(
	v.literal("updates"),
	v.literal("extends"),
	v.literal("derives"),
);

export const severityValidator = v.union(
	v.literal("critical"),
	v.literal("major"),
	v.literal("minor"),
);

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export default defineSchema({
	// ── memories ────────────────────────────────────────────────────────────────
	// Core memory store. Each row is one typed memory entry.
	// Supermemory pattern: updates/extends/derives relations + isLatest flag.
	// Mem0 pattern: typed memory (user/feedback/project/reference/episode).
	// Episodic type includes structured episode metadata.
	//
	// Embedding + search is handled by @convex-dev/rag (component-owned schema).
	// RAG entry key = memoryId string. Filters: namespace, type, isLatest.
	memories: defineTable({
		// Namespace: "global" | "orchestrator/pi" | "project/vantage-starter"
		namespace: v.string(),

		// Memory classification — drives retrieval strategy
		type: memoryTypeValidator,

		// Human-readable content (what the memory says)
		content: v.string(),

		// Which orchestrator (or system) created this memory
		createdBy: creatorValidator,
		instanceId: v.optional(v.string()), // which instance wrote this

		// Graph relations to other memories (Supermemory pattern)
		// "updates" supersedes target (sets target.isLatest = false)
		// "extends" adds detail to target (both remain latest)
		// "derives" is an inference drawn from target
		relations: v.array(
			v.object({
				targetId: v.id("memories"),
				type: relationTypeValidator,
			}),
		),

		// True = this is the current authoritative version.
		// False = superseded by a newer "updates" relation.
		// Search always filters isLatest=true by default.
		isLatest: v.boolean(),

		// Optional TTL hint (ISO string). Cron job handles actual expiry.
		// Example: "2026-06-01T00:00:00Z"
		ttl: v.optional(v.string()),

		// Episodic memory payload — only present when type="episode"
		episode: v.optional(
			v.object({
				context: v.string(), // Situation that triggered this episode
				goal: v.string(), // What was being attempted
				action: v.string(), // What was actually done
				outcome: v.string(), // What happened
				insight: v.string(), // The lesson extracted (procedural memory)
				severity: severityValidator,
			}),
		),

		// Timestamp (ms since epoch)
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// Primary query patterns — all filtered to isLatest for active memory reads
		.index("by_namespace", ["namespace", "isLatest"])
		.index("by_type", ["type", "isLatest"])
		.index("by_creator", ["createdBy", "isLatest"])
		.index("by_namespace_type", ["namespace", "type", "isLatest"]),

	// ── profiles ────────────────────────────────────────────────────────────────
	// One row per INSTANCE. orchestratorId = role (pi/tau/phi).
	// instanceId = unique running copy (pi-chromebook, pi-vps, tau-client-acme).
	// Multiple instances can share the same role.
	// static  = stable identity facts (role, workspace, capabilities)
	// dynamic = mutable session state (current task, last seen, session count)
	profiles: defineTable({
		// Role: "pi" | "tau" | "phi"
		orchestratorId: v.string(),

		// Unique instance identifier: "pi-chromebook" | "pi-vps" | "tau-vps-1"
		instanceId: v.optional(v.string()),

		name: v.string(),

		// Static profile — stable facts, infrequently updated
		static: v.object({
			role: v.string(),
			workspace: v.string(),
			capabilities: v.array(v.string()),
		}),

		// Dynamic profile — updated each session
		dynamic: v.object({
			currentTask: v.optional(v.string()),
			lastSeen: v.number(), // ms since epoch
			sessionCount: v.number(),
		}),
	})
		.index("by_orchestrator", ["orchestratorId"])
		.index("by_instance", ["instanceId"]),

	// ── messages ──────────────────────────────────────────────────────────────
	// Inter-orchestrator messaging. Replaces claude-peers.
	// One message row per send. Recipients tracked via messageReceipts table.
	// channel: "broadcast" | "pi" | "tau" | "phi" | "pi,tau"
	messages: defineTable({
		from: creatorValidator,
		fromInstanceId: v.optional(v.string()), // "pi-chromebook", "tau-vps-1"
		tenantId: v.optional(v.string()),
		channel: v.string(),
		content: v.string(),
		sessionDay: v.optional(v.number()),
		createdAt: v.number(),
	})
		.index("by_day", ["sessionDay"])
		.index("by_from", ["from", "createdAt"])
		.index("by_channel", ["channel", "createdAt"])
		.index("by_tenant_channel", ["tenantId", "channel", "createdAt"]),

	// ── messageReceipts ──────────────────────────────────────────────────────
	// One row per recipient per message. Tracks read status.
	// check_new_messages = query receipts where recipient=X AND readAt=undefined
	messageReceipts: defineTable({
		messageId: v.id("messages"),
		recipient: creatorValidator, // role-level: "pi" | "tau" | "phi"
		recipientInstanceId: v.optional(v.string()), // instance-level: "pi-vps"
		tenantId: v.optional(v.string()),
		readAt: v.optional(v.number()), // undefined = unread, ms epoch = read
	})
		.index("by_recipient_unread", ["recipient", "readAt"])
		.index("by_instance_unread", ["recipientInstanceId", "readAt"])
		.index("by_message", ["messageId"])
		.index("by_tenant_recipient_unread", ["tenantId", "recipient", "readAt"]),

	// ── missions ──────────────────────────────────────────────────────────────
	missions: defineTable({
		name: v.string(),
		description: v.optional(v.string()),
		project: v.string(),
		status: v.union(
			v.literal("brainstorm"),
			v.literal("plan"),
			v.literal("execute"),
			v.literal("validate"),
			v.literal("complete"),
		),
		priority: v.union(
			v.literal("urgent"),
			v.literal("high"),
			v.literal("medium"),
			v.literal("low"),
		),
		pilot: creatorValidator,
		agents: v.array(v.string()),
		brief: v.optional(v.string()),
		startDate: v.optional(v.number()),
		targetDate: v.optional(v.number()),
		progress: v.optional(v.number()),
		createdBy: creatorValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_project", ["project", "status"])
		.index("by_pilot", ["pilot", "status"])
		.index("by_status", ["status", "createdAt"])
		.index("by_priority", ["priority", "status"]),

	// ── tasks ──────────────────────────────────────────────────────────────────
	tasks: defineTable({
		title: v.string(),
		description: v.optional(v.string()),
		project: v.optional(v.string()), // "vantage-starter", "perfect-ai-agent", etc.
		tags: v.optional(v.array(v.string())),
		// Orchestrator or person assigned — open string (issue #132)
		assignedTo: v.string(),
		priority: v.union(
			v.literal("urgent"),
			v.literal("high"),
			v.literal("medium"),
			v.literal("low"),
		),
		status: v.union(
			v.literal("todo"),
			v.literal("in_progress"),
			v.literal("review"),
			v.literal("blocked"),
			v.literal("done"),
		),
		completionNote: v.optional(v.string()), // what was actually done — written on complete/review
		assignedToInstance: v.optional(v.string()), // instance-level assignment: "pi-vps", "tau-chromebook"
		claimedByInstance: v.optional(v.string()), // which instance is working on this
		dependsOn: v.optional(v.array(v.id("tasks"))), // tasks that must be done first
		missionId: v.optional(v.id("missions")),
		estimatedMinutes: v.optional(v.number()),
		actualMinutes: v.optional(v.number()),
		startedAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		dueDate: v.optional(v.number()),
		createdBy: creatorValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_assignee", ["assignedTo", "status"])
		.index("by_project", ["project", "status"])
		.index("by_priority", ["priority", "status"])
		.index("by_status", ["status", "createdAt"])
		.index("by_mission", ["missionId", "status"])
		.index("by_instance", ["assignedToInstance", "status"]),

	// ── diary ──────────────────────────────────────────────────────────────────
	diary: defineTable({
		date: v.string(), // "2026-03-25" ISO date
		orchestrator: creatorValidator,
		instanceId: v.optional(v.string()), // which instance wrote this
		content: v.string(), // Full diary entry
		highlights: v.optional(v.array(v.string())),
		blockers: v.optional(v.array(v.string())),
		createdAt: v.number(),
	})
		.index("by_orchestrator_date", ["orchestrator", "date"])
		.index("by_date", ["date"]),

	// ── briefingNotes ──────────────────────────────────────────────────────────
	briefingNotes: defineTable({
		title: v.string(),
		topic: v.string(),
		participants: v.array(v.string()), // ["pi", "laurent", "tau"]
		content: v.string(), // Full briefing content
		decisions: v.optional(v.array(v.string())),
		linkedMemoryIds: v.optional(v.array(v.id("memories"))),
		createdBy: creatorValidator,
		createdAt: v.number(),
	})
		.index("by_topic", ["topic"])
		.index("by_creator", ["createdBy", "createdAt"]),

	// ── components ──────────────────────────────────────────────────────────
	// Registry of agents, skills, hooks, plugins — backup + inventory.
	// Content stores the full file so nothing is lost if filesystem is destroyed.
	components: defineTable({
		name: v.string(),
		type: v.union(
			v.literal("agent"),
			v.literal("skill"),
			v.literal("hook"),
			v.literal("plugin"),
		),
		team: v.optional(v.string()), // e.g. "marketing", "development"
		content: v.string(), // full file content
		version: v.optional(v.string()),
		project: v.optional(v.string()),
		createdBy: creatorValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_type", ["type"])
		.index("by_team", ["team", "type"])
		.index("by_name_type", ["name", "type"]),

	// ── mandates ──────────────────────────────────────────────────────────────
	// Cross-orchestrator service requests. One orchestrator requests a service from another.
	// Budget (token allocation) is agreed upfront; cost is recorded on settle.
	mandates: defineTable({
		requestedBy: creatorValidator, // who needs the service
		fulfilledBy: creatorValidator, // who will provide the service
		service: v.string(), // description of what is needed
		budget: v.number(), // token budget allocated
		status: v.union(
			v.literal("requested"),
			v.literal("accepted"),
			v.literal("in_progress"),
			v.literal("delivered"),
			v.literal("settled"),
		),
		linkedTaskIds: v.optional(v.array(v.id("tasks"))), // tasks created to fulfill this mandate
		tokensCost: v.optional(v.number()), // actual tokens consumed
		createdAt: v.number(),
		updatedAt: v.number(),
		completedAt: v.optional(v.number()),
		// AP2 authorization fields
		spendingLimits: v.optional(
			v.object({
				maxPerTransaction: v.number(),
				maxPerPeriod: v.number(),
				periodDays: v.optional(v.number()), // default 30
			}),
		),
		approvedCategories: v.optional(v.array(v.string())), // e.g. ["seo", "content", "development"]
		mandateDocument: v.optional(v.string()), // signed authorization text or reference
	})
		.index("by_requestedBy", ["requestedBy", "status"])
		.index("by_fulfilledBy", ["fulfilledBy", "status"])
		.index("by_status", ["status", "createdAt"]),

	// ── issues ────────────────────────────────────────────────────────────────
	// GitHub issues tracked in VantagePeers. Synced via webhook.
	issues: defineTable({
		repo: v.string(), // "myreeldream-ai/MyShortReel-beta"
		issueNumber: v.number(),
		title: v.string(),
		body: v.string(), // truncated to 2000 chars
		htmlUrl: v.string(),
		labels: v.array(v.string()),
		status: v.union(
			v.literal("open"),
			v.literal("in_progress"),
			v.literal("fixed"),
			v.literal("verified"),
			v.literal("closed"),
		),
		priority: v.union(
			v.literal("urgent"),
			v.literal("high"),
			v.literal("medium"),
			v.literal("low"),
		),
		assignedOrchestrator: v.string(),
		project: v.string(),
		fixCommits: v.optional(v.array(v.string())),
		fixedBy: v.optional(v.string()),
		fixedAt: v.optional(v.number()),
		verifiedBy: v.optional(v.string()),
		verifiedAt: v.optional(v.number()),
		linkedTaskIds: v.optional(v.array(v.string())),
		githubCreatedAt: v.number(),
		githubUpdatedAt: v.number(),
		// External repo tracking (for Zeta contributions to third-party repos)
		externalRepo: v.optional(v.string()), // "get-convex/better-auth"
		externalIssueNumber: v.optional(v.number()),
		externalIssueUrl: v.optional(v.string()),
		prUrl: v.optional(v.string()),
		prStatus: v.optional(
			v.union(
				v.literal("draft"),
				v.literal("open"),
				v.literal("merged"),
				v.literal("closed"),
			),
		),
		forkRepo: v.optional(v.string()), // "elpiarthera/better-auth"
	})
		.index("by_repo_number", ["repo", "issueNumber"])
		.index("by_status", ["status"])
		.index("by_project", ["project"])
		.index("by_assigned", ["assignedOrchestrator", "status"])
		.index("by_external_repo", ["externalRepo", "prStatus"]),

	// ── githubRepoMapping ─────────────────────────────────────────────────────
	// Maps GitHub repos to orchestrators. Used by webhook handler to route events.
	githubRepoMapping: defineTable({
		repo: v.string(), // "myreeldream-ai/MyShortReel-beta"
		orchestrator: v.string(), // "omega", "tau", "sigma", etc.
		project: v.string(), // "myreeldream", "vantage-starter", etc.
		active: v.boolean(),
	}).index("by_repo", ["repo"]),

	// ── businessUnits ─────────────────────────────────────────────────────────
	// One row per ElPi Corp business unit. Tracks strategy, structure, and KPIs.
	// managementFee: ElPi Corp takes this percentage of revenue (default 10%).
	businessUnits: defineTable({
		name: v.string(), // e.g. "VantagePeers", "VantageRegistry"
		description: v.string(),
		purpose: v.string(),
		domain: v.optional(v.string()), // e.g. "vantagepeers.com"
		orchestratorId: v.string(), // lead orchestrator — e.g. "sigma"
		status: v.union(
			v.literal("idea"),
			v.literal("building"),
			v.literal("live"),
			v.literal("revenue"),
		),
		businessModel: v.string(), // how it makes money
		targetCustomers: v.string(),
		services: v.array(v.string()), // what it offers
		pricing: v.string(),
		revenueProjections: v.object({
			y1: v.number(),
			y2: v.number(),
			y3: v.number(),
		}),
		coreTeam: v.object({
			agents: v.array(v.string()),
			skills: v.array(v.string()),
			hooks: v.array(v.string()),
			plugins: v.array(v.string()),
		}),
		coreProcesses: v.array(v.string()),
		dependencies: v.array(v.string()), // which BUs it consumes
		kpis: v.array(v.string()),
		managementFee: v.number(), // ElPi Corp % cut (default 10)
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_orchestrator", ["orchestratorId"])
		.index("by_status", ["status"])
		.index("by_name", ["name"]),

	// ── recurringTasks ────────────────────────────────────────────────────────
	// Templates for tasks that auto-create on a schedule (daily standup, weekly scan, etc.)
	// Convex cron checks every 15 min and creates tasks when nextRunAt <= now.
	recurringTasks: defineTable({
		title: v.string(),
		description: v.optional(v.string()),
		// Orchestrator or person assigned — open string (issue #132)
		assignedTo: v.string(),
		priority: v.union(
			v.literal("urgent"),
			v.literal("high"),
			v.literal("medium"),
			v.literal("low"),
		),
		project: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		cronExpression: v.string(), // "0 9 * * *" = daily 9am, "0 9 * * 1" = Monday 9am
		lastCreatedAt: v.optional(v.number()),
		nextRunAt: v.number(),
		active: v.boolean(),
		createdBy: creatorValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_active", ["active", "nextRunAt"])
		.index("by_assignee", ["assignedTo"]),

	// ── fixPatterns ──────────────────────────────────────────────────────────────
	// Knowledge base of fix patterns. Documents bugs, root causes, fix attempts
	// (including failures), and validated fixes. Agents search this BEFORE fixing
	// to avoid repeating mistakes. Semantic search via RAG on symptom + rootCause.
	fixPatterns: defineTable({
		symptom: v.string(), // What the bug looks like (searchable via RAG)
		rootCause: v.string(), // Why it happens
		validatedFix: v.optional(v.string()), // The fix that actually worked
		files: v.optional(v.array(v.string())), // Files involved
		tags: v.array(v.string()), // e.g. "react-hydration", "convex-subscription"
		stack: v.array(v.string()), // e.g. "next.js", "convex", "clerk"
		sourceProject: v.string(), // Origin project
		linkedIssueIds: v.optional(v.array(v.string())), // VantagePeers issue IDs
		createdBy: creatorValidator,
		severity: severityValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_project", ["sourceProject"])
		.index("by_severity", ["severity"])
		.index("by_creator", ["createdBy"]),

	// ── fixAttempts ──────────────────────────────────────────────────────────────
	// Individual fix attempts for a pattern. Separate table to avoid unbounded
	// array growth in fixPatterns documents (per Convex guidelines).
	fixAttempts: defineTable({
		patternId: v.id("fixPatterns"),
		description: v.string(), // What was tried
		commit: v.optional(v.string()), // Commit hash
		worked: v.boolean(), // Did it fix the issue?
		why: v.string(), // Why it worked or didn't
		createdBy: creatorValidator,
		createdAt: v.number(),
	})
		.index("by_pattern", ["patternId"])
		.index("by_worked", ["patternId", "worked"]),

	// ── missionTemplates ──────────────────────────────────────────────────────
	// Reusable mission templates. Each template contains an ordered list of
	// steps that get instantiated as tasks when a triggering event occurs.
	// The "issue-resolution-v2" template drives the IRP (Issue Resolution Protocol).
	missionTemplates: defineTable({
		name: v.string(),
		description: v.optional(v.string()),
		steps: v.array(
			v.object({
				title: v.string(),
				description: v.string(),
				tags: v.optional(v.array(v.string())),
				assignedTo: v.optional(v.string()), // orchestrator role, e.g. "proxima"
				assignedToInstance: v.optional(v.string()), // instance, e.g. "proxima-vps"
				dependsOn: v.optional(v.array(v.number())), // indexes of required steps (0-based)
			}),
		),
		isDefault: v.boolean(),
		createdBy: creatorValidator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_name", ["name"])
		.index("by_default", ["isDefault"]),

	// ── monitoredDeployments ─────────────────────────────────────────────────
	// Registry of Convex deployments to poll for errors.
	// deployKeyEnvVar: name of the env var holding the admin deploy key.
	monitoredDeployments: defineTable({
		name: v.string(),
		deploymentUrl: v.string(),
		deployKeyEnvVar: v.string(),
		githubRepo: v.string(),
		orchestrator: v.string(),
		active: v.boolean(),
		lastCursor: v.optional(v.number()),
		createdAt: v.number(),
	})
		.index("by_active", ["active"])
		.index("by_name", ["name"]),

	// ── issueStats ───────────────────────────────────────────────────────────
	// Daily issue resolution metrics per repo.
	issueStats: defineTable({
		repo: v.string(),
		date: v.string(), // YYYY-MM-DD
		totalIssues: v.number(),
		resolvedIssues: v.number(),
		medianTimeToFirstResponse: v.optional(v.number()), // minutes
		medianTimeToFix: v.optional(v.number()), // minutes
		fastestResolution: v.optional(v.number()), // minutes
		slowestResolution: v.optional(v.number()), // minutes
		avgTimeToFix: v.optional(v.number()), // minutes
		// Before/after VantageOS Team (pivot: 2026-04-01)
		beforeVantageOS: v.optional(
			v.object({
				totalIssues: v.number(),
				resolvedIssues: v.number(),
				medianTimeToFix: v.optional(v.number()),
				avgTimeToFix: v.optional(v.number()),
			}),
		),
		afterVantageOS: v.optional(
			v.object({
				totalIssues: v.number(),
				resolvedIssues: v.number(),
				medianTimeToFix: v.optional(v.number()),
				avgTimeToFix: v.optional(v.number()),
			}),
		),
		issueDetails: v.optional(
			v.array(
				v.object({
					number: v.number(),
					title: v.string(),
					timeToFirstResponse: v.optional(v.number()),
					timeToFix: v.optional(v.number()),
					status: v.string(),
				}),
			),
		),
		calculatedAt: v.number(),
	})
		.index("by_repo_date", ["repo", "date"])
		.index("by_date", ["date"]),

	// ── oauth_clients ─────────────────────────────────────────────────────────
	// OAuth 2.0 Dynamic Client Registration (RFC 7591).
	// One row per registered OAuth client (Claude.ai custom connector, Marie,
	// future Perello VIP clients). Each client is bound to a scopeProfile that
	// limits the `from=` allowlist and namespace read/write prefixes.
	//
	// clientSecretHash = SHA-256 hex of the raw client secret (raw never stored).
	// Admin onboarding returns the raw secret exactly ONCE to the provisioner.
	oauth_clients: defineTable({
		clientId: v.string(), // public identifier (UUID)
		clientSecretHash: v.string(), // SHA-256 hex of raw secret
		redirectUris: v.array(v.string()),
		name: v.string(), // human label, e.g. "marie-iris-rh"
		scopeProfile: v.string(), // FK to oauth_scope_profiles.profileId
		createdAt: v.number(),
		revokedAt: v.optional(v.number()),
	})
		.index("by_clientId", ["clientId"])
		.index("by_scopeProfile", ["scopeProfile"]),

	// ── oauth_authorization_codes ────────────────────────────────────────────
	// Short-lived authorization codes (RFC 6749 §4.1). TTL ~10 min.
	// Cleaned periodically by cron (processExpiredOauthCodes).
	oauth_authorization_codes: defineTable({
		code: v.string(), // opaque random value
		clientId: v.string(),
		redirectUri: v.string(),
		codeChallenge: v.string(), // PKCE S256 (RFC 7636)
		scope: v.string(),
		userId: v.string(), // who the code was issued for (== scopeProfile owner by default)
		expiresAt: v.number(),
	}).index("by_code", ["code"]),

	// ── oauth_access_tokens ──────────────────────────────────────────────────
	// Issued access tokens. tokenHash = SHA-256 hex of the raw token (raw never
	// stored). The HTTP bearer middleware hashes the incoming Authorization
	// header and looks the token up by hash, then enforces fromAllowList +
	// namespaceRead/Write prefixes on every MCP tool call.
	oauth_access_tokens: defineTable({
		tokenHash: v.string(),
		clientId: v.string(),
		userId: v.string(),
		scopes: v.array(v.string()), // OAuth scopes (vantage:read, vantage:write)
		scopeProfile: v.string(), // snapshot at issue time
		fromAllowList: v.array(v.string()),
		namespaceReadPrefixes: v.array(v.string()),
		namespaceWritePrefixes: v.array(v.string()),
		expiresAt: v.number(),
		refreshTokenHash: v.optional(v.string()),
		createdAt: v.number(),
		revokedAt: v.optional(v.number()),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_clientId", ["clientId"]),

	// ── oauth_refresh_tokens ─────────────────────────────────────────────────
	// Refresh tokens for renewing expired access tokens. Same hashing rules.
	oauth_refresh_tokens: defineTable({
		tokenHash: v.string(),
		clientId: v.string(),
		userId: v.string(),
		scopeProfile: v.string(),
		expiresAt: v.number(),
		createdAt: v.number(),
		revokedAt: v.optional(v.number()),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_clientId", ["clientId"]),

	// ── oauth_scope_profiles ─────────────────────────────────────────────────
	// Reusable scope templates. An OAuth client references a profile by
	// profileId; the access_token materialises the profile into the token row
	// so scope changes on the profile don't retroactively grant or revoke.
	//
	// Seeded on first deploy via oauth.seedDefaultProfiles: master, marie-iris-rh,
	// client-generic (deny-by-default template).
	oauth_scope_profiles: defineTable({
		profileId: v.string(), // stable slug e.g. "marie-iris-rh"
		description: v.string(),
		fromAllowList: v.array(v.string()),
		namespaceReadPrefixes: v.array(v.string()),
		namespaceWritePrefixes: v.array(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index("by_profileId", ["profileId"]),

	// ── mcpTenants ────────────────────────────────────────────────────────────
	// Registry of VIP tenants for HTTP MCP transport.
	// Each tenant has a hashed bearer token and a target Convex deployment URL.
	// The HTTP MCP server (Railway) looks up tenants by tokenHash on every request
	// and proxies to the correct Convex deployment.
	// tokenHash = SHA-256 hex of the raw bearer token (raw token never stored).
	mcpTenants: defineTable({
		tokenHash: v.string(), // SHA-256 hex of bearer token
		tenantName: v.string(), // e.g. "perello-consulting-vip-1"
		convexUrl: v.string(), // e.g. "https://xxxx.convex.cloud"
		createdAt: v.number(),
		enabledAt: v.optional(v.number()), // undefined = disabled
		lastUsedAt: v.optional(v.number()),
		revokedAt: v.optional(v.number()),
	}).index("by_tokenHash", ["tokenHash"]),

	// ── errorMonitorFilterRules ──────────────────────────────────────────────
	// Runtime-configurable filter rules for the auto-IRP bot.
	// Each rule matches (functionName, errorMessageRegex) and assigns a severity:
	//   "skip"          → drop silently, no upsert / issue
	//   "log-only"      → console.log only
	//   "create-issue"  → normal flow (used to override a default skip)
	//
	// Defaults are seeded by errorMonitorFilters.seedDefaultRules. Sigma/Pi
	// can add or disable rules without redeploying via addFilterRule /
	// disableFilterRule public mutations.
	//
	// Linked: memory j573cwcs3znp0xsvtg34x435jh84b0eg, pattern m978zeg4b2e9nx67z2hg5rwgfs85hf7f.
	errorMonitorFilterRules: defineTable({
		functionName: v.string(), // exact match, e.g. "tasks:complete"
		errorMessageRegex: v.string(), // RegExp source
		regexFlags: v.optional(v.string()), // e.g. "i"
		reason: v.string(), // human-readable why this is filtered
		severity: v.union(
			v.literal("skip"),
			v.literal("log-only"),
			v.literal("create-issue"),
		),
		active: v.boolean(),
		createdAt: v.number(),
	})
		.index("by_active", ["active"])
		.index("by_function", ["functionName", "active"]),

	// ── errorLogs ────────────────────────────────────────────────────────────
	// Deduplicated log of detected function errors across monitored deployments.
	// hash = simpleHash(functionName + ":" + errorMessage) for deduplication.
	errorLogs: defineTable({
		hash: v.string(),
		deployment: v.string(),
		functionName: v.string(),
		errorMessage: v.string(),
		stackTrace: v.optional(v.string()),
		firstSeen: v.number(),
		lastSeen: v.number(),
		count: v.number(),
		issueNumber: v.optional(v.number()),
		githubRepo: v.optional(v.string()),
	})
		.index("by_hash", ["hash"])
		.index("by_deployment", ["deployment"]),
});
