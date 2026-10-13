// Browser-only opt-in override. Without the query/host match it does nothing.
export function installDraftPreview({ source, portalUrl = 'https://timds.com', hostnameDrafts = {}, window: targetWindow = globalThis.window, document: targetDocument = globalThis.document } = {}) {
  if (!targetWindow || !targetDocument || !source) return null;
  const draft = new URLSearchParams(targetWindow.location.search).get('timds_draft') || hostnameDrafts[targetWindow.location.hostname];
  if (!draft || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(draft)) return null;
  const origin = new URL(portalUrl);
  if (!['https:', 'http:'].includes(origin.protocol)) throw new Error('TimDS preview requires an HTTP portal URL');
  const existing = targetDocument.querySelector('link[data-timds-draft]');
  const link = existing || targetDocument.createElement('link');
  link.rel = 'stylesheet'; link.dataset.timdsDraft = draft;
  link.href = `${origin.origin}/api/public/design-system-previews/${encodeURIComponent(source)}/${encodeURIComponent(draft)}/tokens.css`;
  // Append after pinned styles, with zero writes to the pin or local storage.
  targetDocument.head.appendChild(link);
  return link;
}
