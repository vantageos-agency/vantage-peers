import { ConvexError } from "convex/values";

// A task carries a project, or it is not created (tasks k17c7mz2n765wacn6qxcgy00vn8hsa58
// and k174n9czcs7x77j2hrvqz6n4hh8hrnsb): billing groups done tasks by project, and a
// task without one lands in noProjectCount, outside every invoice line. This is the ONE
// helper every door that inserts into `tasks` uses. Refused with a stable code naming
// the field and the door. Returns the trimmed value, so "p" and "p " never split one
// project into two billing lines.
export const TASK_PROJECT_REQUIRED = "TASK_PROJECT_REQUIRED";

/** The trimmed project, or `null` when it is missing, empty or whitespace. */
export function trimmedProjectOrNull(
	project: string | undefined,
): string | null {
	const trimmed = project?.trim() ?? "";
	return trimmed === "" ? null : trimmed;
}

export function taskProjectRefusal(door: string): string {
	return `${TASK_PROJECT_REQUIRED}: ${door} needs a non-empty \`project\` (the billing line this task belongs to) — ${JSON.stringify({ field: "project", door })}`;
}

export function requireProject(
	project: string | undefined,
	door: string,
): string {
	const trimmed = trimmedProjectOrNull(project);
	if (trimmed === null) throw new ConvexError(taskProjectRefusal(door));
	return trimmed;
}
