"""AI Grammar Checker — FastAPI backend entry point."""

from backend.routes import app  # noqa: F401

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    from backend.config import load_server_config

    server = load_server_config()
    uvicorn.run(app, host=server.host, port=server.port)
