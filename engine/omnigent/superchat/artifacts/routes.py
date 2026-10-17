"""``/v1/artifacts``: deliverable files the Muse saved from its host.

``POST`` takes the raw file bytes (the runner-side ``artifact_save`` tool uploads them) and
adds a version when the name already exists in the Conversation. ``GET`` lists the newest
version of each deliverable, returns one with its versions, or streams the content. Owner-scoped:
another owner's rows 404.
"""

from __future__ import annotations

import asyncio
import logging
import posixpath
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel

from omnigent.context.rollover import _MID_TURN_LIVE_STATUSES
from omnigent.db.db_models import InvalidUuidError, uuid_to_bytes
from omnigent.entities import MessageData
from omnigent.entities.conversation import is_system_notice
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_OWNER, RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.redaction import session_redactor
from omnigent.server.routes._auth_helpers import require_access, require_user
from omnigent.stores import ConversationStore, PermissionStore
from omnigent.superchat.artifact_kinds import (
    KIND_MIME,
    MAX_ARTIFACT_BYTES,
    is_deck_name,
    kind_for_name,
)
from omnigent.superchat.artifacts.hint import MAX_ARTIFACTS, artifact_hint
from omnigent.superchat.artifacts.links import (
    conversation_item,
    is_person_message,
    link_saved_version,
    open_artifact,
    steer_text,
)
from omnigent.superchat.artifacts.patches import name_elements
from omnigent.superchat.artifacts.store import (
    LINK_CHOSEN,
    WRITEBACK_ORIGINS,
    Artifact,
    MessageLink,
    Publication,
    SqlAlchemyArtifactStore,
    VersionConflictError,
    ViewStats,
)
from omnigent.superchat.family.signals import notify_item_updated
from omnigent.superchat.transcript.blocks import project_items

#: Steers the running turn of a session with one line; ``True`` when the turn took it.
Steer = Callable[[Request, str, str], Awaitable[bool]]

#: The preview is shown in a sandboxed, origin-less iframe; this keeps a page that is opened
#: directly (or downloaded and served) from reaching anything but public https assets.
_HTML_CSP = (
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; "
    "style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; "
    "media-src data: blob: https:; connect-src 'none'; form-action 'none'; base-uri 'none'"
)


def publication_to_response(pub: Publication, stats: ViewStats | None = None) -> dict[str, Any]:
    """Serialize a publication with its view stats."""
    return {
        "slug": pub.slug,
        "url_path": pub.url_path,
        "audience": pub.audience,
        "version": pub.published_version,
        "published_at": pub.published_at,
        "updated_at": pub.updated_at,
        "stats": (stats or ViewStats()).as_dict(),
    }


def artifact_to_response(
    item: Artifact,
    *,
    versions: int = 1,
    publication: Publication | None = None,
    stats: ViewStats | None = None,
) -> dict[str, Any]:
    """Serialize one artifact version for the REST API."""
    return {
        "publish": publication_to_response(publication, stats) if publication else None,
        "id": item.id,
        "artifact_id": item.id,
        "parent_session_id": item.parent_session_id,
        "name": item.name,
        "title": item.title,
        "kind": item.kind,
        "mime": item.mime,
        "size": item.size,
        "version": item.version,
        "versions": versions,
        "published": publication is not None,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
        "origin": item.origin,
        "chat_id": item.chat_id,
        "parent_version_id": item.parent_version_id,
        "edit_summary": item.edit_summary,
    }


#: How many of a chat's newest messages are searched for the turn's opening one.
_TURN_LOOKBACK = 50
_logger = logging.getLogger(__name__)


def producing_turn(
    conversations: ConversationStore, parent_session_id: str, chat_id: str | None
) -> tuple[str | None, str | None]:
    """The chat saving a version into *parent_session_id*, and its current turn's person message.

    *chat_id* (``None``: the Conversation itself) counts only when it is that Conversation or a
    chat under it (a Helper, an update run); any other chat records nothing. The turn is named by
    the newest message of the person in that chat (a Helper's Brief, a run's prompt); runtime
    notices are skipped. A failed lookup records nothing: it never fails the save.

    :returns: ``(chat_id, turn_item_id)``, each ``None`` when unknown.
    """
    try:
        return _producing_turn(conversations, parent_session_id, chat_id)
    except Exception:  # noqa: BLE001 - provenance is a label, never a reason to lose a version
        _logger.warning("artifacts: could not find the turn saving into %s", parent_session_id)
        return None, None


