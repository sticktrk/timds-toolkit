// The published reader API accepts a validated parent record, while its
// public lineage stays a smaller shape without the merge baseline.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {packageRoot} from './executable.mjs';

const require = createRequire(import.meta.url);

test('published reader declarations distinguish parent records from public lineage', async t => {
  const scratch = await fs.mkdtemp(path.join(packageRoot, '.offshoot-types-'));
  t.after(() => fs.rm(scratch, {recursive: true, force: true}));
  await fs.writeFile(path.join(scratch, 'reader.mts'), `
import {readDerivedLayer, type ParentRecord, type SystemLineage} from '@dtconcepts/timds/derived';
const parent: ParentRecord = {
  schemaVersion: 1, systemId: 'example/parent', sourceId: '11111111-1111-4111-8111-111111111111',
  version: '1.0.0', commit: 'a'.repeat(40), mode: 'structure',
  baseline: {site: {views: [{id: 'web', pages: [{slug: 'custom_page', customField: true}]}]}, formats: null},
};
void readDerivedLayer('.', {}, {parentRecord: {...parent, schemaVersion: 1, baseline: parent.baseline}});
void readDerivedLayer('.', {}, {parentRecord: null});
const lineage: SystemLineage = parent;
// @ts-expect-error Public lineage lacks the required schema and baseline.
void readDerivedLayer('.', {}, {parentRecord: lineage});
// @ts-expect-error Only the supported parent record schema is accepted.
const invalid: ParentRecord = {...parent, schemaVersion: 2};
`);
  await fs.writeFile(path.join(scratch, 'tsconfig.json'), JSON.stringify({extends: '../tsconfig.json', include: ['reader.mts']}));
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc');
  await promisify(execFile)(process.execPath, [tsc, '--noEmit', '-p', scratch], {cwd: packageRoot}).catch(error => {
    assert.fail(`published reader declarations failed to typecheck:\n${error.stdout}${error.stderr}`);
  });
});
