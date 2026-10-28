"""Prove the player is deterministic (CLAUDE.md 4.1, 8).

Two checks:

1. Same t, same pixels. Two independent browser pages render sample frames;
   the second page visits them in reverse order, so any state leaking from
   one seek into the next shows up as a mismatch.

2. --verify-dedupe: walk every frame in order like the exporter does, and
   whenever seek() returns the same signature as the previous frame (so the
   exporter would reuse the previous PNG), screenshot anyway and confirm the
   pixels really are identical. This is what makes frame reuse safe.

    python -m app.check_determinism modal-verbs-a1
    python -m app.check_determinism modal-verbs-a1 --verify-dedupe

Exit code 0 means every check passed.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys

from . import lesson, store


def _open_page(pw, project):
    browser = pw.chromium.launch(
        executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_PATH") or None,
        # Same flags as the exporter, so this tests what actually renders.
        args=["--disable-lcd-text", "--force-device-scale-factor=1",
              "--hide-scrollbars", "--disable-gpu", "--disable-dev-shm-usage"],
    )
    page = browser.new_page(
        viewport={"width": project.settings.width, "height": project.settings.height},
        device_scale_factor=1,
    )
    page.goto(f"{lesson.BASE_URL}/player/player.html?project={project.id}&export=1")
    page.wait_for_selector("body[data-ready='1']", timeout=30000)
    return browser, page


def _shot(page, t: float) -> tuple[str, str]:
    sig = page.evaluate("(t) => window.seek(t)", t)
    png = page.screenshot(type="png")
    return sig, hashlib.sha256(png).hexdigest()


def check_repeatable(pw, project, step: int) -> int:
    fps = project.settings.fps
    frames = list(range(0, int(project.total_duration() * fps), step))
    times = [f / fps for f in frames]

    b1, p1 = _open_page(pw, project)
    first = {t: _shot(p1, t) for t in times}
    b1.close()
    b2, p2 = _open_page(pw, project)
    second = {t: _shot(p2, t) for t in reversed(times)}
    b2.close()

    bad = [t for t in times if first[t] != second[t]]
    print(f"repeatable: {len(times) - len(bad)}/{len(times)} sampled frames identical")
    for t in bad[:10]:
        same_sig = first[t][0] == second[t][0]
        print(f"  MISMATCH at t={t:.3f} ({'same' if same_sig else 'different'} signature)")
    if len(bad) > 10:
        print(f"  ... and {len(bad) - 10} more, between t={bad[10]:.3f} and t={bad[-1]:.3f}")
    return len(bad)


def check_dedupe(pw, project) -> int:
    fps = project.settings.fps
    total = int(round(project.total_duration() * fps))
    browser, page = _open_page(pw, project)
    prev_sig, prev_hash = None, None
    reused, bad = 0, 0
    for frame in range(total):
        sig, digest = _shot(page, frame / fps)
        if sig == prev_sig:
            reused += 1
            if digest != prev_hash:
                bad += 1
                print(f"  DEDUPE WRONG at frame {frame}: same signature, different pixels")
        prev_sig, prev_hash = sig, digest
        if frame % 300 == 0:
            print(f"  frame {frame}/{total}", flush=True)
    browser.close()
    print(f"dedupe: {reused}/{total} frames would be reused, {bad} of them wrong")
    return bad


def main(argv: list[str] | None = None) -> int:
    from playwright.sync_api import sync_playwright

    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("project", help="project id")
    ap.add_argument("--step", type=int, default=7, help="sample every Nth frame")
    ap.add_argument("--verify-dedupe", action="store_true")
    args = ap.parse_args(argv)

    project = store.load(args.project)
    lesson.ensure_server()
    with sync_playwright() as pw:
        failures = check_repeatable(pw, project, args.step)
        if args.verify_dedupe:
            failures += check_dedupe(pw, project)
    print("PASS" if failures == 0 else f"FAIL ({failures})")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
