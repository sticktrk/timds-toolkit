import assert from 'node:assert/strict';
import test from 'node:test';
import { installDraftPreview } from './consumer-draft-preview.mjs';
test('draft CSS is opt-in and appended after the pinned stylesheet without changing it', () => {
  const pinned = { href: '/pin/tokens.css' }, links = [pinned];
  const document = { querySelector: () => links.find(link => link.dataset?.timdsDraft), createElement: () => ({ dataset: {} }), head: { appendChild: link => links.push(link) } };
  const window = { location: { search: '', hostname: 'product.test' } };
  assert.equal(installDraftPreview({ source: 'acme/core', window, document }), null);
  assert.deepEqual(links, [pinned]);
  window.location.search = '?timds_draft=spring-refresh';
  const link = installDraftPreview({ source: 'acme/core', portalUrl: 'https://host.test', window, document });
  assert.equal(link.href, 'https://host.test/api/public/design-system-previews/acme%2Fcore/spring-refresh/tokens.css');
  assert.equal(links[0].href, '/pin/tokens.css'); assert.equal(links.at(-1), link);
  window.location.search = '?timds_draft=../../unsafe';
  assert.equal(installDraftPreview({ source: 'acme/core', window, document }), null);
});
