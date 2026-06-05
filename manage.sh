#!/bin/bash
# Agentic AI Hub — management CLI
# Usage: ./manage.sh [start|stop|restart|logs|status]

PIDFILE="/tmp/agentic-hub.pid"
LOGFILE="/tmp/agentic-hub.log"

start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "❌ Already running (PID $(cat "$PIDFILE"))"
    exit 1
  fi
  cd "$(dirname "$0")" || exit 1
  nohup bun run src/index.ts > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  echo "✅ Started (PID $!)"
  echo "   tail -f $LOGFILE"
}

stop() {
  if [ ! -f "$PIDFILE" ]; then
    echo "❌ Not running (no PID file)"
    exit 1
  fi
  PID=$(cat "$PIDFILE")
  kill "$PID" 2>/dev/null && echo "✅ Stopped (PID $PID)" || echo "❌ Failed to stop"
  rm -f "$PIDFILE"
}

status() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "✅ Running (PID $(cat "$PIDFILE"))"
  else
    echo "❌ Not running"
    [ -f "$PIDFILE" ] && rm -f "$PIDFILE"
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
