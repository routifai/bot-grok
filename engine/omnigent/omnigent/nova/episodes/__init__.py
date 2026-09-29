"""Episodes: a dated record of each finished task, and recall of past ones.

See ``README.md`` for what this primitive owns. Other code imports only what
is re-exported here — never ``omnigent.nova.episodes.<internal module>``
directly (Nova rule #1).
"""

from omnigent.nova.episodes.entities import Episode
from omnigent.nova.episodes.service import (
    NO_RESPONSE,
    WORK_TOOLS,
    BuiltEpisode,
    build_episode,
    rank_episodes,
    record_turn,
    render_episodes,
)
from omnigent.nova.episodes.store import EpisodeStore

__all__ = [
    "NO_RESPONSE",
    "WORK_TOOLS",
    "BuiltEpisode",
    "Episode",
    "EpisodeStore",
    "build_episode",
    "rank_episodes",
    "record_turn",
    "render_episodes",
]
