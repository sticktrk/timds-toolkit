import type {RuntimeIdentity, RuntimeRequirements} from "../src/runtime.mjs";
export declare const VIDEO_RUNTIME_CAPABILITIES: Readonly<Pick<RuntimeIdentity, "videoSchema" | "componentApi" | "features">>;
export declare function releaseLineOf(version: string): string;
export declare function runtimeIdentityFor(pkg: {name: string; version: string}): Readonly<RuntimeIdentity>;
export declare function assertRuntimeCompatibility(requirements: RuntimeRequirements | undefined, selected: RuntimeIdentity): RuntimeIdentity;
