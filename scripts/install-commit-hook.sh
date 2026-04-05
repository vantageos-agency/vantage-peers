#!/bin/bash
# Install the commit-msg hook on all VPS workspaces
# Replaces Co-Authored-By, strips Claude Code attribution, adds MTTR

HOOK_CONTENT='#!/bin/bash
# VantageOS Team commit-msg hook
COMMIT_MSG_FILE="$1"
DATE=$(date +%Y-%m-%d)
TIME=$(date +%H:%M)

# Detect orchestrator from workspace path
WORKSPACE=$(pwd)
case "$WORKSPACE" in
  */myreeldream*) ORCH="Omega"; TEAM="VantageOS Team Dev" ;;
  */vantage-memory*|*/vantage-peers*) ORCH="Sigma"; TEAM="VantageOS Team Infra" ;;
  */vantage-starter*) ORCH="Tau"; TEAM="VantageOS Team Frontend" ;;
  */perfect-ai-agent*) ORCH="Phi"; TEAM="VantageOS Team Product" ;;
  */ElPi*) ORCH="Pi"; TEAM="VantageOS Team Lead" ;;
  *) ORCH="Agent"; TEAM="VantageOS Team" ;;
esac

# Replace Co-Authored-By line with VantageOS signature
sed -i "s/Co-Authored-By:.*$/Orchestrator: $ORCH — $TEAM | $DATE $TIME/" "$COMMIT_MSG_FILE"

# Remove "Generated with Claude Code" lines
sed -i "/🤖.*Generated with/d" "$COMMIT_MSG_FILE"
sed -i "/Generated with \[Claude Code\]/d" "$COMMIT_MSG_FILE"
sed -i "/Generated with Claude Code/d" "$COMMIT_MSG_FILE"

# MTTR: if commit references an issue (#NNN), calculate fix time
ISSUE_NUM=$(grep -oP '"'"'(?<=#)\d+'"'"' "$COMMIT_MSG_FILE" | head -1)
if [ -n "$ISSUE_NUM" ] && command -v gh &>/dev/null; then
  CREATED=$(gh issue view "$ISSUE_NUM" --json createdAt --jq '"'"'.createdAt'"'"' 2>/dev/null)
  if [ -n "$CREATED" ] && [ "$CREATED" != "null" ]; then
    CREATED_TS=$(date -d "$CREATED" +%s 2>/dev/null)
    NOW_TS=$(date +%s)
    if [ -n "$CREATED_TS" ]; then
      DIFF_MIN=$(( (NOW_TS - CREATED_TS) / 60 ))
      CREATED_SHORT=$(date -d "$CREATED" +"%H:%M" 2>/dev/null)
      echo "" >> "$COMMIT_MSG_FILE"
      echo "Fix pushed in: ${DIFF_MIN} min (issue #${ISSUE_NUM} opened ${CREATED_SHORT} → commit ${TIME})" >> "$COMMIT_MSG_FILE"
    fi
  fi
fi
'

REPOS=(
  "/root/coding/vantage-memory"
  "/root/coding/myreeldream"
  "/home/elpi/coding/vantage-starter"
  "/home/elpi/coding/perfect-ai-agent"
  "/home/elpi/coding/vantage-peers-site"
  "/home/elpi/coding/ElPi Corp"
)

for repo in "${REPOS[@]}"; do
  if [ -d "$repo/.git" ]; then
    HOOK_PATH="$repo/.git/hooks/commit-msg"
    echo "$HOOK_CONTENT" > "$HOOK_PATH"
    chmod +x "$HOOK_PATH"
    echo "Installed: $HOOK_PATH"
  else
    echo "Skipped (no .git): $repo"
  fi
done
