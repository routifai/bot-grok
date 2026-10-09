"""Built-in tools for searching the person's uploaded files.

Schema-only classes: the runner dispatches each to the server's ``/v1/knowledge`` endpoints.

* ``files_search`` — passages from the person's files, with file, page and a thumbnail.
* ``files_read_page`` — one page: its image (to look at charts and layout) and its text.
"""

from __future__ import annotations

from omnigent.superchat.artifacts import ArtifactTool

KNOWLEDGE_TOOL_NAMES = ("files_search", "files_read_page")


class FilesSearchTool(ArtifactTool):
    """Search the person's files; dispatched to ``POST /v1/knowledge/search``."""

    _NAME = "files_search"
    _DESC = (
        "Search inside the person's saved files (PDF, text, Markdown, CSV, XLSX) by meaning and "
        "by keyword. Returns the best passages with the file name, artifact id, page, a score and "
        "a thumbnail_url. Use it for big files or many files; cite the file and page of what you "
        "use. A file that is still being indexed may be missing: files_indexing says how many."
    )
    _PROPERTIES = {
        "query": {"type": "string", "description": "What to look for, in plain words."},
        "file_ids": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Artifact ids to search in; omit to search every file.",
        },
        "k": {"type": "integer", "description": "How many passages to return (default 8)."},
    }
    _REQUIRED = ("query",)


class FilesReadPageTool(ArtifactTool):
    """Read one page of an indexed file; dispatched to ``/v1/knowledge/files/{id}/pages/{n}``."""

    _NAME = "files_read_page"
    _DESC = (
        "Look at one page of a saved file: returns the page image (so you can read charts, "
        "tables and layout) and the page's text. Use it after files_search when the answer is "
        "visual or needs the whole page. Pages are numbered from 1."
    )
    _PROPERTIES = {
        "artifact_id": {"type": "string", "description": "The artifact id."},
        "page": {"type": "integer", "description": "Page number, from 1."},
    }
    _REQUIRED = ("artifact_id", "page")
