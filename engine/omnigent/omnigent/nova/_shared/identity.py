"""Who a Nova request is for."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi import Request

    from omnigent.server.auth import AuthProvider


@dataclass(frozen=True)
class NovaActor:
    """The person a Nova operation acts for.

    Nova keeps one assistant per person, so the person's identity is the key
    for everything Nova stores.

    :param user_id: Omnigent user id, e.g. ``"sam@example.com"``, or
        ``"local"`` on a single-user server.
    :param workspace_id: Omnigent workspace; ``0`` on single-workspace servers.
    """

    user_id: str
    workspace_id: int = 0


def actor_from_request(request: Request, auth_provider: AuthProvider | None) -> NovaActor | None:
    """Resolve the caller, or ``None`` when the request is unauthenticated.

    :param request: The incoming request.
    :param auth_provider: The server's auth provider.
    :returns: The actor, or ``None``; routes answer ``None`` with 401.
    """
    # Imported here: the server's auth module imports much of Omnigent, and this
    # module is loaded while Omnigent builds its tool registry.
    from omnigent.db.db_models import current_workspace_id
    from omnigent.server.routes._auth_helpers import get_user_id

    user_id = get_user_id(request, auth_provider) if auth_provider else "local"
    if not user_id:
        return None
    return NovaActor(user_id=user_id, workspace_id=current_workspace_id())
