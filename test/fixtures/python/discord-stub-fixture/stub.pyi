"""Fake Discord plumbing stub.

This file is an original placeholder used only to exercise diagnostics plumbing. It does
not model Discord.py, its API, or any compatibility claim about that library.
"""

from __future__ import annotations

from typing import Protocol


class EventSource(Protocol):
    def wait_for(self, event: str, *, timeout: float | None = None) -> object: ...


def dispatch(source: EventSource, event: str) -> object:
    return source.wait_for(event)
