import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AnyModel, Provider } from "@earendil-works/pi-ai";

export const CONTEXT_CAP = 272_000;
export const DEFAULT_RESERVE = 16_384;

export function isCopilotGpt(model: { provider: string; id: string } | undefined): boolean {
	return model?.provider === "github-copilot" && /^gpt(?:-|\d)/i.test(model.id);
}

export function capModel<T extends AnyModel>(model: T): T {
	if (!isCopilotGpt(model) || (model.type !== undefined && model.type !== "chat")) return model;
	if (!("contextWindow" in model) || model.contextWindow <= CONTEXT_CAP) return model;
	return { ...model, contextWindow: CONTEXT_CAP };
}

/** Keep the live catalog, auth, refresh, filtering and streaming implementations intact. */
export function withContextCap(provider: Provider): Provider {
	return new Proxy(provider, {
		get(target, key) {
			if (key === "getModels") return () => target.getModels().map(capModel);
			if (key === "getAllModels") {
				return () => (target.getAllModels?.() ?? target.getModels()).map(capModel);
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export interface PreferenceStore {
	load(): boolean;
	save(enabled: boolean): void;
}

export function preferenceStore(path: string): PreferenceStore {
	return {
		load() {
			let text: string;
			try {
				text = readFileSync(path, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
				throw error;
			}
			const config: unknown = JSON.parse(text);
			if (!config || typeof config !== "object" || !("enabled" in config) || typeof config.enabled !== "boolean") {
				throw new Error(`Expected { "enabled": boolean } in ${path}`);
			}
			return config.enabled;
		},
		save(enabled) {
			mkdirSync(dirname(path), { recursive: true });
			const temporary = `${path}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
				renameSync(temporary, path);
			} finally {
				rmSync(temporary, { force: true });
			}
		},
	};
}
