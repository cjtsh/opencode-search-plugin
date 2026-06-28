/**
 * Web Search Plugin for opencode
 *
 * Provides a `web_search` tool that:
 *   - Performs web searches using Brave Search or Serper.dev (Google)
 *   - Auto-enables for local models (ollama, lmstudio, unsloth,
 *     llamacpp, vllm, exo, llama.cpp) by checking both the provider ID
 *     and model ID (enables LiteLLM local pass-throughs to trigger correctly)
 *   - Stays out of the way for hosted models that already ship
 *     native search (use opencode's built-in `websearch` tool there)
 *   - Tracks model switches via session events and shows a toast
 *     when the gating state changes
 *   - Can be force-toggled via WEB_SEARCH_FORCE env var
 *
 * API keys (read from process.env, never hardcoded):
 *   - BRAVE_API_KEY   (free 2,000/month)
 *   - SERPER_API_KEY  (paid cheap)
 *
 * Optional env:
 *   - WEB_SEARCH_PRIMARY        brave | serper (default: brave)
 *   - WEB_SEARCH_FORCE          on | off | auto (default: auto)
 *   - WEB_SEARCH_MAX_CHARS      truncation cap (default: 8000)
 *   - WEB_SEARCH_MAX_RESULTS    result cap     (default: 10, max 20)
 *
 * Tool Arguments:
 *   - query: The search query string
 *   - count: (Optional) number of results
 *   - provider: (Optional) Force "brave" or "serper" search engine
 *
 * Install:
 *   cp web-search.ts ~/.config/opencode/plugins/web-search.ts
 *   # or per-project: .opencode/plugins/web-search.ts
 *
 * The plugin's name is `web_search` (underscore) so it does NOT
 * collide with opencode's built-in `websearch` (Exa) tool. Both
 * can coexist; on local models without Exa enabled, only this
 * tool is available.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

// ============================================================
// .env loader (zero-dependency, only fills in MISSING keys)
// ============================================================
// Reads `.env` from three locations, in order:
//   1. The directory containing this plugin file
//   2. ~/.config/opencode/.env  (global install)
//   3. The current working directory (project-local dev)
// IMPORTANT: Never overrides keys already in process.env,
// so shell exports (e.g. ~/.zshrc) always win. .env is purely
// additive for users who don't use shell exports.
function loadEnvFile(envPath: string): void {
	if (!existsSync(envPath)) return;
	try {
		const content = readFileSync(envPath, "utf-8");
		for (const rawLine of content.split("\n")) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
			if (!m) continue;
			const [, key, rawValue] = m;
			if (process.env[key] !== undefined) continue; // already set, never override
			let value = rawValue.trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			process.env[key] = value;
		}
	} catch {
		// Silent — never break the plugin over a malformed .env
	}
}

try {
	const here = dirname(fileURLToPath(import.meta.url));
	loadEnvFile(join(here, ".env"));
	loadEnvFile(join(homedir(), ".config", "opencode", ".env"));
	loadEnvFile(join(process.cwd(), ".env"));
} catch {
	// import.meta.url may not be available in every loader — that's fine
}

// ============================================================
// Configuration
// ============================================================
const TOOL_NAME = "web_search";
const MAX_RESULT_CHARS = Number(process.env.WEB_SEARCH_MAX_CHARS) || 8000;
const MAX_RESULTS_DEFAULT = Number(process.env.WEB_SEARCH_MAX_RESULTS) || 10;
const MAX_RESULTS_LIMIT = 20;

// Local provider patterns (case-insensitive). web_search is enabled
// whenever the active session's provider matches one of these.
// Expand this list to support more local runtimes.
const LOCAL_PATTERNS: RegExp[] = [
	/ollama/i,
	/lmstudio/i,
	/unsloth/i,
	/llamacpp/i,
	/llama\.cpp/i,
	/vllm/i,
	/exo/i,
];

type Provider = "brave" | "serper";
const PRIMARY_PROVIDER = (process.env.WEB_SEARCH_PRIMARY ?? "brave").toLowerCase().trim() === "serper" ? "serper" : "brave";
let activeProvider: Provider = PRIMARY_PROVIDER;

// Force override: on | off | auto (default auto).
const FORCE_MODE = (process.env.WEB_SEARCH_FORCE ?? "auto").toLowerCase().trim();
const FORCE_ON = FORCE_MODE === "on" || FORCE_MODE === "true" || FORCE_MODE === "1";
const FORCE_OFF = FORCE_MODE === "off" || FORCE_MODE === "false" || FORCE_MODE === "0";

// ============================================================
// Types
// ============================================================
interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	date?: string;
}

interface BraveResponse {
	web?: {
		results?: Array<{
			title: string;
			url: string;
			description: string;
			age?: string;
		}>;
	};
}

interface SerperResponse {
	organic?: Array<{
		title: string;
		link: string;
		snippet: string;
		date?: string;
	}>;
}

interface SessionModel {
	providerID?: string;
	modelID?: string;
}

// ============================================================
// Helpers
// ============================================================
// Matches the pi plugin's approach: test the full "provider/model" string
// against the local patterns. This is essential for users who consolidate
// everything through a gateway (LiteLLM, etc.) where the provider ID is
// always the gateway name (e.g. "litellm-local") but the model ID carries
// the actual runtime marker (e.g. "ollama/qwen3.5:9b", "lmstudio/qwen-2.5").
function isLocalModel(
	providerID: string | undefined | null,
	modelID: string | undefined | null,
): boolean {
	if (!providerID && !modelID) return false;
	const haystack = `${providerID ?? ""}/${modelID ?? ""}`;
	return LOCAL_PATTERNS.some((p) => p.test(haystack));
}

// Defensively extract a model object from a session payload.
// opencode's SDK shapes vary slightly across versions, so we
// accept several possible locations and normalize keys.
function extractModel(session: unknown): SessionModel | undefined {
	if (!session || typeof session !== "object") return undefined;
	const s = session as Record<string, unknown>;

	const normalize = (modelObj: unknown): SessionModel | undefined => {
		if (!modelObj || typeof modelObj !== "object") return undefined;
		const m = modelObj as Record<string, unknown>;
		const providerID = String(m.providerID || m.providerId || m.provider || "");
		const modelID = String(m.modelID || m.modelId || m.id || m.model || "");
		if (!providerID) return undefined;
		return { providerID, modelID };
	};

	const direct = normalize(s.model);
	if (direct) return direct;

	const info = s.info as Record<string, unknown> | undefined;
	if (info) {
		const infoModel = normalize(info.model);
		if (infoModel) return infoModel;
	}

	return undefined;
}

async function searchBrave(query: string, count: number): Promise<SearchResult[]> {
	const apiKey = process.env.BRAVE_API_KEY;
	if (!apiKey) throw new Error("BRAVE_API_KEY env var not set");

	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(Math.min(count, MAX_RESULTS_LIMIT)));

	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": apiKey,
		},
	});

	if (!response.ok) {
		throw new Error(`Brave API ${response.status}: ${await response.text()}`);
	}

	const data = (await response.json()) as BraveResponse;
	return (data.web?.results ?? []).map((r) => ({
		title: r.title,
		url: r.url,
		snippet: r.description,
		date: r.age,
	}));
}

async function searchSerper(query: string, count: number): Promise<SearchResult[]> {
	const apiKey = process.env.SERPER_API_KEY;
	if (!apiKey) throw new Error("SERPER_API_KEY env var not set");

	const response = await fetch("https://google.serper.dev/search", {
		method: "POST",
		headers: {
			"X-API-KEY": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			q: query,
			num: Math.min(count, MAX_RESULTS_LIMIT),
		}),
	});

	if (!response.ok) {
		throw new Error(`Serper API ${response.status}: ${await response.text()}`);
	}

	const data = (await response.json()) as SerperResponse;
	return (data.organic ?? []).map((r) => ({
		title: r.title,
		url: r.link,
		snippet: r.snippet,
		date: r.date,
	}));
}

function formatResults(results: SearchResult[], provider: Provider): string {
	if (results.length === 0) {
		return `No results from ${provider}.`;
	}

	const lines: string[] = [
		`Found ${results.length} result${results.length === 1 ? "" : "s"} (via ${provider}):`,
		"",
	];

	for (const [i, r] of results.entries()) {
		lines.push(`${i + 1}. **${r.title}**`);
		lines.push(`   ${r.url}`);
		if (r.date) lines.push(`   Date: ${r.date}`);
		lines.push(`   ${r.snippet}`);
		lines.push("");
	}

	let output = lines.join("\n");
	if (output.length > MAX_RESULT_CHARS) {
		output = output.slice(0, MAX_RESULT_CHARS) + "\n\n[Results truncated]";
	}
	return output;
}

// ============================================================
// Plugin
// ============================================================
export const WebSearchPlugin: Plugin = async ({ client }) => {
	const log = (
		level: "debug" | "info" | "warn" | "error",
		message: string,
		extra?: Record<string, unknown>,
	) => {
		client.app
			.log({ body: { service: "web-search", level, message, extra } })
			.catch(() => {});
	};

	// Cached snapshot of the current session's provider/model.
	// Refreshed by session events and again on every tool execute.
	let cachedProvider: string | null = null;
	let cachedModel: string | null = null;

	log("info", "plugin loaded", {
		force: FORCE_MODE,
		brave: !!process.env.BRAVE_API_KEY,
		serper: !!process.env.SERPER_API_KEY,
		localPatterns: LOCAL_PATTERNS.map((p) => p.source),
	});

	if (FORCE_ON) log("info", "WEB_SEARCH_FORCE=on — tool will run for every model");
	if (FORCE_OFF) log("info", "WEB_SEARCH_FORCE=off — tool is fully disabled");

	// Best-effort: pick up the latest session's model at startup in the background
	// so we do not block plugin initialization (which would deadlock opencode startup).
	client.session.list()
		.then((list) => {
			const latest = (list.data ?? [])[0];
			const model = extractModel(latest);
			if (model?.providerID) {
				cachedProvider = model.providerID;
				cachedModel = model.modelID ?? null;
			}
		})
		.catch((e) => {
			log("debug", "could not pre-fetch session list", { error: String(e) });
		});

	async function notifyGating(providerID: string, modelID: string | null): Promise<void> {
		const local = isLocalModel(providerID, modelID);
		const active = FORCE_ON || (!FORCE_OFF && local);
		const message = FORCE_OFF
			? `web_search disabled (WEB_SEARCH_FORCE=off)`
			: local
				? `web_search enabled — local model ${providerID}/${modelID ?? "?"}`
				: `web_search idle — hosted ${providerID} has native search`;
		try {
			await client.tui.showToast({
				body: {
					message,
					variant: active ? "success" : "info",
				},
			});
		} catch {
			// toast may fail in non-TUI contexts (SDK, server-only) — ignore
		}
		log("info", "gating state", { provider: providerID, model: modelID, local, active });
	}

	return {
		// Track model switches. session.updated fires when the user picks
		// a different model mid-session; session.created fires on new chats.
		event: async ({ event }) => {
			if (event.type !== "session.updated" && event.type !== "session.created") return;
			const model = extractModel(event.properties as unknown);
			if (!model?.providerID) return;
			const changed = model.providerID !== cachedProvider;
			cachedProvider = model.providerID;
			cachedModel = model.modelID ?? null;
			if (changed) await notifyGating(cachedProvider, cachedModel);
		},

		tool: {
			[TOOL_NAME]: tool({
				description:
					"Search the web for current information: news, weather, prices, recent events, sports scores, " +
					"or anything where the answer may have changed recently or might not be in the model's training data. " +
					"Returns a numbered list of results with titles, URLs, and snippets. " +
					"Uses Brave Search as primary, Serper.dev (Google results) as fallback. " +
					"Auto-enabled for local models (ollama, lmstudio, unsloth, llamacpp, vllm, exo). " +
					"For hosted providers, prefer the built-in 'websearch' tool. " +
					"Use this for: current events, weather, prices, news, sports scores, library docs, " +
					"release notes, or any time-sensitive question. " +
					"Do NOT use for: code questions, file operations, math, or anything answerable from context.",
				args: {
					query: tool.schema
						.string()
						.describe("The search query string (be specific for better results)"),
					count: tool.schema
						.number()
						.int()
						.min(1)
						.max(MAX_RESULTS_LIMIT)
						.optional()
						.describe(
							`Number of results to return (1-${MAX_RESULTS_LIMIT}, default ${MAX_RESULTS_DEFAULT})`,
						),
					provider: tool.schema
						.enum(["brave", "serper"])
						.optional()
						.describe("Force a specific search provider for this query (defaults to brave, falls back to serper)"),
				},

				async execute(args, context) {
					// 1. Refresh the cached model from the live session — this is
					//    the authoritative source of truth, events are just UX.
					let providerID = cachedProvider;
					try {
						const session = await client.session.get({
							path: { id: context.sessionID },
						});
						const model = extractModel(session.data);
						if (model?.providerID) {
							providerID = model.providerID;
							cachedProvider = model.providerID;
							cachedModel = model.modelID ?? null;
						}
					} catch (e) {
						log("warn", "could not fetch current session", { error: String(e) });
					}

				// 2. Gate. Force flags take precedence over auto-detection.
				const local = isLocalModel(providerID, cachedModel);
					const shouldRun = FORCE_ON || (!FORCE_OFF && local);

					if (FORCE_OFF) {
						return (
							"web_search is disabled (WEB_SEARCH_FORCE=off). " +
							"Remove the env var or set WEB_SEARCH_FORCE=auto to re-enable."
						);
					}

					if (!shouldRun) {
						log("info", "gated: hosted model", { provider: providerID });
						return [
							`web_search is disabled for hosted model "${providerID ?? "unknown"}".`,
							``,
							`Hosted providers usually ship their own native search.`,
							`Prefer opencode's built-in \`websearch\` tool for this model.`,
							``,
							`To force-enable web_search anyway, set WEB_SEARCH_FORCE=on`,
							`in your environment or .env file.`,
						].join("\n");
					}

					// 3. Run search with fallback.
					const count = args.count ?? MAX_RESULTS_DEFAULT;
					const primaryProvider = args.provider ?? activeProvider;
					log("info", "searching", {
						query: args.query,
						count,
						provider: primaryProvider,
						model: `${providerID}/${cachedModel ?? "?"}`,
					});

					let results: SearchResult[];
					let usedProvider: Provider = primaryProvider;

					if (primaryProvider === "brave") {
						try {
							results = await searchBrave(args.query, count);
						} catch (braveErr) {
							const msg = braveErr instanceof Error ? braveErr.message : String(braveErr);
							log("warn", "brave failed, trying fallback to serper", { error: msg });
							if (process.env.SERPER_API_KEY) {
								try {
									results = await searchSerper(args.query, count);
									usedProvider = "serper";
								} catch (serperErr) {
									const sMsg =
										serperErr instanceof Error ? serperErr.message : String(serperErr);
									log("error", "both backends failed", { brave: msg, serper: sMsg });
									throw new Error(
										`Both search backends failed.\nBrave: ${msg}\nSerper: ${sMsg}`,
									);
								}
							} else {
								throw new Error(msg);
							}
						}
					} else {
						// primaryProvider is "serper"
						try {
							results = await searchSerper(args.query, count);
						} catch (serperErr) {
							const msg = serperErr instanceof Error ? serperErr.message : String(serperErr);
							log("warn", "serper failed, trying fallback to brave", { error: msg });
							if (process.env.BRAVE_API_KEY) {
								try {
									results = await searchBrave(args.query, count);
									usedProvider = "brave";
								} catch (braveErr) {
									const bMsg =
										braveErr instanceof Error ? braveErr.message : String(braveErr);
									log("error", "both backends failed", { serper: msg, brave: bMsg });
									throw new Error(
										`Both search backends failed.\nSerper: ${msg}\nBrave: ${bMsg}`,
									);
								}
							} else {
								throw new Error(msg);
							}
						}
					}

					log("info", "search complete", {
						provider: usedProvider,
						results: results.length,
					});
					return formatResults(results, usedProvider);
				},
			}),
		},
	};
};

export default WebSearchPlugin;
