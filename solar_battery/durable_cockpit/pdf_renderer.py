from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Protocol, runtime_checkable


PDF_RENDERER_ID = "weasyprint_restricted_process"
PDF_RENDERER_VERSION = "69.0"
PDF_CONTENT_TYPE = "application/pdf"


class PdfRenderError(RuntimeError):
    """Privacy-safe PDF renderer failure."""


@dataclass(frozen=True, slots=True)
class PdfRenderResult:
    data: bytes
    content_type: str
    page_count: int
    renderer_id: str
    renderer_version: str


@runtime_checkable
class PdfRenderer(Protocol):
    def render(self, html_bytes: bytes) -> PdfRenderResult: ...


class WeasyPrintPdfRenderer:
    def __init__(
        self,
        *,
        timeout_seconds: float = 30,
        max_html_bytes: int = 5_000_000,
        max_pdf_bytes: int = 50_000_000,
        memory_limit_bytes: int = 512 * 1024 * 1024,
        cpu_limit_seconds: int = 25,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.max_html_bytes = max_html_bytes
        self.max_pdf_bytes = max_pdf_bytes
        self.memory_limit_bytes = memory_limit_bytes
        self.cpu_limit_seconds = cpu_limit_seconds

    def render(self, html_bytes: bytes) -> PdfRenderResult:
        _validate_html(html_bytes, max_bytes=self.max_html_bytes)
        with tempfile.TemporaryDirectory(prefix="residential-pdf-") as output_dir:
            output_path = Path(output_dir) / "artifact.pdf"
            page_count_path = Path(output_dir) / "page-count.txt"
            environment = {
                "PATH": os.environ.get("PATH", ""),
                "LANG": "C.UTF-8",
                "PYTHONHASHSEED": "0",
                "SOURCE_DATE_EPOCH": "0",
                "TZ": "UTC",
                "PDF_RENDER_MEMORY_LIMIT_BYTES": str(self.memory_limit_bytes),
                "PDF_RENDER_CPU_LIMIT_SECONDS": str(self.cpu_limit_seconds),
                "PDF_RENDER_OUTPUT_PATH": str(output_path),
                "PDF_RENDER_PAGE_COUNT_PATH": str(page_count_path),
            }
            try:
                completed = subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "solar_battery.durable_cockpit.pdf_render_process",
                    ],
                    input=html_bytes,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    env=environment,
                    timeout=self.timeout_seconds,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise PdfRenderError(
                    "The internal PDF renderer timed out safely."
                ) from exc
            except OSError as exc:
                raise PdfRenderError(
                    "The internal PDF renderer could not start safely."
                ) from exc

            if completed.returncode != 0:
                raise PdfRenderError("The internal PDF could not be rendered safely.")
            try:
                output_size = output_path.stat().st_size
                if page_count_path.stat().st_size > 32:
                    raise OSError("page count metadata exceeds limit")
                header = page_count_path.read_bytes().strip()
            except OSError as exc:
                raise PdfRenderError(
                    "The internal PDF renderer returned invalid output."
                ) from exc
            if not header.startswith(b"PAGES:") or b"\n" in header:
                raise PdfRenderError(
                    "The internal PDF renderer returned invalid output."
                )
            if output_size < 5 or output_size > self.max_pdf_bytes:
                raise PdfRenderError(
                    "The internal PDF renderer returned invalid output."
                )
            try:
                pdf_bytes = output_path.read_bytes()
            except OSError as exc:
                raise PdfRenderError(
                    "The internal PDF renderer returned invalid output."
                ) from exc
            if len(pdf_bytes) != output_size:
                raise PdfRenderError(
                    "The internal PDF renderer returned invalid output."
                )
        try:
            page_count = int(header.removeprefix(b"PAGES:"))
        except ValueError as exc:
            raise PdfRenderError(
                "The internal PDF renderer returned invalid output."
            ) from exc
        if page_count < 1 or not pdf_bytes.startswith(b"%PDF-"):
            raise PdfRenderError("The internal PDF renderer returned invalid output.")
        return PdfRenderResult(
            data=pdf_bytes,
            content_type=PDF_CONTENT_TYPE,
            page_count=page_count,
            renderer_id=PDF_RENDERER_ID,
            renderer_version=PDF_RENDERER_VERSION,
        )


class _SafeHtmlParser(HTMLParser):
    _DENIED_TAGS = {
        "applet",
        "audio",
        "base",
        "embed",
        "form",
        "frame",
        "frameset",
        "iframe",
        "input",
        "link",
        "object",
        "script",
        "source",
        "track",
        "video",
    }
    _RESOURCE_ATTRIBUTES = {"action", "background", "data", "formaction", "href", "poster", "src", "srcset"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.unsafe = False

    def handle_starttag(self, tag, attrs):
        if tag.casefold() in self._DENIED_TAGS:
            self.unsafe = True
            return
        for name, value in attrs:
            if name.casefold() not in self._RESOURCE_ATTRIBUTES or not value:
                continue
            normalized = value.strip()
            if name.casefold() == "href" and normalized.startswith("#"):
                continue
            self.unsafe = True

    handle_startendtag = handle_starttag


def _validate_html(html_bytes: bytes, *, max_bytes: int) -> None:
    if not html_bytes or len(html_bytes) > max_bytes:
        raise PdfRenderError("The internal HTML cannot be rendered safely.")
    try:
        html = html_bytes.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise PdfRenderError("The internal HTML cannot be rendered safely.") from exc
    parser = _SafeHtmlParser()
    try:
        parser.feed(html)
        parser.close()
    except Exception as exc:
        raise PdfRenderError("The internal HTML cannot be rendered safely.") from exc
    if parser.unsafe:
        raise PdfRenderError("The internal HTML cannot be rendered safely.")
