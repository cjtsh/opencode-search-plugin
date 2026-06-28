#!/usr/bin/env node
/**
 * LiteLLM → opencode model sync
 *
 * Queries LiteLLM's /v1/models endpoint and ensures every model it exposes
 * is registered in your opencode config. Without this, you have to manually
 * add each model to opencode.jsonc whenever you add or rename one in LiteLLM.
 *
 * Usage:
 *   node litellm-sync.ts              Dry-run: print missing models only
 *   node litellm-sync.ts --apply      Write missing models into config
 *   node litellm-sync.ts --apply --provider litellm-local
 *   node litellm-sync.ts --endpoint http://localhost:4000/v1 --key sk-xxx
 *
 * The script:
 *   1. Finds your opencode config (~/.config/opencode/opencode.jsonc)
 *   2. Locates the LiteLLM provider (by name or baseURL matching localhost:4000)
 *   3. Fetches /v1/models from the gateway
 *   4. Diffs against currently-registered models
 *   5. Prints missing models (dry-run) or merges them in (--apply)
 *
 * --apply preserves your existing config. It only ADDS missing entries with
 * a minimal { "name": "<id>" } block. A timestamped backup is created before
 * any write. Your comments ARE lost on write (JSONC → JSON); the backup
 * preserves the original. This is a known limitation — prefer dry-run +
 * manual paste if you have extensive comments.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------- arg parsing ----------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const values: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
	if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
		values[argv[i].slice(2)] = argv[i + 1];
		i++;
	}
}
const APPLY = flags.has("--apply");
const CONFIG_PATH =
	values.config ?? join(homedir(), ".config", "opencode", "opencode.jsonc");
const PROVIDER_HINT = values.provider;
const ENDPOINT_OVERRIDE = values.endpoint;
const KEY_OVERRIDE = values.key;

// ---------- JSONC parser (string-aware comment + trailing comma tolerant) ----------
// Walks the string char-by-char so // inside a string literal (e.g. URLs
// like "https://...") is NOT treated as a line comment. This is the only
// safe way to strip JSONC comments without a real parser dependency.
function stripJsoncComments(str: string): string {
	let out = "";
	let i = 0;
	let inString = false;
	let inBlock = false;
	let inLine = false;
	while (i < str.length) {
		const ch = str[i];
		const next = str[i + 1];

		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += next ?? "";
				i += 2;
				continue;
			}
			if (ch === '"') inString = false;
			i++;
			continue;
		}
		if (inBlock) {
			if (ch === "*" && next === "/") {
				inBlock = false;
				i += 2;
				continue;
			}
			if (ch === "\n") out += ch; // preserve newlines for line numbers
			i++;
			continue;
		}
		if (inLine) {
			if (ch === "\n") {
				inLine = false;
				out += ch;
			}
			i++;
			continue;
		}
		// not in string or comment
		if (ch === "/" && next === "*") {
			inBlock = true;
			i += 2;
			continue;
		}
		if (ch === "/" && next === "/") {
			inLine = true;
			i += 2;
			continue;
		}
		if (ch === '"') inString = true;
		out += ch;
		i++;
	}
	return out;
}

function parseJSONC(content: string): unknown {
	const stripped = stripJsoncComments(content);
	// remove trailing commas (safe after comment strip)
	const clean = stripped.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(clean);
}

// ---------- main ----------
async function main(): Promise<void> {
	if (!existsSync(CONFIG_PATH)) {
		console.error(`✗ Config not found: ${CONFIG_PATH}`);
		console.error(`  Pass --config /path/to/your/opencode.jsonc to override.`);
		process.exit(1);
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	let config: any;
	try {
		config = parseJSONC(raw);
	} catch (e) {
		console.error(`✗ Could not parse config: ${(e as Error).message}`);
		process.exit(1);
	}

	const providers = config.provider ?? {};
	let providerKey: string | null = null;
	let provider: any = null;

	for (const [key, p] of Object.entries(providers) as [string, any][]) {
		if (PROVIDER_HINT && key !== PROVIDER_HINT) continue;
		const baseURL: string = p?.options?.baseURL ?? "";
		const isLitellm =
			key.toLowerCase().includes("litellm") ||
			baseURL.includes("localhost:4000") ||
			baseURL.includes("127.0.0.1:4000");
		if (isLitellm) {
			providerKey = key;
			provider = p;
			break;
		}
	}

	if (!providerKey || !provider) {
		console.error("✗ No LiteLLM provider found in config.");
		console.error("  Looked for provider with:");
		console.error("    - name containing 'litellm', OR");
		console.error("    - baseURL containing localhost:4000 or 127.0.0.1:4000");
		if (PROVIDER_HINT) console.error(`  (forced to: ${PROVIDER_HINT})`);
		console.error("  Pass --provider <key> to target a specific provider.");
		process.exit(1);
	}

	const baseURL = ENDPOINT_OVERRIDE ?? provider.options?.baseURL;
	const apiKey = KEY_OVERRIDE ?? provider.options?.apiKey ?? process.env.LITELLM_API_KEY;

	if (!baseURL) {
		console.error(`✗ No baseURL on provider "${providerKey}".`);
		process.exit(1);
	}

	console.log(`LiteLLM provider : ${providerKey}`);
	console.log(`Endpoint         : ${baseURL}`);
	console.log(`Mode             : ${APPLY ? "APPLY (will write config)" : "DRY-RUN"}`);
	console.log("");

	// Fetch models
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	let resp: Response;
	try {
		resp = await fetch(`${baseURL.replace(/\/$/, "")}/models`, { headers });
	} catch (e) {
		console.error(`✗ Could not reach LiteLLM at ${baseURL}: ${(e as Error).message}`);
		process.exit(1);
	}
	if (!resp.ok) {
		console.error(`✗ LiteLLM returned ${resp.status}: ${await resp.text()}`);
		process.exit(1);
	}

	const data = (await resp.json()) as { data?: Array<{ id: string }> };
	const discovered = (data.data ?? []).map((m) => m.id).sort();

	console.log(`Discovered ${discovered.length} model(s) from LiteLLM:`);
	for (const id of discovered) console.log(`  • ${id}`);
	console.log("");

	// Diff
	const existing = provider.models ?? {};
	const existingIds = new Set(Object.keys(existing));
	const missing = discovered.filter((id) => !existingIds.has(id));

	if (missing.length === 0) {
		console.log("✓ All LiteLLM models are already in opencode config. Nothing to do.");
		process.exit(0);
	}

	console.log(`${missing.length} model(s) missing from opencode config:`);
	for (const id of missing) console.log(`  + ${id}`);
	console.log("");

	if (!APPLY) {
		console.log("Dry-run only. To merge these into your config, run:");
		console.log(`  node litellm-sync.ts --apply`);
		console.log("");
		console.log("Or paste this block under provider." + providerKey + ".models:");
		console.log("");
		for (const id of missing) {
			console.log(`  "${id}": { "name": "${id}" },`);
		}
		process.exit(0);
	}

	// Apply
	const backup = `${CONFIG_PATH}.sync-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	copyFileSync(CONFIG_PATH, backup);
	console.log(`Backup written: ${backup}`);

	if (!provider.models) provider.models = {};
	for (const id of missing) {
		if (!provider.models[id]) provider.models[id] = { name: id };
	}

	// Write back as JSON (comments lost; backup preserves original)
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
	console.log(`✓ Added ${missing.length} model(s) to ${CONFIG_PATH}`);
	console.log("");
	console.log("Restart opencode for new models to appear in /models.");
	console.log("Note: config was rewritten as JSON (comments removed).");
	console.log(`      Original preserved at: ${backup}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
