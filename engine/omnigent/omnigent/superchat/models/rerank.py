"""Which model reorders a Computer's search hits, resolved through the model layer.

``files_query`` reads its best hits again with a small chat model. Like embeddings, the call is
made by the Computer through the model proxy; this only answers *which* provider and model, with
the same resolution as a run (the person's own connection, then the organization's, among the
providers whose upstream speaks Chat Completions) and the same suspension and budget checks. It
never falls back to an operator key. A cheap model is used on purpose: the rerank reads twenty
short passages.
"""

from __future__ import annotations

from dataclasses import dataclass

from omnigent.superchat.models.embeddings import EmbeddingUnavailable, ModelEmbeddings
from omnigent.superchat.models.store import ModelConnectionStore, resolve_model_connection
from omnigent.superchat.models.upstreams import UPSTREAMS

#: A cheap, fast chat model, spelled the way an any-vendor upstream (OpenRouter) expects it.
RERANK_MODEL = "openai/gpt-4o-mini"
#: Providers that serve Chat Completions and any vendor's model, best first.
RERANK_PROVIDERS = tuple(
    name
    for name, upstream in UPSTREAMS.items()
    if "chat" in upstream.wire_apis and upstream.vendors_served == "any"
)

REASON_NO_CONNECTION = "no_connection"


class RerankUnavailable(Exception):
    """No model can rerank for this owner now; ``reason`` is ``no_connection``, ``suspended`` or
    ``budget``."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class RerankPlan:
    """The provider (the ``{provider}`` of the proxy route) and model to call."""

    provider: str
    model: str


class ModelRerank:
    """Resolves the connection that reranks for an owner."""

    def __init__(self, connections: ModelConnectionStore, checks: ModelEmbeddings) -> None:
        self._connections = connections
        self._checks = checks

    def plan(self, owner_id: str) -> RerankPlan:
        """The model *owner_id*'s Computer reranks with through the model proxy.

        :raises RerankUnavailable: suspended, budget used up, or no chat-capable connection.
        """
        try:
            self._checks.check(owner_id)
        except EmbeddingUnavailable as exc:
            raise RerankUnavailable(exc.reason) from None
        connection = resolve_model_connection(
            self._connections, owner_id=owner_id, preferred=RERANK_PROVIDERS
        )
        if connection is None:
            raise RerankUnavailable(REASON_NO_CONNECTION)
        return RerankPlan(connection.provider, RERANK_MODEL)
