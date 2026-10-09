"""Built-in tools for searching the person's uploaded files.

Schema-only classes: the runner dispatches each to :mod:`omnigent.superchat.knowledge.handlers`,
which answers from the index in the person's Computer.

* ``files_search`` — passages from the person's files, with file, page and a thumbnail.
* ``files_read_page`` — one page: its image (to look at charts and layout) and its text.
"""

from __future__ import annotations

from omnigent.superchat.artifacts import ArtifactTool

KNOWLEDGE_TOOL_NAMES = ("files_search", "files_read_page")


class FilesSearchTool(ArtifactTool):
    """Search the person's files; answered by the index in their Computer."""

    _NAME = "files_search"
    _DESC = (
        "Search inside the person's files in your workspace (uploads, files you saved: PDF, text, "
        "Markdown, CSV, XLSX) by meaning and by keyword. Returns the best passages with the file "
        "name, path, file id, page, a score and a thumbnail_url. Use it for big files or many "
        "files; cite the file and page of what you use. A file that is still being indexed may "
        "be missing: files_indexing says how many."
    )
    _PROPERTIES = {
        "query": {"type": "string", "description": "What to look for, in plain words."},
        "file_ids": {
            "type": "array",
            "items": {"type": "string"},
            "description": "File ids (from an earlier search) to search in; omit for every file.",
        },
        "k": {"type": "integer", "description": "How many passages to return (default 8)."},
    }
    _REQUIRED = ("query",)


class FilesReadPageTool(ArtifactTool):
    """Read one page of an indexed file; answered by the index in their Computer."""

    _NAME = "files_read_page"
    _DESC = (
        "Look at one page of an indexed file: returns the page image (so you can read charts, "
        "tables and layout) and the page's text. Use it after files_search when the answer is "
        "visual or needs the whole page. Name the file by its name or path (as you know it from "
        "the person's files or from files_search); a file_id works too. Pages are numbered from 1."
    )
    _PROPERTIES = {
        "path": {
            "type": "string",
            "description": "The file's workspace path or plain file name, e.g. report.pdf.",
        },
        "file_id": {"type": "string", "description": "Optional: the file id from files_search."},
        "page": {"type": "integer", "description": "Page number, from 1."},
    }
    _REQUIRED = ("path", "page")
