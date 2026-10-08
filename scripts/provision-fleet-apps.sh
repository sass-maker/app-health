#!/usr/bin/env bash
# Provision App Health apps, ingest keys, and origin-pinned public keys for
# every fleet product wired with the drop-in client. Idempotent via
# .fleet-local/app-health-provisioning.json (metadata only — never keys).
#
# Usage:
#   export APP_HEALTH_OWNER_TOKEN=<owner token from health.sassmaker.com>
#   ./scripts/provision-fleet-apps.sh            # provision everything missing
#   ./scripts/provision-fleet-apps.sh --dry-run  # show the plan only
#
# Server products get `wrangler secret put APP_HEALTH_INGEST_KEY` in their
# worker directory. Browser products get the ahk_pub_ key written into the
# __PUBLIC_KEY__ slot of each listed file (redeploy afterwards).

set -euo pipefail

API="https://health.sassmaker.com"
FLEET="${FLEET_ROOT:-/Users/sarthak/Desktop/fleet}"
STATE="$FLEET/app-health/.fleet-local/fleet-provisioning.json"
DRY_RUN="${1:-}"

if [ "$DRY_RUN" != "--dry-run" ]; then
  : "${APP_HEALTH_OWNER_TOKEN:?Set APP_HEALTH_OWNER_TOKEN (owner token from the App Health dashboard)}"
fi

mkdir -p "$(dirname "$STATE")"
[ -f "$STATE" ] || echo '{}' > "$STATE"

jget() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

state_get() { jget ".get('$1',{})" < "$STATE"; }

create_app() { # name -> json {app_id, env_id, ingest_key}
  curl -fsS -X POST "$API/v1/apps" \
    -H "Authorization: Bearer $APP_HEALTH_OWNER_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"environment\":\"production\"}"
}

create_public_key() { # app_id env_id origins_json -> raw key
  curl -fsS -X POST "$API/v1/public-keys" \
    -H "Authorization: Bearer $APP_HEALTH_OWNER_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"app_id\":\"$1\",\"environment_id\":\"$2\",\"allowed_origins\":$3}" | jget "['key']"
}

save_state() {
  python3 - "$STATE" "$1" "$2" "$3" "$4" <<'PY'
import json, sys
path, pid, app_id, env_id, pub = sys.argv[1:6]
d = json.load(open(path))
d[pid] = {"app_id": app_id, "environment_id": env_id, "public_key": pub}
json.dump(d, open(path, "w"), indent=2)
PY
}

patch_slot() { # file pubkey
  if grep -q '__PUBLIC_KEY__' "$1"; then
    perl -pi -e "s/__PUBLIC_KEY__/$2/" "$1"
    echo "    patched $1"
  fi
}

patch_ios_landings() { # product app_id pubkey
  python3 - "$FLEET/ios-landings/src/lib/app-health.mjs" "$1" "$2" "$3" <<'PY'
import re, sys
path, product, app_id, pub = sys.argv[1:5]
s = open(path).read()
if f'{product}:' in s:
    print(f'    ios-landings already has {product}')
    sys.exit(0)
entry = (f'  {product}: Object.freeze({{\n'
         f'    projectId: "{app_id}",\n'
         f'    publicKey: "{pub}",\n'
         f'  }}),\n')
s = s.replace('\n});\n\nexport function appHealthConfigFor', '\n' + entry + '});\n\nexport function appHealthConfigFor')
open(path, 'w').write(s)
print(f'    ios-landings +{product}')
PY
}

# id | display name | wrangler dir ('' = none) | origins (comma-sep, '' = none) | browser key files (space-sep)
MANIFEST=$(cat <<'EOF'
meme-lab|Meme Lab|meme-lab|https://memes.significanthobbies.com|meme-lab/worker/public/app-health-log.js
field-track|Field Track|field-track|https://field-track.sassmaker.com|field-track/public/app-health-log.js
reddit-insights|Reddit Insights|reddit-insights/workers/daily-collector|https://reddit-insights.highsignal.app|reddit-insights/scripts/browser/app-health-log.js
fleet-social|Fleet Social|fleet-social||
mentionpilot|MentionPilot|mentionpilot/apps/web|https://mention.highsignal.app|mentionpilot/apps/web/public/app-health-log.js
daddyrad|DaddyRad||https://daddyrad.com,https://www.daddyrad.com|daddyrad/site/public/app-health-log.js
every-song|Every Song Is a Website||https://music.significanthobbies.com|every-song-is-a-website/shared/app-health.js
war-chest|War Chest||https://warchest.significanthobbies.com|war-chest/site/app-health-log.js
mashup|Mashup||https://mashup.highsignal.app|mashup/web/public/app-health-log.js
web-playables|Web Playables||https://idle.aliveville.com|web-playables/apps/hub/public/app-health-log.js
agent-testing|Agent Testing||https://browser-agents.sarthakagrawal.dev|agent-testing/site/app-health-log.js
aliveville|Aliveville||https://aliveville.com|aliveville/web3d/public/app-health-log.js
browserdaddy|BrowserDaddy||https://browser.daddyrad.com|IOS:browserdaddy
contextdaddy|ContextDaddy||https://context.daddyrad.com|IOS:contextdaddy
performancedaddy|PerformanceDaddy||https://performance.daddyrad.com|IOS:performancedaddy
motion|Motion||https://motion.significanthobbies.com|IOS:motion
indulge|Indulge||https://indulge.significanthobbies.com|IOS:indulge
EOF
)

echo "$MANIFEST" | while IFS='|' read -r id name wdir origins files; do
  [ -z "$id" ] && continue
  existing=$(state_get "$id")
  app_id=$(echo "$existing" | jget ".get('app_id','')" 2>/dev/null || true)
  if [ -n "$app_id" ]; then
    echo "skip $id (already provisioned: $app_id)"
    continue
  fi
  echo "== $id ($name)"
  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "    would create app, ${wdir:+secret in $wdir, }origins: ${origins:-none}, files: ${files:-none}"
    continue
  fi
  resp=$(create_app "$name") || { echo "    FAILED create_app"; continue; }
  app_id=$(echo "$resp" | jget "['app']['id']")
  env_id=$(echo "$resp" | jget "['environment']['id']")
  ingest_key=$(echo "$resp" | jget "['key']['key']")
  echo "    app_id=$app_id env=$env_id"
  if [ -n "$wdir" ]; then
    (cd "$FLEET/$wdir" && printf '%s' "$ingest_key" | npx wrangler secret put APP_HEALTH_INGEST_KEY >/dev/null 2>&1) \
      && echo "    secret set in $wdir" || echo "    !! secret put failed in $wdir — set manually"
  fi
  pub=""
  if [ -n "$origins" ]; then
    ojson=$(python3 -c "import json; print(json.dumps('$origins'.split(',')))")
    pub=$(create_public_key "$app_id" "$env_id" "$ojson") || { echo "    FAILED public-key"; pub=""; }
    [ -n "$pub" ] && echo "    public key created"
  fi
  for f in $files; do
    case "$f" in
      IOS:*) [ -n "$pub" ] && patch_ios_landings "${f#IOS:}" "$app_id" "$pub" ;;
      *) [ -n "$pub" ] && patch_slot "$FLEET/$f" "$pub" ;;
    esac
  done
  save_state "$id" "$app_id" "$env_id" "$pub"
done

echo
echo "Done. State (ids only, no secrets): $STATE"
echo "Next: redeploy browser surfaces so the new keys go live."
