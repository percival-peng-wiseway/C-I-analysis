from __future__ import annotations

import hashlib
from io import BytesIO
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import uuid4

from solar_battery.durable_cockpit.filesystem_object_store import (
    _sanitize_filename,
    _validate_relative_key,
)
from solar_battery.durable_cockpit.object_store import ObjectStore, StoredObject


class HttpObjectStore(ObjectStore):
    """Private object storage reached through a Container outbound handler."""

    def __init__(self, base_url: str) -> None:
        normalized = base_url.rstrip("/")
        if not normalized.startswith("http://"):
            raise ValueError("HTTP object-store bridge must use an http:// URL")
        self._base_url = normalized

    def put_bytes(
        self,
        *,
        namespace: str,
        filename_hint: str,
        data: bytes,
        object_identity: str | None = None,
    ) -> StoredObject:
        identity = object_identity or uuid4().hex
        storage_key = self.storage_key_for(
            namespace=namespace,
            filename_hint=filename_hint,
            object_identity=identity,
        )
        digest = hashlib.sha256(data).hexdigest()
        request = Request(
            self._url(storage_key),
            data=data,
            method="PUT",
            headers={
                "Content-Type": "application/octet-stream",
                "X-E3-SHA256": digest,
            },
        )
        with urlopen(request, timeout=60) as response:
            if response.status not in {200, 201, 204}:
                raise OSError(f"object-store PUT failed with HTTP {response.status}")
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
        safe_namespace = _validate_relative_key(namespace)
        safe_identity = _validate_relative_key(object_identity)
        if "/" in safe_identity:
            raise ValueError("object identity must contain one safe path segment")
        safe_filename = _sanitize_filename(filename_hint)
        return f"{safe_namespace}/{safe_identity}-{safe_filename}"

    def open_read(self, storage_key: str) -> BytesIO:
        request = Request(self._url(storage_key), method="GET")
        try:
            with urlopen(request, timeout=60) as response:
                return BytesIO(response.read())
        except HTTPError as exc:
            if exc.code == 404:
                raise FileNotFoundError(storage_key) from exc
            raise

    def delete(self, storage_key: str) -> None:
        request = Request(self._url(storage_key), method="DELETE")
        try:
            with urlopen(request, timeout=60) as response:
                if response.status not in {200, 202, 204}:
                    raise OSError(
                        f"object-store DELETE failed with HTTP {response.status}"
                    )
        except HTTPError as exc:
            if exc.code != 404:
                raise

    def _url(self, storage_key: str) -> str:
        safe_key = _validate_relative_key(storage_key)
        return f"{self._base_url}/{quote(safe_key, safe='/')}"
