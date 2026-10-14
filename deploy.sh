#!/bin/sh
set -eu
cd "$(dirname "$0")"
action=${1:-help}
if [ "$action" = init ]; then
  docker run --rm --network none --user "$(id -u):$(id -g)" \
    -v "$(pwd):/app" -w /app oven/bun:1.4.2-slim \
    bun docker/prepare-env.ts "${2:-}"
  exit 0
fi
if [ "$action" = help ]; then
  echo 'Usage: ./deploy.sh init https://brief.example.com | up | update | logs | down'
  exit 0
fi
if [ ! -f .env.production ]; then
  echo 'Run ./deploy.sh init https://brief.example.com first.' >&2
  exit 1
fi
compose() { docker compose --env-file .env.production -f compose.production.yml "$@"; }
case "$action" in
  up) compose up -d --build --wait --wait-timeout 3600 ;;
  update)
    compose build
    compose stop web api worker
    compose run --rm migrate
    compose up -d --wait --wait-timeout 3600
    ;;
  logs) compose logs -f --tail=100 api worker web ollama ;;
  down) compose down ;;
  *) echo "Unknown command: $action" >&2; exit 1 ;;
esac
