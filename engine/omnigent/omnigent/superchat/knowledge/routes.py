"""``/v1/knowledge``: what is indexed, search, and the page images the citations show.

Owner-scoped: another person's file answers 404, like the artifacts routes. The runner-side
``files_search`` / ``files_read_page`` tools call these, and so does Nova.
"""

from __future__ import annotations

import asyncio
import base64
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import AuthProvider
from omnigent.superchat.artifacts import check_id, request_owner
from omnigent.superchat.knowledge.service import DEFAULT_K, MAX_K, KnowledgeService
from omnigent.superchat.knowledge.store import Job


class SearchBody(BaseModel):
    """Body of ``POST /knowledge/search``."""

    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=2000)
    file_ids: list[str] | None = Field(default=None, max_length=200)
    k: int = Field(default=DEFAULT_K, ge=1, le=MAX_K)


def create_knowledge_router(
    service: KnowledgeService, *, auth_provider: AuthProvider | None = None
) -> APIRouter:
    """Build the router, mounted with ``prefix="/v1"``."""
    router = APIRouter()

    def _owner(request: Request) -> str | None:
        return request_owner(request, auth_provider)

    async def _job(request: Request, artifact_id: str) -> Job:
        check_id(artifact_id, "artifact id")
        job = await asyncio.to_thread(service.job_for, _owner(request), artifact_id)
        if job is None:
            raise OmnigentError("File is not indexed", code=ErrorCode.NOT_FOUND)
        return job

    @router.get("/knowledge/status")
    async def status(request: Request) -> dict[str, Any]:
        """Per-file index state, and whether searches can use embeddings."""
        return await asyncio.to_thread(service.status, _owner(request))

    @router.post("/knowledge/search")
    async def search(request: Request, body: SearchBody) -> dict[str, Any]:
        """Passages from the caller's files, best first, with page and thumbnail."""
        for file_id in body.file_ids or []:
            check_id(file_id, "file id")
        try:
            return await asyncio.to_thread(
                lambda: service.search(
                    _owner(request), body.query, file_ids=body.file_ids, k=body.k
                )
            )
        except ImportError as exc:
            raise OmnigentError(str(exc), code=ErrorCode.SUPERCHAT_NOT_CONFIGURED) from None

    @router.post("/knowledge/reindex")
    async def reindex(request: Request) -> dict[str, Any]:
        """Re-embed files that are keyword-only or were embedded with another model."""
        queued = await asyncio.to_thread(service.reindex, _owner(request))
        return {"queued": queued}

    @router.get("/knowledge/files/{artifact_id}/pages/{page}")
    async def read_page(request: Request, artifact_id: str, page: int) -> dict[str, Any]:
        """A page's text and, for a PDF, its image (base64 WebP)."""
        job = await _job(request, artifact_id)
        found = await asyncio.to_thread(service.page, job, page)
        if found is None:
            raise OmnigentError("Page not found", code=ErrorCode.NOT_FOUND)
        image = found.pop("image")
        return {
            **found,
            "name": job.name,
            "artifact_id": job.source_id,
            "image_base64": base64.b64encode(image).decode() if image else None,
            "image_mime": "image/webp" if image else None,
        }

    def _image_route(variant: str, tail: str) -> None:
        @router.get(
            f"/knowledge/files/{{artifact_id}}/pages/{{page}}/{tail}", name=f"knowledge_{tail}"
        )
        async def page_image(request: Request, artifact_id: str, page: int) -> Response:
            job = await _job(request, artifact_id)
            data = await asyncio.to_thread(service.page_image, job, page, variant)
            if data is None:
                raise OmnigentError("Page image not found", code=ErrorCode.NOT_FOUND)
            return Response(
                content=data,
                media_type="image/webp",
                headers={
                    "Cache-Control": "private, max-age=3600",
                    "X-Content-Type-Options": "nosniff",
                },
            )

    _image_route("thumb", "thumbnail")
    _image_route("page", "image")
    return router