def _producing_turn(
    conversations: ConversationStore, parent_session_id: str, chat_id: str | None
) -> tuple[str | None, str | None]:
    chat = chat_id or parent_session_id
    if chat != parent_session_id:
        found = conversations.get_conversation(chat)
        family = {found.parent_conversation_id, found.root_conversation_id} if found else set()
        if parent_session_id not in family:
            return None, None
    page = conversations.list_items(chat, limit=_TURN_LOOKBACK, order="desc", type="message")
    for item in page.data:
        data = item.data
        if isinstance(data, MessageData) and data.role == "user" and not is_system_notice(data):
            return chat, item.id
    return chat, None


async def steer_running_turn(
    request: Request, conversation_store: ConversationStore, session_id: str, text: str
) -> bool:
    """Steer the session's running turn with *text*, through the runner's own steer path.

    The line goes as a runtime notice with ``if_running``: the runner takes it into the turn
    running now, or refuses it (nothing is kept) when none runs.
    """
    from omnigent.server.routes._sessions.helpers import _get_runner_client
    from omnigent.server.routes._sessions.orchestration import (
        _dispatch_session_event_to_runner,
    )
    from omnigent.server.schemas import SessionEventInput

    conversation = await asyncio.to_thread(conversation_store.get_conversation, session_id)
    if conversation is None:
        return False
    runner = await _get_runner_client(
        session_id, getattr(request.app.state, "runner_router", None)
    )
    if runner is None:
        return False
    body = SessionEventInput(
        type="message",
        data={
            "role": "user",
            "is_system_notice": True,
            "content": [{"type": "input_text", "text": text}],
        },
        if_running=True,
    )
    try:
        await _dispatch_session_event_to_runner(
            session_id,
            conversation,
            body,
            conversation_store,
            runner,
            agent_name=None,
            file_store=None,
            artifact_store=None,
        )
    except (httpx.HTTPError, OmnigentError):
        return False
    return True


class MessageArtifactBody(BaseModel):
    """``POST /sessions/{id}/items/{item_id}/artifact``: the artifact picked, or ``None``."""

    artifact_id: str | None


def check_id(value: str, what: str) -> None:
    try:
        uuid_to_bytes(value)
    except InvalidUuidError as exc:
        raise OmnigentError(f"invalid {what}", code=ErrorCode.INVALID_INPUT) from exc


def _disposition(kind: str, name: str) -> str:
    safe = posixpath.basename(name).replace('"', "'") or f"artifact.{kind}"
    return (
        f"filename=\"{safe.encode('ascii', 'replace').decode()}\"; filename*=UTF-8''{quote(name)}"
    )


def request_owner(request: Request, auth_provider: AuthProvider | None) -> str | None:
    """The calling owner's id, or ``None`` for the single local user (rows are unowned)."""
    user_id = require_user(request, auth_provider)
    owner = user_id if user_id is not None else RESERVED_USER_LOCAL
    return None if owner == RESERVED_USER_LOCAL else owner


async def load_artifact(
    store: SqlAlchemyArtifactStore, owner: str | None, artifact_id: str
) -> Artifact:
    """The owner's artifact version, or a 404 (another owner's rows are indistinguishable)."""
    check_id(artifact_id, "artifact id")
    item = await asyncio.to_thread(store.get, artifact_id, user_id=owner)
    if item is None:
        raise OmnigentError("Artifact not found", code=ErrorCode.NOT_FOUND)
    return item


def _refuse_unseen_manual_edit(
    store: SqlAlchemyArtifactStore, owner: str | None, session_id: str, name: str
) -> None:
    """409 when the newest version is a hand edit the Muse has not been told about yet.

    A save built from an older copy of the file would silently overwrite the person's edit; the
    write-back at the start of the Muse's turn marks the edit delivered, so a Muse that re-read
    the file passes.
    """
    group = store.versions_of(user_id=owner, parent_session_id=session_id, name=name)
    head = group[0] if group else None
    if head is not None and head.origin in WRITEBACK_ORIGINS and head.delivered_at is None:
        who = (
            f"{name} was refreshed from its sources"
            if head.origin == "update"
            else f"The person edited {name} by hand"
        )
        raise OmnigentError(
            f"{who} (v{head.version}); read the workspace file "
            "again and apply your change on top of their edits before saving.",
            code=ErrorCode.CONFLICT,
        )


