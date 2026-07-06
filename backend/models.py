"""Pydantic models for the AI Grammar backend API."""

from pydantic import BaseModel


class CheckRequest(BaseModel):
    """Request body for the /check endpoint."""

    text: str
    language: str = "auto"
    max_tokens: int | None = None  # 0 or None = unbounded


class ErrorItem(BaseModel):
    """A single detected error with position and correction."""

    start: int
    end: int
    error: str
    correction: str
    explanation: str
    type: str = "error"  # "error", "improvement", or "idiom"


class CheckResponse(BaseModel):
    """Response body returned by the /check endpoint."""

    errors: list[ErrorItem]
    model: str
    tokens_used: int
    error: str | None = None


class PolishResponse(BaseModel):
    """Response body returned by the /polish endpoint."""

    polished: str
    model: str
    tokens_used: int
    error: str | None = None


class TranslateRequest(BaseModel):
    """Request body for the /translate endpoint."""
    text: str
    target_lang: str = "en"
    max_tokens: int | None = None


class TranslateResponse(BaseModel):
    """Response body returned by the /translate endpoint."""
    translated: str
    model: str
    tokens_used: int
    error: str | None = None
