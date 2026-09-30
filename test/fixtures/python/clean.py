"""Deterministic clean fixture: annotation and import resolve without a diagnostic."""

from __future__ import annotations

VALUE: int = 1


def double(value: int) -> int:
    return value * 2