def create_artifacts_router(
    store: SqlAlchemyArtifactStore,
    *,
    conversation_store: ConversationStore,
    permission_store: PermissionStore | None = None,
    auth_provider: AuthProvider | None = None,
    steer: Steer | None = None,
) -> APIRouter:
    """Build the artifacts router, mounted with ``prefix="/v1"``.

    :param steer: Steers a running turn (tests pass a fake); the runner's steer path otherwise.
    """
    router = APIRouter()

    async def _steer(request: Request, session_id: str, text: str) -> bool:
        if steer is not None:
            return await steer(request, session_id, text)
        return await steer_running_turn(request, conversation_store, session_id, text)

    def _owner(request: Request) -> str | None:
        return request_owner(request, auth_provider)

    def _caller(request: Request) -> str | None:
        # Access is checked as the real caller: the single local user owns its sessions, even
        # though its artifact rows are stored unowned (``_owner`` is ``None`` for it).
        return require_user(request, auth_provider)

    async def _load(request: Request, artifact_id: str) -> Artifact:
        return await load_artifact(store, _owner(request), artifact_id)

    @router.post("/artifacts", status_code=201)
    async def create_artifact(
        request: Request,
        parent_session_id: str = Query(),
        name: str = Query(min_length=1, max_length=512),
        title: str | None = Query(default=None, max_length=256),
        source_path: str | None = Query(default=None, max_length=1024),
        chat_id: str | None = Query(default=None),
    ) -> dict[str, Any]:
        """Save the request body as the next version of ``name`` in a session the caller owns.

        ``chat_id`` is the chat saving it when that is not the Conversation itself (a Helper);
        the version records it and its turn (:func:`producing_turn`).
        """
        owner = _owner(request)
        check_id(parent_session_id, "parent_session_id")
        await require_access(
            _caller(request), parent_session_id, LEVEL_OWNER, permission_store, conversation_store
        )
        kind = kind_for_name(name)
        if kind is None:
            raise OmnigentError(
                f"file type not allowed; use one of: {', '.join(KIND_MIME)}",
                code=ErrorCode.INVALID_INPUT,
            )
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_ARTIFACT_BYTES:
            raise OmnigentError("file too large (25 MB max)", code=ErrorCode.INVALID_INPUT)
        data = await request.body()
        if not data:
            raise OmnigentError("file is empty", code=ErrorCode.INVALID_INPUT)
        if len(data) > MAX_ARTIFACT_BYTES:
            raise OmnigentError("file too large (25 MB max)", code=ErrorCode.INVALID_INPUT)
        clean_name = posixpath.basename(name)
        await asyncio.to_thread(
            _refuse_unseen_manual_edit, store, owner, parent_session_id, clean_name
        )
        if kind == "html" and not is_deck_name(clean_name):
            # A page is editable by hand only where it has ids; don't leave that to the author.
            data = await asyncio.to_thread(name_elements, data)
        if chat_id is not None:
            check_id(chat_id, "chat_id")
        saver, turn_item_id = await asyncio.to_thread(
            producing_turn, conversation_store, parent_session_id, chat_id
        )
        item_id = await asyncio.to_thread(
            conversation_item, conversation_store, parent_session_id, saver, turn_item_id
        )
        item = await asyncio.to_thread(
            store.create,
            user_id=owner,
            parent_session_id=parent_session_id,
            name=clean_name,
            title=title,
            kind=kind,
            mime=KIND_MIME[kind],
            data=data,
            source_path=source_path,
            turn_item_id=turn_item_id,
            chat_id=saver,
            item_id=item_id,
        )
        try:
            await asyncio.to_thread(link_saved_version, store, item)
        except Exception:  # the chip is a label, never a reason to fail a save
            _logger.warning("artifacts: could not link %s to its message", item.id, exc_info=True)
        return artifact_to_response(item, versions=item.version)

    @router.get("/artifacts")
    async def list_artifacts(
        request: Request,
        parent_session_id: str | None = Query(default=None),
        limit: int = Query(default=200, ge=1, le=500),
    ) -> dict[str, Any]:
        """The newest version of each deliverable, newest first."""
        owner = _owner(request)
        if parent_session_id is not None:
            check_id(parent_session_id, "parent_session_id")
        rows = await asyncio.to_thread(
            store.list_latest, user_id=owner, parent_session_id=parent_session_id, limit=limit
        )
        pubs = await asyncio.to_thread(store.publications_for_owner, owner)
        stats = await asyncio.to_thread(store.stats, [p.slug for p in pubs.values()])
        out = []
        for a, n in rows:
            pub = pubs.get((a.parent_session_id, a.name))
            out.append(
                artifact_to_response(
                    a, versions=n, publication=pub, stats=stats.get(pub.slug) if pub else None
                )
            )
        return {"artifacts": out}

    @router.get("/artifacts/pending-edits")
    async def pending_edits(request: Request, parent_session_id: str = Query()) -> dict[str, Any]:
        """Hand-edited versions in a session not yet written back to its host.

        The runner calls this at the start of the Muse's turn: it writes each ``latest``
        edit's bytes to ``source_path``, tells the Muse (``note``) and then acks the ids via
        ``POST /artifacts/{id}/delivered``.
        """
        owner = _owner(request)
        check_id(parent_session_id, "parent_session_id")
        await require_access(
            _caller(request), parent_session_id, LEVEL_OWNER, permission_store, conversation_store
        )
        rows = await asyncio.to_thread(
            store.pending_manual, user_id=owner, parent_session_id=parent_session_id
        )
        newest: dict[str, int] = {}
        for row in rows:
            newest[row.name] = max(newest.get(row.name, 0), row.version)
        edits = []
        for row in rows:
            head = await asyncio.to_thread(store.newest, row)
            edits.append(
                {
                    **artifact_to_response(row),
                    "source_path": row.source_path,
                    # Only the group's newest version is written back, and only when it is
                    # this hand edit (a later save by the Muse supersedes it).
                    "write_back": head is not None and head.id == row.id,
                }
            )
        return {"edits": edits}

    @router.get("/artifacts/hint")
    async def artifacts_hint(request: Request, session_id: str = Query()) -> dict[str, Any]:
        """The runtime hint for the start of a turn in the Conversation (``None``: none).

        The runner calls this when a turn starts: this Conversation's artifacts, newest first,
        with the one the person's latest message was sent with open marked. A Helper has none.
        """
        owner = _owner(request)
        check_id(session_id, "session_id")
        await require_access(
            _caller(request), session_id, LEVEL_OWNER, permission_store, conversation_store
        )
        conversation = await asyncio.to_thread(conversation_store.get_conversation, session_id)
        if conversation is None or conversation.parent_conversation_id is not None:
            return {"hint": None}
        rows = await asyncio.to_thread(
            store.list_latest, user_id=owner, parent_session_id=session_id, limit=MAX_ARTIFACTS
        )
        _, asked = await asyncio.to_thread(producing_turn, conversation_store, session_id, None)
        opened = await asyncio.to_thread(open_artifact, store, session_id, asked)
        return {"hint": artifact_hint([a for a, _n in rows], opened)}

    @router.post("/sessions/{session_id}/items/{item_id}/artifact")
    async def set_message_artifact(
        request: Request,
        session_id: str,
        item_id: str,
        body: MessageArtifactBody,
    ) -> dict[str, Any]:
        """The person picks which artifact their message is about (``None``: none).

        Records it as ``chosen``, tells the family stream, steers the turn the message started
        when it is still running, and answers with the message as the transcript shows it.
        """
        user_id = _caller(request)
        check_id(session_id, "session_id")
        await require_access(
            user_id, session_id, LEVEL_OWNER, permission_store, conversation_store
        )
        try:
            uuid_to_bytes(item_id)
            item = await asyncio.to_thread(conversation_store.get_item, session_id, item_id)
        except InvalidUuidError:
            item = None
        if item is None or not is_person_message(item):
            raise OmnigentError("Message not found", code=ErrorCode.NOT_FOUND)
        current = await asyncio.to_thread(store.message_link, session_id, item_id)
        artifact_id = body.artifact_id
        if artifact_id is None:
            link = MessageLink(None, None, None, LINK_CHOSEN)
        else:
            check_id(artifact_id, "artifact_id")
            picked = await asyncio.to_thread(store.get_in_session, artifact_id, session_id)
            if picked is None:
                raise OmnigentError("Artifact not found", code=ErrorCode.NOT_FOUND)
            same = current is not None and current.name == picked.name
            version = current.version if same and current is not None else None
            link = MessageLink(picked.id, picked.name, version, LINK_CHOSEN)
        await asyncio.to_thread(store.set_message_link, session_id, item_id, link)
        notify_item_updated(session_id, item_id)
        conversation = await asyncio.to_thread(conversation_store.get_conversation, session_id)
        if conversation is not None and conversation.live_status in _MID_TURN_LIVE_STATUSES:
            _, latest = await asyncio.to_thread(
                producing_turn, conversation_store, session_id, None
            )
            if latest == item_id:
                await _steer(request, session_id, steer_text(link))
        projected = project_items([item.to_api_dict()])
        message = projected[0] if projected else {"id": item.id, "role": "user", "blocks": []}
        message["artifact"] = link.to_wire()
        redactor = await session_redactor(request, conversation_store, session_id, user_id)
        return redactor.deep(message)

    @router.post("/artifacts/{artifact_id}/delivered")
    async def mark_delivered(request: Request, artifact_id: str) -> dict[str, Any]:
        """Ack that a hand-edited version was written back and announced (idempotent)."""
        item = await _load(request, artifact_id)
        ok = await asyncio.to_thread(store.mark_delivered, item.id, user_id=item.user_id)
        return {"delivered": ok}

    @router.post("/artifacts/{artifact_id}/restore")
    async def restore_artifact(request: Request, artifact_id: str) -> dict[str, Any]:
        """Make this earlier version the newest again: a NEW ``restore`` version with its bytes.

        Nothing is rewritten in place, so the versions in between stay in the history (and a
        restore can itself be restored over). Like a hand edit it is written back to the
        host and announced to the Muse at the start of its next turn.
        """
        item = await _load(request, artifact_id)
        head = await asyncio.to_thread(store.newest, item)
        if head is None or head.id == item.id:
            return artifact_to_response(item, versions=item.version)
        data = await asyncio.to_thread(store.read, item)
        try:
            created = await asyncio.to_thread(
                store.create,
                user_id=item.user_id,
                parent_session_id=item.parent_session_id,
                name=item.name,
                title=head.title,
                kind=item.kind,
                mime=item.mime,
                data=data,
                origin="restore",
                parent_version_id=head.id,
                source_path=head.source_path,
                edit_summary=f"restored version {item.version}",
                base_version=head.version,
            )
        except VersionConflictError as exc:
            raise OmnigentError(
                "A newer version arrived meanwhile; pick the version again to restore it.",
                code=ErrorCode.CONFLICT,
            ) from exc
        return artifact_to_response(created, versions=created.version)

    @router.get("/artifacts/{artifact_id}")
    async def get_artifact(request: Request, artifact_id: str) -> dict[str, Any]:
        """One version's metadata plus every version of its deliverable."""
        item = await _load(request, artifact_id)
        versions = await asyncio.to_thread(store.versions, item)
        pub = await asyncio.to_thread(store.publication_for, item)
        stats = (await asyncio.to_thread(store.stats, [pub.slug])).get(pub.slug) if pub else None
        return {
            **artifact_to_response(item, versions=len(versions), publication=pub, stats=stats),
            "all_versions": [
                {
                    "id": v.id,
                    "version": v.version,
                    "size": v.size,
                    "created_at": v.created_at,
                    "origin": v.origin,
                    "parent_version_id": v.parent_version_id,
                    "edit_summary": v.edit_summary,
                    "turn_item_id": v.turn_item_id,
                    "chat_id": v.chat_id,
                    "item_id": v.item_id,
                }
                for v in versions
            ],
        }

    @router.get("/artifacts/{artifact_id}/content")
    async def get_artifact_content(
        request: Request,
        artifact_id: str,
        version: int | None = Query(default=None, ge=1),
        download: bool = Query(default=False),
    ) -> Response:
        """The file's bytes with its real content type (``?version=`` picks another version)."""
        item = await _load(request, artifact_id)
        if version is not None and version != item.version:
            match = next(
                (v for v in await asyncio.to_thread(store.versions, item) if v.version == version),
                None,
            )
            if match is None:
                raise OmnigentError("Version not found", code=ErrorCode.NOT_FOUND)
            item = match
        data = await asyncio.to_thread(store.read, item)
        headers = {
            "Content-Disposition": f"{'attachment' if download else 'inline'}; "
            f"{_disposition(item.kind, item.name)}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=0, must-revalidate",
        }
        if item.kind == "html":
            headers["Content-Security-Policy"] = _HTML_CSP
        return Response(content=data, media_type=item.mime, headers=headers)

    @router.delete("/artifacts/{artifact_id}")
    async def delete_artifact(request: Request, artifact_id: str) -> dict[str, Any]:
        """Delete a deliverable with all its versions."""
        item = await _load(request, artifact_id)
        removed = await asyncio.to_thread(store.delete_group, item)
        return {"deleted": True, "name": item.name, "versions_removed": removed}

    return router
