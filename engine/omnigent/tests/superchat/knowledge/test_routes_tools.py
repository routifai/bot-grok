"""Routes, tool definitions, runner handlers and the transcript's citation chips."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omnigent.errors import OmnigentError
from omnigent.runtime.mcp_tool_result import decode_mcp_image_result
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.knowledge import FEATURE
from omnigent.superchat.knowledge.handlers import handle_knowledge_tool
from omnigent.superchat.knowledge.routes import create_knowledge_router
from omnigent.superchat.knowledge.tools import KNOWLEDGE_TOOL_NAMES
from omnigent.superchat.transcript.blocks import project_items
from tests.superchat.knowledge._fixtures import Env, build_env, make_pdf

FINANCE = make_pdf(
    [
        [("1. Revenue overview", 20), ("Revenue grew twelve percent in Montreal.", 11)],
        [("2. Risks", 20), ("Currency exposure is the main risk for the group.", 11)],
    ]
)
ALICE = {"x-user": "alice"}
BOB = {"x-user": "bob"}
SUPER_CHAT = {"omnigent.context.mode": "superside-chat"}


class _Auth:
    def get_user_id(self, request: Request) -> str | None:
        return request.headers.get("x-user")


def _app(env: Env) -> FastAPI:
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _h(_: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse({"error": exc.message}, status_code=exc.http_status)

    @app.get("/v1/sessions/{session_id}")
    async def _session(session_id: str) -> dict[str, Any]:
        return {"kind": "conversation", "parent_session_id": None}

    app.include_router(create_knowledge_router(env.service, auth_provider=_Auth()), prefix="/v1")  # type: ignore[arg-type]
    return app


@pytest.fixture()
def env(db_uri: str, tmp_path: Path) -> Env:
    return build_env(db_uri, tmp_path)


@pytest.fixture()
def client(env: Env) -> TestClient:
    return TestClient(_app(env))


def _handle(env: Env, tool: str, args: dict[str, Any]) -> str:
    async def run() -> str:
        transport = httpx.ASGITransport(app=_app(env))
        async with httpx.AsyncClient(
            transport=transport, base_url="http://engine", headers=ALICE
        ) as http:
            ctx = HandlerCtx(tool, http, "c" * 32, SUPER_CHAT)
            return await handle_knowledge_tool(ctx, args)

    return asyncio.run(run())


def test_status_lists_the_callers_files_only(env: Env, client: TestClient) -> None:
    env.save("finance.pdf", FINANCE)
    env.run_all()
    body = client.get("/v1/knowledge/status", headers=ALICE).json()
    assert [(f["name"], f["state"], f["pages"]) for f in body["files"]] == [
        ("finance.pdf", "searchable", 2)
    ]
    assert body["embeddings"]["available"] is True
    assert client.get("/v1/knowledge/status", headers=BOB).json()["files"] == []


def test_search_route_returns_passages_with_page_score_and_thumbnail(
    env: Env, client: TestClient
) -> None:
    item = env.save("finance.pdf", FINANCE)
    env.run_all()
    body = client.post(
        "/v1/knowledge/search", json={"query": "currency exposure", "k": 3}, headers=ALICE
    ).json()
    top = body["results"][0]
    assert (top["file_name"], top["artifact_id"], top["page"]) == ("finance.pdf", item.id, 2)
    assert top["thumbnail_url"] == f"/v1/knowledge/files/{item.id}/pages/2/thumbnail"
    assert "Currency exposure" in top["passage"] and body["mode"] == "hybrid"
    assert (
        client.post("/v1/knowledge/search", json={"query": ""}, headers=ALICE).status_code == 422
    )
    bad = client.post(
        "/v1/knowledge/search", json={"query": "x", "file_ids": ["nope"]}, headers=ALICE
    )
    assert bad.status_code == 400


def test_page_routes_serve_text_image_and_thumbnail_to_the_owner_only(
    env: Env, client: TestClient
) -> None:
    item = env.save("finance.pdf", FINANCE)
    env.run_all()
    page = client.get(f"/v1/knowledge/files/{item.id}/pages/2", headers=ALICE).json()
    assert "Currency exposure" in page["text"] and page["image_mime"] == "image/webp"
    assert page["page_count"] == 2 and page["image_base64"]
    thumb = client.get(f"/v1/knowledge/files/{item.id}/pages/1/thumbnail", headers=ALICE)
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/webp"
    assert thumb.content[:4] == b"RIFF"
    big = client.get(f"/v1/knowledge/files/{item.id}/pages/1/image", headers=ALICE)
    assert len(big.content) > len(thumb.content)
    assert client.get(f"/v1/knowledge/files/{item.id}/pages/9", headers=ALICE).status_code == 404
    assert client.get(f"/v1/knowledge/files/{item.id}/pages/1", headers=BOB).status_code == 404
    assert (
        client.get(f"/v1/knowledge/files/{item.id}/pages/1/thumbnail", headers=BOB).status_code
        == 404
    )


def test_reindex_route(env: Env, client: TestClient) -> None:
    env.save("finance.pdf", FINANCE)
    env.run_all()
    assert client.post("/v1/knowledge/reindex", headers=ALICE).json() == {"queued": 0}


def test_tool_defs_are_offered_to_the_super_chat_only() -> None:
    assert KNOWLEDGE_TOOL_NAMES == ("files_search", "files_read_page")
    tools = FEATURE.tools(SUPER_CHAT, None)  # type: ignore[arg-type]
    schemas = {t.name(): t.get_schema()["function"]["parameters"] for t in tools}
    assert schemas["files_search"]["required"] == ["query"]
    assert schemas["files_read_page"]["required"] == ["artifact_id", "page"]
    assert FEATURE.tools({}, None) == []  # type: ignore[arg-type]
    assert set(FEATURE.handlers) == set(KNOWLEDGE_TOOL_NAMES)


def test_files_search_tool_output(env: Env) -> None:
    item = env.save("finance.pdf", FINANCE)
    env.run_all()
    out = json.loads(_handle(env, "files_search", {"query": "currency exposure", "k": 2}))
    assert out["type"] == "file_search" and len(out["results"]) <= 2
    first = out["results"][0]
    assert set(first) >= {
        "file_name", "artifact_id", "page", "score", "thumbnail_url", "passage", "heading"
    }  # fmt: skip
    assert (first["artifact_id"], first["page"]) == (item.id, 2)
    narrowed = json.loads(
        _handle(env, "files_search", {"query": "revenue", "file_ids": [item.id]})
    )
    assert {r["artifact_id"] for r in narrowed["results"]} == {item.id}


def test_files_search_tool_rejects_bad_arguments(env: Env) -> None:
    assert "requires a query" in json.loads(_handle(env, "files_search", {}))["error"]
    bad = json.loads(_handle(env, "files_search", {"query": "x", "file_ids": ["zz"]}))
    assert "artifact ids" in bad["error"]


def test_files_read_page_returns_the_image_and_the_text(env: Env) -> None:
    item = env.save("finance.pdf", FINANCE)
    env.run_all()
    raw = _handle(env, "files_read_page", {"artifact_id": item.id, "page": 2})
    result = decode_mcp_image_result(json.loads(raw))
    assert result is not None and not result.is_error
    text, image = result.content
    meta = json.loads(str(text["text"]))
    assert meta["page"] == 2 and "Currency exposure" in meta["text"]
    assert (image["type"], image["mimeType"]) == ("image", "image/webp")
    assert len(str(image["data"])) > 100


def test_files_read_page_of_a_text_file_is_plain_text(env: Env) -> None:
    item = env.save("notes.md", b"# Board notes\nThe vote passed.")
    env.run_all()
    out = json.loads(_handle(env, "files_read_page", {"artifact_id": item.id, "page": 1}))
    assert "The vote passed." in out["text"] and "image_base64" not in out


def test_files_read_page_errors(env: Env) -> None:
    item = env.save("finance.pdf", FINANCE)
    env.run_all()
    assert (
        "valid artifact_id"
        in json.loads(_handle(env, "files_read_page", {"artifact_id": "x", "page": 1}))["error"]
    )
    assert (
        "page number"
        in json.loads(_handle(env, "files_read_page", {"artifact_id": item.id, "page": 0}))[
            "error"
        ]
    )
    assert json.loads(_handle(env, "files_read_page", {"artifact_id": item.id, "page": 7}))[
        "error"
    ].startswith("server returned 404")


def _msg(item_id: str, role: str, text: str) -> dict[str, Any]:
    kind = "input_text" if role == "user" else "output_text"
    return {
        "id": item_id, "type": "message", "role": role, "created_at": 1,
        "content": [{"type": kind, "text": text}],
    }  # fmt: skip


def _search_call(call_id: str, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = json.dumps({"type": "file_search", "results": results})
    return [
        {"id": f"c{call_id}", "type": "function_call", "name": "mcp__omnigent__files_search",
         "call_id": call_id, "arguments": "{}", "created_at": 1},
        {"id": f"o{call_id}", "type": "function_call_output", "call_id": call_id,
         "output": output},
    ]  # fmt: skip


def test_search_results_become_citation_chips_under_the_answer() -> None:
    hits = [
        {"artifact_id": "a" * 32, "file_name": "finance.pdf", "page": 2, "thumbnail_url": "/t"},
        {"artifact_id": "a" * 32, "file_name": "finance.pdf", "page": 2, "thumbnail_url": "/t"},
        {"artifact_id": "b" * 32, "file_name": "notes.md", "page": 1, "thumbnail_url": None},
    ]
    items = [
        _msg("m1", "user", "what is the main risk?"),
        *_search_call("s1", hits),
        _msg("m2", "assistant", "Currency exposure (finance.pdf, p. 2)."),
    ]
    messages = project_items(items)
    assert [m["role"] for m in messages] == ["user", "assistant"]
    text, chips = messages[1]["blocks"]
    assert text["type"] == "text" and chips["type"] == "card"
    assert chips["card"]["card"] == "passages"
    assert chips["card"]["data"]["items"] == [
        {"artifactId": "a" * 32, "name": "finance.pdf", "page": 2, "hasThumbnail": True},
        {"artifactId": "b" * 32, "name": "notes.md", "page": 1},
    ]
    assert chips["card"]["fallback"] == "Sources: finance.pdf p. 2, notes.md p. 1"


def test_chips_do_not_leak_into_a_later_turn_and_empty_searches_show_nothing() -> None:
    items = [
        _msg("m1", "user", "q1"),
        *_search_call("s1", [{"artifact_id": "a" * 32, "file_name": "f.pdf", "page": 1}]),
        _msg("m2", "user", "q2"),
        _msg("m3", "assistant", "plain answer"),
        _msg("m4", "user", "q3"),
        *_search_call("s2", []),
        _msg("m5", "assistant", "nothing found"),
    ]
    answers = [m for m in project_items(items) if m["role"] == "assistant"]
    assert [len(m["blocks"]) for m in answers] == [1, 1]
