import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  CHANGED_RATIO_THRESHOLD,
  DIFF_CHANNEL_THRESHOLD,
  decodePng,
  diffPngs,
  encodePng,
  pngSize,
} from "./consumer-png.mjs";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The decoder does not verify CRCs, so hand-built fixtures leave them zero.
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body, Buffer.alloc(4)]);
}

function rawPng({ width, height, colorType, bitDepth = 8, interlace = 0, rows, extra = [] }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  header[12] = interlace;
  const raw = Buffer.concat(rows.map((row) => Buffer.from([0, ...row])));
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), ...extra, chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function solid(width, height, [r, g, b, a = 255]) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) data.set([r, g, b, a], index * 4);
  return data;
}

const pixel = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

test("encodePng and decodePng round-trip RGBA and RGB with every filter choice", () => {
  const width = 33;
  const height = 17;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < rgba.length; index += 1) rgba[index] = (index * 7919 + (index >> 5)) % 256;
  const decoded = decodePng(encodePng({ data: rgba, height, width }));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.ok(decoded.data.equals(rgba));
  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0; index < rgb.length; index += 1) rgb[index] = (index * 31) % 256;
  const fromRgb = decodePng(encodePng({ channels: 3, data: rgb, height, width }));
  for (let index = 0; index < width * height; index += 1) {
    assert.deepEqual([...fromRgb.data.subarray(index * 4, index * 4 + 4)], [...rgb.subarray(index * 3, index * 3 + 3), 255]);
  }
  assert.deepEqual(pngSize(encodePng({ data: rgba, height, width })), { height, width });
  assert.equal(pngSize(Buffer.from("nope")), null);
});

test("decodePng reads grayscale, gray+alpha, and palette images and refuses what it cannot compare", () => {
  const gray = decodePng(rawPng({ colorType: 0, height: 1, rows: [[0, 128]], width: 2 }));
  assert.deepEqual(pixel(gray, 1, 0), [128, 128, 128, 255]);
  const grayAlpha = decodePng(rawPng({ colorType: 4, height: 1, rows: [[10, 20]], width: 1 }));
  assert.deepEqual(pixel(grayAlpha, 0, 0), [10, 10, 10, 20]);
  const palette = decodePng(rawPng({
    colorType: 3,
    extra: [chunk("PLTE", Buffer.from([255, 0, 0, 0, 0, 255])), chunk("tRNS", Buffer.from([7]))],
    height: 1,
    rows: [[0, 1]],
    width: 2,
  }));
  assert.deepEqual(pixel(palette, 0, 0), [255, 0, 0, 7]);
  assert.deepEqual(pixel(palette, 1, 0), [0, 0, 255, 255]);
  assert.throws(() => decodePng(Buffer.from("not a png")), /Not a PNG/);
  assert.throws(() => decodePng(rawPng({ bitDepth: 16, colorType: 2, height: 1, rows: [[0, 0, 0, 0, 0, 0]], width: 1 })), /bit depth 16/);
  assert.throws(() => decodePng(rawPng({ colorType: 2, height: 1, interlace: 1, rows: [[0, 0, 0]], width: 1 })), /Interlaced/);
  assert.throws(() => decodePng(rawPng({ colorType: 3, height: 1, rows: [[0]], width: 1 })), /no PLTE/);
});

test("diffPngs counts changed pixels, tolerates anti-aliasing, pads different sizes, and draws an overlay", () => {
  const white = encodePng({ data: solid(10, 10, [255, 255, 255]), height: 10, width: 10 });
  assert.equal(DIFF_CHANNEL_THRESHOLD > 0 && DIFF_CHANNEL_THRESHOLD < 32, true);
  assert.equal(CHANGED_RATIO_THRESHOLD, 0.0005);

  const same = diffPngs(white, white);
  assert.deepEqual([same.changedPixels, same.changedRatio, same.changed, same.width, same.height], [0, 0, false, 10, 10]);

  // A one-step shade change everywhere (anti-aliasing noise) is not a change.
  const nearlyWhite = encodePng({ data: solid(10, 10, [255 - DIFF_CHANNEL_THRESHOLD, 255, 255]), height: 10, width: 10 });
  assert.equal(diffPngs(white, nearlyWhite).changedPixels, 0);

  // Four changed pixels of 100.
  const marked = solid(10, 10, [255, 255, 255]);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [9, 9]]) marked.set([0, 0, 0, 255], (y * 10 + x) * 4);
  const diff = diffPngs(white, encodePng({ data: marked, height: 10, width: 10 }));
  assert.equal(diff.changedPixels, 4);
  assert.equal(diff.changedRatio, 0.04);
  assert.equal(diff.changed, true);
  const overlay = decodePng(diff.overlay);
  assert.deepEqual([overlay.width, overlay.height], [10, 10]);
  const [r, g, b] = pixel(overlay, 0, 0);
  assert.ok(r > 150 && g < 40 && b > 80, `changed pixels are highlighted (got ${r},${g},${b})`);
  const faded = pixel(overlay, 5, 5);
  assert.ok(faded[0] < 255 && faded[0] > 200 && faded[0] === faded[1], "unchanged pixels are the head faded");

  // A taller head: the base is padded and the padding counts as changed.
  const tall = encodePng({ data: solid(10, 15, [255, 255, 255]), height: 15, width: 10 });
  const padded = diffPngs(white, tall);
  assert.deepEqual([padded.width, padded.height, padded.changedPixels], [10, 15, 50]);
  assert.equal(padded.changedRatio, 50 / 150);
  // A wider, shorter base: padding in both directions.
  const wide = encodePng({ data: solid(12, 8, [255, 255, 255]), height: 8, width: 12 });
  const both = diffPngs(wide, white, { overlay: false });
  assert.deepEqual([both.width, both.height, both.changedPixels, both.overlay], [12, 10, 12 * 10 - 10 * 8, null]);

  // Transparent pixels are compared as they look on white.
  const clear = encodePng({ data: solid(10, 10, [0, 0, 0, 0]), height: 10, width: 10 });
  assert.equal(diffPngs(white, clear).changedPixels, 0);

  // Just under and over the changed-ratio threshold.
  const big = 100;
  const blank = encodePng({ data: solid(big, big, [255, 255, 255]), height: big, width: big });
  const dotted = solid(big, big, [255, 255, 255]);
  dotted.set([0, 0, 0, 255], 0);
  const fivePerTenThousand = diffPngs(blank, encodePng({ data: dotted, height: big, width: big }));
  assert.equal(fivePerTenThousand.changedRatio, 0.0001);
  assert.equal(fivePerTenThousand.changed, false);
  for (let index = 1; index < 6; index += 1) dotted.set([0, 0, 0, 255], index * 4);
  assert.equal(diffPngs(blank, encodePng({ data: dotted, height: big, width: big })).changed, true);
});
