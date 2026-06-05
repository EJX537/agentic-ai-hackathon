#!/bin/bash
# Agentic AI Hub — management CLI
# Usage: ./manage.sh [start|stop|restart|logs|status]

PIDFILE="/tmp/agentic-hub.pid"
LOGFILE="/tmp/agentic-hub.log"

DOCKER_NAME="rocketride-engine"

start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "❌ Already running (PID $(cat "$PIDFILE"))"
    exit 1
  fi

  # Start Docker engine if not running
  if docker ps --filter "name=$DOCKER_NAME" --format '{{.Names}}' 2>/dev/null | grep -q "$DOCKER_NAME"; then
    echo "✅ Docker engine already running"
  else
    echo "[Docker] Starting $DOCKER_NAME..."
    docker start "$DOCKER_NAME" 2>/dev/null || \
      docker run --name "$DOCKER_NAME" -d -p 5565:5565 --restart unless-stopped \
        --platform linux/amd64 \
        ghcr.io/rocketride-org/rocketride-engine:latest
    # Wait for engine to be ready
    for i in $(seq 1 15); do
      sleep 2
      if docker ps --filter "name=$DOCKER_NAME" --format '{{.Status}}' 2>/dev/null | grep -q "healthy\|starting\|Up"; then
        echo "[Docker] Engine ready ($(docker ps --filter "name=$DOCKER_NAME" --format '{{.Status}}'))"
        break
      fi
    done
  fi

  cd "$(dirname "$0")" || exit 1
  nohup bun run src/index.ts > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  echo "✅ Started (PID $!)"
  echo "   tail -f $LOGFILE"
}

stop() {
  # Stop agent
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    kill "$PID" 2>/dev/null && echo "✅ Stopped (PID $PID)" || echo "❌ Failed to stop agent"
    rm -f "$PIDFILE"
  else
    echo "⚠️  Agent not running"
  fi

  # Stop Docker engine
  if docker ps --filter "name=$DOCKER_NAME" --format '{{.Names}}' 2>/dev/null | grep -q "$DOCKER_NAME"; then
    echo "[Docker] Stopping $DOCKER_NAME..."
    docker stop "$DOCKER_NAME" >/dev/null 2>&1 && echo "✅ Docker engine stopped"
  else
    echo "⚠️  Docker engine not running"
  fi
}

status() {
  echo "── Agent ──"
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "  ✅ Running (PID $(cat "$PIDFILE"))"
  else
    echo "  ❌ Not running"
    [ -f "$PIDFILE" ] && rm -f "$PIDFILE"
  fi
  echo "── Docker ──"
  if docker ps --filter "name=$DOCKER_NAME" --format 'table {{.Names}}	{{.Status}}' 2>/dev/null | grep -q engine; then
    docker ps --filter "name=$DOCKER_NAME" --format '  ✅ {{.Names}} ({{.Status}})'
  else
    echo "  ❌ Not running"
  fi
}

logs() {
  if [ ! -f "$LOGFILE" ]; then
    echo "No logs yet"
    exit 1
  fi
  tail -f "$LOGFILE"
}

case "${1:-status}" in
  start|stop|restart|status|logs)
    if [ "$1" = "restart" ]; then stop; sleep 1; start; else "$1"; fi
    ;;
  *)
    echo "Usage: $0 [start|stop|restart|logs|status]"
    exit 1
    ;;
esac
