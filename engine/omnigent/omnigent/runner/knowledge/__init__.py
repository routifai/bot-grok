"""File search that runs in the person's Computer.

The Computer's workspace is the one copy of a person's files, so parsing, passages, thumbnails and
the index live here too, on the home volume (``~/.nova/knowledge``). Nothing about a file is
kept in
the engine: it only relays (``omnigent.superchat.knowledge``), and embeddings come from the
engine's
model proxy so no key enters the Computer.

Layout: ``chunking`` / ``parse`` / ``pdf`` (text and renders, no ML), ``db`` (SQLite: FTS5
BM25 plus
sqlite-vec), ``embedder`` (the model proxy client), ``indexer`` (reconcile, passes, search),
``runtime`` (the background thread and the handlers' way in).
"""
