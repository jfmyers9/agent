# Luan Agents Feature Decisions

Source reviewed: <https://github.com/luan/agents> at `0d5b340 feat(plannotator): add planning assistant skills` on 2026-05-14, focused on Pi and Codex config.

## Adopted now

| Feature                        | Where                                                           | Notes                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Pi keybindings                 | `harnesses/pi/keybindings.json`                                 | Emacs-style editor/session shortcuts and queueing.                                                                                      |
| Pi TUI icon/colors             | `harnesses/pi/tui.json`, `harnesses/pi/extensions/tui/`         | Luan's current footer/editor chrome is adopted with provider usage bars defaulted off to avoid `ct` dependency.                         |
| Pi quiet/model settings        | `harnesses/pi/settings.json`                                    | Quiet startup, terminal noise reduction, explicit Codex GPT model cycle.                                                                |
| Pi per-model effort            | `harnesses/pi/effort.json`, `harnesses/pi/extensions/effort.ts` | `/effort` persists model-specific thinking level.                                                                                       |
| Pi local context               | `harnesses/pi/extensions/agents-local/`                         | Loads untracked `AGENTS.local.md` / `CLAUDE.local.md` as both prompt text and structured context files.                                 |
| Pi clear command               | `harnesses/pi/extensions/clear.ts`                              | `/clear` and `ctrl+shift+l` fresh-session flow.                                                                                         |
| Pi Vim editor                  | `harnesses/pi/extensions/vim/`                                  | Luan's current Vim extension replaces the older local `pi-vim/` copy.                                                                   |
| Pi skill references            | `harnesses/pi/extensions/skillful/`                             | Replaces `skill-dollar`; supports `$skill-name`, autocomplete/highlighting, caching, and a `skill` tool while preserving `/skill:name`. |
| Pi Plannotator event guard     | `harnesses/pi/extensions/plannotator-events/`                   | Prevents stale duplicate Plannotator event listeners across reloads.                                                                    |
| Pi Git workflow hints          | `harnesses/pi/extensions/git-tool/`                             | Adds repo-configured Graphite/Git-Spice/current-branch prompt guidance and skill resource discovery.                                    |
| Pi prompt stash/history        | `harnesses/pi/extensions/prompt-storage/`                       | Local-only prompt draft stash/history with non-`ctrl+s` shortcuts.                                                                      |
| Pi custom system prompt        | `harnesses/pi/extensions/system-prompt/`                        | Renders a tested Mustache prompt using current cwd, tools, context files, skills, date, and timezone.                                   |
| Pi token burden report         | `harnesses/pi/extensions/token-burden/`                         | Inspects session token categories and skill/tool burden without adopting Luan's broader `ct` stack.                                     |
| Pi spawn lanes                 | `harnesses/pi/extensions/spawn/`                                | Adds `/spawn`, `spawn_lane`, `spawn_list`, and `spawn_map` for bounded parallel Pi/shell/command lanes.                                 |
| Pi task extension without `ct` | `harnesses/pi/extensions/tasks/`                                | Keeps local blueprint-linked project tasks, HUD, board, and worktree lanes rather than Luan's `ct task` backend.                        |
| Pi Context7 docs lookup        | `npm:@dreki-gg/pi-context7@0.1.9`                               | Reviewed pinned docs lookup tools with optional API key and local cache.                                                                |
| Pi Lens tools                  | `npm:pi-lens`                                                   | Keeps current AST/LSP/code-intelligence package instead of porting `ct`/`sym`.                                                          |
| Codex queue/status ergonomics  | `harnesses/codex/config.toml`                                   | Plan-mode reasoning, `alt-enter` queue, status-line fields.                                                                             |
| Codex lightweight hooks        | `harnesses/codex/hooks.json`, `harnesses/codex/hooks/`          | Source/Graphite reminders and raw Git footgun blocking without `ct`/mux.                                                                |

## Adapted from Luan, not copied wholesale

| Feature                | Decision                     | Adaptation                                                                                                                                                                                         |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider usage bars    | Adopted with safe default    | Luan's `tui` command exists, but `usageBars.visible` defaults to `false` so missing `ct` does not break normal Pi startup. Existing no-`ct` quota behavior should be merged separately if desired. |
| Plannotator package    | Adopted with skills disabled | `@plannotator/pi-extension` is installed as a package object with `skills: []` so shared skills remain repo-controlled.                                                                            |
| Git workflow extension | Adopted                      | Runtime mode is controlled by `git config agents.git-tool`, with this repo using Graphite guidance locally.                                                                                        |
| Prompt storage         | Adopted with local shortcuts | Keeps `alt+s`, `ctrl+alt+s`, and `ctrl+r` rather than Luan's `ctrl+s` stash default.                                                                                                               |
| Spawn helper code      | Adopted narrowly             | Copies only spawn-required tokenizer/lane-placement helpers, not the full `exec-command` replacement tool.                                                                                         |
| Package/test metadata  | Adopted narrowly             | Adds Bun/TypeScript validation for selected Pi extensions without adopting Luan's `just`, `stow`, `ct`, `sym`, or Rust workspace.                                                                  |

