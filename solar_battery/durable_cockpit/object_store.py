from __future__ import annotations

from dataclasses import dataclass
from typing import BinaryIO, Protocol


@dataclass(frozen=True, slots=True)
class StoredObject:
    storage_key: str
    size_bytes: int
    sha256_hex: str


class ObjectStore(Protocol):
    def storage_key_for(
        self,
        *,
        namespace: str,
        filename_hint: str,
        object_identity: str,
    ) -> str: ...

    def put_bytes(
        self,
        *,
        namespace: str,
        filename_hint: str,
        data: bytes,
        object_identity: str | None = None,
    ) -> StoredObject: ...

    def open_read(self, storage_key: str) -> BinaryIO: ...

    def delete(self, storage_key: str) -> None: ...
