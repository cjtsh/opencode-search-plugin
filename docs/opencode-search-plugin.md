# opencode Web Search Plugin — Reference

Full reference for the opencode web search plugin. For install + quick start, see the [README](../README.md).

---

## Table of contents

- [Architecture](#architecture)
- [How auto-detection works](#how-auto-detection-works)
- [Tool reference](#tool-reference)
- [Environment variables](#environment-variables)
- [Customization](#customization)
  - [Add a third backend (Perplexity, Tavily, etc.)](#add-a-third-backend-perplexity-tavily-etc)
  - [Change the local model patterns](#change-the-local-model-patterns)
  - [Replace the formatter](#replace-the-formatter)
- [Plugin API notes](#plugin-api-notes)
- [Sharing across machines](#sharing-across-machines)
- [Troubleshooting](#troubleshooting)
- [Comparison with the pi version](#comparison-with-the-pi-version)

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      opencode TUI                         │
│                                                          │
│   user ─► session ─► model (provider/id)                 │
│              │                                           │
│              │  session.updated / session.created        │
│              ▼                                           │
│   ┌────────────────────────────────────────┐             │
│   │        web-search.ts (plugin)          │             │
│   │                                        │             │
│   │   event hook ──► cache provider/id     │             │
│   │                  show toast            │             │
│   │                                        │             │
│   │   tool: web_search                     │             │
│   │     1. client.session.get (live)       │             │
│   │     2. gate: FORCE_ON | local?         │             │
│   │     3. searchBrave() ──► fail ──►      │             │
│   │        searchSerper()                  │             │
│   │     4. format + truncate               │             │
│   └────────────────────────────────────────┘             │
│              │                                           │
└──────────────┼───────────────────────────────────────────┘
               │
               ▼
      ┌─────────────────┐         ┌─────────────────┐
      │  Brave Search   │         │   Serper.dev    │
      │  (primary)      │         │   (fallback)    │
      └─────────────────┘         └─────────────────┘
```

The plugin is a single TypeScript file with no runtime dependencies beyond `@opencode-ai/plugin` (which opencode provides). All I/O uses Node's native `fetch`.

---

## How auto-detection works

The plugin maintains a cached `{ providerID, modelID }` and refreshes it from three sources:

1. **Background startup check** — runs `client.session.list()` asynchronously in the background at startup to populate the initial state without blocking the opencode bootstrap phase.
2. **Session events** (`session.updated`, `session.created`) — update the cache and fire a toast when the provider changes.
3. **Live `client.session.get()` on every tool call** — the authoritative source. If events are missed or the cache is stale, this re-syncs.

A provider is considered "local" if its ID matches any pattern in `LOCAL_PATTERNS`:

```ts
const LOCAL_PATTERNS: RegExp[] = [
  /ollama/i,
  /lmstudio/i,
  /unsloth/i,
  /llamacpp/i,
  /llama\.cpp/i,
  /vllm/i,
  /exo/i,
];
```

The full provider/model string (e.g. `ollama/llama3`, `lmstudio/qwen-2.5`, or `litellm-local/unsloth-gemma-4-12b`) is matched against these regex patterns, meaning the check works against either segment.

### Gateway Pass-through (e.g. LiteLLM)

If you route your models through a local gateway like LiteLLM, the provider ID in opencode will be `litellm` or `litellm-local` for all models (both local and remote). The plugin handles this by evaluating the combined `providerID/modelID` string:
- **Local models** routed through LiteLLM (e.g., `litellm-local/unsloth-gemma-4-12b`) will trigger the search because the model ID segment contains the keyword `unsloth` which matches the local patterns.
- **Remote/hosted models** routed through LiteLLM (e.g., `litellm-local/claude-3-5-sonnet`) will NOT trigger the search because the combined string contains no local keywords, keeping the tool gated/disabled as expected.

### Gating matrix

| `WEB_SEARCH_FORCE` | Local model | Hosted model |
|---|---|---|
| `auto` (default) | runs | returns gate message |
| `on` | runs | **runs** |
| `off` | disabled | disabled |

---

## Tool reference

### `web_search`

Search the web for current information.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | The search query |
| `count` | number | no | Results to return (1–20, default 10) |
| `provider` | string | no | Force a specific search provider for this query (`"brave"` or `"serper"`) |

**Returns:** A formatted string with numbered results (title, URL, optional date, snippet), truncated to `WEB_SEARCH_MAX_CHARS`.

**Example call (from the model):**

```json
{
  "name": "web_search",
  "args": { "query": "bitcoin price USD today", "count": 5 }
}
```

**Example output:**

```
Found 5 results (via brave):

1. **Bitcoin (BTC) price**
   https://coinmarketcap.com/...
   Date: 2h ago
   The live Bitcoin price today is $67,432.18 USD...

2. **BTC Price Index**
   https://www.coindesk.com/...
   ...
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `BRAVE_API_KEY` | (required) | Brave Search API key |
| `SERPER_API_KEY` | (optional) | Serper.dev API key (fallback) |
| `WEB_SEARCH_PRIMARY` | `brave` | The primary search provider (`brave` or `serper`) |
| `WEB_SEARCH_FORCE` | `auto` | `on` / `off` / `auto` |
| `WEB_SEARCH_MAX_CHARS` | `8000` | Max characters of result text |
| `WEB_SEARCH_MAX_RESULTS` | `10` | Default result count (1–20) |

**Precedence:** shell exports (`process.env`) > `.env` file. The plugin only fills in keys that aren't already set.

---

## Customization

### Add a third backend (Perplexity, Tavily, etc.)

Backends are isolated functions with a uniform signature:

```ts
type Provider = "brave" | "serper";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

async function searchX(query: string, count: number): Promise<SearchResult[]>
```

To add Perplexity as an example:

**1. Add the backend function** (next to `searchBrave` / `searchSerper`):

```ts
interface PerplexityResponse {
  results?: Array<{ title: string; url: string; snippet: string }>;
}

async function searchPerplexity(
  query: string,
  count: number,
): Promise<SearchResult[]> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY env var not set");

  const response = await fetch("https://api.perplexity.ai/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, num: Math.min(count, MAX_RESULTS_LIMIT) }),
  });

  if (!response.ok) {
    throw new Error(`Perplexity API ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as PerplexityResponse;
  return (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
  }));
}
```

**2. Extend the `Provider` type:**

```ts
type Provider = "brave" | "serper" | "perplexity";
```

**3. Wire into the fallback chain** in `execute()`:

```ts
try {
  results = await searchBrave(args.query, count);
} catch (braveErr) {
  if (process.env.PERPLEXITY_API_KEY) {
    try {
      results = await searchPerplexity(args.query, count);
      usedProvider = "perplexity";
    } catch (pErr) {
      // fall through to serper...
    }
  }
  // existing serper fallback...
}
```

**4. Add the key** to `.env.example`:

```bash
PERPLEXITY_API_KEY=your_perplexity_key_here
```

That's it. No other changes needed.

### Change the local model patterns

Edit `LOCAL_PATTERNS`:

```ts
const LOCAL_PATTERNS: RegExp[] = [
  /ollama/i,
  /lmstudio/i,
  /unsloth/i,
  /llamacpp/i,
  /llama\.cpp/i,
  /vllm/i,
  /exo/i,
  /my-custom-runtime/i,   // add yours
];
```

Restart opencode. The new pattern is logged on startup.

### Replace the formatter

The `formatResults` function controls the output shape. Common tweaks:

- **Plain text instead of markdown** — remove the `**` markers.
- **JSON output** — return `JSON.stringify(results, null, 2)`.
- **Tighter snippets** — truncate `r.snippet` to N characters.
- **Different truncation cap** — set `WEB_SEARCH_MAX_CHARS` instead of editing code.

---

## Plugin API notes

opencode's plugin API differs from pi's in a few important ways:

| Concern | pi | opencode |
|---|---|---|
| Tool registration | `pi.registerTool({ name, ... })` | `return { tool: { [name]: tool({...}) } }` |
| Schema library | TypeBox (`Type.Object`) | zod (`tool.schema.object` / `z.object`) |
| Model event | `model_select` | `session.updated` / `session.created` |
| Toggle tool active | `pi.setActiveTools([...])` | not available — gate inside `execute()` |
| Slash commands | `pi.registerCommand` | not available in plugin API |
| Notify user | `ctx.ui.notify(msg, level)` | `client.tui.showToast({ body: { message, variant } })` |
| Log | `console.log` | `client.app.log({ body: { service, level, message, extra } })` |

**Key implication:** opencode has no way to truly unregister a tool at runtime. The plugin always registers `web_search`; gating happens by returning early from `execute()` with a friendly message. This is by design — it keeps the tool discoverable and lets `WEB_SEARCH_FORCE=on` flip behavior instantly.

---

## Sharing across machines

### Via dotfiles repo

```bash
# In your dotfiles repo
cp web-search.ts ~/.dotfiles/opencode/plugins/web-search.ts
cp .env.example  ~/.dotfiles/opencode/.env.example

# Symlink into place
ln -s ~/.dotfiles/opencode/plugins/web-search.ts ~/.config/opencode/plugins/web-search.ts
```

### Via npm

Publish as a package and add to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@yourname/opencode-web-search"]
}
```

opencode auto-installs npm plugins via Bun at startup.

---

## Troubleshooting

### TUI window starts but is completely empty / hangs on startup

This occurs if a plugin blocks the opencode bootstrap loading sequence. In the plugin registration phase, the plugin loader blocks startup. Performing blocking async calls (like `await client.session.list()`) inside the plugin's main setup function will create a deadlock because the session manager is waiting for all plugins to load before starting.

**Solution:** Ensure you are using the latest version of `web-search.ts` where session pre-fetching is performed asynchronously as a non-blocking background promise (`.then` / `.catch` chain) rather than `await`ed.

### The tool runs but always returns "No results"

Check the API key. For Brave, a 401 typically means the key is wrong or the free-tier quota is exhausted. The plugin logs `Brave API 401: ...` via `client.app.log`.

### The tool never runs on a local model

The provider ID doesn't match any pattern. Check the logs for `provider: <value>` and either:

- Add the pattern to `LOCAL_PATTERNS`, or
- Set `WEB_SEARCH_FORCE=on` to bypass detection entirely.

### Toasts don't appear

You're likely running opencode via the SDK or as a server (no TUI). Toasts require the TUI. The state transition is still logged.

### Both backends fail

Verify at least one key is set. On startup, the plugin logs:

```
plugin loaded — brave=false serper=false
```

If both are false, no search can run.

### `.env` not being picked up

The loader searches three locations in order:

1. Plugin file's own directory
2. `~/.config/opencode/.env`
3. Current working directory

Make sure your `.env` is in one of these. Shell exports (`~/.zshrc`) always win, so unset any conflicting exports if you want `.env` to take effect.

---

## Comparison with the pi version

This plugin is a port of [`mypbs/pi-search-plugin`](https://github.com/mypbs/pi-search-plugin). Behavior parity:

- Same dual-backend fallback (Brave → Serper)
- Same local model auto-detection (extended with `llamacpp`, `vllm`, `exo`)
- Same `.env` loader (zero-dep, additive)
- Same result formatting + truncation

Differences forced by the opencode plugin API:

- No slash commands (`/search`, `/search-status`, etc.) — opencode has no plugin API for these. Use the tool directly or check logs for status.
- Tool is always registered (no `setActiveTools` equivalent). Gating happens in `execute()`.
- `WEB_SEARCH_FORCE` env var replaces the `/search-force` slash command.
- Status diagnostics live in opencode's log stream (filtered by `service: web-search`).
