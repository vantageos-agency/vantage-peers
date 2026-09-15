cd /tmp/vr-pull && K=$(grep -E '^CONVEX_DEPLOY_KEY_VANTAGE_REGISTRY=.+' $W/.env.local | tail -1); pub() { kind="$1"; fn="$2"; src="$3"; python3 -c '
import json, sys
body = open(sys.argv[1]).read()
json.dump({"name": sys.argv[2], "content": body}, open(".args.json", "w"))
' "$src" "$kind" && CONVEX_DEPLOY_KEY="${K#*=}" node_modules/.bin/convex run "$fn" "$(cat .args.json)" && rm -f .args.json; }; pub hook hookContent:upsertHookContent /tmp/vr-pull/hook.py
