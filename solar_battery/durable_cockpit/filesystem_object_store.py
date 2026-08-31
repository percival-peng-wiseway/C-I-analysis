from __future__ import annotations

import hashlib
import os
import re
import tempfile
from pathlib import Path, PurePosixPath
from typing import BinaryIO
from uuid import uuid4

from solar_battery.durable_cockpit.object_store import ObjectStore, StoredObject


_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")
_SAFE_FILENAME_CHAR = re.compile(r"[^A-Za-z0-9._-]+")


class FilesystemObjectStore(ObjectStore):
    def __init__(self, root: str | Path) -> None:
        self._root = Path(root)

    def put_bytes(
        self,
        *,
        namespace: str,
        filename_hint: str,
        data: bytes,
        object_identity: str | None = None,
    ) -> StoredObject:
        if object_identity is None:
            object_identity = uuid4().hex
        storage_key = self.storage_key_for(
            namespace=namespace,
            filename_hint=filename_hint,
            object_identity=object_identity,
        )
        destination = self._resolve_storage_path(storage_key)
        destination.parent.mkdir(parents=True, exist_ok=True)

        digest = hashlib.sha256(data).hexdigest()
        fd, temporary_name = tempfile.mkstemp(
            prefix=".tmp-",
            dir=str(destination.parent),
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, destination)
        except Exception:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass
            raise

        return StoredObject(
            storage_key=storage_key,
            size_bytes=len(data),
            sha256_hex=digest,
        )

    def storage_key_for(
        self,
        *,
        namespace: str,
        filename_hint: str,
        object_identity: str,
    ) -> str:
        namespace_path = self._validate_namespace(namespace)
        safe_filename = _sanitize_filename(filename_hint)
        if not _SAFE_SEGMENT.fullmatch(object_identity):
            raise ValueError("unsafe object identity")
        return str(namespace_path / f"{object_identity}-{safe_filename}")

    def open_read(self, storage_key: str) -> BinaryIO:
        return self._resolve_storage_path(storage_key).open("rb")

    def delete(self, storage_key: str) -> None:
        path = self._resolve_storage_path(storage_key)
        try:
            path.unlink()
        except FileNotFoundError:
            return

    def _resolve_storage_path(self, storage_key: str) -> Path:
        relative = _validate_relative_key(storage_key)
        root = self._root.resolve()
        candidate = (root / Path(relative)).resolve()
        if candidate != root and root not in candidate.parents:
            raise ValueError("storage key escapes the object-store root")
        return candidate

    @staticmethod
    def _validate_namespace(namespace: str) -> PurePosixPath:
        relative = _validate_relative_key(namespace)
        return PurePosixPath(relative)


def _validate_relative_key(value: str) -> str:
    normalized = value.replace("\\", "/").strip("/")
    if not normalized:
        raise ValueError("relative object-store key is required")
    path = PurePosixPath(normalized)
    if path.is_absolute():
        raise ValueError("absolute object-store keys are not allowed")
    for segment in path.parts:
        if segment in {"", ".", ".."} or not _SAFE_SEGMENT.fullmatch(segment):
            raise ValueError("unsafe object-store path segment")
    return str(path)


def _sanitize_filename(filename_hint: str) -> str:
    basename = filename_hint.replace("\\", "/").split("/")[-1].strip()
    if not basename:
        basename = "upload.csv"
    stem = Path(basename).stem or "upload"
    suffix = Path(basename).suffix.lower() or ".csv"
    safe_stem = _SAFE_FILENAME_CHAR.sub("-", stem).strip("-.") or "upload"
    safe_suffix = _SAFE_FILENAME_CHAR.sub("", suffix) or ".csv"
    return f"{safe_stem}{safe_suffix}"
