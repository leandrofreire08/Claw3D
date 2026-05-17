#!/bin/bash
# Claw3D startup script - runs demo gateway + Next.js server
set -e

# Carrega variaveis do .env se existir
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

# Config
STUDIO_PORT="${PORT:-3000}"
DEMO_PORT="${DEMO_ADAPTER_PORT:-18789}"
STUDIO_TOKEN="${STUDIO_ACCESS_TOKEN:-}"

echo "=== Claw3D Starter ==="
echo "Studio port: $STUDIO_PORT"
echo "Demo gateway port: $DEMO_PORT"
echo "Access token: ${STUDIO_TOKEN:+configurado}${STUDIO_TOKEN:-desabilitado}"
echo ""

# Start demo gateway in background
echo "[demo-gateway] Starting on ws://localhost:$DEMO_PORT ..."
cd "$SCRIPT_DIR"
DEMO_ADAPTER_PORT=$DEMO_PORT node server/demo-gateway-adapter.js &
DEMO_PID=$!
echo "[demo-gateway] PID: $DEMO_PID"

# Give it a sec to start
sleep 2

# Verify demo gateway is up
if ! kill -0 $DEMO_PID 2>/dev/null; then
  echo "[ERROR] Demo gateway failed to start"
  exit 1
fi
echo "[demo-gateway] OK"

export NODE_ENV=production

echo "[studio] Starting Next.js server on 0.0.0.0:$STUDIO_PORT ..."
echo "[studio] Demo gateway URL: ws://localhost:$DEMO_PORT"

# Handle shutdown gracefully
cleanup() {
  echo ""
  echo "[shutdown] Stopping demo gateway..."
  kill $DEMO_PID 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# Start the main server (this blocks)
exec node "$SCRIPT_DIR/server/index.js"
