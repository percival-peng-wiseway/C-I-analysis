from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sys


def _apply_resource_limits() -> bool:
    try:
        import resource

        memory = int(os.environ.get("PDF_RENDER_MEMORY_LIMIT_BYTES", "536870912"))
        cpu = int(os.environ.get("PDF_RENDER_CPU_LIMIT_SECONDS", "25"))
        requested_limits = (
            (resource.RLIMIT_AS, memory, memory),
            (resource.RLIMIT_CPU, cpu, cpu + 1),
            (resource.RLIMIT_FSIZE, 50_000_000, 50_000_000),
            (resource.RLIMIT_NOFILE, 64, 64),
        )
        for key, soft, hard in requested_limits:
            if sys.platform == "darwin" and key == resource.RLIMIT_AS:
                # Darwin rejects an address-space soft limit below the
                # interpreter's existing mapped region. The supported Linux
                # worker must install this bound; macOS remains local QA only.
                continue
            # macOS represents infinity as INT64_MAX and refuses lowering the
            # hard value below the current soft value. The production Linux
            # worker installs both bounds; local macOS verification installs
            # the same soft bounds while retaining the kernel hard ceiling.
            if sys.platform == "darwin":
                hard = resource.getrlimit(key)[1]
            resource.setrlimit(key, (soft, hard))
        return True
    except (ImportError, OSError, ValueError):
        return False


def _deny_resource_fetch(url: str, *args, **kwargs):
    from weasyprint.urls import FatalURLFetchingError

    raise FatalURLFetchingError("external resources are disabled")


def main() -> int:
    if not _apply_resource_limits():
        return 5
    output_value = os.environ.get("PDF_RENDER_OUTPUT_PATH")
    page_count_value = os.environ.get("PDF_RENDER_PAGE_COUNT_PATH")
    if not output_value or not page_count_value:
        return 2
    output_path = Path(output_value)
    page_count_path = Path(page_count_value)
    html_bytes = sys.stdin.buffer.read(5_000_001)
    if not html_bytes or len(html_bytes) > 5_000_000:
        return 2
    try:
        from weasyprint import HTML

        document = HTML(
            string=html_bytes.decode("utf-8", errors="strict"),
            url_fetcher=_deny_resource_fetch,
            media_type="print",
        ).render()
        document.write_pdf(
            target=output_path,
            pdf_variant="pdf/a-3u",
            pdf_identifier=hashlib.sha256(html_bytes).hexdigest(),
            custom_metadata=False,
            uncompressed_pdf=False,
        )
    except Exception:
        return 3
    try:
        output_size = output_path.stat().st_size
        with output_path.open("rb") as handle:
            signature = handle.read(5)
    except OSError:
        return 4
    if signature != b"%PDF-" or output_size > 50_000_000 or not document.pages:
        return 4
    try:
        page_count_path.write_bytes(
            f"PAGES:{len(document.pages)}\n".encode("ascii")
        )
    except OSError:
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
