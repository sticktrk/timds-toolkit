#!/usr/bin/env python3
"""Generate per-line audio and deterministic word timings for a TimDS production."""

import argparse
import asyncio
import json
from pathlib import Path

import edge_tts

TAIL_MS = 350


async def synthesize(line, config, output):
    stream = edge_tts.Communicate(
        line["tts"],
        config["voice"],
        rate=line.get("rate", config["rate"]),
        pitch=line.get("pitch", config["pitch"]),
        boundary="WordBoundary",
    )
    audio = bytearray()
    words = []
    async for chunk in stream.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            words.append({
                "text": chunk["text"],
                "startMs": round(chunk["offset"] / 10_000),
                "endMs": round((chunk["offset"] + chunk["duration"]) / 10_000),
            })
    if not audio or not words:
        raise RuntimeError(f"edge-tts returned no audio or timings for {line['id']}")
    (output / f"{line['id']}.mp3").write_bytes(bytes(audio))
    return {"id": line["id"], "words": words, "durationMs": words[-1]["endMs"] + TAIL_MS}


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", required=True)
    parser.add_argument("--captions", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    script_path = Path(args.script)
    captions_path = Path(args.captions)
    output = Path(args.output)
    if captions_path.exists() and not args.force:
        print(f"skip {script_path.parent.name}: captions already exist; use --force to replace the locked take")
        return
    config = json.loads(script_path.read_text())
    required = {"slug", "voice", "rate", "pitch", "lines"}
    missing = sorted(required.difference(config))
    if missing:
        raise ValueError(f"{script_path}: missing {', '.join(missing)}")
    output.mkdir(parents=True, exist_ok=True)
    entries = []
    for line in config["lines"]:
        entries.append(await synthesize(line, config, output))
    captions_path.write_text(json.dumps({"lines": entries}, indent=2) + "\n")
    seconds = sum(entry["durationMs"] for entry in entries) / 1000
    print(f"generated {config['slug']}: {len(entries)} lines, {seconds:.1f}s spoken")


if __name__ == "__main__":
    asyncio.run(main())
