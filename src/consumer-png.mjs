// PNG decode, encode, and pixel diff for consumer preview comparisons.
//
// `timds consumer preview --base REF` compares each base capture with its head
// capture. The diff runs here, in Node, on the PNG bytes Chrome returned:
// `zlib` inflates the image data, the five PNG scanline filters are undone,
// and the comparison and the overlay are plain loops over RGBA buffers. That
// keeps the comparison deterministic, testable without a browser, and free of
// browser limits (canvas area, data-URL size over the DevTools socket), and it
// needs no dependency.
//
// Boundary: this module knows images only. It decodes 8-bit, non-interlaced
// PNGs (every colour type; Chrome emits RGB or RGBA), encodes RGB overlays,
// and reports changed pixels. Which captures to compare, where files go, and
// what counts as a changed route belong to `consumer-preview.mjs`.

import { deflateSync, inflateSync } from "node:zlib";

/** A capture counts as changed when more than this share of its pixels differ. */
export const CHANGED_RATIO_THRESHOLD = 0.0005;

/** Per-channel difference (0–255) at or below which two pixels are the same, so anti-aliasing and font hinting do not register. */
export const DIFF_CHANNEL_THRESHOLD = 8;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/**
 * Decode a PNG into `{ width, height, data }`, `data` being RGBA bytes.
 * Throws a plain Error for anything that is not an 8-bit, non-interlaced PNG.
 */
