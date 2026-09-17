// Client-owned crop decisions. TimDS validates the record; a designer reviews
// the actual subject across the shot before recording it here.
export function validateVideoVerticalMetadata(input, { assetCatalog, mediaCatalog, footagePrefix }) {
  const fail = (message) => { throw new Error(`video vertical metadata: ${message}`); };
  if (!input || input.schemaVersion !== 1 || !input.assets || Array.isArray(input.assets) || typeof input.assets !== "object") {
    fail("expected schemaVersion 1 and an assets object");
  }
  if (!footagePrefix) fail("the video contract needs producer.footage.assetPrefix");
  const assets = assetCatalog.assets || assetCatalog;
  const derivatives = new Set(Object.values(assets).map((asset) => asset.vertical).filter(Boolean));
  const masters = Object.keys(assets).filter((key) => key.startsWith(footagePrefix) && !derivatives.has(key));
  const published = new Map(mediaCatalog.assets.map((asset) => [asset.key, asset]));
  const records = {};
  for (const key of masters) {
    const record = input.assets[key];
    if (!record || typeof record !== "object" || Array.isArray(record)) fail(`${key} needs a reviewed crop record`);
    const source = published.get(assets[key].mediaKey);
    if (!source || !/^[a-f0-9]{64}$/u.test(record.sourceSha256 || "") || record.sourceSha256 !== source.sha256) {
      fail(`${key}.sourceSha256 must match the published master; review the crop again when the source changes`);
    }
    const position = typeof record.objectPosition === "string" && record.objectPosition.trim().match(/^(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/u);
    if (!position || position.slice(1).some((value) => Number(value) > 100)) {
      fail(`${key}.objectPosition must contain two percentages between 0% and 100%`);
    }
    if (!["upper", "lower"].includes(record.text)) fail(`${key}.text must be upper or lower for the vertical headline zone`);
    if (!Array.isArray(record.reviewedFrames) || record.reviewedFrames.length !== 3 || !["first", "middle", "last"].every((frame) => record.reviewedFrames.includes(frame))) {
      fail(`${key}.reviewedFrames must include first, middle, and last after inspecting the subject and text zone`);
    }
    const verticalKey = assets[key].vertical;
    if (verticalKey && (!assets[verticalKey] || !published.has(assets[verticalKey].mediaKey))) {
      fail(`${key}.vertical must link a declared, published derivative`);
    }
    records[key] = { sourceSha256: record.sourceSha256, objectPosition: `${position[1]}% ${position[2]}%`, text: record.text, reviewedFrames: [...record.reviewedFrames] };
  }
  for (const key of Object.keys(input.assets)) {
    if (!Object.hasOwn(records, key)) fail(`${key} is not a registered footage master`);
  }
  return { schemaVersion: 1, assets: records };
}
