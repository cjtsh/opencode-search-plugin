# opencode Web Search Plugin

A plugin for [opencode](https://opencode.ai) that gives **local LLM models live internet access** via **Brave Search** (primary) and **Serper.dev** (fallback).

Solves a real gap: when you point opencode at a local model (Ollama, LM Studio, Unsloth, llama.cpp, vLLM, Exo), the model has no built-in web search. Ask "what's the price of bitcoin?" and you get *"I don't have internet access."* This plugin fixes that by registering a `web_search` tool the model can call like any other.

Auto-enabled only when the active session's provider matches a local pattern. Stays out of the way for hosted models (Anthropic, OpenAI, Google, etc.) that already ship native search.

---

## Why this exists

opencode ships a built-in `websearch` tool backed by Exa AI — but it's gated to either the OpenCode provider or `OPENCODE_ENABLE_EXA=1`. For users running local models and preferring their own search backend (Brave/Serper, with their own API keys), this plugin is the right tool.

| Approach | Setup | Backend | Auto-detect local models |
|---|---|---|---|
| Built-in `websearch` | `OPENCODE_ENABLE_EXA=1` env var | Exa AI (hosted, no key) | No |
| **This plugin** | Install + 1 API key | Brave + Serper (your keys) | **Yes** |

Both can coexist. On a local model without Exa enabled, only this plugin's `web_search` is available. On hosted models, both can be available.

---

## Quick Install (60 seconds)

```bash
# 1. Drop the plugin into opencode's plugin directory
mkdir -p ~/.config/opencode/plugins
cp web-search.ts ~/.config/opencode/plugins/web-search.ts

# 2. Get API keys (both have free/cheap tiers)
#    Brave:  https://brave.com/search/api/   (free, 2,000/month)
#    Serper: https://serper.dev/             (paid, cheap)

# 3. Set the keys (pick ONE method)
```

### Option A: Shell exports (recommended for personal use)

Add to `~/.zshrc` or `~/.bashrc`:

```bash
export BRAVE_API_KEY="your_brave_key_here"
export SERPER_API_KEY="your_serper_key_here"
```

Then `source ~/.zshrc` and restart opencode.

### Option B: `.env` file (recommended for portability)

```bash
cp .env.example ~/.config/opencode/.env
nano ~/.config/opencode/.env    # paste in your real keys
```

Restart opencode. Done.

---

## Per-project install

To enable for a single project only, drop it in the project's plugin dir:

```bash
mkdir -p .opencode/plugins
cp web-search.ts .opencode/plugins/web-search.ts
```

Project plugins load **after** global plugins (so a project copy takes precedence).

---

## How it works

1. On startup, the plugin registers a `web_search` tool.
2. In the background, it runs a non-blocking query to pre-fetch the latest session's model context (done asynchronously to prevent deadlocking the opencode bootstrap loader).
3. It subscribes to session events. When the user picks a model, it caches the provider ID.
4. On every tool call, it re-checks the live session (via `client.session.get`) for the freshest state.
5. If the provider ID or model ID matches a local pattern (`ollama`, `lmstudio`, `unsloth`, `llamacpp`, `vllm`, `exo`), the search runs. Checking the combined string allows gateway setups like LiteLLM to work correctly (e.g., enabling search for `litellm-local/unsloth-gemma-4-12b` but gating/disabling it for remote models like `litellm-local/gpt-4o`).
6. If hosted and not force-enabled, the tool returns a friendly message pointing the model at the built-in `websearch`.
7. On model switches, a toast notification shows the new gating state.

The tool is **always registered** — there's no way to truly "unregister" a tool at runtime in opencode. Instead, behavior changes based on the current model. This matches the spirit of the pi plugin's `setActiveTools` toggle while staying within opencode's plugin API.

---

## Force override

If you want `web_search` to run regardless of model (e.g., for testing, or you don't trust the auto-detection):

```bash
# Always run (even on hosted models)
export WEB_SEARCH_FORCE=on

# Never run (fully disable the tool)
export WEB_SEARCH_FORCE=off

# Default: only run for local models
export WEB_SEARCH_FORCE=auto
```

---

## Tuning and Configuration

You can customize the search behavior using the following environment variables:

```bash
# Select primary search engine (brave or serper, default: brave)
export WEB_SEARCH_PRIMARY=serper

# Cap result text length (default 8000 chars)
export WEB_SEARCH_MAX_CHARS=4000

# Default result count (1-20, default 10)
export WEB_SEARCH_MAX_RESULTS=5
```

---

## Features

- Native `web_search` tool the model calls autonomously
- Dual-backend fallback (Brave primary, Serper fallback)
- Smart auto-detection for local models (ollama, lmstudio, unsloth, llamacpp, vllm, exo)
- Reactive to model switches (no restart needed, shows toast on change)
- Runtime re-check on every call (always reflects current state)
- Result truncation tunable for small context windows
- Zero npm dependencies (single file, uses native `fetch`)
- Works with shell exports OR `.env` files (shell exports always win)
- Structured logging via `client.app.log`
- Force override via `WEB_SEARCH_FORCE` env var

---

## Verifying it works

After installing and setting keys:

1. Launch opencode with a **local model** (e.g. switch to Ollama).
2. You should see a toast: `web_search enabled — local model ollama/...`.
3. Ask: *"What's the price of bitcoin right now?"*
4. The model should call `web_search` and return current data.
5. Switch to a **hosted model** (e.g. Anthropic).
6. Toast: `web_search idle — hosted anthropic has native search`.
7. Asking the same question, the model uses its own search or `web_search` returns the friendly gate message.

For diagnostics, check opencode's logs (filtered by `service: web-search`):

```
plugin loaded — force=auto brave=true serper=true localPatterns=[ollama, lmstudio, ...]
model changed — provider=ollama model=llama3 local=true
searching — query="bitcoin price" count=10 provider=brave model=ollama/llama3
search complete — provider=brave results=10
```

---

## Adding more providers (Perplexity, Tavily, etc.)

The search functions are isolated and follow a simple signature:

```ts
async function searchX(query: string, count: number): Promise<SearchResult[]>
```

To add a third backend:

1. Implement `searchX` following the `searchBrave` / `searchSerper` pattern.
2. Add `"x"` to the `Provider` union type.
3. Wire it into the fallback chain in `execute()`.
4. Add the API key to `.env.example`.

See [`docs/opencode-search-plugin.md`](docs/opencode-search-plugin.md) for the full walkthrough.

---

## Security & Privacy

- **No hardcoded keys.** The plugin reads from `process.env` only.
- **No telemetry.** It makes one HTTP request per search to the configured backend.
- **`.env` is gitignored.** The repo ships with `.env.example` (placeholders only).
- **No key collection.** This repo will never ask for, log, or transmit your API keys.

---

## Comparison: pi plugin vs opencode plugin

| Feature | pi version | opencode version |
|---|---|---|
| Tool API | `pi.registerTool` + TypeBox | `tool()` helper + zod |
| Model detection | `model_select` event | `session.updated` event + live `session.get` |
| Toggle mechanism | `pi.setActiveTools([...])` | Runtime gate in `execute()` |
| Slash commands | `/search`, `/search-status`, etc. | None (opencode has no plugin slash command API) |
| User notifications | `ctx.ui.notify` | `client.tui.showToast` + `client.app.log` |
| Result truncation | Hardcoded 8000 | Configurable via `WEB_SEARCH_MAX_CHARS` |

---

## Troubleshooting

**opencode TUI window starts but is completely empty / hangs on startup.**
This occurs if a plugin blocks the bootstrap loading sequence by awaiting async calls (like `client.session.list()`) during plugin registration before the session manager is ready. Ensure you are using the latest version of `web-search.ts` where session pre-fetching is performed as a non-blocking background promise.

**Tool never runs / returns the "hosted model" message on a local model.**
Your provider ID doesn't match any pattern. Check opencode logs for `provider: <value>` and add it to `LOCAL_PATTERNS` in the plugin file, or set `WEB_SEARCH_FORCE=on`.

**`Brave API 401: ...`**
Wrong or expired `BRAVE_API_KEY`. Re-check the key at https://brave.com/search/api/.

**Both backends fail.**
Verify at least one key is set. The plugin logs `brave=false serper=false` on startup if neither is configured.

**No toast on model switch.**
You're likely running in non-TUI mode (SDK / server). Toasts require the TUI — logs still capture the transition.

---

## License

MIT © 2026 [mypbs](https://github.com/mypbs)


## Legal notice

This plugin is provided under the [MIT License](LICENSE). Review the [disclaimer](DISCLAIMER.md) before configuring external search providers, API keys, or model-generated queries. The canonical Bitseeker LLC disclaimer is pinned at [software-disclaimer v1.2.2](https://github.com/cjtsh/software-disclaimer/releases/tag/v1.2.2).
