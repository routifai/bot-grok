"""Finds each primitive's routes, tools and context sections.

Registration is by convention, so adding a primitive never means editing another
one: a primitive exposes ``routes.create_router``, ``tools.TOOLS`` and/or
``context.context_section`` and it is picked up here.
"""

from __future__ import annotations

import importlib
import logging
from collections.abc import Awaitable, Callable
from types import ModuleType
from typing import TYPE_CHECKING, Any

from omnigent.nova._shared import ContextRequest, ContextSection, NovaDeps

if TYPE_CHECKING:
    from fastapi import APIRouter, FastAPI

_logger = logging.getLogger(__name__)

# Order matters only for context: sections also carry their own priority.
PRIMITIVES = ("memory", "episodes", "goals", "asks", "feed", "skills", "context")

SectionProvider = Callable[[ContextRequest], Awaitable[ContextSection | None]]


def _module(primitive: str, name: str) -> ModuleType | None:
    try:
        return importlib.import_module(f"omnigent.nova.{primitive}.{name}")
    except ModuleNotFoundError as exc:
        # Only a missing optional module is fine; a broken import inside one is not.
        if (
            exc.name == f"omnigent.nova.{primitive}.{name}"
            or exc.name == f"omnigent.nova.{primitive}"
        ):
            return None
        raise


def routers(deps: NovaDeps) -> list[APIRouter]:
    """Every primitive's router, built with the server's dependencies."""
    found: list[APIRouter] = []
    for primitive in PRIMITIVES:
        module = _module(primitive, "routes")
        if module is not None:
            found.append(module.create_router(deps))
    return found


def tools() -> dict[str, Callable[[dict[str, str]], Any]]:
    """Every primitive's Omnigent built-in tool factories, by tool name."""
    found: dict[str, Callable[[dict[str, str]], Any]] = {}
    for primitive in PRIMITIVES:
        module = _module(primitive, "tools")
        if module is None:
            continue
        for name, factory in module.TOOLS.items():
            if name in found:
                raise ValueError(f"Nova tool {name!r} is registered twice")
            found[name] = factory
    return found


def section_providers() -> list[SectionProvider]:
    """Every primitive's ``context_section`` function."""
    found: list[SectionProvider] = []
    for primitive in PRIMITIVES:
        module = _module(primitive, "context")
        provider = getattr(module, "context_section", None) if module else None
        if provider is not None:
            found.append(provider)
    return found


def include_routers(app: FastAPI, deps: NovaDeps) -> None:
    """Mount every Nova router under ``/v1/nova``."""
    for router in routers(deps):
        app.include_router(router, prefix="/v1/nova", tags=["nova"])
    _logger.info("Nova routes mounted")
