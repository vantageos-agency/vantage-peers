#!/usr/bin/env python3
"""Warn if a file has >500 lines added in a single edit."""
import json, sys

def main():
    input_data = json.loads(sys.stdin.read())
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})
    tool_output = input_data.get("tool_output", "")
    
    if tool_name not in ("Write", "Edit"):
        return 0
    
    # For Write, check content length
    if tool_name == "Write":
        content = tool_input.get("content", "")
        lines = content.count('\n') + 1
        if lines > 500:
            print(json.dumps({
                "decision": "block", 
                "reason": f"BLOCKED: File has {lines} lines (>500). Decompose into smaller components. Each component should be in its own file. Never create monolithic files."
            }))
            return 0
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
