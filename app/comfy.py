"""ComfyUI client.

Talks to a running ComfyUI over HTTP + websocket. The server must never crash
because ComfyUI is down — every failure here is reported, not raised into the
request path (CLAUDE.md 6.6).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Callable, Optional

from . import store

URL = "http://127.0.0.1:8188"
WS_URL = "ws://127.0.0.1:8188"
WORKFLOW = store.ROOT / "workflows" / "txt2img.json"

# Photon is an SD1.5 checkpoint: it is trained at 512px and degrades badly
# (duplicated limbs, repeated faces) when pushed much past ~768. Generate small
# and let the browser scale to 1080x1920 — upscaling a clean image beats
# generating a broken large one.
GEN_WIDTH = 512
GEN_HEIGHT = 896

# The model is weak at hands, so they are pushed out of frame by the negative
# prompt as well as by how scene prompts are written (see assemble.py).
BASE_NEGATIVE = (
    "hands, fingers, deformed hands, extra fingers, mutated hands, "
    "text, watermark, signature, logo, letters, words, caption, "
    "blurry, lowres, deformed, disfigured, extra limbs, bad anatomy, "
    "ugly, duplicate, cropped, jpeg artifacts"
)

ProgressFn = Callable[[float, str], None]


class ComfyError(RuntimeError):
    pass


def health() -> bool:
    try:
        with urllib.request.urlopen(f"{URL}/system_stats", timeout=3):
            return True
    except Exception:
        return False


def checkpoints() -> list[str]:
    """Available checkpoint filenames, for the settings dropdown."""
    try:
        with urllib.request.urlopen(
            f"{URL}/object_info/CheckpointLoaderSimple", timeout=10
        ) as r:
            data = json.loads(r.read().decode("utf-8"))
        return list(
            data["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0]
        )
    except Exception:
        return []


def _patch(workflow: dict, *, prompt: str, negative: str, seed: int,
           checkpoint: str, steps: int, cfg: float,
           width: int, height: int) -> dict:
    """Fill a workflow template.

    Fields are located by node `class_type`, never by hardcoded node id, so the
    user can rearrange their graph in ComfyUI without breaking this
    (CLAUDE.md 6.6).
    """
    wf = json.loads(json.dumps(workflow))  # deep copy

    text_nodes = [
        (nid, node) for nid, node in wf.items()
        if node.get("class_type") == "CLIPTextEncode"
    ]
    # Distinguish positive from negative by the template's _meta title, falling
    # back to document order.
    pos_id = neg_id = None
    for nid, node in text_nodes:
        title = (node.get("_meta") or {}).get("title", "").lower()
        if "neg" in title:
            neg_id = nid
        elif "pos" in title:
            pos_id = nid
    if pos_id is None or neg_id is None:
        ordered = [nid for nid, _ in text_nodes]
        pos_id = pos_id or (ordered[0] if ordered else None)
        neg_id = neg_id or (ordered[1] if len(ordered) > 1 else None)

    for nid, node in wf.items():
        ct = node.get("class_type")
        if ct == "CheckpointLoaderSimple" and checkpoint:
            node["inputs"]["ckpt_name"] = checkpoint
        elif ct == "EmptyLatentImage":
            node["inputs"]["width"] = width
            node["inputs"]["height"] = height
        elif ct == "KSampler":
            node["inputs"]["seed"] = seed
            node["inputs"]["steps"] = steps
            node["inputs"]["cfg"] = cfg
        elif nid == pos_id:
            node["inputs"]["text"] = prompt
        elif nid == neg_id:
            node["inputs"]["text"] = negative

    return wf


def generate(
    prompt: str,
    seed: int,
    dest: Path,
    checkpoint: str = "photon_v1.safetensors",
    negative: str = "",
    steps: int = 25,
    cfg: float = 6.0,
    width: int = GEN_WIDTH,
    height: int = GEN_HEIGHT,
    on_progress: Optional[ProgressFn] = None,
    timeout: float = 300.0,
) -> Path:
    """Generate one image and write it to `dest`."""
    import websocket  # websocket-client

    if not WORKFLOW.exists():
        raise ComfyError(f"Missing workflow template: {WORKFLOW}")
    if not health():
        raise ComfyError(
            f"ComfyUI is not responding at {URL}. Start it and try again."
        )

    negative = ", ".join(x for x in (BASE_NEGATIVE, negative) if x)
    workflow = json.loads(WORKFLOW.read_text(encoding="utf-8"))
    wf = _patch(
        workflow, prompt=prompt, negative=negative, seed=seed,
        checkpoint=checkpoint, steps=steps, cfg=cfg, width=width, height=height,
    )

    client_id = str(uuid.uuid4())

    # Connect before queuing, or the early progress messages are missed.
    ws = websocket.WebSocket()
    ws.connect(f"{WS_URL}/ws?clientId={client_id}", timeout=15)
    ws.settimeout(timeout)

    try:
        body = json.dumps({"prompt": wf, "client_id": client_id}).encode("utf-8")
        req = urllib.request.Request(
            f"{URL}/prompt", data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                prompt_id = json.loads(r.read().decode("utf-8"))["prompt_id"]
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:800]
            raise ComfyError(f"ComfyUI rejected the workflow:\n{detail}") from None

        while True:
            raw = ws.recv()
            if isinstance(raw, bytes):
                continue  # binary preview frames
            msg = json.loads(raw)
            mtype = msg.get("type")
            data = msg.get("data", {})

            if mtype == "progress" and on_progress:
                mx = data.get("max") or 1
                on_progress(data.get("value", 0) / mx, "Generating image")
            elif mtype == "execution_error" and data.get("prompt_id") == prompt_id:
                raise ComfyError(
                    f"ComfyUI failed: {data.get('exception_message', 'unknown error')}"
                )
            elif (
                mtype == "executing"
                and data.get("node") is None
                and data.get("prompt_id") == prompt_id
            ):
                break
    finally:
        try:
            ws.close()
        except Exception:
            pass

    with urllib.request.urlopen(f"{URL}/history/{prompt_id}", timeout=30) as r:
        history = json.loads(r.read().decode("utf-8"))

    outputs = history.get(prompt_id, {}).get("outputs", {})
    images = [
        img
        for node in outputs.values()
        for img in node.get("images", [])
        if img.get("type") == "output"
    ]
    if not images:
        raise ComfyError("ComfyUI finished but produced no image.")

    img = images[0]
    query = urllib.parse.urlencode(
        {
            "filename": img["filename"],
            "subfolder": img.get("subfolder", ""),
            "type": img.get("type", "output"),
        }
    )
    with urllib.request.urlopen(f"{URL}/view?{query}", timeout=60) as r:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(r.read())

    return dest
