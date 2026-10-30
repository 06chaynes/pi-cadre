#!/usr/bin/env bash
# Local SearXNG search for Pi web tools (pi-web-access), in Docker, reachable only from this machine.
#
# Usage: launchers/searxng.sh setup|status|teardown [--purge]
#   setup     write the config (once) and start the container, then wait until it answers
#   status    container state and which search engines answered a test query
#   teardown  stop and remove the container; --purge also deletes the config directory
#
# Environment: SEARXNG_PORT (default 8888), SEARXNG_CONFIG_DIR (default ~/.config/pi-cadre/searxng),
# SEARXNG_CONTAINER (default pi-cadre-searxng).
set -euo pipefail

# A release at least two weeks old when this script was written; update deliberately.
IMAGE="searxng/searxng:2026.10.16-ff8f5ddcc"
PORT="${SEARXNG_PORT:-8888}"
CONFIG_DIR="${SEARXNG_CONFIG_DIR:-$HOME/.config/pi-cadre/searxng}"
CONTAINER="${SEARXNG_CONTAINER:-pi-cadre-searxng}"
URL="http://127.0.0.1:$PORT"

die() { echo "searxng: $*" >&2; exit 1; }

need_docker() {
  command -v docker >/dev/null || die "docker is not installed (https://docs.docker.com/get-docker/)"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running; start Docker Desktop (or your daemon) and retry"
}

write_config() {
  [ -f "$CONFIG_DIR/settings.yml" ] && return
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  local secret
  secret="$(openssl rand -hex 32)"
  # JSON output is what Pi web tools read. The engines below answered in testing; Brave and DuckDuckGo often
  # rate-limit or show a CAPTCHA to frequent automated queries.
  cat > "$CONFIG_DIR/settings.yml" <<EOF
use_default_settings: true
server:
  secret_key: "$secret"
  limiter: false
  image_proxy: false
search:
  formats:
    - html
    - json
engines:
  - name: bing
    disabled: false
  - name: yahoo
    disabled: false
  - name: mojeek
    disabled: false
  - name: startpage
    disabled: false
EOF
  chmod 600 "$CONFIG_DIR/settings.yml"
  echo "Wrote $CONFIG_DIR/settings.yml"
}

answering() { # prints the engines that answered a test query, or nothing
  curl -s --max-time 20 "$URL/search?q=open+source+search&format=json" 2>/dev/null |
    python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ".join(sorted({e for r in d["results"] for e in r.get("engines", [])})))' 2>/dev/null || true
}

setup() {
  need_docker
  write_config
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker start "$CONTAINER" >/dev/null
  else
    docker run -d --name "$CONTAINER" --restart unless-stopped -p "127.0.0.1:$PORT:8080" -v "$CONFIG_DIR:/etc/searxng" "$IMAGE" >/dev/null
  fi
  echo "Waiting for SearXNG on $URL ..."
  local engines=""
  for _ in $(seq 60); do
    engines="$(answering)"
    [ -n "$engines" ] && break
    sleep 3
  done
  [ -n "$engines" ] || die "SearXNG did not answer; see: docker logs $CONTAINER"
  echo "SearXNG is up on $URL (answering engines: $engines)."
  cat <<EOF

To use it from Pi, install pi-web-access and put this in web-search.json in your Pi agent directory
(~/.pi/agent/web-search.json by default). "provider": "searxng" keeps every search on this instance:

  { "provider": "searxng", "searxngBaseUrl": "$URL", "workflow": "none" }
EOF
}

status() {
  need_docker
  local state
  state="$(docker ps -a --filter "name=^${CONTAINER}$" --format '{{.Status}}')"
  [ -n "$state" ] || { echo "$CONTAINER: not created (run: $0 setup)"; return; }
  echo "$CONTAINER: $state"
  local engines
  engines="$(answering)"
  if [ -n "$engines" ]; then echo "Answering engines: $engines"; else echo "No engine answered a test query on $URL"; fi
}

teardown() {
  need_docker
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker rm -f "$CONTAINER" >/dev/null
    echo "Removed container $CONTAINER"
  else
    echo "No container $CONTAINER"
  fi
  if [ "${1:-}" = "--purge" ]; then
    rm -rf "$CONFIG_DIR"
    echo "Deleted $CONFIG_DIR"
  fi
}

case "${1:-}" in
  setup) setup ;;
  status) status ;;
  teardown) teardown "${2:-}" ;;
  -h|--help|"") sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '$1' (setup|status|teardown)" ;;
esac
