export type RuntimeIdentity = {name: string; version: string; releaseLine: string; videoSchema: number; componentApi: number; features: readonly string[]};
export type RuntimeRequirements = {releaseLine: string; minimumVersion: string; videoSchema: number; componentApi: number; features: string[]; testedVersions?: string[]};
export declare const runtimeIdentity: Readonly<RuntimeIdentity>;
export declare const runtimeDependencies: Readonly<Record<string, string>>;
export declare function sharedRuntimeRequirements(): RuntimeRequirements;
export declare function assertRuntimeCompatibility(requirements?: RuntimeRequirements, selected?: RuntimeIdentity): RuntimeIdentity;
export declare function assertVideoContractRuntime(contract: {schemaVersion: number; runtime?: RuntimeRequirements}): void;
