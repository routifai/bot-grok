"""Domain logic for Asks: open one, answer it, list what's open, expire stale ones.

Pure with respect to Omnigent's runtime: :class:`AskService` only ever talks
to the :class:`~omnigent.nova.asks.store.AskStore` it is bound to, so it is
fully testable with a fake store and no Omnigent server running. The
elicitation-specific parts (mirroring a live elicitation, resolving one on
answer) live in ``bridge.py``, which calls into this service rather than the
other way around.
"""

from __future__ import annotations

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import NovaActor, new_id, now_s
from omnigent.nova.asks.entities import Ask, AskAction, AskKind, AskStatus
from omnigent.nova.asks.store import AskStore

_MAX_ACTIONS = 4


class AskService:
    """Domain logic for Asks, bound to one store."""

    def __init__(self, store: AskStore) -> None:
        """
        :param store: The Ask store this service reads and writes.
        """
        self._store = store

    def open_ask(
        self,
        *,
        actor: NovaActor,
        kind: AskKind,
        text: str,
        detail: str | None = None,
        actions: tuple[AskAction, ...] = (),
        session_id: str | None = None,
        elicitation_id: str | None = None,
        goal_id: str | None = None,
        task_id: str | None = None,
    ) -> Ask:
        """Open a new Ask for the person.

        :param actor: The person this Ask is for.
        :param kind: What sort of thing is being asked.
        :param text: The question or approval prompt. Must be non-empty.
        :param detail: Optional longer context.
        :param actions: Up to four tappable options; empty for a free-text
            question. Ids must be unique.
        :param session_id: The Omnigent session this Ask concerns, if any.
        :param elicitation_id: The Omnigent elicitation this Ask mirrors, if
            it came from one.
        :param goal_id: The Goal this Ask concerns, if any.
        :param task_id: The Goal task this Ask concerns, if any.
        :returns: The persisted Ask.
        :raises OmnigentError: ``INVALID_INPUT`` for an empty question or a
            malformed action list; ``ALREADY_EXISTS`` if ``elicitation_id``
            is already mirrored by another Ask.
        """
        if not text.strip():
            raise OmnigentError("An Ask needs a question", code=ErrorCode.INVALID_INPUT)
        if len(actions) > _MAX_ACTIONS:
            raise OmnigentError(
                f"An Ask offers at most {_MAX_ACTIONS} options", code=ErrorCode.INVALID_INPUT
            )
        ids = [a.id for a in actions]
        if len(set(ids)) != len(ids):
            raise OmnigentError("Ask options must have unique ids", code=ErrorCode.INVALID_INPUT)
        ask = Ask(
            id=new_id(),
            workspace_id=actor.workspace_id,
            user_id=actor.user_id,
            session_id=session_id,
            kind=kind,
            text=text,
            detail=detail,
            actions=actions,
            status=AskStatus.OPEN,
            answer=None,
            elicitation_id=elicitation_id,
            goal_id=goal_id,
            task_id=task_id,
            created_at=now_s(),
            answered_at=None,
        )
        return self._store.create(ask)

    def answer(self, actor: NovaActor, ask_id: str, answer: str) -> Ask:
        """Record the person's answer to one of their open Asks.

        :param actor: The person answering; also the Ask's required owner.
        :param ask_id: The Ask being answered.
        :param answer: The person's answer — an offered action's id, or free
            text for a question with no fixed options.
        :returns: The now-answered Ask.
        :raises OmnigentError: ``NOT_FOUND`` if no such Ask exists for this
            person; ``CONFLICT`` if it is no longer open; ``INVALID_INPUT``
            if the Ask offers fixed options and ``answer`` isn't one of them.
        """
        ask = self._store.get(ask_id, user_id=actor.user_id)
        if ask is None:
            raise OmnigentError("Ask not found", code=ErrorCode.NOT_FOUND)
        if ask.status is not AskStatus.OPEN:
            raise OmnigentError("This Ask was already answered", code=ErrorCode.CONFLICT)
        if ask.actions and answer not in {a.id for a in ask.actions}:
            raise OmnigentError(
                "Answer must be one of the offered options", code=ErrorCode.INVALID_INPUT
            )
        updated = self._store.set_status(
            ask_id,
            user_id=actor.user_id,
            status=AskStatus.ANSWERED,
            answer=answer,
            answered_at=now_s(),
        )
        if updated is None:
            # Existence and ownership were just confirmed by the ``get``
            # above; only a concurrent delete (Asks are never deleted today)
            # reaches here.
            raise OmnigentError("Ask not found", code=ErrorCode.NOT_FOUND)
        return updated

    def list_open(self, actor: NovaActor) -> list[Ask]:
        """List the person's open Asks, newest first.

        :param actor: The person whose Asks to return.
        """
        return self._store.list_open(user_id=actor.user_id)

    def expire_for_session(self, session_id: str) -> list[Ask]:
        """Expire every open Ask tied to a session.

        :param session_id: The session whose open Asks no longer apply.
        :returns: The Asks that were expired.
        """
        return self._store.expire_open_for_session(session_id, now=now_s())
