# opencode-discord-presence (OpenCode V2)

[![npm version](https://img.shields.io/npm/v/@yushi_61/opencode-discord-presence.svg)](https://www.npmjs.com/package/@yushi_61/opencode-discord-presence)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Display your current OpenCode session status in Discord Rich Presence. Show which AI agent you're using, the current model, prompt/file activity, and more.

> ### About this fork
>
> This repository is the **official home of OpenCode V2 support** for Discord Rich Presence.
> OpenCode V2 replaced the V1 plugin contract (`{ id, server }` hook objects are no longer
> executed), and [the original plugin](https://github.com/Puri12/opencode-discord-presence)
> is V1-only — the upstream maintainer has pointed V2 users at a fork. This fork ships a
> **dual V1/V2 package** built from one source tree, published to npm as
> [`@yushi_61/opencode-discord-presence`](https://www.npmjs.com/package/@yushi_61/opencode-discord-presence).
>
> All original code, design, documentation, and tests belong to
> [Puri12/opencode-discord-presence](https://github.com/Puri12/opencode-discord-presence) (MIT) —
> see [Credits](#credits). The V2 adapter is adapted from the V2 port contributed by
> [Muhammad Rheza Alfin (vheins)](https://github.com/vheins) in
> [Puri12/opencode-discord-presence#14](https://github.com/Puri12/opencode-discord-presence/pull/14).
> This fork follows upstream, so V1 users can use it too.

<img width="293" height="119" alt="image" src="https://github.com/user-attachments/assets/879207e0-4759-477d-ba34-f79f927737bd" />


## Features

- **Real-time agent display** - Shows which AI agent (Claude, Prometheus, etc.) you're currently using
- **Model information** - Displays the active model (Claude Sonnet, GPT-4, etc.)
- **Discord elapsed timer** - Presence includes a Discord start timestamp so elapsed coding time appears in the client timer UI
- **Localization** - English (default) and Korean (`language: "ko"`), with correct particle selection for agent names
- **Idle detection** - Automatically shows when you're taking a break
- **Live File Spotlight** - Shows the file currently being edited, read, or diagnosed by the agent, with language-specific Discord icons
- **Task Mission Board** - Displays active todo progress with task labels and completion counts (e.g., "Implementing dark mode (2/5)") — **V1 only**: OpenCode V2 removed the `todowrite` tool this card is driven by
- **Diagnostics placeholder support** - Keeps the diagnostics display surface reserved for future/external integrations; current OpenCode plugin API v1 logs diagnostics events but does not expose counts (see [limitations](#limitations))
- **Smart rotation** - Critical states (errors, idle, all-done) pin; informational cards (file spotlight, mission board, session stats) rotate every 20 seconds by default
- **Session recap** - When a session ends, a recap card shows total prompts and files touched for 30 seconds
- **Auto-clear on exit** - Presence disappears within ~10 seconds of closing every OpenCode client (TUI / web); Linux only, tunable via `richPresence.autoClearSeconds` (0 disables)

## Installation

One package supports both generations: **OpenCode V2** and **OpenCode V1**.

```bash
# Using bun
bun add @yushi_61/opencode-discord-presence

# Using npm
npm install @yushi_61/opencode-discord-presence

# Using pnpm
pnpm add @yushi_61/opencode-discord-presence
```

### OpenCode V2

V2 manages plugins itself:

```bash
opencode plugin add @yushi_61/opencode-discord-presence
```

Or pin it in `opencode.json(c)` — V2 uses the plural `plugins` key:

```jsonc
{
  "plugins": ["@yushi_61/opencode-discord-presence"]
}
```

### OpenCode V1

V1 uses the singular `plugin` key:

```json
{
  "plugin": ["@yushi_61/opencode-discord-presence"]
}
```

### How V2 support works

OpenCode V2 changed the plugin contract: the default export must be an
`{ id, setup }` definition and V1 hook objects are not executed at all. This
package ships a dual V1/V2 build from one source tree — `src/v2.ts` maps the V2
context, hooks, and events onto the existing presence engine, so the exact same
build works on both generations.

V2 differences worth knowing:

- V2 exposes no `client.app.log` equivalent; plugin diagnostics only appear with
  `OPENCODE_DISCORD_DEBUG=true`.
- V2 removed the `todowrite` tool, so the mission board / todo summary stays
  empty. Agent, model, file spotlight, idle, and recap rotation are unchanged.
- V2 renamed tool arguments (`path` instead of `filePath`) and tools
  (`shell`, `subagent`, `patch`); both naming schemes are handled.
- V2 loads a plugin once per project directory inside one server process. The
  adapter keeps a single shared presence engine with one Discord connection and
  exactly-once event handling, so parallel projects do not fight over the
  activity shown in Discord.
- V2 runs plugins inside the background *service*, which outlives the TUI.
  The plugin therefore auto-clears presence ~`autoClearSeconds` (default 8)
  after the last attached OpenCode client disconnects — i.e. within ~10s of
  quitting with Ctrl+C / Q — and restores it when you attach a client again.
  Detection reads Linux procfs (`/proc`); on macOS/Windows, or when the plugin
  does not run inside the server process, the watchdog is inert and presence
  persists until the service stops (the pre-0.8.2 behavior).

## Quick Start

Register the plugin in your `opencode.json`:

```json
{
  "plugin": ["@yushi_61/opencode-discord-presence"]
}
```

That's it! The plugin will automatically connect to Discord and display your session status.

> `opencode.json` only **registers** the plugin. All plugin settings live in `.discord-presence.json` or environment variables — see [Configuration](#configuration) below.
>
> On OpenCode V2 the key is `plugins` (plural) and package installs are managed with `opencode plugin add`.

## Configuration

Create a `.discord-presence.json` file in your project root (preferred) or home directory:

```json
{
  "enabled": true,
  "applicationId": "YOUR_DISCORD_APP_ID",
  "language": "ko",
  "richPresence": {
    "enableFileSpotlight": false,
    "enableMissionBoard": true,
    "rotationIntervalSeconds": 20,
    "mainAgentOnly": false,
    "autoClearSeconds": 8,
    "diagnostics": {
      "errorsOnly": true
    }
  }
}
```

> ⚠️ `enableFileSpotlight` is **off by default**: turning it on broadcasts the path of the file you're currently editing to anyone viewing your Discord profile. Only enable it if you're working on a public repo or don't mind that exposure.

Or use environment variables:

```bash
OPENCODE_DISCORD_ENABLED=true
OPENCODE_DISCORD_CLIENT_ID=YOUR_APP_ID
OPENCODE_DISCORD_LANGUAGE=ko
OPENCODE_DISCORD_DEBUG=true
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable or disable the plugin |
| `applicationId` | `string` | (built-in) | Custom Discord Application ID for your own branding |
| `language` | `string` | `"en"` | Display language (`"en"` or `"ko"`) |
| `debug` | `boolean` | `false` | Emit `[discord-presence]` lifecycle logs (connect / disconnect / failures). Off by default so nothing prints in your OpenCode console. |
| `richPresence.enableFileSpotlight` | `boolean` | `false` | Show the path of the file currently being edited/read. **Off by default for privacy** — Discord broadcasts your activity to anyone viewing your profile, so leaking working file paths can expose private repo internals. Enable explicitly if you're OK with that. |
| `richPresence.enableMissionBoard` | `boolean` | `true` | Show task mission board card |
| `richPresence.rotationIntervalSeconds` | `number` | `20` | How often informational cards rotate (10–60 seconds) |
| `richPresence.mainAgentOnly` | `boolean` | `false` | When `true`, only `chat.message` events from the **main** session (root, no `parentID`) update Discord presence; sub-agent / task sessions are filtered out so a background planner or explore agent does not flicker the user's profile. When `false`, every chat.message overwrites presence — last writer wins, but the orchestrator still tracks busy/idle across all sessions so the "idle" text appears only when every tracked session reports idle. |
| `richPresence.autoClearSeconds` | `number` | `8` | Seconds with **zero attached OpenCode clients** (TUI / web / desktop) before the Discord activity is cleared. Quitting the TUI closes its event-stream connection to the background service; this watchdog notices and clears presence ~this-many seconds later (plus a ≤2s poll interval) instead of leaving it stale forever. `0` disables. Requires Linux procfs — inert on macOS/Windows (see [limitations](#limitations)). |
| `richPresence.diagnostics.errorsOnly` | `boolean` | `true` | Reserved for future/external diagnostics integrations; inactive with current OpenCode plugin API v1 |

For backward compatibility, the parser also accepts `discordPresence.applicationId`, but new configs should use the top-level `applicationId` shown above.

### Where the plugin reads from

Each setting is resolved in this order — the first defined value wins:

1. **`<projectRoot>/.discord-presence.json`** — per-project config, lives next to your `opencode.json`. Recommended for project-specific tweaks (e.g. a Korean idle string for a Korean codebase).
2. **`~/.discord-presence.json`** — your global default, used by every OpenCode project.
3. **Environment variables** — `OPENCODE_DISCORD_ENABLED`, `OPENCODE_DISCORD_CLIENT_ID`, `OPENCODE_DISCORD_LANGUAGE`, `OPENCODE_DISCORD_DEBUG`. Convenient for one-off overrides (`OPENCODE_DISCORD_DEBUG=true opencode …`).
4. **Built-in defaults** — silent (`debug: false`), English, shared Discord App ID.

> `opencode.json` itself is **not** a config source for this plugin. Putting `discordPresence: { … }` inside `opencode.json` will not be picked up; use `.discord-presence.json` instead. (The shared OpenCode schema does not allow plugin-specific fields, so this keeps your `opencode.json` valid.)

### Per-project example

```bash
# In any OpenCode project, alongside opencode.json:
cat > .discord-presence.json <<'JSON'
{
  "language": "ko",
  "debug": false,
  "richPresence": {
    "rotationIntervalSeconds": 15
  }
}
JSON
```

Restart OpenCode and the new settings take effect on the next chat message.

## Custom Discord Application

For custom branding (your own images and app name):

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to "Rich Presence" → "Art Assets"
4. Upload your images (at least one named `opencode-logo`)
5. Copy the Application ID from "General Information"
6. Add it to your config:

```json
{
  "applicationId": "YOUR_APPLICATION_ID"
}
```

## How It Works

The plugin hooks into OpenCode's event system:

- **chat.message** - Updates presence when you send/receive messages, tracking the current agent and model
- **tool.execute.before** / **tool.execute.after** - Captures file context and tool operation labels (edit, read, search, build, test, etc.)
- **file.edited** - Updates the live file spotlight with the edited file path and language icon
- **todo.updated** - Drives mission board progress with active task labels and completion counts
- **session.idle** - Triggers idle state with the last active task shown in the state line
- **session.deleted** - Triggers session recap showing total prompts and files touched for 30 seconds

> On OpenCode V2 the adapter subscribes to the equivalent V2 surfaces —
> `session.hook("prompt")`, `tool.hook("execute.before" / "execute.after")` and
> `ctx.event` — and translates them into the V1 event shapes above. V2 has no
> `todo.updated` event, so the mission board stays empty there.

### Limitations

- **lsp.client.diagnostics** is listened for, but error/warning counts are not available through the OpenCode plugin API v1. Diagnostic counts shown in presence require external LSP configuration. The plugin logs diagnostics events but does not fabricate counts.
- **Auto-clear on exit is Linux-only.** The plugin counts the TCP connections accepted by the OpenCode service process via procfs (`/proc/self/fd` + `/proc/net/tcp{,6}`) to detect attached clients; macOS and Windows have no procfs, so `autoClearSeconds` is inert there and presence persists until the service stops. "Zero listening sockets in this process" is treated as *unknown*, never as *zero clients*, so setups where the plugin does not run inside the server process (e.g. the V1 CLI) can never have their presence suppressed by mistake.

### Presence States

| State | English | Description |
|-------|---------|-------------|
| Active editing | `Working with {agent}` | File being edited |
| Active reading | `Working with {agent}` | File being read |
| Task active | `Working with {agent}` | With mission progress |
| Diagnostics error | `Working with {agent}` | Errors detected |
| Idle | `{agent} is idle` | No activity |
| Session complete | `Session Complete!` | Session ended (30s) |
| All tasks done | `All tasks complete!` | No pending tasks |

With `language: "ko"` the same states are rendered in Korean; the plugin picks the
correct particle for the agent name automatically based on whether it ends with a
consonant.

## Visual Sample Matrix

The following states are fully supported in v1 (runtime-backed):

| Condition | Headline | State line | Large image |
|-----------|----------|------------|-------------|
| Editing file | `Working with Claude` | `src/plugin.ts` | language icon |
| Reading file | `Working with Claude` | `src/services/discord-rpc.ts` | action-reading |
| Task active | `Working with Claude` | `Implementing dark mode (2/5)` | task |
| Diagnostics error | `Working with Claude` | `5 errors, 2 warnings` | state-error |
| Idle | `Claude is idle` | `Last task: Add theme toggle` | state-idle |
| Session recap | `Session Complete!` | `27 prompts • 3 files` | state-recap |
| All tasks complete | `All tasks complete!` | `5/5 finished` | state-complete |

Illustrative-only states (not implemented in v1):

| Condition | Headline | State line | Notes |
|-----------|----------|------------|-------|
| Night mode | `Burning the midnight oil` | `src/index.ts` | Not in v1 unless time-based config added |

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run tests in watch mode
bun test --watch

# Type check
bun run typecheck

# Lint
bun run lint

# Format
bun run format

# Build
bun run build
```

### Releases

Releases are published from CI with [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC — no `NPM_TOKEN` secret, and npm generates a provenance attestation automatically):

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then tag and create a GitHub release (`github.com/Yushi5058/opencode-discord-presence/releases/new`).
   That triggers `.github/workflows/publish.yml`, or run it manually with
   `gh workflow run publish.yml`.
3. The workflow type-checks, lints, tests, builds, and publishes the tarball to
   [`@yushi_61/opencode-discord-presence`](https://www.npmjs.com/package/@yushi_61/opencode-discord-presence).

## Architecture

```
src/
├── index.ts              # Main entry point & exports
├── plugin.ts             # OpenCode hook registration + presence engine
├── config.ts             # Configuration management
├── types/
│   └── index.ts          # TypeScript type definitions
├── services/
│   └── discord-rpc.ts    # Discord RPC service (hardened lifecycle)
├── state/
│   └── presence-state.ts # Instance-scoped presence snapshot + reducer
└── utils/
    ├── activity-rotation.ts # Precedence + rotation engine
    ├── file-label.ts        # Path sanitization + truncation
    ├── file-icons.ts        # Language → icon mapping
    ├── session-metrics.ts   # Session counters + recap
    ├── tool-label.ts        # Tool → operation label mapping
    └── particle.ts          # Korean particle handling
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details.

### Quick Contribution Guide

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Run tests (`bun test`)
4. Commit your changes (`git commit -m 'feat: add amazing feature'`)
5. Push to the branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

## Credits

This package is a fork of **[Puri12/opencode-discord-presence](https://github.com/Puri12/opencode-discord-presence)**
— the original Discord Rich Presence plugin for OpenCode. The presence engine, configuration
system, localization, Discord RPC service, tests, and the vast majority of this documentation
were written by [Puri12](https://github.com/Puri12) and contributors, and are reused here under
the MIT license.

- **Original project / source code:** [Puri12/opencode-discord-presence](https://github.com/Puri12/opencode-discord-presence) (MIT)
- **V2 adapter:** adapted from the OpenCode V2 port contributed by
  [Muhammad Rheza Alfin (vheins)](https://github.com/vheins) in
  [PR Puri12/opencode-discord-presence#14](https://github.com/Puri12/opencode-discord-presence/pull/14),
  maintained here for V2
- **V2 support maintained by:** [Yushi5058](https://github.com/Yushi5058)

If you only use OpenCode V1, the [original plugin](https://github.com/Puri12/opencode-discord-presence)
works and is the upstream source of most of this code. Fixes that apply to both generations are
welcome upstream; V2-specific work lives here.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [OpenCode](https://github.com/opencode-ai/opencode) - The AI coding assistant this plugin extends
- [Puri12/opencode-discord-presence](https://github.com/Puri12/opencode-discord-presence) - The original V1 plugin this fork is built on
- [@xhayper/discord-rpc](https://github.com/xhayper/discord-rpc) - Discord RPC library used by this plugin

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.
