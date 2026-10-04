"""``_is_tenant_authored``: a fork's clone of an operator template keeps its trust."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from omnigent.server.routes.sessions.routes_agent import _is_tenant_authored


def _agent(agent_id: str, location: str, session_id: str | None) -> Any:
    return SimpleNamespace(id=agent_id, bundle_location=location, session_id=session_id)


class _Store:
    def __init__(self, *agents: Any) -> None:
        self._agents = {a.id: a for a in agents}

    def get(self, agent_id: str) -> Any:
        return self._agents.get(agent_id)


def test_template_is_operator_authored() -> None:
    template = _agent("tpl", "tpl/abc", None)
    assert _is_tenant_authored(_Store(template), template) is False  # type: ignore[arg-type]


def test_fork_clone_of_template_is_operator_authored() -> None:
    template = _agent("tpl", "tpl/abc", None)
    clone = _agent("clone", "tpl/abc", "sess")
    assert _is_tenant_authored(_Store(template, clone), clone) is False  # type: ignore[arg-type]


def test_tenant_upload_is_tenant_authored() -> None:
    template = _agent("tpl", "tpl/abc", None)
    upload = _agent("up", "up/xyz", "sess")
    assert _is_tenant_authored(_Store(template, upload), upload) is True  # type: ignore[arg-type]


def test_forged_prefix_with_different_bundle_is_tenant_authored() -> None:
    template = _agent("tpl", "tpl/abc", None)
    forged = _agent("up", "tpl/evil", "sess")
    assert _is_tenant_authored(_Store(template, forged), forged) is True  # type: ignore[arg-type]
