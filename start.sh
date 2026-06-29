#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"

# Source user profile for API keys and tokens (suppress conda init noise)
if [ -f "$HOME/.profile" ]; then
    set +euo pipefail
    source "$HOME/.profile" 2>/dev/null
    set -euo pipefail
fi

cd "$BACKEND_DIR"

if [ ! -f config.yaml ]; then
    echo "ERROR: config.yaml not found in $BACKEND_DIR"
    echo "Copy config.example.yaml to config.yaml and fill in your settings."
    exit 1
fi

HOST=$(python -c "import yaml; c=yaml.safe_load(open('config.yaml')); print(c.get('server',{}).get('host','127.0.0.1'))" 2>/dev/null || echo "127.0.0.1")
PORT=$(python -c "import yaml; c=yaml.safe_load(open('config.yaml')); print(c.get('server',{}).get('port',8766))" 2>/dev/null || echo "8766")

# Kill only the previous ai-grammar process on this port — not arbitrary
# processes.  Blind fuser -k would terminate unrelated daemons (e.g.
# hermes-webui) if they happened to share the same port.
OLD_PID=$(fuser "${PORT}/tcp" 2>/dev/null | tr -d ' ' || true)
if [[ -n "$OLD_PID" ]] && [[ "$OLD_PID" =~ ^[0-9]+$ ]]; then
    PROC_CWD=$(readlink "/proc/$OLD_PID/cwd" 2>/dev/null || true)
    if [[ "$PROC_CWD" == "$BACKEND_DIR"* ]]; then
        kill "$OLD_PID" 2>/dev/null || true
        sleep 0.5
    else
        echo "Port $PORT occupied by non-ai-grammar process (pid $OLD_PID, cwd: $PROC_CWD) — leaving it alone"
    fi
fi

echo "Installing dependencies..."
pip install -q -r requirements.txt

echo "Starting AI Grammar Checker backend on http://${HOST}:${PORT} ..."
exec python main.py
