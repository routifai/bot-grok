"""Opt-in trace of every model call a harness CLI makes (dev only, off by default).

With ``OMNIGENT_LLM_TRACE_DIR`` set, the process that runs a Claude CLI starts a small logging
reverse proxy on ``127.0.0.1`` and points the CLI's ``ANTHROPIC_BASE_URL`` at it
(:func:`base_url_for`). The proxy forwards each request unchanged to the real upstream (the
direct API or a gateway, whatever the base URL was), streams the answer straight back, and
writes one JSONL record per request: the session, the time, the request body (system, tools
with every field, messages, model, max_tokens), the status and the assembled answer (text,
tool calls, stop reason, usage). Header values are never written. :func:`event` records what
the executor itself sees (the CLI's ``system/init``, each prompt it sends in).

Read the records with ``engine/scripts/llm_trace.py <dir>``. Stdlib only.
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

TRACE_DIR_ENV = "OMNIGENT_LLM_TRACE_DIR"
#: Never forwarded as-is to the upstream (hop-by-hop, or rewritten here).
_DROP_REQUEST = {"host", "content-length", "connection", "accept-encoding", "keep-alive"}
_DROP_RESPONSE = {"content-length", "transfer-encoding", "connection", "content-encoding"}
_UPSTREAM_TIMEOUT_S = 900

_lock = threading.Lock()
_server: ThreadingHTTPServer | None = None


def trace_dir() -> Path | None:
    """The trace directory, or ``None`` when tracing is off."""
    raw = os.environ.get(TRACE_DIR_ENV, "").strip()
    return Path(raw) if raw else None


def _write(record: dict[str, Any]) -> None:
    folder = trace_dir()
    if folder is None:
        return
    try:
        folder.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False, default=str) + "\n"
        with _lock, open(folder / f"trace-{os.getpid()}.jsonl", "a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError:
        pass  # a trace never breaks a turn


def event(session: str, kind: str, payload: Any) -> None:
    """Record something the executor saw for *session* (``cli_init``, ``prompt``); no-op off."""
    if trace_dir() is not None:
        _write({"kind": kind, "session": session, "t": time.time(), "data": payload})


def base_url_for(session: str, upstream: str) -> str | None:
    """A base URL for *session*'s CLI that traces through the proxy to *upstream*; ``None`` when
    tracing is off (the CLI keeps its own base URL)."""
    if trace_dir() is None:
        return None
    port = _ensure_server()
    target = base64.urlsafe_b64encode(upstream.rstrip("/").encode()).decode().rstrip("=")
    return f"http://127.0.0.1:{port}/s/{urllib.parse.quote(session, safe='')}/u/{target}"


def _ensure_server() -> int:
    global _server
    with _lock:
        if _server is None:
            _server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
            _server.daemon_threads = True
            threading.Thread(target=_server.serve_forever, name="llm-trace", daemon=True).start()
        return int(_server.server_address[1])


def _assemble_sse(raw: bytes) -> dict[str, Any]:
    """The answer a Messages stream carried: model, text, tool calls, stop reason, usage."""
    out: dict[str, Any] = {"content": []}
    blocks: dict[int, dict[str, Any]] = {}
    for line in raw.decode("utf-8", errors="replace").splitlines():
        if not line.startswith("data:"):
            continue
        try:
            data = json.loads(line[5:].strip())
        except ValueError:
            continue
        kind = data.get("type")
        if kind == "message_start":
            message = data.get("message") or {}
            out["model"] = message.get("model")
            out["usage"] = message.get("usage")
        elif kind == "content_block_start":
            block = dict(data.get("content_block") or {})
            block.pop("input", None)
            block["_json"] = ""
            blocks[int(data.get("index", 0))] = block
        elif kind == "content_block_delta":
            block = blocks.setdefault(int(data.get("index", 0)), {"_json": ""})
            delta = data.get("delta") or {}
            if delta.get("type") == "text_delta":
                block["text"] = block.get("text", "") + str(delta.get("text", ""))
            elif delta.get("type") == "input_json_delta":
                block["_json"] += str(delta.get("partial_json", ""))
            elif delta.get("type") == "thinking_delta":
                block["thinking"] = block.get("thinking", "") + str(delta.get("thinking", ""))
        elif kind == "message_delta":
            out["stop_reason"] = (data.get("delta") or {}).get("stop_reason")
            out["usage_delta"] = data.get("usage")
        elif kind == "error":
            out["error"] = data.get("error")
    for index in sorted(blocks):
        block = blocks[index]
        partial = block.pop("_json", "")
        if partial:
            try:
                block["input"] = json.loads(partial)
            except ValueError:
                block["input_raw"] = partial
        out["content"].append(block)
    return out


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # the answer ends when the connection closes: no re-chunking

    def log_message(self, *_args: Any) -> None:
        return  # never the stdlib's access line: a path can carry a session id

    def do_GET(self) -> None:
        self._forward()

    def do_POST(self) -> None:
        self._forward()

    def _forward(self) -> None:
        started = time.time()
        parts = self.path.split("/", 5)  # "", "s", session, "u", upstream, rest
        if len(parts) < 5 or parts[1] != "s" or parts[3] != "u":
            self.send_error(404)
            return
        session = urllib.parse.unquote(parts[2])
        padded = parts[4] + "=" * (-len(parts[4]) % 4)
        upstream = urllib.parse.urlsplit(base64.urlsafe_b64decode(padded).decode())
        rest = "/" + (parts[5] if len(parts) > 5 else "")
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        headers = {k: v for k, v in self.headers.items() if k.lower() not in _DROP_REQUEST}
        headers["accept-encoding"] = "identity"
        secure = upstream.scheme == "https"
        connect = http.client.HTTPSConnection if secure else http.client.HTTPConnection
        conn = connect(upstream.netloc, timeout=_UPSTREAM_TIMEOUT_S)
        captured = bytearray()
        status = 0
        try:
            target = upstream.path.rstrip("/") + rest
            conn.request(self.command, target, body=body, headers=headers)
            resp = conn.getresponse()
            status = resp.status
            self.send_response(resp.status, resp.reason)
            for key, value in resp.getheaders():
                if key.lower() not in _DROP_RESPONSE:
                    self.send_header(key, value)
            self.end_headers()
            while chunk := resp.read1(65536):
                captured += chunk
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, http.client.HTTPException) as exc:
            if not status:
                self.send_error(502, type(exc).__name__)
        finally:
            conn.close()
            _write(_record(session, self.command, rest, started, status, body, bytes(captured)))


def _record(
    session: str, method: str, path: str, started: float, status: int, body: bytes, answer: bytes
) -> dict[str, Any]:
    try:
        request: Any = json.loads(body) if body else None
    except ValueError:
        request = {"bytes": len(body)}
    text = answer.lstrip()
    if text.startswith((b"event:", b"data:")):
        response: Any = _assemble_sse(answer)
    else:
        try:
            response = json.loads(answer) if answer else None
        except ValueError:
            response = {"bytes": len(answer)}
    return {
        "kind": "call",
        "session": session,
        "t": started,
        "ms": round((time.time() - started) * 1000),
        "method": method,
        "path": path,
        "status": status,
        "request": request,
        "response": response,
    }
