#!/usr/bin/env python3
"""Block Agent briefs that say 'build the whole page' without listing components."""
import json, sys, re

def main():
    input_data = json.loads(sys.stdin.read())
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})
    
    if tool_name != "Agent":
        return 0
    
    prompt = tool_input.get("prompt", "")
    
    # Check for vague briefs
    vague_patterns = [
        r"build the (?:whole|entire|full) page",
        r"create the (?:whole|entire|full) page",
        r"implement everything",
        r"write all the code",
    ]
    
    for pattern in vague_patterns:
        if re.search(pattern, prompt, re.IGNORECASE):
            print(json.dumps({
                "decision": "block",
                "reason": f"BLOCKED: Vague brief detected ('{pattern}'). Agent briefs must list specific components to use or create. Decompose into smaller tasks with specific file targets."
            }))
            return 0
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
