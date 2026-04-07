#!/bin/bash
# Seed GitHub issues from MyShortReel-beta into VantagePeers issues table
# Usage: bash scripts/seed-issues.sh [--closed]
#
# --closed: also seed the 10 most recent closed issues

set -euo pipefail
cd "$(dirname "$0")/.."

REPO="myreeldream-ai/MyShortReel-beta"

echo "=== Seeding OPEN issues from $REPO ==="
gh issue list --repo "$REPO" --state open \
  --json number,title,body,labels,createdAt,updatedAt,url --limit 100 | \
python3 -c "
import json, sys, subprocess
from datetime import datetime

issues = json.load(sys.stdin)
status = sys.argv[1] if len(sys.argv) > 1 else 'open'
count = 0
failed = 0
for issue in issues:
    labels = [l['name'] for l in issue.get('labels', [])]
    body = (issue.get('body') or '')[:2000]
    created = int(datetime.fromisoformat(issue['createdAt'].replace('Z', '+00:00')).timestamp() * 1000)
    updated = int(datetime.fromisoformat(issue['updatedAt'].replace('Z', '+00:00')).timestamp() * 1000)

    args = json.dumps({
        'repo': '$REPO',
        'issueNumber': issue['number'],
        'title': issue['title'],
        'body': body,
        'htmlUrl': issue['url'],
        'labels': labels,
        'status': status,
        'githubCreatedAt': created,
        'githubUpdatedAt': updated,
    })
    result = subprocess.run(
        ['npx', 'convex', 'run', 'issues:upsertFromGitHub', args],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode == 0:
        count += 1
        print(f'  OK  #{issue[\"number\"]}: {issue[\"title\"][:60]}')
    else:
        failed += 1
        print(f'  FAIL #{issue[\"number\"]}: {result.stderr[:120]}')
print(f'\n  Status={status} | Seeded={count} | Failed={failed}')
" "open"

if [[ "${1:-}" == "--closed" ]]; then
  echo ""
  echo "=== Seeding CLOSED issues (last 10) from $REPO ==="
  gh issue list --repo "$REPO" --state closed \
    --json number,title,body,labels,createdAt,updatedAt,url --limit 10 | \
  python3 -c "
import json, sys, subprocess
from datetime import datetime

issues = json.load(sys.stdin)
status = 'closed'
count = 0
failed = 0
for issue in issues:
    labels = [l['name'] for l in issue.get('labels', [])]
    body = (issue.get('body') or '')[:2000]
    created = int(datetime.fromisoformat(issue['createdAt'].replace('Z', '+00:00')).timestamp() * 1000)
    updated = int(datetime.fromisoformat(issue['updatedAt'].replace('Z', '+00:00')).timestamp() * 1000)

    args = json.dumps({
        'repo': '$REPO',
        'issueNumber': issue['number'],
        'title': issue['title'],
        'body': body,
        'htmlUrl': issue['url'],
        'labels': labels,
        'status': status,
        'githubCreatedAt': created,
        'githubUpdatedAt': updated,
    })
    result = subprocess.run(
        ['npx', 'convex', 'run', 'issues:upsertFromGitHub', args],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode == 0:
        count += 1
        print(f'  OK  #{issue[\"number\"]}: {issue[\"title\"][:60]}')
    else:
        failed += 1
        print(f'  FAIL #{issue[\"number\"]}: {result.stderr[:120]}')
print(f'\n  Status={status} | Seeded={count} | Failed={failed}')
"
fi

echo ""
echo "=== Verifying stats ==="
npx convex run issues:getStats '{}'
