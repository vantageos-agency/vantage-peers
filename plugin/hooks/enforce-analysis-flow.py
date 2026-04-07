#!/usr/bin/env python3
"""
Hook: enforce-analysis-flow
Trigger: PreToolUse on create_task
Purpose: When a task contains a URL (GitHub repo or web article), enforce the full analysis flow:
  1. Rapport/analyse technique
  2. Article blog
  3. Stockage EasyVibeCoding
Blocks task creation if any of the 3 deliverables is missing from the description.
"""
import json
import sys
import re

def main():
    input_data = json.loads(sys.stdin.read())
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    # Only check create_task
    if tool_name != "mcp__vantage-peers__create_task":
        print(json.dumps({"decision": "approve"}))
        return

    description = tool_input.get("description", "")
    title = tool_input.get("title", "")
    combined = f"{title} {description}".lower()

    # Detect URLs in the task
    url_patterns = [
        r'https?://github\.com/[^\s]+',
        r'https?://[^\s]+\.(com|io|dev|xyz|org|net|ai)/[^\s]*',
    ]

    has_url = False
    for pattern in url_patterns:
        if re.search(pattern, combined):
            has_url = True
            break

    if not has_url:
        print(json.dumps({"decision": "approve"}))
        return

    # Check if this is an analysis/research task (not a fix/deploy task)
    analysis_keywords = ["analy", "repo", "article", "research", "évalue", "explore", "audit", "review repo", "scrape", "étudi"]
    is_analysis = any(kw in combined for kw in analysis_keywords)

    # Exclude fix/deploy/mission tasks
    fix_keywords = ["fix", "deploy", "seed", "migration", "webhook", "irp", "hotfix", "pr #", "merge"]
    is_fix = any(kw in combined for kw in fix_keywords)

    if not is_analysis or is_fix:
        print(json.dumps({"decision": "approve"}))
        return

    # Enforce 3 deliverables
    missing = []

    # Check for rapport/analysis output
    rapport_keywords = ["rapport", "report", "docs/", "analyse technique", "architecture", "inventory", "tools inventory"]
    if not any(kw in combined for kw in rapport_keywords):
        missing.append("RAPPORT TECHNIQUE (docs/ ou analyse structurée)")

    # Check for article
    article_keywords = ["article", "blog", "publi", "content", "write-up"]
    if not any(kw in combined for kw in article_keywords):
        missing.append("ARTICLE BLOG (pour EasyVibeCoding blog)")

    # Check for EasyVibeCoding storage
    storage_keywords = ["easyvibecoding", "convex", "stockage", "stocke", "store", "hip-parrot"]
    if not any(kw in combined for kw in storage_keywords):
        missing.append("STOCKAGE EASYVIBECODING (Convex hip-parrot-213)")

    if missing:
        missing_list = "\n  - ".join(missing)
        print(json.dumps({
            "decision": "block",
            "reason": f"""BLOCKED: Task contains a URL for analysis but is missing required deliverables.

The FULL analysis flow requires 3 outputs:
  1. Rapport technique (docs/ file with structured analysis)
  2. Article blog (published via blog pipeline)
  3. Stockage EasyVibeCoding (Convex hip-parrot-213)

Missing:
  - {missing_list}

Add ALL 3 deliverables to the task description before creating."""
        }))
    else:
        print(json.dumps({"decision": "approve"}))

if __name__ == "__main__":
    main()
