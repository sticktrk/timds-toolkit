import type {RuntimeIdentity, RuntimeRequirements} from "../src/runtime.mjs";
export declare const VIDEO_RUNTIME_CAPABILITIES: Readonly<Pick<RuntimeIdentity, "releaseLine" | "videoSchema" | "componentApi" | "features">>;
export declare function assertRuntimeCompatibility(requirements: RuntimeRequirements | undefined, selected: RuntimeIdentity): RuntimeIdentity;
