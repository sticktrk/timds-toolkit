// Read-only, deterministic npm-package contract for hosts preparing toolkit
// upgrades. Resource hashes describe templates; only rendered hashes describe
// final bytes, and neither grants permission to overwrite authored source.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { packageRoot, packageIdentity } from './executable.mjs';
import { CLAUDE_SKILLS_LINK, CLAUDE_SKILLS_TARGET } from './agent-skills.mjs';
import { designSystemSkillNames } from './skill-names.mjs';
import { HOSTED_SKILL_TEMPLATE, hostedSkillPlaceholders, hostedSkillSystem, renderHostedSkillFiles } from './skills-install.mjs';
import { STARTER_FORMATS_FILE, STARTER_LAYOUT_FILE, STARTER_SITE_FILE, describeStarterSteps, starterFragments, starterKind, starterPlumbingFiles } from './starter.mjs';
import { dependencyAutomationFiles, packageResourcePaths, standaloneReleaseAutomationFiles, starterTemplateFiles } from './release-resources.mjs';

export const RELEASE_METADATA_SCHEMA_VERSION = 1;
const digest = content => createHash('sha256').update(content).digest('hex');
const comparePath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const templatePath = name => path.posix.normalize(`templates/${name}`);
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function selection(options = {}, additional = []) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Toolkit release metadata options must be an object');
  const unknown = Object.keys(options).filter(key => !['schemaVersion', 'starter', ...additional].includes(key));
  if (unknown.length) throw new Error(`Unknown toolkit release metadata option ${unknown.join(', ')}`);
  const { schemaVersion = RELEASE_METADATA_SCHEMA_VERSION, starter = 'starter' } = options;
  if (schemaVersion !== RELEASE_METADATA_SCHEMA_VERSION) throw new Error(`Unsupported toolkit release metadata schema ${JSON.stringify(schemaVersion)}; expected 1`);
  return { schemaVersion, starter: starterKind(starter) };
}

