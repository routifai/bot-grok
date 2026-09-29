"""Only an explicit label makes a session private."""

from omnigent.nova._shared import Scope, scope_from_labels


def test_explicit_private_label_is_private() -> None:
    assert scope_from_labels({"nova.scope": "private"}) is Scope.PRIVATE


def test_missing_label_is_project() -> None:
    assert scope_from_labels({}) is Scope.PROJECT


def test_unrecognised_label_is_project() -> None:
    assert scope_from_labels({"nova.scope": "PRIVATE "}) is Scope.PROJECT
