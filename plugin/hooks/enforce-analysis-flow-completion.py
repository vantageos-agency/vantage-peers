#!/usr/bin/env python3
"""
Hook: enforce-analysis-flow-completion
Trigger: PreToolUse on complete_task
Purpose: When completing an analysis task, verify all 3 deliverables are mentioned
in the completionNote. Blocks completion if deliverables are missing.
"""
import json
import sys
import re

def main():
    input_data = json.loads(sys.stdin.read())
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    if tool_name != "mcp__vantage-peers__complete_task":
        print(json.dumps({"decision": "approve"}))
        return

    completion_note = tool_input.get("completionNote", "").lower()
    
    if not completion_note:
        print(json.dumps({
            "decision": "block",
            "reason": "BLOCKED: completionNote is empty. Describe what was done."
        }))
        return

    # Check if this looks like an analysis task completion
    analysis_keywords = ["analy", "repo", "report", "article", "research"]
    is_analysis = any(kw in completion_note for kw in analysis_keywords)
    
    if not is_analysis:
        print(json.dumps({"decision": "approve"}))
        return

    missing = []
    
    rapport_kw = ["rapport", "report", "docs/", "analysis", "analyse"]
    if not any(kw in completion_note for kw in rapport_kw):
        missing.append("RAPPORT TECHNIQUE")

    article_kw = ["article", "blog", "publi", "published"]
    if not any(kw in completion_note for kw in article_kw):
        missing.append("ARTICLE BLOG")

    storage_kw = ["easyvibecoding", "convex", "stored", "stocke", "hip-parrot"]
    if not any(kw in completion_note for kw in storage_kw):
        missing.append("STOCKAGE EASYVIBECODING")

    if missing:
        missing_list = ", ".join(missing)
        print(json.dumps({
            "decision": "block",
            "reason": f"BLOCKED: Analysis task missing deliverables in completionNote: {missing_list}. Complete ALL 3 deliverables before closing."
        }))
    else:
        print(json.dumps({"decision": "approve"}))

if __name__ == "__main__":
    main()
