"""AI Grammar Checker — FastAPI backend entry point."""

import sys
from pathlib import Path

# Ensure the project root is on sys.path so 'backend' package is importable
_project_root = Path(__file__).resolve().parents[1]
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from backend.routes import app  # noqa: F401

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    from backend.config import load_server_config

    server = load_server_config()
    uvicorn.run(app, host=server.host, port=server.port)
