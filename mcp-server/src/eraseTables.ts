// The tables the erase_row tool names: the COVERED list of the one erase mechanism in the
// backend (convex/lib/eraseRow.ts `ERASE_TABLES`). Task k170t9bg650dyw6hxjj627p9fx8hhpeq.
//
// The MCP server is a separate package and cannot import the backend source, so the list is
// carried here and PINNED to the backend's by test/erase-row-tables.test.ts, which parses
// `ERASE_TABLES` out of convex/lib/eraseRow.ts and fails on any difference in either
// direction. A table covered in the backend but missing here is a table the tool cannot
// erase; a table here and not in the backend is an enum value Convex would refuse.

export const ERASE_ROW_TABLES = [
	"memories",
	"messages",
	"missions",
	"tasks",
	"recurringTasks",
	"briefingNotes",
	"diary",
	"debateRooms",
	"issues",
	"businessUnits",
	"debateTemplates",
] as const;