function toolkitIdentity() {
  const { name, version } = packageIdentity();
  if (name !== '@dtconcepts/timds' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid installed toolkit package identity');
  return { name, version };
}

async function resourceFile(packagePath) {
  if (typeof packagePath !== 'string' || !packagePath || packagePath.includes('\\') || packagePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid toolkit resource path');
  let absolute = packageRoot;
  try {
    for (const part of packagePath.split('/')) {
      absolute = path.join(absolute, part);
      if ((await fs.lstat(absolute)).isSymbolicLink()) throw new Error('symbolic links are not package resources');
    }
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('expected a regular file');
    const bytes = await fs.readFile(absolute);
    return { packagePath, mode: stat.mode & 0o111 ? '100755' : '100644', sha256: digest(bytes), bytes: bytes.length, content: textDecoder.decode(bytes) };
  } catch (error) {
    throw new Error(`Cannot read toolkit resource ${packagePath}: ${error.message}`, { cause: error });
  }
}

async function skillResources(name) {
  const resources = await packageResourcePaths(`skills/${name}`);
  if (!resources.includes(`skills/${name}/SKILL.md`)) throw new Error(`Cannot read toolkit resource skills/${name}/SKILL.md: missing required skill entry point`);
  return resources;
}

async function definitions(starter) {
  const files = new Map((await starterTemplateFiles(starter)).map(([filePath, resource]) => [filePath, { path: filePath, resource, policy: 'seed-only', operation: 'copy' }]));
  const set = (filePath, resource, policy, operation = 'copy', parameters) => files.set(filePath, { path: filePath, resource, policy, operation, ...(parameters ? { parameters } : {}) });
  for (const [filePath, template] of starterPlumbingFiles) set(filePath, templatePath(template), 'starter-plumbing');
  for (const [filePath, template] of starterFragments(starter)) set(filePath, templatePath(template), 'stock-fragment');
  for (const filePath of [STARTER_SITE_FILE, STARTER_FORMATS_FILE]) set(filePath, `templates/${starter}/${filePath}`, 'catalog-merge', 'three-way-merge');
  set(STARTER_LAYOUT_FILE, `templates/${starter}/${STARTER_LAYOUT_FILE}`, 'layout-patch', 'patch-missing-links');
  // These are seed resources, not replacement candidates, including templates
  // init subsequently migrates to grouped contract files.
  set('tokens.json', starter === 'starter' ? 'templates/tokens.json' : `templates/${starter}/tokens.json`, 'seed-only', 'contract-groups');
  set('media.json', 'templates/media.json', 'seed-only', 'contract-groups');
  set('timds.json', 'templates/timds.json', 'seed-only', 'initialize-manifest', ['systemId', 'name', 'baselineVersion', 'standalone', 'consumer', 'provider', 'description']);
  set('.gitignore', 'templates/design-system-gitignore', 'seed-only', 'append-ignore-lines', ['standalone', 'provider']);
  set('CHANGELOG.md', 'templates/CHANGELOG.md', 'seed-only', 'replace-placeholders', ['__VERSION__']);
  for (const [filePath, resource] of [['AGENTS.md', 'design-system-AGENTS.md'], ['CLAUDE.md', 'design-system-CLAUDE.md'], ['README.md', 'design-system-README.md'], ['media-local/README.md', 'media-local-README.md']]) {
    set(filePath, `templates/${resource}`, 'seed-only', 'replace-placeholders', ['__TIMDS_CLI__', '__CONTRACT_DESCRIPTION__', '__DIST_PATH__', '__MEDIA_LOCAL__', '__SKILLS_PATH__']);
  }
  for (const [filePath, template] of standaloneReleaseAutomationFiles) set(filePath, templatePath(template), 'release-automation');
  for (const [filePath, template] of dependencyAutomationFiles) set(filePath, templatePath(template), 'dependency-automation');
  for (const name of designSystemSkillNames) {
    for (const resource of await skillResources(name)) set(`.agents/${resource}`, resource, 'managed-skill');
  }
  // The hosted destination is parameterized and must never be mistaken for a
  // literal trusted path or for the final rendered hash.
  for (const resource of await skillResources(HOSTED_SKILL_TEMPLATE)) {
    set(`.agents/skills/__SKILL_NAME__/${resource.slice(`skills/${HOSTED_SKILL_TEMPLATE}/`.length)}`, resource, 'hosted-skill', 'render-hosted-skill', [...hostedSkillPlaceholders]);
  }
  return [...files.values()].sort(comparePath);
}

/** Describe shipped npm resources and their policies, without reading a workspace. */
export async function describeToolkitRelease(options = {}) {
  const selected = selection(options);
  const files = await definitions(selected.starter);
  const resources = [];
  for (const resource of [...new Set(files.map(file => file.resource))].sort()) {
    const { content, ...metadata } = await resourceFile(resource);
    resources.push(metadata);
  }
  return {
    ...selected,
    toolkit: toolkitIdentity(),
    // The starter level this release scaffolds at, the oldest level it
    // builds, and every starter step as data: the same definitions starter
    // sync, upgrade and starter migrate apply, so a host can verify a
    // candidate change against them (docs/release-metadata.md).
    starterSteps: describeStarterSteps(),
    resources,
    files,
    symlinks: [{ path: CLAUDE_SKILLS_LINK, target: CLAUDE_SKILLS_TARGET, mode: '120000', policy: 'create-if-absent' }],
    generated: [
      { path: '.timds/installation.json', policy: 'version-metadata', operation: 'installation-record', parameters: ['previousInstallation', 'automationAdoption'] },
      { path: '.timds/starter.json', policy: 'version-metadata', operation: 'starter-record', parameters: ['previousStarterRecord', 'plumbingMode'] },
      { path: 'package.json', policy: 'seed-only', operation: 'initialize-package', parameters: ['repositoryName', 'standalone', 'provider', 'baselineVersion', 'existingPackage'] },
    ],
  };
}

/** Read only a resource declared for this starter by the installed package. */
export async function readToolkitReleaseResource(packagePath, options = {}) {
  const selected = selection(options);
  const files = await definitions(selected.starter);
  if (!files.some(file => file.resource === packagePath)) throw new Error(`Unknown toolkit release resource ${JSON.stringify(packagePath)}`);
  return resourceFile(packagePath);
}

/** Exact npm managed bytes. Callers still enforce each file's replacement policy. */
export async function renderToolkitManagedFiles(options = {}) {
  const selected = selection(options, ['releaseAutomation', 'dependencyAutomation', 'hostedSkill']);
  for (const flag of ['releaseAutomation', 'dependencyAutomation']) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new Error(`${flag} must be a boolean`);
  }
  const enabled = new Set(['starter-plumbing', 'stock-fragment', 'managed-skill']);
  if (options.releaseAutomation) enabled.add('release-automation');
  if (options.dependencyAutomation) enabled.add('dependency-automation');
  const files = [];
  for (const definition of await definitions(selected.starter)) {
    if (!enabled.has(definition.policy)) continue;
    const resource = await resourceFile(definition.resource);
    // Canonical Git modes describe fresh package output. Existing-file mode
    // preservation during an upgrade remains the caller's policy.
    const mode = resource.mode;
    files.push({ path: definition.path, policy: definition.policy, mode, sha256: resource.sha256, content: resource.content });
  }
  if (options.hostedSkill !== undefined) {
    if (!options.hostedSkill || typeof options.hostedSkill !== 'object' || Array.isArray(options.hostedSkill)) throw new Error('hostedSkill must be an explicit system identity');
    const system = hostedSkillSystem(options.hostedSkill);
    // This API is always npm output even inside an executable environment.
    // Verify resources before rendering, including every directory component.
    for (const resource of await skillResources(HOSTED_SKILL_TEMPLATE)) await resourceFile(resource);
    for (const file of await renderHostedSkillFiles(system, { binary: false })) {
      files.push({ path: `.agents/skills/${system.skill}/${file.relative}`, policy: 'hosted-skill', mode: '100644', sha256: digest(file.content), content: file.content });
    }
  }
  files.push({ path: CLAUDE_SKILLS_LINK, policy: 'create-if-absent', mode: '120000', sha256: digest(CLAUDE_SKILLS_TARGET), content: CLAUDE_SKILLS_TARGET });
  files.sort(comparePath);
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Hosted skill destination collides with a managed toolkit skill');
  return { ...selected, toolkit: toolkitIdentity(), files };
}
