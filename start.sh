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

echo "Installing dependencies..."
pip install -q -r requirements.txt

echo "Starting AI Grammar Checker backend on http://${HOST}:${PORT} ..."
exec python main.py
