"""Per-account model credential: one sealed provider key per user, never returned in plaintext.

Exactly one active key per user is enforced by the primary key ``(workspace_id, user_id)``: a new
key replaces the old one by upsert. The key is sealed with the vault's AES-256-GCM
(``OMNIGENT_VAULT_KEY``), associated data ``"<user_id>|<provider>"``, and fails closed when the
vault key is missing. Plaintext leaves only through :func:`get_owner_model_credential` /
:meth:`ModelCredentialStore.get_plaintext` (server side, for the run path); it is never logged.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from omnigent.db.db_models import SqlUserModelCredential, current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.model_credentials.probe import PROVIDERS
from omnigent.superchat.vault.store import seal, unseal

STATUS_VALID = "valid"


class CredentialInputError(ValueError):
    """The provider or key is not acceptable."""


@dataclass(frozen=True)
class CredentialMeta:
    """What a client may see about the saved key: never the key."""

    provider: str
    hint: str
    validated_at: int
    status: str


def _meta(row: SqlUserModelCredential) -> CredentialMeta:
    return CredentialMeta(row.provider, row.hint, row.validated_at, row.status)


def _aad_id(provider: str) -> str:
    return provider


class ModelCredentialStore:
    """SQLAlchemy-backed store, owner-scoped by ``user_id``."""

    def __init__(self, storage_location: str) -> None:
        """:param storage_location: SQLAlchemy database URI."""
        self.storage_location = storage_location
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.model_credential_store"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.model_credential_store", immediate=True
        )

    def put(
        self, user_id: str, provider: str, api_key: str, *, validated_at: int | None = None
    ) -> CredentialMeta:
        """Seal and store the key, replacing any previous one.

        :raises VaultUnavailableError: no usable ``OMNIGENT_VAULT_KEY`` (nothing is stored).
        :raises CredentialInputError: unknown provider or empty key.
        """
        if provider not in PROVIDERS:
            raise CredentialInputError("provider must be 'anthropic' or 'openrouter'")
        api_key = api_key.strip()
        if not api_key:
            raise CredentialInputError("api_key is required")
        ciphertext = seal(api_key, user_id=user_id, secret_id=_aad_id(provider))
        now = now_epoch()
        stamp = validated_at if validated_at is not None else now

        def write(session: Session) -> CredentialMeta:
            row = session.get(SqlUserModelCredential, (current_workspace_id(), user_id))
            if row is None:
                row = SqlUserModelCredential(user_id=user_id, created_at=now)
                session.add(row)
            row.provider = provider
            row.ciphertext = ciphertext
            row.hint = api_key[-4:]
            row.validated_at = stamp
            row.status = STATUS_VALID
            row.updated_at = now
            session.flush()
            return _meta(row)

        return run_write_transaction(self._session_immediate, "model_credential_put", write)

    def get_meta(self, user_id: str) -> CredentialMeta | None:
        """:returns: Masked metadata of the user's key, or ``None``."""
        with self._session("model_credential_get_meta") as session:
            row = session.scalars(
                select(SqlUserModelCredential).where(
                    SqlUserModelCredential.user_id == user_id,
                    SqlUserModelCredential.workspace_id == current_workspace_id(),
                )
            ).first()
            return _meta(row) if row else None

    def get_plaintext(self, user_id: str) -> tuple[str, str] | None:
        """:returns: ``(provider, api_key)`` or ``None``. Server side only.

        :raises VaultUnavailableError: the vault key is missing or cannot open the value.
        """
        with self._session("model_credential_get") as session:
            row = session.scalars(
                select(SqlUserModelCredential).where(
                    SqlUserModelCredential.user_id == user_id,
                    SqlUserModelCredential.workspace_id == current_workspace_id(),
                )
            ).first()
            if row is None:
                return None
            provider, token = row.provider, row.ciphertext
        return provider, unseal(token, user_id=user_id, secret_id=_aad_id(provider))

    def delete(self, user_id: str) -> bool:
        """:returns: ``True`` when a key was removed."""

        def write(session: Session) -> bool:
            result = session.execute(
                delete(SqlUserModelCredential).where(
                    SqlUserModelCredential.user_id == user_id,
                    SqlUserModelCredential.workspace_id == current_workspace_id(),
                )
            )
            return bool(result.rowcount)

        return run_write_transaction(self._session_immediate, "model_credential_delete", write)


def get_owner_model_credential(
    store: ModelCredentialStore, user_id: str
) -> tuple[str, str] | None:
    """The owner's ``(provider, plaintext key)`` for the run path, or ``None``; server side."""
    return store.get_plaintext(user_id)
