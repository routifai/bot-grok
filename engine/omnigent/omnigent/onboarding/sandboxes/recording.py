"""Recording capability: capture what a person does on a sandbox's screen as semantic actions.

Optional capability (:attr:`SandboxCapabilities.recording`) that sits next to ``screen``. While a
person holds control of the sandbox's browser, a helper inside the sandbox reports semantic
actions (click, type, select, navigate) with element role, accessible name and a selector hint,
plus a downscaled keyframe screenshot per action. The provider pulls the trace and keyframes out
and deletes them from the sandbox on stop, so nothing is kept there.

Providers opt in by mixing in :class:`RecordingMixin` and setting ``recording=True`` in their
capabilities; the helper command is ``aiden-recorder`` (``infra/sandboxes/computer``).
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import click

if TYPE_CHECKING:
    from collections.abc import Mapping

    from omnigent.onboarding.sandboxes.base import RemoteCommandResult

_logger = logging.getLogger(__name__)

RECORDER_COMMAND = "aiden-recorder"
_RECORDING_ID_RE = re.compile(r"^[a-f0-9]{8,64}$")
_KEYFRAME_RE = re.compile(r"^k\d{1,4}$")
# Keyframes are pulled one command each; a recording never holds more than the helper's cap.
MAX_PULLED_KEYFRAMES = 60


@dataclass
class RecordingTrace:
    """What a recording captured.

    :param actions: Ordered semantic actions, each ``{"seq", "kind", "url", ...}`` and, when a
        keyframe was taken, ``"keyframe": "k3"``.
    :param keyframes: Keyframe JPEG bytes by name, e.g. ``{"k3": b"..."}``. Only names the
        actions refer to are kept.
    """

    actions: list[dict[str, Any]] = field(default_factory=list)
    keyframes: dict[str, bytes] = field(default_factory=dict)


def _last_json(result: RemoteCommandResult) -> dict[str, Any]:
    """Parse the helper's JSON reply (its last stdout line)."""
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise click.ClickException(
            f"recorder gave no answer: {(result.stderr or '').strip()[:300]}"
        )
    try:
        body = json.loads(lines[-1])
    except ValueError as exc:
        raise click.ClickException(
            f"recorder gave an unreadable answer: {lines[-1][:200]}"
        ) from exc
    if not isinstance(body, dict):
        raise click.ClickException("recorder gave an unreadable answer")
    return body


class RecordingMixin:
    """Recording capability for an exec-capable sandbox launcher (needs ``run``)."""

    if TYPE_CHECKING:

        def run(
            self,
            sandbox_id: str,
            command: str,
            *,
            check: bool = True,
            env: Mapping[str, str] | None = None,
        ) -> RemoteCommandResult:
            """Run a shell command in the sandbox (the launcher this mixes into supplies it)."""
            ...

    def _recorder(self, sandbox_id: str, *args: str) -> RemoteCommandResult:
        for arg in args:
            if not (_RECORDING_ID_RE.match(arg) or _KEYFRAME_RE.match(arg) or arg.isalpha()):
                raise click.ClickException(f"invalid recorder argument {arg!r}")
        return self.run(sandbox_id, " ".join([RECORDER_COMMAND, *args]), check=False)

    def start_recording(self, sandbox_id: str, recording_id: str) -> None:
        """
        Start recording the sandbox browser.

        :param sandbox_id: The sandbox to record.
        :param recording_id: Hex id the engine chose for this recording, e.g. ``"a1b2c3d4e5f6"``.
        :raises click.ClickException: When the recorder cannot start (no browser, no helper).
        """
        body = _last_json(self._recorder(sandbox_id, "start", recording_id))
        if body.get("ok") is not True:
            raise click.ClickException(
                f"could not start recording: {body.get('error', 'unknown')}"
            )

    def stop_recording(self, sandbox_id: str, recording_id: str) -> RecordingTrace:
        """
        Stop recording and return the trace; the sandbox's copy is always deleted.

        :param sandbox_id: The sandbox being recorded.
        :param recording_id: The id given to :meth:`start_recording`.
        :returns: The ordered actions and their keyframe images.
        :raises click.ClickException: When the trace cannot be read back.
        """
        try:
            self._recorder(sandbox_id, "stop", recording_id)
            body = _last_json(self._recorder(sandbox_id, "pull", recording_id))
            if body.get("ok") is not True:
                raise click.ClickException(
                    f"could not read recording: {body.get('error', 'unknown')}"
                )
            actions = [a for a in body.get("actions", []) if isinstance(a, dict)]
            wanted = [a["keyframe"] for a in actions if isinstance(a.get("keyframe"), str)]
            available = set(body.get("keyframes", []))
            keyframes: dict[str, bytes] = {}
            for name in dict.fromkeys(wanted):
                if name not in available or len(keyframes) >= MAX_PULLED_KEYFRAMES:
                    continue
                data = self._pull_keyframe(sandbox_id, recording_id, name)
                if data:
                    keyframes[name] = data
            for action in actions:
                if action.get("keyframe") not in keyframes:
                    action.pop("keyframe", None)
            return RecordingTrace(actions=actions, keyframes=keyframes)
        finally:
            self.discard_recording(sandbox_id, recording_id)

    def discard_recording(self, sandbox_id: str, recording_id: str) -> None:
        """Delete a recording's files from the sandbox; never raises."""
        try:
            self._recorder(sandbox_id, "discard", recording_id)
        except click.ClickException:
            _logger.warning("could not discard recording %s", recording_id)

    def _pull_keyframe(self, sandbox_id: str, recording_id: str, name: str) -> bytes:
        result = self._recorder(sandbox_id, "frame", recording_id, name)
        if result.returncode != 0:
            return b""
        try:
            return base64.b64decode(result.stdout.strip(), validate=True)
        except (binascii.Error, ValueError):
            return b""
