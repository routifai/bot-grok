"""Proactive provisioning: the standing proactive tasks (Study) a Super Chat gets lazily.

Layout: ``provisioner`` (desired tasks + :class:`ProactiveProvisioner`), ``hook`` (the single
call ``routes_events`` makes on a user message). Imports stay lazy so importing a submodule
never loads the server.
"""
