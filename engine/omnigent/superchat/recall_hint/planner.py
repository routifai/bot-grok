"""The hint's planner: one cheap model call that says whether to recall and what to search for.

The model is the cheap chat model the engine's proxy already resolves for the files rerank
(``GET /v1/model/rerank``), called with the Computer's launch token. When it misses its cap or
fails, :func:`derive_queries` writes the sub-queries from the message instead.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import date

import httpx

#: The planner's own cap; past it the code-derived queries are used.
PLANNER_CAP_SECONDS = 0.6
MAX_QUERIES = 3
_QUERY_MAX_CHARS = 200
_INPUT_MAX_CHARS = 600

PLANNER_SYSTEM = (
    "You decide whether anything from earlier (past conversation turns, notes, files, facts "
    "about the person) would help answer the person's new message, and write searches for it. "
    'Reply with only JSON: {"need": true, "queries": [{"q": "...", "historical": false}], '
    '"project": "", "since": "", "until": ""}. '
    "need is false for a greeting, thanks or other acknowledgement, a pick from offered options, "
    "a short instruction about the reply in progress, or a message the recent turns and open "
    "entries already answer; then queries is empty. Otherwise write one to three short keyword "
    "queries, each a different angle: the thing, the decision about it, the file or person it "
    "touches. Mark a query historical when the message asks about the past (when did we first, "
    "what did I say in March). project is the Project slug the message is about, or empty. "
    "since and until bound the dates the message asks about, YYYY-MM-DD, counted from today's "
    "date (in March: the first and last day of the latest March); empty when it names no time."
)

#: ``(system, user) -> the model's text``; raises on any failure.
Chat = Callable[[str, str], Awaitable[str]]


@dataclass(frozen=True)
class Query:
    """One sub-query; *historical* turns the recency factor off for it."""

    text: str
    historical: bool = False


@dataclass(frozen=True)
class Plan:
    """What to recall this turn: nothing (``need`` false) or up to three sub-queries.

    :param since: First date the message asks about (``YYYY-MM-DD``), or ``None``.
    :param until: Last date the message asks about, or ``None``.
    """

    need: bool
    queries: tuple[Query, ...] = ()
    project: str | None = None
    since: str | None = None
    until: str | None = None


@dataclass(frozen=True)
class PlannerInput:
    """What the planner reads.

    :param recent: ``(role, text)`` of the last two turns, oldest first.
    :param today: The person's local date (``YYYY-MM-DD``), for dates the message names.
    """

    message: str
    project_name: str | None = None
    entry_titles: Sequence[str] = ()
    recent: Sequence[tuple[str, str]] = ()
    today: str = ""


class PlannerUnavailable(Exception):
    """No model can plan now (outside a managed Computer, no connection, an error)."""


def _clip(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def planner_prompt(inputs: PlannerInput) -> str:
    """The user message the planner reads."""
    lines = [f"New message: {_clip(inputs.message, _INPUT_MAX_CHARS)}"]
    if inputs.today:
        lines.append(f"Today: {inputs.today}")
    lines.append(f"Open Project: {inputs.project_name or 'none'}")
    if inputs.entry_titles:
        lines.append("Open entries:")
        lines.extend(f"- {_clip(title, 120)}" for title in inputs.entry_titles)
    if inputs.recent:
        lines.append("Recent turns:")
        lines.extend(f"{role}: {_clip(text, 300)}" for role, text in inputs.recent)
    return "\n".join(lines)


def _iso_date(value: object) -> str | None:
    """*value* when it is a real ``YYYY-MM-DD`` date, else ``None``."""
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value.strip()):
        return None
    try:
        return date.fromisoformat(value.strip()).isoformat()
    except ValueError:
        return None


def parse_plan(text: str) -> Plan:
    """The plan in the model's reply. A date that is not a real ``YYYY-MM-DD`` is dropped, and
    both when ``since`` comes after ``until``.

    :raises ValueError: when the reply holds no usable plan.
    """
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match is None:
        raise ValueError("no JSON object")
    raw = json.loads(match.group(0))
    if not isinstance(raw, dict) or not isinstance(raw.get("need"), bool):
        raise ValueError("no need flag")
    project = raw.get("project")
    project = project.strip() if isinstance(project, str) and project.strip() else None
    if not raw["need"]:
        return Plan(need=False, project=project)
    queries: list[Query] = []
    for item in raw.get("queries") or []:
        if isinstance(item, str):
            query = Query(item)
        elif isinstance(item, dict) and isinstance(item.get("q"), str):
            query = Query(item["q"], historical=item.get("historical") is True)
        else:
            continue
        clean = _clip(query.text, _QUERY_MAX_CHARS)
        if clean and all(q.text != clean for q in queries):
            queries.append(Query(clean, query.historical))
    if not queries:
        raise ValueError("need without queries")
    since, until = _iso_date(raw.get("since")), _iso_date(raw.get("until"))
    if since and until and since > until:
        since = until = None
    return Plan(
        need=True,
        queries=tuple(queries[:MAX_QUERIES]),
        project=project,
        since=since,
        until=until,
    )


async def proxy_chat(system: str, user: str) -> str:
    """One completion from the cheap model, through the engine's model proxy.

    :raises PlannerUnavailable: when no model answered.
    """
    from omnigent.runner.knowledge.runtime import proxy_access

    base, credential = proxy_access()
    if not base or not credential:
        raise PlannerUnavailable("no model proxy credential")
    async with httpx.AsyncClient(
        base_url=base.rstrip("/"),
        headers={"Authorization": f"Bearer {credential}"},
        timeout=PLANNER_CAP_SECONDS,
    ) as client:
        plan = await client.get("/v1/model/rerank")
        body = plan.json() if plan.status_code == 200 else None
        if not isinstance(body, dict) or not body.get("available"):
            raise PlannerUnavailable("no cheap model")
        response = await client.post(
            f"/v1/model/{body['provider']}/v1/chat/completions",
            json={
                "model": body["model"],
                "temperature": 0,
                "max_tokens": 200,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
        )
    if response.status_code >= 400:
        raise PlannerUnavailable(f"model answered {response.status_code}")
    try:
        return str(response.json()["choices"][0]["message"]["content"])
    except (KeyError, IndexError, TypeError, ValueError):
        raise PlannerUnavailable("no answer") from None


async def plan_queries(inputs: PlannerInput, chat: Chat | None = None) -> Plan:
    """Ask the planner. Raises on any failure; the caller falls back to :func:`derive_queries`."""
    reply = await (chat or proxy_chat)(PLANNER_SYSTEM, planner_prompt(inputs))
    return parse_plan(reply)


_PATH = re.compile(r"[\w~./-]*[\w-]\.[A-Za-z0-9]{1,5}\b|\b[\w-]+/[\w./-]+")
_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b")
_NUMBER = re.compile(r"\b\d[\d,.]*[kKmM%]?(?!\w)")
#: Capitalized words (names, months, products); the message's first word is skipped.
_NAME = re.compile(r"\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*")


def identifiers(message: str) -> list[str]:
    """Paths, dates, numbers and names in *message*; a part of one already found is skipped."""
    found: list[str] = []
    for pattern in (_PATH, _DATE, _NUMBER, _NAME):
        for match in pattern.finditer(message):
            if pattern is _NAME and not message[: match.start()].strip():
                continue
            token = match.group(0).strip(".,")
            if token and not any(token in seen for seen in found):
                found.append(token)
    return found


def derive_queries(
    message: str, project_name: str | None = None, entry_titles: Sequence[str] = ()
) -> tuple[Query, ...]:
    """The planner's stand-in: the message; the message with the open Project and entry titles;
    the identifiers in the message. Empty and repeated queries are dropped."""
    context = " ".join(part for part in (project_name, *entry_titles) if part)
    candidates = [
        message,
        f"{message} {context}" if context else "",
        " ".join(identifiers(message)),
    ]
    out: list[Query] = []
    for text in candidates:
        clean = _clip(text, _QUERY_MAX_CHARS)
        if clean and all(q.text != clean for q in out):
            out.append(Query(clean))
    return tuple(out)
