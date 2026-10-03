/** One explicit mode for the reviewed old-derived authentication fallback image. */
export type RuntimeMode = "normal" | "rollback-auth-only";

export function parseRuntimeMode(value: string | undefined): RuntimeMode {
	if (value === undefined || value === "normal") return "normal";
	if (value === "rollback-auth-only") return value;
	throw new Error("OXY_RUNTIME_MODE_INVALID");
}

export const runtimeMode = parseRuntimeMode(process.env.OXY_RUNTIME_MODE);
export const isRollbackAuthOnly = runtimeMode === "rollback-auth-only";

/** Module-load effects already use this value: dotenv must not change it later. */
export function assertRuntimeModeUnchanged(): void {
	if (parseRuntimeMode(process.env.OXY_RUNTIME_MODE) !== runtimeMode) {
		throw new Error("OXY_RUNTIME_MODE_CHANGED_AFTER_MODULE_LOAD");
	}
}