## Rejected or deferred

| Feature                                                | Decision                     | Rationale                                                                              | Dependencies / risk                                            | Follow-up question                               |
| ------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| Codex `approval_policy = never` + `danger-full-access` | Rejected                     | Current shared config keeps explicit approval and workspace sandbox safety.            | Higher blast radius for mistaken tool calls.                   | Separate local-only unsafe profile?              |
| User-specific paths/env                                | Rejected                     | Shared config must stay portable.                                                      | Hardcoded home directories, usernames, project trust paths.    | None.                                            |
| `ct` / `sym` / just / stow architecture                | Rejected as wholesale copy   | Too large and overlaps `bin/blueprint`, `pi-lens`, and shell installer architecture.   | Rust CLI/toolchain, MCP servers, install automation migration. | Evaluate selected `ct` capabilities separately?  |
| Luan `ct` task backend                                 | Rejected for shared default  | Blueprints plus local JSON tasks are already portable and worktree-scoped.             | Would regress no-`ct` task tools.                              | Revisit only if task store limitations appear.   |
| Pi/Codex Lens via `ct` hooks                           | Deferred                     | Current Pi uses `npm:pi-lens`; parity should extend `pi-lens` or blueprint checks.     | `ct hook lens-*`, Lens DB, lifecycle hooks.                    | Investigate `pi-lens` parity first.              |
| Codex MCP `lens` / `fff`                               | Deferred                     | Missing backends and not config-only.                                                  | MCP servers, FFF binaries, per-tool approvals.                 | Which servers justify dependencies?              |
| FFF Pi tools                                           | Deferred                     | Tool semantics and dependency surface need validation.                                 | Replaces grep/find behavior.                                   | Compare with current rg/ast/lsp workflow.        |
| mux sidebar                                            | Rejected for now             | Requires an external tmux/mux workflow not present here.                               | `mux` binary, tmux pane state, notifications.                  | Revisit only if mux becomes local workflow.      |
| Pi web-access tools                                    | Deferred/rejected by default | Broad network/API-key/cookie surface.                                                  | Search providers, browser/cookie access, content fetchers.     | Which web sources are needed beyond Context7?    |
| Codex live web search                                  | Deferred                     | Cached search is safer/cheaper default.                                                | More network use and changing results.                         | Explicit local profile?                          |
| Codex image generation / memories / multi-agent        | Deferred                     | Not required for core coding workflow.                                                 | Provider feature flags/data retention.                         | Which feature has a concrete coding use case?    |
| Codex plugins / marketplaces                           | Deferred                     | Requires plugin install/update infrastructure and overlaps skills.                     | Marketplace trust, local packaging.                            | Graphite plugin vs existing skills?              |
| Pi custom pretty transcript renderer                   | Deferred                     | Footer/editor chrome is enough for now; transcript overrides are high-conflict.        | Rendering compatibility and extension composition.             | Revisit if footer/editor chrome is insufficient. |
| Pi Catppuccin/Oh Pi themes                             | Optional/deferred            | Visual preference.                                                                     | Third-party theme package.                                     | Theme package or local theme JSON?               |
| Pi subagents/mosaic package                            | Rejected for shared workflow | Current rules prefer blueprints and explicit tasks over native subagent orchestration. | Hidden durable state and orchestration complexity.             | Blueprint-compatible design first.               |
| Pi VCC package                                         | Deferred                     | Workflow value unknown.                                                                | Third-party/local config.                                      | What concrete VCC behavior is desired?           |
| Pi Codex-native compaction/image/web rewrites          | Deferred                     | Heavy provider-specific changes; current compaction/retry remains.                     | Native OpenAI/Codex payload rewriting and custom artifacts.    | Are current compactions failing?                 |
| Pi apply_patch / exec_command / ask / dynamic-tools    | Deferred                     | Changes core tool semantics and model interaction patterns.                            | Custom tools/rendering, conflicts with built-ins.              | Evaluate each as a separate vertical change.     |
| Generated `GLOBAL_AGENTS.md`                           | Deferred                     | Current explicit `AGENTS.md` is simpler.                                               | Render/validation automation.                                  | Is template drift recurring?                     |
| `loop` prompt scheduler                                | Rejected by default          | Repeated autonomous prompts can surprise or run away.                                  | Timers, queued prompts, long-lived actions.                    | Only for bounded monitoring use case.            |

## Follow-up spec candidates

- `prompt history retention/redaction controls`
- `Pi Git workflow guard/status without ct`
- `Selected Pi tool semantics review: apply_patch, exec_command, dynamic-tools, ask`
- `pi-lens / blueprint diagnostics parity without ct`
- `Codex plugin and MCP adoption`
- `No-ct provider quota bars inside adopted tui extension`
