import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { CONTEXT_CAP, DEFAULT_RESERVE, isCopilotGpt, preferenceStore, withContextCap, type PreferenceStore } from "./core.ts";

/** Use Pi's native between-turn compaction; never abort a run with ctx.compact(). */
export default function copilotGptCompact(
	pi: ExtensionAPI,
	store: PreferenceStore = preferenceStore(join(getAgentDir(), "copilot-gpt-compact.json")),
): void {
	let enabled = true;
	let original: Provider | undefined;
	let capped: Provider | undefined;

	function description(ctx: ExtensionContext): string {
		const settings = pi.getSettings().compaction;
		const model = ctx.model;
		if (!isCopilotGpt(model) || !model) {
			return `Copilot GPT early compaction: ${enabled ? "on" : "off"}; not applicable to the current model.`;
		}
		const reserve = settings?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens
			?? settings?.reserveTokens ?? DEFAULT_RESERVE;
		const threshold = Math.max(0, model.contextWindow - reserve);
		const native = settings?.enabled === false ? " Native auto-compaction is disabled in /settings." : "";
		return `Copilot GPT early compaction: ${enabled ? "on" : "off"}; effective window ${model.contextWindow.toLocaleString()}, native compact threshold > ${threshold.toLocaleString()} tokens.${native}`;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const applicable = isCopilotGpt(ctx.model);
		const nativeDisabled = pi.getSettings().compaction?.enabled === false;
		ctx.ui.setStatus("copilot-compact", applicable
			? `Copilot compact: ${!enabled ? "off" : nativeDisabled ? "paused" : "on (272k)"}`
			: undefined);
	}

	function apply(ctx: ExtensionContext): void {
		if (original && capped) pi.registerProvider(enabled ? capped : original);
		updateStatus(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		try {
			enabled = store.load();
		} catch (error) {
			enabled = true;
			ctx.ui.notify(`Cannot read Copilot compact preference; defaulting to on. ${String(error)}`, "warning");
		}
		// Capture the existing provider, including its live/remote model catalog.
		// Do not recreate Copilot OAuth or copy a fixed list of its models.
		original ??= ctx.modelRegistry.getProvider("github-copilot");
		if (!original) {
			ctx.ui.notify("Copilot compact: GitHub Copilot provider not found.", "warning");
			return;
		}
		capped ??= withContextCap(original);
		apply(ctx);
		if (enabled && isCopilotGpt(ctx.model) && ctx.model!.contextWindow > CONTEXT_CAP) {
			ctx.ui.notify("Copilot compact: an explicit model/provider override takes precedence over the 272k cap. Check models.json or other provider extensions.", "warning");
		}
	});

	pi.on("model_select", (_event, ctx) => {
		// Scoped model cycling can select an uncapped snapshot captured before startup.
		// Re-registering refreshes the active model from the capped registry without
		// emitting another model_select event or changing the selected model ID.
		if (ctx.model?.provider === "github-copilot") apply(ctx);
		else updateStatus(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.model?.provider === "github-copilot" && enabled && ctx.model.contextWindow > CONTEXT_CAP) apply(ctx);
		else updateStatus(ctx);
	});

	pi.registerCommand("copilot-compact", {
		description: "Copilot GPT early compaction: /copilot-compact [on|off|toggle|status] (default on; saved globally)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (!["on", "off", "toggle", "status"].includes(action)) {
				ctx.ui.notify("Usage: /copilot-compact [on|off|toggle|status]", "warning");
				return;
			}
			if (action !== "status") {
				await ctx.waitForIdle();
				const next = action === "toggle" ? !enabled : action === "on";
				try {
					// If saving fails, leave the running preference unchanged.
					store.save(next);
				} catch (error) {
					ctx.ui.notify(`Cannot save Copilot compact preference: ${String(error)}`, "error");
					return;
				}
				enabled = next;
				apply(ctx);
			}
			ctx.ui.notify(description(ctx), "info");
		},
	});
}
