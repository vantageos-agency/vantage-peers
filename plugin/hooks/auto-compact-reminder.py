#!/usr/bin/env python3
import json, sys, hashlib, os

def main():
    try:
        data = json.loads(sys.stdin.read())
    except:
        print(json.dumps({}))
        return 0

    cwd = os.getcwd()
    workspace_hash = hashlib.md5(cwd.encode()).hexdigest()[:8]
    counter_file = f"/tmp/.claude-compact-counter-{workspace_hash}"

    count = 0
    if os.path.exists(counter_file):
        try:
            with open(counter_file) as f:
                count = int(f.read().strip())
        except:
            count = 0
    count += 1
    with open(counter_file, "w") as f:
        f.write(str(count))

    FIRST_THRESHOLD = 35
    REPEAT_INTERVAL = 15

    should_remind = False
    if count == FIRST_THRESHOLD:
        should_remind = True
    elif count > FIRST_THRESHOLD and (count - FIRST_THRESHOLD) % REPEAT_INTERVAL == 0:
        should_remind = True

    if should_remind:
        msg = (
            f"[AUTO-COMPACT] {count} tool calls this session. "
            "Context is growing large. Consider running /compact to reduce token usage. "
            "If mid-task, finish the current task first, then compact."
        )
        print(json.dumps({"hookSpecificOutput": {"additionalContext": msg}}))
    else:
        print(json.dumps({}))

    return 0

if __name__ == "__main__":
    sys.exit(main())
