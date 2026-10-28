"""Headless render: drive player.html frame by frame, pipe PNGs to ffmpeg.

This is the export half of the "one renderer, two drivers" design. The studio
preview calls seek(t) with wall-clock time; here we call it with frame/fps.
Same code path, so the preview cannot drift from the export (CLAUDE.md 4.2).
"""

from __future__ import annotations

import os
import subprocess
import threading
from pathlib import Path
from typing import Callable, Optional

from .models import Project
from .store import OUTPUT_DIR

ProgressFn = Callable[[float, str], None]


def _ffmpeg_cmd(fps: int, out_path: Path, audio_path: Optional[Path]) -> list[str]:
    cmd = [
        "ffmpeg", "-y",
        "-f", "image2pipe",
        "-framerate", str(fps),
        "-i", "-",
    ]
    if audio_path and audio_path.exists():
        cmd += ["-i", str(audio_path)]

    cmd += [
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "20",
        # Mandatory: without yuv420p many phones and social apps refuse the file.
        "-pix_fmt", "yuv420p",
        "-r", str(fps),
    ]
    if audio_path and audio_path.exists():
        cmd += ["-c:a", "aac", "-b:a", "192k", "-shortest"]

    cmd += ["-movflags", "+faststart", str(out_path)]
    return cmd


def output_name(project_id: str) -> str:
    """Timestamped filename, so a new render never overwrites an old video."""
    from datetime import datetime

    return f"{project_id}-{datetime.now().strftime('%Y-%m-%d-%H%M')}.mp4"


def render(
    project: Project,
    base_url: str = "http://127.0.0.1:8000",
    audio_path: Optional[Path] = None,
    on_progress: Optional[ProgressFn] = None,
    out_path: Optional[Path] = None,
    dedupe: bool = True,
) -> Path:
    """Render the project to MP4. Returns the output path.

    With `dedupe`, a frame whose seek() signature equals the previous frame's
    reuses the previous PNG instead of taking a screenshot. Lessons are mostly
    holds between animations, so this skips most of the screenshots.
    `python -m app.check_determinism --verify-dedupe` proves it is lossless.
    """
    from playwright.sync_api import sync_playwright

    fps = project.settings.fps
    width = project.settings.width
    height = project.settings.height
    duration = project.total_duration()
    if duration <= 0:
        raise ValueError("Project has no scenes to render.")

    total_frames = max(1, int(round(duration * fps)))

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if out_path is None:
        out_path = OUTPUT_DIR / output_name(project.id)

    def progress(frac: float, msg: str) -> None:
        if on_progress:
            on_progress(frac, msg)

    progress(0.0, "Launching browser")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            # Only needed where Chromium is preinstalled outside Playwright's
            # own cache (e.g. a cloud container); unset on the Windows machine.
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None,
            args=[
                "--disable-lcd-text",           # deterministic glyph rasterisation
                "--force-device-scale-factor=1",
                "--hide-scrollbars",
                "--disable-gpu",                # headless GPU raster is nondeterministic
                # A long render is hundreds of full-page screenshots. Chromium's
                # default shared-memory budget is far too small for that at
                # 1080x1920 and the browser is killed part-way through, which
                # surfaces here as a render that freezes mid-sequence.
                "--disable-dev-shm-usage",
                "--renderer-process-limit=1",
                "--js-flags=--max-old-space-size=512",
            ],
        )
        try:
            page = browser.new_page(
                viewport={"width": width, "height": height},
                device_scale_factor=1,
            )
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            page.goto(
                f"{base_url}/player/player.html?project={project.id}&export=1",
                wait_until="load",
            )
            # window.ready resolves once fonts and images are decoded.
            page.wait_for_function("window.ready !== undefined", timeout=15000)
            page.evaluate("window.ready")
            page.wait_for_selector("body[data-ready='1']", timeout=30000)
            if errors:
                raise RuntimeError("Player error: " + "; ".join(errors[:3]))

            progress(0.02, f"Rendering {total_frames} frames")

            proc = subprocess.Popen(
                _ffmpeg_cmd(fps, out_path, audio_path),
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            assert proc.stdin is not None and proc.stderr is not None

            # ffmpeg is chatty on stderr. Nothing reads that pipe during the
            # frame loop, so once the OS buffer fills ffmpeg blocks on write,
            # stops draining stdin, and the whole pipeline deadlocks — a
            # render that freezes part-way with no error. Drain it in a
            # background thread for the lifetime of the process.
            stderr_chunks: list[bytes] = []

            def drain_stderr() -> None:
                for line in iter(proc.stderr.readline, b""):
                    stderr_chunks.append(line)

            stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
            stderr_thread.start()

            def ffmpeg_stderr() -> str:
                stderr_thread.join(timeout=2)
                return b"".join(stderr_chunks).decode("utf-8", "replace")

            prev_sig: Optional[str] = None
            png = b""
            reused = 0
            try:
                for frame in range(total_frames):
                    t = frame / fps
                    # Bound every browser call: if Chromium dies the default is
                    # to block indefinitely, which looks like a silent hang.
                    sig = page.evaluate("(t) => window.seek(t)", t)
                    if dedupe and sig and sig == prev_sig:
                        reused += 1
                    else:
                        png = page.screenshot(type="png", timeout=20000)
                    prev_sig = sig
                    proc.stdin.write(png)
                    proc.stdin.flush()

                    if frame % 15 == 0 or frame == total_frames - 1:
                        progress(
                            0.02 + 0.93 * (frame + 1) / total_frames,
                            f"Frame {frame + 1}/{total_frames}",
                        )
            except BrokenPipeError:
                # ffmpeg died early — its stderr holds the real reason.
                stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
                raise RuntimeError(
                    f"ffmpeg rejected the frame stream:\n{stderr[-1500:]}"
                ) from None

            proc.stdin.close()
            progress(0.96, "Encoding")
            stderr_out = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
            code = proc.wait()
            if code != 0:
                raise RuntimeError(f"ffmpeg exited {code}:\n{stderr_out[-1500:]}")
        finally:
            browser.close()

    progress(1.0, f"Done: {out_path.name} ({reused}/{total_frames} frames reused)")
    return out_path
