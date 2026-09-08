"""Bounded local PDF layout extraction, with Paddle OCR only for scanned pages."""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

import pdfplumber

MAX_TEXT = 250_000
MAX_PAGES = 20
OCR_BUDGET_SECONDS = 90
OCR_MAX_RSS_BYTES = 2 * 1024**3
_OCR_LOCK = threading.Lock()


class BillDocumentError(ValueError):
    pass


class BillText(str):
    """Keep the text-reader contract while retaining ephemeral source geometry."""
    def __new__(cls, text: str, pages: list[dict], warnings: list[dict]):
        instance = super().__new__(cls, text)
        instance.pages, instance.warnings = pages, warnings
        return instance


def _lines(words: list[dict], page: int, method: str) -> list[dict]:
    groups: list[list[dict]] = []
    for word in sorted(words, key=lambda item: (item["top"], item["x0"])):
        if not groups or abs(word["top"] - groups[-1][0]["top"]) > 4:
            groups.append([])
        groups[-1].append(word)
    result = []
    for group in groups:
        group.sort(key=lambda item: item["x0"])
        boxes = [item.get("source_bbox", [item["x0"], item["top"], item["x1"], item["bottom"]]) for item in group]
        result.append({"text": " ".join(item["text"] for item in group), "page": page, "method": method,
                       "bbox": [round(min(b[0] for b in boxes), 2), round(min(b[1] for b in boxes), 2),
                                round(max(b[2] for b in boxes), 2), round(max(b[3] for b in boxes), 2)],
                       "confidence": min(item.get("confidence", 1.0) for item in group)})
    return result


def _ocr_pages(data: bytes, indices: list[int]) -> tuple[dict[int, list[dict]], str | None]:
    root = os.environ.get("CI_PADDLE_MODEL_DIR")
    if not root or not Path(root).is_dir():
        return {}, "ocr_unavailable"
    if not _OCR_LOCK.acquire(blocking=False):
        return {}, "ocr_busy"
    try:
        import psutil
        with tempfile.TemporaryDirectory(prefix="ci-bill-ocr-") as directory:
            pdf_path = Path(directory) / "bill.pdf"
            pdf_path.write_bytes(data)
            env = {**os.environ, "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True",
                   "HF_HUB_OFFLINE": "1", "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1",
                   "MKL_NUM_THREADS": "1", "NUMEXPR_NUM_THREADS": "1"}
            command = [sys.executable, "-m", "solar_battery.ci_paddle_ocr", str(pdf_path), directory, *map(str, indices)]
            error = None
            with subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env) as process:
                monitor = psutil.Process(process.pid)
                deadline = time.monotonic() + OCR_BUDGET_SECONDS
                try:
                    while process.poll() is None:
                        if time.monotonic() >= deadline:
                            error = "ocr_timeout"
                            break
                        try:
                            rss = monitor.memory_info().rss + sum(child.memory_info().rss for child in monitor.children(recursive=True))
                            if rss > OCR_MAX_RSS_BYTES:
                                error = "ocr_memory_limit"
                                break
                        except psutil.NoSuchProcess:
                            pass
                        time.sleep(0.1)
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.wait()
                if process.returncode and error is None:
                    error = "ocr_failed"
            results = {}
            for index in indices:
                output = Path(directory) / f"page-{index}.json"
                if output.is_file() and output.stat().st_size <= 2_000_000:
                    results[index] = json.loads(output.read_text())
            return results, error
    except (OSError, ImportError, ValueError):
        return {}, "ocr_unavailable"
    finally:
        _OCR_LOCK.release()


def extract_bill_document(data: bytes) -> BillText:
    pages, warnings, scan_indices = [], [], []
    try:
        with pdfplumber.open(io.BytesIO(data)) as document:
            if not document.pages or len(document.pages) > MAX_PAGES:
                raise BillDocumentError("The bill must contain between 1 and 20 pages.")
            total_chars = 0
            for index, page in enumerate(document.pages):
                if page.width <= 0 or page.height <= 0 or max(page.width, page.height) > 14_400:
                    raise BillDocumentError("The bill page dimensions are unsupported.")
                total_chars += len(page.chars)
                if total_chars > MAX_TEXT:
                    raise BillDocumentError("The bill contains too much text.")
                words = page.dedupe_chars().extract_words(x_tolerance=2, y_tolerance=3)
                large_image = any(image["width"] * image["height"] > page.width * page.height * 0.45 for image in page.images)
                if sum(len(word["text"]) for word in words) < 40 or large_image:
                    scan_indices.append(index)
                lines = _lines(words, index + 1, "native_text")
                tables = [{"bbox": list(table.bbox), "rows": table.extract()} for table in page.find_tables()[:30]]
                pages.append({"page": index + 1, "width": float(page.width), "height": float(page.height),
                              "method": "native_text", "lines": lines, "tables": tables})
                page.close()
        if scan_indices:
            recognized, error = _ocr_pages(data, scan_indices)
            for index in scan_indices:
                if recognized.get(index):
                    pages[index]["lines"] = _lines(recognized[index], index + 1, "paddle_ocr")
                    pages[index]["method"] = "paddle_ocr"
                    pages[index]["tables"] = []
                else:
                    warnings.append({"code": error or "ocr_empty", "page": index + 1,
                                     "message": "This scanned page could not be read completely. Check it against the PDF or retry the upload."})
        text = "\n".join(line["text"] for page in pages for line in page["lines"])
        if len(text) > MAX_TEXT:
            raise BillDocumentError("The bill contains too much text.")
        return BillText(text, pages, warnings)
    except BillDocumentError:
        raise
    except Exception as exc:
        raise BillDocumentError("The electricity bill PDF could not be read safely.") from exc
