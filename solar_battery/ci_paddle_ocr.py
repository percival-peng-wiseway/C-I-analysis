"""CPU Paddle worker. Models are provisioned at build time, never per upload.

The API invokes this module in a disposable subprocess, with an RSS/time budget.
Only this module imports Paddle; API and optimizer processes never load it.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import sys

MODELS = {
    "text_detection": "PP-OCRv5_mobile_det",
    "text_recognition": "en_PP-OCRv5_mobile_rec",
    "doc_orientation_classify": "PP-LCNet_x1_0_doc_ori",
}


def provision_models(destination: Path) -> None:
    import shutil
    from paddlex.inference.utils.official_models import official_models

    destination.mkdir(parents=True, exist_ok=True)
    for name in MODELS.values():
        shutil.copytree(official_models[name], destination / name, dirs_exist_ok=True)


def run(pdf_path: Path, output_dir: Path, indices: list[int]) -> None:
    import numpy as np
    import pypdfium2 as pdfium
    from paddleocr import PaddleOCR

    root = Path(os.environ["CI_PADDLE_MODEL_DIR"])
    arguments = {}
    for key, name in MODELS.items():
        directory = root / name
        if not (directory / "inference.yml").is_file():
            raise RuntimeError("Missing pre-provisioned OCR model")
        arguments[f"{key}_model_name"] = name
        arguments[f"{key}_model_dir"] = str(directory)
    engine = PaddleOCR(
        **arguments, device="cpu", cpu_threads=1, enable_mkldnn=False,
        use_doc_orientation_classify=True, use_doc_unwarping=False,
        use_textline_orientation=False, text_recognition_batch_size=1,
        text_det_limit_side_len=2000, text_det_limit_type="max",
        text_rec_score_thresh=0.0,
    )
    with pdfium.PdfDocument(pdf_path) as document:
        for index in indices:
            page = document[index]
            try:
                width, height = page.get_size()
                scale = min(3.0, math.sqrt(8_000_000 / max(1, width * height)))
                bitmap = page.render(scale=scale)
                try:
                    # Paddle accepts BGR arrays; PDFium/Pillow produces RGB.
                    pixels = np.asarray(bitmap.to_pil().convert("RGB"))[:, :, ::-1].copy()
                finally:
                    bitmap.close()
            finally:
                page.close()
            result = next(iter(engine.predict(pixels)))
            angle = int(result.get("doc_preprocessor_res", {}).get("angle", 0))
            def original_point(x, y):
                # Paddle rotates clockwise by 360-angle; invert that transform.
                if angle == 90:
                    return width - y / scale, x / scale
                if angle == 180:
                    return width - x / scale, height - y / scale
                if angle == 270:
                    return y / scale, height - x / scale
                return x / scale, y / scale
            words = []
            for text, score, polygon in zip(result["rec_texts"], result["rec_scores"], result["rec_polys"]):
                points = [original_point(float(x), float(y)) for x, y in polygon]
                # Reading order uses corrected geometry. bbox retains original
                # PDF coordinates so the field can be located in the source.
                xs, ys = zip(*points)
                cx, cy = zip(*[(float(x) / scale, float(y) / scale) for x, y in polygon])
                words.append({"text": str(text), "confidence": float(score),
                              "x0": min(cx), "top": min(cy), "x1": max(cx), "bottom": max(cy),
                              "source_bbox": [min(xs), min(ys), max(xs), max(ys)]})
            encoded = json.dumps(words, allow_nan=False)
            if len(encoded) > 2_000_000:
                raise RuntimeError("OCR output limit")
            (output_dir / f"page-{index}.json").write_text(encoded)
            del pixels, result, words


if __name__ == "__main__":
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    if sys.argv[1] == "--download":
        provision_models(Path(sys.argv[2]))
    else:
        run(Path(sys.argv[1]), Path(sys.argv[2]), [int(index) for index in sys.argv[3:]])
