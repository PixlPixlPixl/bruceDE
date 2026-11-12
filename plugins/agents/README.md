# Agent plugins

One folder per agent CLI. Each is **data only**: a `plugin.json` with
`"entrypoints": {}` and a `contributes.agents` entry, plus a `package.json` so npm's
workspace linking sees it. No source, no build, no trust prompt — the host reads the
manifest at discovery time and never imports code.

They live in this subfolder rather than next to the feature plugins because the list
grows: `terminal/`, `git/`, `projects/` stay legible while agents accumulate here.
Discovery descends exactly one grouping level (`MAX_GROUPING_DEPTH` in
`workspace-core/src/node/plugin-discovery.ts`), and a folder that holds its own
`plugin.json` is a plugin, so `src/` or `dist/` inside one can never be mistaken for
another.

| Folder | Plugin id | Agent | Command |
|---|---|---|---|
| `pi/` | `icebox.agent-pi` | Pi | `pi --mode rpc --no-session` (native RPC mode) |
| `gemini/` | `icebox.agent-gemini` | Gemini CLI | `gemini --experimental-acp` (native ACP flag) |
| `claude-code/` | `icebox.agent-claude-code` | Claude Code | `claude-code-acp` (ACP adapter for `claude`) |
| `opencode/` | `icebox.agent-opencode` | OpenCode | `opencode acp` (native ACP mode) |
| `codex/` | `icebox.agent-codex` | Codex | `codex-acp` (ACP adapter for `codex`) |

Only Pi is verified end to end in this repository; the others are declared from each
CLI's documented interface and cannot be tested without the binary installed. A
missing binary is not an error: the picker lists the agent as **Not installed**, so
the declaration is the whole failure mode. Where a CLI has no ACP mode of its own
(Codex, Claude Code), the command names the adapter rather than the CLI, because
spawning the CLI would only fail the ACP handshake.

Adding an agent: copy a folder, change `plugin.json` (`id`, `name`, `command`,
`args`, `protocol`), and it appears after the plugin manager's **Refresh**. A
user-level one goes in `~/.icebox/plugins/agents/<name>/` and asks for trust first,
because declaring a command means spawning it. `ICEBOX_AGENTS` still overrides the
whole catalogue for a one-off run.

Protocol limits are the orchestrator's, not the manifest's: `acp` and `pi-rpc` are
stdio drivers, `agui` needs an HTTP endpoint and is only for agents that already
serve one (see `plugins/README.md`).
