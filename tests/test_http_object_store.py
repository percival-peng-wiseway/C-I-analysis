from __future__ import annotations

from io import BytesIO
from urllib.error import HTTPError

import pytest

from solar_battery.durable_cockpit.http_object_store import HttpObjectStore


class _Response(BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def test_http_object_store_round_trip_contract(monkeypatch):
    requests = []

    def fake_urlopen(request, timeout):
        requests.append((request, timeout))
        if request.get_method() == "GET":
            return _Response(b"stored evidence")
        response = _Response()
        response.status = 204
        return response

    monkeypatch.setattr(
        "solar_battery.durable_cockpit.http_object_store.urlopen",
        fake_urlopen,
    )
    store = HttpObjectStore("http://e3-r2.internal")

    stored = store.put_bytes(
        namespace="workspace/project",
        filename_hint="bill evidence.pdf",
        data=b"stored evidence",
        object_identity="evidence-1",
    )
    assert stored.storage_key == "workspace/project/evidence-1-bill-evidence.pdf"
    assert store.open_read(stored.storage_key).read() == b"stored evidence"
    store.delete(stored.storage_key)

    assert [request.get_method() for request, _ in requests] == [
        "PUT",
        "GET",
        "DELETE",
    ]
    assert all(timeout == 60 for _, timeout in requests)


def test_http_object_store_maps_missing_objects(monkeypatch):
    def fake_urlopen(request, timeout):
        raise HTTPError(request.full_url, 404, "missing", {}, None)

    monkeypatch.setattr(
        "solar_battery.durable_cockpit.http_object_store.urlopen",
        fake_urlopen,
    )
    store = HttpObjectStore("http://e3-r2.internal")

    with pytest.raises(FileNotFoundError):
        store.open_read("workspace/project/missing.pdf")