export function decodePng(input) {
  const png = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Not a PNG image");
  let offset = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > png.length) throw new Error(`The PNG is truncated in its ${type} chunk`);
    const body = png.subarray(start, end);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset = end + 4;
  }
  if (!header) throw new Error("The PNG has no IHDR chunk");
  const { width, height, bitDepth, colorType, interlace } = header;
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}; only 8-bit images can be compared`);
  if (interlace !== 0) throw new Error("Interlaced PNGs cannot be compared");
  if (colorType === 3 && !palette) throw new Error("The palette PNG has no PLTE chunk");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("The PNG image data is shorter than its dimensions");
  const data = Buffer.alloc(width * height * 4);
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rowStart + 1 + x];
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let decoded;
      switch (filter) {
        case 0: decoded = value; break;
        case 1: decoded = value + left; break;
        case 2: decoded = value + up; break;
        case 3: decoded = value + ((left + up) >> 1); break;
        case 4: decoded = value + paeth(left, up, upLeft); break;
        default: throw new Error(`Unknown PNG filter type ${filter} on row ${y}`);
      }
      current[x] = decoded & 0xff;
    }
    const out = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = out + x * 4;
      if (colorType === 6) {
        data[target] = current[source];
        data[target + 1] = current[source + 1];
        data[target + 2] = current[source + 2];
        data[target + 3] = current[source + 3];
      } else if (colorType === 2) {
        data[target] = current[source];
        data[target + 1] = current[source + 1];
        data[target + 2] = current[source + 2];
        data[target + 3] = 255;
      } else if (colorType === 0 || colorType === 4) {
        data[target] = data[target + 1] = data[target + 2] = current[source];
        data[target + 3] = colorType === 4 ? current[source + 1] : 255;
      } else {
        const index = current[source];
        data[target] = palette[index * 3] ?? 0;
        data[target + 1] = palette[index * 3 + 1] ?? 0;
        data[target + 2] = palette[index * 3 + 2] ?? 0;
        data[target + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      }
    }
    [previous, current] = [current, previous];
  }
  return { data, height, width };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * Encode `data` (RGBA when `channels` is 4, RGB when 3) as an 8-bit PNG,
 * choosing each row's filter by the minimum-sum-of-absolute-differences rule.
 */
export function encodePng({ width, height, data, channels = 4 }) {
  if (channels !== 3 && channels !== 4) throw new Error("encodePng writes RGB (3) or RGBA (4) data");
  const stride = width * channels;
  if (data.length < stride * height) throw new Error("encodePng data is shorter than width × height × channels");
  const raw = Buffer.alloc(height * (stride + 1));
  const candidates = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  const zero = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prior = y ? data.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter < 5; filter += 1) {
      const target = candidates[filter];
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const left = x >= channels ? row[x - channels] : 0;
        const up = prior[x];
        const upLeft = x >= channels ? prior[x - channels] : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        else if (filter === 2) predictor = up;
        else if (filter === 3) predictor = (left + up) >> 1;
        else if (filter === 4) predictor = paeth(left, up, upLeft);
        const value = (row[x] - predictor) & 0xff;
        target[x] = value;
        score += value < 128 ? value : 256 - value;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        best = filter;
      }
    }
    // The early break may have left the winning candidate partly filled; refill it.
    const rowStart = y * (stride + 1);
    raw[rowStart] = best;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = prior[x];
      const upLeft = x >= channels ? prior[x - channels] : 0;
      let predictor = 0;
      if (best === 1) predictor = left;
      else if (best === 2) predictor = up;
      else if (best === 3) predictor = (left + up) >> 1;
      else if (best === 4) predictor = paeth(left, up, upLeft);
      raw[rowStart + 1 + x] = (row[x] - predictor) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Composite an RGBA pixel over white, the background a reviewer sees.
const over = (value, alpha) => Math.round((value * alpha + 255 * (255 - alpha)) / 255);

const HIGHLIGHT = [236, 0, 140];

/**
 * Compare two PNG captures. The smaller one is padded to the larger size;
 * padded pixels count as changed. A pixel is changed when any channel differs
 * by more than `channelThreshold` after compositing over white. Returns
 * `{ width, height, changedPixels, changedRatio, changed, overlay }`, where
 * `overlay` is an RGB PNG of the head capture faded, changed pixels in magenta.
 */
export function diffPngs(basePng, headPng, { channelThreshold = DIFF_CHANNEL_THRESHOLD, ratioThreshold = CHANGED_RATIO_THRESHOLD, overlay = true } = {}) {
  const base = decodePng(basePng);
  const head = decodePng(headPng);
  const width = Math.max(base.width, head.width);
  const height = Math.max(base.height, head.height);
  const out = overlay ? Buffer.alloc(width * height * 3) : null;
  let changedPixels = 0;
  const [hr, hg, hb] = HIGHLIGHT;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inBase = x < base.width && y < base.height;
      const inHead = x < head.width && y < head.height;
      // Head colour composited over white; white where the head is padded.
      let r = 255;
      let g = 255;
      let b = 255;
      if (inHead) {
        const at = (y * head.width + x) * 4;
        const alpha = head.data[at + 3];
        r = over(head.data[at], alpha);
        g = over(head.data[at + 1], alpha);
        b = over(head.data[at + 2], alpha);
      }
      let changed = true;
      if (inBase && inHead) {
        const at = (y * base.width + x) * 4;
        const alpha = base.data[at + 3];
        changed = Math.abs(over(base.data[at], alpha) - r) > channelThreshold
          || Math.abs(over(base.data[at + 1], alpha) - g) > channelThreshold
          || Math.abs(over(base.data[at + 2], alpha) - b) > channelThreshold;
      }
      if (changed) changedPixels += 1;
      if (!out) continue;
      const target = (y * width + x) * 3;
      if (changed) {
        out[target] = (hr * 3 + r) >> 2;
        out[target + 1] = (hg * 3 + g) >> 2;
        out[target + 2] = (hb * 3 + b) >> 2;
      } else {
        out[target] = Math.round(r * 0.3 + 157.5);
        out[target + 1] = Math.round(g * 0.3 + 157.5);
        out[target + 2] = Math.round(b * 0.3 + 157.5);
      }
    }
  }
  const total = width * height;
  const changedRatio = total ? changedPixels / total : 0;
  return {
    changed: changedRatio > ratioThreshold,
    changedPixels,
    changedRatio,
    height,
    overlay: out ? encodePng({ channels: 3, data: out, height, width }) : null,
    width,
  };
}

/** `{ width, height }` from a PNG header without decoding it, or null. */
export function pngSize(png) {
  if (!png || png.length < 24 || !Buffer.from(png.subarray(0, 8)).equals(PNG_SIGNATURE)) return null;
  return { height: png.readUInt32BE(20), width: png.readUInt32BE(16) };
}
