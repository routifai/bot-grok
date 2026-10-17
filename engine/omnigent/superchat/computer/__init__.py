"""Computer status route: whether a session's Computer is up (``/sessions/{id}/computer``).

Mounted on the sessions router; the Computer itself (runner, files, headless browser) is not
this package's concern, only reporting its readiness and launch progress.
"""
