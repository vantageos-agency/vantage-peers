import { type FunctionReference } from "convex/server";
import { type GenericId as Id } from "convex/values";
export declare const api: PublicApiType;
export declare const internal: InternalApiType;
export type PublicApiType = {
    briefingNotes: {
        create: FunctionReference<"mutation", "public", {
            content: string;
            createdBy: string;
            decisions?: Array<string>;
            linkedMemoryIds?: Array<Id<"memories">>;
            participants: Array<string>;
            title: string;
            topic: string;
        }, Id<"briefingNotes">>;
        get: FunctionReference<"query", "public", {
            noteId: Id<"briefingNotes">;
        }, {
            _creationTime: number;
            _id: Id<"briefingNotes">;
            content: string;
            createdAt: number;
            createdBy: string;
            decisions?: Array<string>;
            linkedMemoryIds?: Array<Id<"memories">>;
            participants: Array<string>;
            title: string;
            topic: string;
        } | null>;
        list: FunctionReference<"query", "public", {
            limit?: number;
            topic?: string;
        }, Array<{
            _creationTime: number;
            _id: Id<"briefingNotes">;
            content: string;
            createdAt: number;
            createdBy: string;
            decisions?: Array<string>;
            linkedMemoryIds?: Array<Id<"memories">>;
            participants: Array<string>;
            title: string;
            topic: string;
        }>>;
    };
    businessUnits: {
        create: FunctionReference<"mutation", "public", {
            businessModel: string;
            coreProcesses: Array<string>;
            coreTeam: {
                agents: Array<string>;
                hooks: Array<string>;
                plugins: Array<string>;
                skills: Array<string>;
            };
            dependencies: Array<string>;
            description: string;
            domain?: string;
            kpis: Array<string>;
            managementFee?: number;
            name: string;
            orchestratorId: string;
            pricing: string;
            purpose: string;
            revenueProjections: {
                y1: number;
                y2: number;
                y3: number;
            };
            services: Array<string>;
            status: "idea" | "building" | "live" | "revenue";
            targetCustomers: string;
        }, Id<"businessUnits">>;
        update: FunctionReference<"mutation", "public", {
            buId: Id<"businessUnits">;
            businessModel?: string;
            coreProcesses?: Array<string>;
            coreTeam?: {
                agents: Array<string>;
                hooks: Array<string>;
                plugins: Array<string>;
                skills: Array<string>;
            };
            dependencies?: Array<string>;
            description?: string;
            domain?: string;
            kpis?: Array<string>;
            managementFee?: number;
            name?: string;
            orchestratorId?: string;
            pricing?: string;
            purpose?: string;
            revenueProjections?: {
                y1: number;
                y2: number;
                y3: number;
            };
            services?: Array<string>;
            status?: "idea" | "building" | "live" | "revenue";
            targetCustomers?: string;
        }, null>;
        remove: FunctionReference<"mutation", "public", {
            buId: Id<"businessUnits">;
        }, {
            deleted: boolean;
        }>;
        get: FunctionReference<"query", "public", {
            buId: Id<"businessUnits">;
        }, {
            _creationTime: number;
            _id: Id<"businessUnits">;
            businessModel: string;
            coreProcesses: Array<string>;
            coreTeam: {
                agents: Array<string>;
                hooks: Array<string>;
                plugins: Array<string>;
                skills: Array<string>;
            };
            createdAt: number;
            dependencies: Array<string>;
            description: string;
            domain?: string;
            kpis: Array<string>;
            managementFee: number;
            name: string;
            orchestratorId: string;
            pricing: string;
            purpose: string;
            revenueProjections: {
                y1: number;
                y2: number;
                y3: number;
            };
            services: Array<string>;
            status: "idea" | "building" | "live" | "revenue";
            targetCustomers: string;
            updatedAt: number;
        } | null>;
        list: FunctionReference<"query", "public", {
            limit?: number;
            orchestratorId?: string;
            status?: "idea" | "building" | "live" | "revenue";
        }, Array<{
            _creationTime: number;
            _id: Id<"businessUnits">;
            businessModel: string;
            coreProcesses: Array<string>;
            coreTeam: {
                agents: Array<string>;
                hooks: Array<string>;
                plugins: Array<string>;
                skills: Array<string>;
            };
            createdAt: number;
            dependencies: Array<string>;
            description: string;
            domain?: string;
            kpis: Array<string>;
            managementFee: number;
            name: string;
            orchestratorId: string;
            pricing: string;
            purpose: string;
            revenueProjections: {
                y1: number;
                y2: number;
                y3: number;
            };
            services: Array<string>;
            status: "idea" | "building" | "live" | "revenue";
            targetCustomers: string;
            updatedAt: number;
        }>>;
    };
    components: {
        register: FunctionReference<"mutation", "public", {
            content: string;
            createdBy: string;
            name: string;
            project?: string;
            team?: string;
            type: "agent" | "skill" | "hook" | "plugin";
            version?: string;
        }, {
            componentId: Id<"components">;
            created: boolean;
        }>;
        list: FunctionReference<"query", "public", {
            limit?: number;
            team?: string;
            type?: "agent" | "skill" | "hook" | "plugin";
        }, any>;
        get: FunctionReference<"query", "public", {
            name: string;
            type: "agent" | "skill" | "hook" | "plugin";
        }, any>;
        update: FunctionReference<"mutation", "public", {
            componentId: Id<"components">;
            content?: string;
            name?: string;
            project?: string;
            team?: string;
            version?: string;
        }, Id<"components">>;
        remove: FunctionReference<"mutation", "public", {
            componentId: Id<"components">;
        }, {
            deleted: boolean;
        }>;
        search: FunctionReference<"query", "public", {
            limit?: number;
            query: string;
            type?: "agent" | "skill" | "hook" | "plugin";
        }, any>;
    };
    diary: {
        write: FunctionReference<"mutation", "public", {
            blockers?: Array<string>;
            content: string;
            date: string;
            highlights?: Array<string>;
            orchestrator: string;
        }, Id<"diary">>;
        get: FunctionReference<"query", "public", {
            date: string;
            orchestrator: string;
        }, {
            _creationTime: number;
            _id: Id<"diary">;
            blockers?: Array<string>;
            content: string;
            createdAt: number;
            date: string;
            highlights?: Array<string>;
            instanceId?: string;
            orchestrator: string;
        } | null>;
        list: FunctionReference<"query", "public", {
            limit?: number;
            orchestrator?: string;
        }, Array<{
            _creationTime: number;
            _id: Id<"diary">;
            blockers?: Array<string>;
            content: string;
            createdAt: number;
            date: string;
            highlights?: Array<string>;
            instanceId?: string;
            orchestrator: string;
        }>>;
        listByDateRange: FunctionReference<"query", "public", {
            from: string;
            orchestrator?: string;
            to: string;
        }, Array<{
            _creationTime: number;
            _id: Id<"diary">;
            blockers?: Array<string>;
            content: string;
            createdAt: number;
            date: string;
            highlights?: Array<string>;
            instanceId?: string;
            orchestrator: string;
        }>>;
    };
    episodes: {
        storeEpisode: FunctionReference<"mutation", "public", {
            action: string;
            context: string;
            createdBy: string;
            goal: string;
            insight: string;
            namespace: string;
            outcome: string;
            relations?: Array<{
                targetId: Id<"memories">;
                type: "updates" | "extends" | "derives";
            }>;
            severity: "critical" | "major" | "minor";
            ttl?: string;
        }, Id<"memories">>;
        listEpisodes: FunctionReference<"query", "public", {
            limit?: number;
            namespace: string;
            severity?: "critical" | "major" | "minor";
        }, Array<{
            _creationTime: number;
            _id: Id<"memories">;
            content: string;
            createdAt: number;
            createdBy: string;
            episode: {
                action: string;
                context: string;
                goal: string;
                insight: string;
                outcome: string;
                severity: "critical" | "major" | "minor";
            };
            isLatest: boolean;
            namespace: string;
        }>>;
        getCriticalInsights: FunctionReference<"query", "public", {
            limit?: number;
        }, Array<{
            _id: Id<"memories">;
            context: string;
            createdAt: number;
            createdBy: string;
            insight: string;
            namespace: string;
        }>>;
    };
    mandates: {
        create: FunctionReference<"mutation", "public", {
            approvedCategories?: Array<string>;
            budget: number;
            fulfilledBy: string;
            mandateDocument?: string;
            requestedBy: string;
            service: string;
            spendingLimits?: {
                maxPerPeriod: number;
                maxPerTransaction: number;
                periodDays?: number;
            };
        }, Id<"mandates">>;
        accept: FunctionReference<"mutation", "public", {
            callerOrchestrator: string;
            mandateId: Id<"mandates">;
        }, null>;
        update: FunctionReference<"mutation", "public", {
            callerOrchestrator: string;
            linkedTaskIds?: Array<Id<"tasks">>;
            mandateId: Id<"mandates">;
            status?: "requested" | "accepted" | "in_progress" | "delivered" | "settled";
            tokensCost?: number;
        }, null>;
        settle: FunctionReference<"mutation", "public", {
            callerOrchestrator: string;
            finalCost: number;
            mandateId: Id<"mandates">;
        }, null>;
        list: FunctionReference<"query", "public", {
            fulfilledBy?: string;
            limit?: number;
            requestedBy?: string;
            status?: "requested" | "accepted" | "in_progress" | "delivered" | "settled";
        }, Array<{
            _creationTime: number;
            _id: Id<"mandates">;
            approvedCategories?: Array<string>;
            budget: number;
            completedAt?: number;
            createdAt: number;
            fulfilledBy: string;
            linkedTaskIds?: Array<Id<"tasks">>;
            mandateDocument?: string;
            requestedBy: string;
            service: string;
            spendingLimits?: {
                maxPerPeriod: number;
                maxPerTransaction: number;
                periodDays?: number;
            };
            status: "requested" | "accepted" | "in_progress" | "delivered" | "settled";
            tokensCost?: number;
            updatedAt: number;
        }>>;
        get: FunctionReference<"query", "public", {
            mandateId: Id<"mandates">;
        }, {
            _creationTime: number;
            _id: Id<"mandates">;
            approvedCategories?: Array<string>;
            budget: number;
            completedAt?: number;
            createdAt: number;
            fulfilledBy: string;
            linkedTaskIds?: Array<Id<"tasks">>;
            mandateDocument?: string;
            requestedBy: string;
            service: string;
            spendingLimits?: {
                maxPerPeriod: number;
                maxPerTransaction: number;
                periodDays?: number;
            };
            status: "requested" | "accepted" | "in_progress" | "delivered" | "settled";
            tokensCost?: number;
            updatedAt: number;
        } | null>;
        validateSpending: FunctionReference<"query", "public", {
            mandateId: Id<"mandates">;
            proposedAmount: number;
        }, {
            currentSpend: number;
            perPeriodLimit?: number;
            perTransactionLimit?: number;
            reason?: string;
            remainingBudget: number;
            withinLimits: boolean;
        }>;
    };
    memories: {
        storeMemory: FunctionReference<"mutation", "public", {
            content: string;
            createdBy: string;
            episode?: {
                action: string;
                context: string;
                goal: string;
                insight: string;
                outcome: string;
                severity: "critical" | "major" | "minor";
            };
            isLatest?: boolean;
            namespace: string;
            relations: Array<{
                targetId: Id<"memories">;
                type: "updates" | "extends" | "derives";
            }>;
            ttl?: string;
            type: "user" | "feedback" | "project" | "reference" | "episode";
        }, Id<"memories">>;
        getMemory: FunctionReference<"query", "public", {
            memoryId: Id<"memories">;
        }, {
            _creationTime: number;
            _id: Id<"memories">;
            content: string;
            createdAt: number;
            createdBy: string;
            episode?: {
                action: string;
                context: string;
                goal: string;
                insight: string;
                outcome: string;
                severity: "critical" | "major" | "minor";
            };
            isLatest: boolean;
            namespace: string;
            relations: Array<{
                targetId: Id<"memories">;
                type: "updates" | "extends" | "derives";
            }>;
            ttl?: string;
            type: "user" | "feedback" | "project" | "reference" | "episode";
            updatedAt: number;
        } | null>;
        listMemories: FunctionReference<"query", "public", {
            includeSuperseded?: boolean;
            limit?: number;
            namespace: string;
            type?: "user" | "feedback" | "project" | "reference" | "episode";
        }, Array<{
            _creationTime: number;
            _id: Id<"memories">;
            content: string;
            createdAt: number;
            createdBy: string;
            episode?: {
                action: string;
                context: string;
                goal: string;
                insight: string;
                outcome: string;
                severity: "critical" | "major" | "minor";
            };
            isLatest: boolean;
            namespace: string;
            relations: Array<{
                targetId: Id<"memories">;
                type: "updates" | "extends" | "derives";
            }>;
            ttl?: string;
            type: "user" | "feedback" | "project" | "reference" | "episode";
            updatedAt: number;
        }>>;
        softDeleteMemory: FunctionReference<"mutation", "public", {
            memoryId: Id<"memories">;
        }, null>;
    };
    messages: {
        sendMessage: FunctionReference<"mutation", "public", {
            channel: string;
            content: string;
            from: string;
            fromInstanceId?: string;
            sessionDay?: number;
            tenantId?: string;
        }, Id<"messages">>;
        checkNewMessages: FunctionReference<"query", "public", {
            recipient: string;
            recipientInstanceId?: string;
            tenantId?: string;
        }, Array<{
            channel?: string;
            content: string;
            createdAt: number;
            from: string;
            fromInstanceId?: string;
            messageId: Id<"messages">;
            receiptId: Id<"messageReceipts">;
        }>>;
        markAsRead: FunctionReference<"mutation", "public", {
            receiptIds: Array<Id<"messageReceipts">>;
        }, number>;
        deleteMessage: FunctionReference<"mutation", "public", {
            callerOrchestrator?: string;
            messageId: Id<"messages">;
        }, {
            deleted: boolean;
            receiptsDeleted: number;
        }>;
        listMessages: FunctionReference<"query", "public", {
            from?: string;
            limit?: number;
            sessionDay?: number;
        }, Array<{
            _creationTime: number;
            _id: Id<"messages">;
            channel?: string;
            content: string;
            createdAt: number;
            from: string;
            fromInstanceId?: string;
            sessionDay?: number;
            to?: string;
        }>>;
        getUnreadCount: FunctionReference<"query", "public", {
            orchestratorId: string;
        }, number>;
        listBroadcastStatus: FunctionReference<"query", "public", {
            messageId: Id<"messages">;
        }, {
            channel?: string;
            createdAt: number;
            from: string;
            messageId: Id<"messages">;
            receipts: Array<{
                read: boolean;
                readAt?: number;
                recipient: string;
                recipientInstanceId?: string;
            }>;
        }>;
        listByChannel: FunctionReference<"query", "public", {
            channel?: string;
            limit?: number;
        }, Array<{
            _creationTime: number;
            _id: Id<"messages">;
            channel: string;
            content: string;
            createdAt: number;
            from: string;
            fromInstanceId?: string;
            sessionDay?: number;
        }>>;
    };
    missions: {
        create: FunctionReference<"mutation", "public", {
            agents: Array<string>;
            brief?: string;
            createdBy: string;
            description?: string;
            name: string;
            pilot: string;
            priority: "urgent" | "high" | "medium" | "low";
            progress?: number;
            project: string;
            startDate?: number;
            status: "brainstorm" | "plan" | "execute" | "validate" | "complete";
            targetDate?: number;
        }, Id<"missions">>;
        get: FunctionReference<"query", "public", {
            missionId: Id<"missions">;
        }, {
            _creationTime: number;
            _id: Id<"missions">;
            agents: Array<string>;
            brief?: string;
            createdAt: number;
            createdBy: string;
            description?: string;
            name: string;
            pilot: string;
            priority: "urgent" | "high" | "medium" | "low";
            progress?: number;
            project: string;
            startDate?: number;
            status: "brainstorm" | "plan" | "execute" | "validate" | "complete";
            targetDate?: number;
            updatedAt: number;
        } | null>;
        list: FunctionReference<"query", "public", {
            limit?: number;
            pilot?: string;
            project?: string;
            status?: "brainstorm" | "plan" | "execute" | "validate" | "complete";
        }, Array<{
            _creationTime: number;
            _id: Id<"missions">;
            agents: Array<string>;
            brief?: string;
            createdAt: number;
            createdBy: string;
            description?: string;
            name: string;
            pilot: string;
            priority: "urgent" | "high" | "medium" | "low";
            progress?: number;
            project: string;
            startDate?: number;
            status: "brainstorm" | "plan" | "execute" | "validate" | "complete";
            targetDate?: number;
            updatedAt: number;
        }>>;
        update: FunctionReference<"mutation", "public", {
            agents?: Array<string>;
            brief?: string;
            description?: string;
            missionId: Id<"missions">;
            name?: string;
            pilot?: string;
            priority?: "urgent" | "high" | "medium" | "low";
            progress?: number;
            project?: string;
            startDate?: number;
            status?: "brainstorm" | "plan" | "execute" | "validate" | "complete";
            targetDate?: number;
        }, null>;
        updateStatus: FunctionReference<"mutation", "public", {
            missionId: Id<"missions">;
            status: "brainstorm" | "plan" | "execute" | "validate" | "complete";
        }, null>;
        updateProgress: FunctionReference<"mutation", "public", {
            missionId: Id<"missions">;
            progress: number;
        }, null>;
    };
    profiles: {
        getProfile: FunctionReference<"query", "public", {
            instanceId?: string;
            orchestratorId?: string;
        }, {
            _creationTime: number;
            _id: Id<"profiles">;
            dynamic: {
                currentTask?: string;
                lastSeen: number;
                sessionCount: number;
            };
            instanceId?: string;
            name: string;
            orchestratorId: string;
            static: {
                capabilities: Array<string>;
                role: string;
                workspace: string;
            };
        } | null>;
        upsertProfile: FunctionReference<"mutation", "public", {
            dynamic?: {
                currentTask?: string;
                lastSeen: number;
                sessionCount: number;
            };
            instanceId?: string;
            name?: string;
            orchestratorId: string;
            static?: {
                capabilities: Array<string>;
                role: string;
                workspace: string;
            };
        }, Id<"profiles">>;
        updateDynamic: FunctionReference<"mutation", "public", {
            currentTask?: string;
            instanceId?: string;
            lastSeen: number;
            orchestratorId: string;
            sessionCountDelta?: number;
        }, null>;
        getProfileWithMemories: FunctionReference<"query", "public", {
            instanceId?: string;
            memoryLimit?: number;
            namespace: string;
            orchestratorId: string;
        }, {
            memories: Array<{
                _id: Id<"memories">;
                content: string;
                createdAt: number;
                createdBy: string;
                type: "user" | "feedback" | "project" | "reference" | "episode";
            }>;
            profile: {
                _creationTime: number;
                _id: Id<"profiles">;
                dynamic: {
                    currentTask?: string;
                    lastSeen: number;
                    sessionCount: number;
                };
                instanceId?: string;
                name: string;
                orchestratorId: string;
                static: {
                    capabilities: Array<string>;
                    role: string;
                    workspace: string;
                };
            } | null;
        }>;
        listProfiles: FunctionReference<"query", "public", {
            orchestratorId?: string;
        }, Array<{
            _creationTime: number;
            _id: Id<"profiles">;
            dynamic: {
                currentTask?: string;
                lastSeen: number;
                sessionCount: number;
            };
            instanceId?: string;
            name: string;
            orchestratorId: string;
            static: {
                capabilities: Array<string>;
                role: string;
                workspace: string;
            };
        }>>;
    };
    recurringTasks: {
        create: FunctionReference<"mutation", "public", {
            assignedTo: string;
            createdBy: string;
            cronExpression: string;
            description?: string;
            priority: "urgent" | "high" | "medium" | "low";
            project?: string;
            tags?: Array<string>;
            title: string;
        }, Id<"recurringTasks">>;
        list: FunctionReference<"query", "public", {
            active?: boolean;
            assignedTo?: string;
            limit?: number;
        }, any>;
        update: FunctionReference<"mutation", "public", {
            assignedTo?: string;
            cronExpression?: string;
            description?: string;
            priority?: "urgent" | "high" | "medium" | "low";
            project?: string;
            recurringTaskId: Id<"recurringTasks">;
            tags?: Array<string>;
            title?: string;
        }, Id<"recurringTasks">>;
        pause: FunctionReference<"mutation", "public", {
            taskId: Id<"recurringTasks">;
        }, any>;
        resume: FunctionReference<"mutation", "public", {
            taskId: Id<"recurringTasks">;
        }, any>;
        remove: FunctionReference<"mutation", "public", {
            taskId: Id<"recurringTasks">;
        }, any>;
    };
    search: {
        hybridSearch: FunctionReference<"action", "public", {
            limit?: number;
            namespace?: string;
            query: string;
            textWeight?: number;
            type?: "user" | "feedback" | "project" | "reference" | "episode";
            vectorWeight?: number;
        }, Array<{
            content: string;
            memoryId: Id<"memories">;
            namespace: string;
            rrfScore: number;
            type: "user" | "feedback" | "project" | "reference" | "episode";
        }>>;
        recall: FunctionReference<"action", "public", {
            limit?: number;
            namespace?: string;
            query: string;
            scoreThreshold?: number;
            type?: "user" | "feedback" | "project" | "reference" | "episode";
        }, Array<{
            content: string;
            memoryId: Id<"memories">;
            namespace: string;
            score: number;
            type: "user" | "feedback" | "project" | "reference" | "episode";
        }>>;
        searchFixPatterns: FunctionReference<"action", "public", {
            limit?: number;
            query: string;
            scoreThreshold?: number;
        }, Array<{
            patternId: string;
            rootCause: string;
            score: number;
            severity: string;
            sourceProject: string;
            stack: Array<string>;
            symptom: string;
            tags: Array<string>;
            validatedFix?: string;
        }>>;
        textSearch: FunctionReference<"action", "public", {
            limit?: number;
            namespace?: string;
            query: string;
            type?: "user" | "feedback" | "project" | "reference" | "episode";
        }, Array<{
            content: string;
            memoryId: Id<"memories">;
            namespace: string;
            type: "user" | "feedback" | "project" | "reference" | "episode";
        }>>;
    };
    tasks: {
        create: FunctionReference<"mutation", "public", {
            assignedTo: string;
            assignedToInstance?: string;
            createdBy: string;
            dependsOn?: Array<Id<"tasks">>;
            description?: string;
            dueDate?: number;
            estimatedMinutes?: number;
            missionId?: Id<"missions">;
            priority: "urgent" | "high" | "medium" | "low";
            project?: string;
            status: "todo" | "in_progress" | "review" | "blocked" | "done";
            tags?: Array<string>;
            title: string;
        }, Id<"tasks">>;
        get: FunctionReference<"query", "public", {
            taskId: Id<"tasks">;
        }, {
            _creationTime: number;
            _id: Id<"tasks">;
            actualMinutes?: number;
            assignedTo: string;
            assignedToInstance?: string;
            claimedByInstance?: string;
            completedAt?: number;
            completionNote?: string;
            createdAt: number;
            createdBy: string;
            dependsOn?: Array<Id<"tasks">>;
            description?: string;
            dueDate?: number;
            estimatedMinutes?: number;
            missionId?: Id<"missions">;
            priority: "urgent" | "high" | "medium" | "low";
            project?: string;
            startedAt?: number;
            status: "todo" | "in_progress" | "review" | "blocked" | "done";
            tags?: Array<string>;
            title: string;
            updatedAt: number;
        } | null>;
        list: FunctionReference<"query", "public", {
            assignedTo?: string;
            assignedToInstance?: string;
            limit?: number;
            project?: string;
            status?: "todo" | "in_progress" | "review" | "blocked" | "done";
        }, Array<{
            _creationTime: number;
            _id: Id<"tasks">;
            actualMinutes?: number;
            assignedTo: string;
            assignedToInstance?: string;
            claimedByInstance?: string;
            completedAt?: number;
            completionNote?: string;
            createdAt: number;
            createdBy: string;
            dependsOn?: Array<Id<"tasks">>;
            description?: string;
            dueDate?: number;
            estimatedMinutes?: number;
            missionId?: Id<"missions">;
            priority: "urgent" | "high" | "medium" | "low";
            project?: string;
            startedAt?: number;
            status: "todo" | "in_progress" | "review" | "blocked" | "done";
            tags?: Array<string>;
            title: string;
            updatedAt: number;
        }>>;
        update: FunctionReference<"mutation", "public", {
            actualMinutes?: number;
            assignedTo?: string;
            assignedToInstance?: string;
            callerOrchestrator?: string;
            completedAt?: number;
            completionNote?: string;
            dependsOn?: Array<Id<"tasks">>;
            description?: string;
            dueDate?: number;
            estimatedMinutes?: number;
            missionId?: Id<"missions">;
            priority?: "urgent" | "high" | "medium" | "low";
            project?: string;
            startedAt?: number;
            status?: "todo" | "in_progress" | "review" | "blocked" | "done";
            tags?: Array<string>;
            taskId: Id<"tasks">;
            title?: string;
        }, null>;
        complete: FunctionReference<"mutation", "public", {
            callerOrchestrator?: string;
            completionNote?: string;
            taskId: Id<"tasks">;
        }, null>;
        start: FunctionReference<"mutation", "public", {
            callerOrchestrator?: string;
            taskId: Id<"tasks">;
        }, null>;
        checkout: FunctionReference<"mutation", "public", {
            callerInstance?: string;
            callerOrchestrator: string;
            taskId: Id<"tasks">;
        }, {
            claimed: boolean;
            reason?: string;
        }>;
        deleteTask: FunctionReference<"mutation", "public", {
            callerOrchestrator?: string;
            taskId: Id<"tasks">;
        }, {
            deleted: boolean;
        }>;
        listByMission: FunctionReference<"query", "public", {
            limit?: number;
            missionId: Id<"missions">;
            status?: "todo" | "in_progress" | "review" | "blocked" | "done";
        }, Array<{
            _creationTime: number;
            _id: Id<"tasks">;
            actualMinutes?: number;
            assignedTo: string;
            assignedToInstance?: string;
            claimedByInstance?: string;
            completedAt?: number;
            completionNote?: string;
            createdAt: number;
            createdBy: string;
            dependsOn?: Array<Id<"tasks">>;
            description?: string;
            dueDate?: number;
            estimatedMinutes?: number;
            missionId?: Id<"missions">;
            priority: "urgent" | "high" | "medium" | "low";
            project?: string;
            startedAt?: number;
            status: "todo" | "in_progress" | "review" | "blocked" | "done";
            tags?: Array<string>;
            title: string;
            updatedAt: number;
        }>>;
        listOverdue: FunctionReference<"query", "public", {
            assignedTo?: string;
            limit?: number;
        }, any>;
    };
    dashboard: {
        getDashboardSummary: FunctionReference<"query", "public", Record<string, never>, {
            activeOrchestrators: Array<{
                _creationTime: number;
                _id: Id<"profiles">;
                dynamic: {
                    currentTask?: string;
                    lastSeen: number;
                    sessionCount: number;
                };
                instanceId?: string;
                name: string;
                orchestratorId: string;
                static: {
                    capabilities: Array<string>;
                    role: string;
                    workspace: string;
                };
            }>;
            openMandates: number;
            recentActivity: Array<{
                actor: string;
                excerpt: string;
                id: string;
                status?: string;
                type: "task" | "message" | "mandate";
                updatedAt: number;
            }>;
            tasksInProgress: number;
            unreadMessages: number;
        }>;
        getProjectSummary: FunctionReference<"query", "public", Record<string, never>, Array<{
            activeOrchestrators: Array<string>;
            missionCount: number;
            name: string;
            tasksByStatus: {
                blocked: number;
                done: number;
                in_progress: number;
                review: number;
                todo: number;
            };
        }>>;
    };
    errorMonitor: {
        addDeployment: FunctionReference<"mutation", "public", {
            deployKeyEnvVar: string;
            deploymentUrl: string;
            githubRepo: string;
            name: string;
            orchestrator: string;
        }, Id<"monitoredDeployments">>;
        removeDeployment: FunctionReference<"mutation", "public", {
            name: string;
        }, null>;
        listDeployments: FunctionReference<"query", "public", Record<string, never>, Array<{
            _creationTime: number;
            _id: Id<"monitoredDeployments">;
            active: boolean;
            createdAt: number;
            deployKeyEnvVar: string;
            deploymentUrl: string;
            githubRepo: string;
            lastCursor?: number;
            name: string;
            orchestrator: string;
        }>>;
        listErrors: FunctionReference<"query", "public", {
            deployment?: string;
            limit?: number;
        }, Array<{
            _creationTime: number;
            _id: Id<"errorLogs">;
            count: number;
            deployment: string;
            errorMessage: string;
            firstSeen: number;
            functionName: string;
            githubRepo?: string;
            hash: string;
            issueNumber?: number;
            lastSeen: number;
            stackTrace?: string;
        }>>;
        getError: FunctionReference<"query", "public", {
            errorId: Id<"errorLogs">;
        }, {
            _creationTime: number;
            _id: Id<"errorLogs">;
            count: number;
            deployment: string;
            errorMessage: string;
            firstSeen: number;
            functionName: string;
            githubRepo?: string;
            hash: string;
            issueNumber?: number;
            lastSeen: number;
            stackTrace?: string;
        } | null>;
    };
    fixPatterns: {
        create: FunctionReference<"mutation", "public", {
            createdBy: string;
            files?: Array<string>;
            linkedIssueIds?: Array<string>;
            rootCause: string;
            severity: "critical" | "major" | "minor";
            sourceProject: string;
            stack: Array<string>;
            symptom: string;
            tags: Array<string>;
            validatedFix?: string;
        }, Id<"fixPatterns">>;
        addAttempt: FunctionReference<"mutation", "public", {
            commit?: string;
            createdBy: string;
            description: string;
            patternId: Id<"fixPatterns">;
            why: string;
            worked: boolean;
        }, Id<"fixAttempts">>;
        validate: FunctionReference<"mutation", "public", {
            patternId: Id<"fixPatterns">;
            validatedFix: string;
        }, null>;
        linkIssue: FunctionReference<"mutation", "public", {
            issueId: string;
            patternId: Id<"fixPatterns">;
        }, null>;
        get: FunctionReference<"query", "public", {
            patternId: Id<"fixPatterns">;
        }, {
            _creationTime: number;
            _id: Id<"fixPatterns">;
            attempts: Array<{
                _id: Id<"fixAttempts">;
                commit?: string;
                createdAt: number;
                createdBy: string;
                description: string;
                why: string;
                worked: boolean;
            }>;
            createdAt: number;
            createdBy: string;
            files?: Array<string>;
            linkedIssueIds?: Array<string>;
            rootCause: string;
            severity: "critical" | "major" | "minor";
            sourceProject: string;
            stack: Array<string>;
            symptom: string;
            tags: Array<string>;
            updatedAt: number;
            validatedFix?: string;
        } | null>;
        listByProject: FunctionReference<"query", "public", {
            limit?: number;
            sourceProject: string;
        }, Array<{
            _creationTime: number;
            _id: Id<"fixPatterns">;
            createdAt: number;
            createdBy: string;
            files?: Array<string>;
            linkedIssueIds?: Array<string>;
            rootCause: string;
            severity: "critical" | "major" | "minor";
            sourceProject: string;
            stack: Array<string>;
            symptom: string;
            tags: Array<string>;
            updatedAt: number;
            validatedFix?: string;
        }>>;
        listAll: FunctionReference<"query", "public", {
            limit?: number;
        }, Array<{
            _creationTime: number;
            _id: Id<"fixPatterns">;
            createdAt: number;
            createdBy: string;
            files?: Array<string>;
            linkedIssueIds?: Array<string>;
            rootCause: string;
            severity: "critical" | "major" | "minor";
            sourceProject: string;
            stack: Array<string>;
            symptom: string;
            tags: Array<string>;
            updatedAt: number;
            validatedFix?: string;
        }>>;
        listByStack: FunctionReference<"query", "public", {
            limit?: number;
            stack: string;
        }, Array<{
            _creationTime: number;
            _id: Id<"fixPatterns">;
            createdAt: number;
            rootCause: string;
            severity: "critical" | "major" | "minor";
            sourceProject: string;
            stack: Array<string>;
            symptom: string;
            tags: Array<string>;
            validatedFix?: string;
        }>>;
    };
    githubRepoMapping: {
        getByRepo: FunctionReference<"query", "public", {
            repo: string;
        }, any>;
        list: FunctionReference<"query", "public", Record<string, never>, any>;
        add: FunctionReference<"mutation", "public", {
            active?: boolean;
            orchestrator: string;
            project: string;
            repo: string;
        }, any>;
        remove: FunctionReference<"mutation", "public", {
            repo: string;
        }, any>;
        seed: FunctionReference<"mutation", "public", {
            mappings: Array<{
                orchestrator: string;
                project: string;
                repo: string;
            }>;
        }, any>;
    };
    issueStatsQueries: {
        getLatest: FunctionReference<"query", "public", {
            limit?: number;
            repo?: string;
        }, Array<{
            _creationTime: number;
            _id: Id<"issueStats">;
            afterVantageOS?: {
                avgTimeToFix?: number;
                medianTimeToFix?: number;
                resolvedIssues: number;
                totalIssues: number;
            };
            avgTimeToFix?: number;
            beforeVantageOS?: {
                avgTimeToFix?: number;
                medianTimeToFix?: number;
                resolvedIssues: number;
                totalIssues: number;
            };
            calculatedAt: number;
            date: string;
            fastestResolution?: number;
            medianTimeToFirstResponse?: number;
            medianTimeToFix?: number;
            repo: string;
            resolvedIssues: number;
            slowestResolution?: number;
            totalIssues: number;
        }>>;
    };
    issues: {
        upsertFromGitHub: FunctionReference<"mutation", "public", {
            body: string;
            githubCreatedAt: number;
            githubUpdatedAt: number;
            htmlUrl: string;
            issueNumber: number;
            labels: Array<string>;
            repo: string;
            status: "open" | "in_progress" | "fixed" | "verified" | "closed";
            title: string;
        }, any>;
        updateStatus: FunctionReference<"mutation", "public", {
            issueNumber: number;
            repo: string;
            status: "open" | "in_progress" | "fixed" | "verified" | "closed";
        }, any>;
        linkCommit: FunctionReference<"mutation", "public", {
            commitSha: string;
            fixedBy: string;
            issueNumber: number;
            repo: string;
        }, any>;
        linkTask: FunctionReference<"mutation", "public", {
            issueNumber: number;
            repo: string;
            taskId: string;
        }, any>;
        verify: FunctionReference<"mutation", "public", {
            issueNumber: number;
            repo: string;
            verifiedBy: string;
        }, any>;
        close: FunctionReference<"mutation", "public", {
            issueNumber: number;
            repo: string;
        }, any>;
        getByRepoNumber: FunctionReference<"query", "public", {
            issueNumber: number;
            repo: string;
        }, any>;
        listByProject: FunctionReference<"query", "public", {
            limit?: number;
            project: string;
            status?: "open" | "in_progress" | "fixed" | "verified" | "closed";
        }, any>;
        listByOrchestrator: FunctionReference<"query", "public", {
            assignedOrchestrator: string;
            limit?: number;
            status?: "open" | "in_progress" | "fixed" | "verified" | "closed";
        }, any>;
        listByStatus: FunctionReference<"query", "public", {
            limit?: number;
            status: "open" | "in_progress" | "fixed" | "verified" | "closed";
        }, Array<any>>;
        getStats: FunctionReference<"query", "public", {
            project?: string;
        }, any>;
        createExternal: FunctionReference<"mutation", "public", {
            assignedOrchestrator: string;
            body: string;
            externalIssueNumber: number;
            externalIssueUrl: string;
            externalRepo: string;
            forkRepo?: string;
            priority?: "urgent" | "high" | "medium" | "low";
            project?: string;
            title: string;
        }, Id<"issues">>;
        updatePrStatus: FunctionReference<"mutation", "public", {
            issueNumber: number;
            prStatus: "draft" | "open" | "merged" | "closed";
            prUrl: string;
            repo: string;
        }, null>;
        listExternalOpen: FunctionReference<"query", "public", {
            limit?: number;
            prStatus?: "draft" | "open" | "merged" | "closed";
        }, Array<{
            _creationTime: number;
            _id: Id<"issues">;
            assignedOrchestrator: string;
            externalIssueUrl?: string;
            externalRepo?: string;
            issueNumber: number;
            prStatus?: string;
            prUrl?: string;
            repo: string;
            status: string;
            title: string;
        }>>;
    };
    missionTemplates: {
        getByName: FunctionReference<"query", "public", {
            name: string;
        }, {
            _creationTime: number;
            _id: Id<"missionTemplates">;
            createdAt: number;
            createdBy: string;
            description?: string;
            isDefault: boolean;
            name: string;
            steps: Array<{
                description: string;
                tags?: Array<string>;
                title: string;
            }>;
            updatedAt: number;
        } | null>;
        upsert: FunctionReference<"mutation", "public", {
            createdBy: string;
            description?: string;
            isDefault?: boolean;
            name: string;
            steps: Array<{
                description: string;
                tags?: Array<string>;
                title: string;
            }>;
        }, Id<"missionTemplates">>;
    };
};
export type InternalApiType = {};
