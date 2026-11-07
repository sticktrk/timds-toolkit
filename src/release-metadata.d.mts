export type StarterKind = 'starter' | 'brand-kit';
export type FileMode = '100644' | '100755' | '120000';
export type ResourcePolicy = 'seed-only' | 'starter-plumbing' | 'stock-fragment' | 'catalog-merge' | 'layout-patch' | 'release-automation' | 'dependency-automation' | 'managed-skill' | 'hosted-skill';
export interface ReleaseSelection { schemaVersion?: 1; starter?: StarterKind }
export interface ToolkitIdentity { name: '@dtconcepts/timds'; version: string }
export interface ResourceMetadata { packagePath: string; mode: Exclude<FileMode, '120000'>; sha256: string; bytes: number }
export interface ResourceFile extends ResourceMetadata { content: string }
export interface FileDefinition { path: string; resource: string; policy: ResourcePolicy; operation: string; parameters?: string[] }
export interface ToolkitRelease {
  schemaVersion: 1;
  toolkit: ToolkitIdentity;
  starter: StarterKind;
  resources: ResourceMetadata[];
  files: FileDefinition[];
  symlinks: { path: string; target: string; mode: '120000'; policy: 'create-if-absent' }[];
  generated: { path: string; policy: 'version-metadata' | 'seed-only'; operation: string; parameters: string[] }[];
}
export interface HostedSkillIdentity { portalUrl: string; systemId: string; systemName?: string | null; studioUrl?: string | null }
export interface RenderOptions extends ReleaseSelection {
  hostedSkill?: HostedSkillIdentity;
  releaseAutomation?: boolean;
  dependencyAutomation?: boolean;
}
export interface RenderedManagedFile { path: string; policy: ResourcePolicy | 'create-if-absent'; mode: FileMode; sha256: string; content: string }
export interface RenderedToolkitFiles { schemaVersion: 1; toolkit: ToolkitIdentity; starter: StarterKind; files: RenderedManagedFile[] }
export const RELEASE_METADATA_SCHEMA_VERSION: 1;
export function describeToolkitRelease(options?: ReleaseSelection): Promise<ToolkitRelease>;
export function readToolkitReleaseResource(packagePath: string, options?: ReleaseSelection): Promise<ResourceFile>;
export function renderToolkitManagedFiles(options?: RenderOptions): Promise<RenderedToolkitFiles>;
