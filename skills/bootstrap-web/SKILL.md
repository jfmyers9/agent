---
name: bootstrap-web
description: >
  Scaffold an opinionated SvelteKit web project with Bun, Tailwind, Cloudflare,
  D1, and passkey authentication. Invoke explicitly when starting a new web app
  from scratch.
argument-hint: "<project-name-or-path> [description]"
user-invocable: true
disable-model-invocation: true
---

# Bootstrap Web

Create a working SvelteKit starter after verifying the current ecosystem and
the user's visual direction.

@rules/harness-compat.md applies.

## Arguments

- `<project-name-or-path>` — required target. Resolve a bare name under
  `~/src/`; honor an explicit path exactly.
- `[description]` — optional product purpose and design context.

Ask for a target when missing. Reuse description and design details already in
the request instead of asking for them again. Inspect an existing target before
writing; never replace a non-empty directory without explicit approval.

## Fixed Preferences

Do not research substitutes for these choices:

| Layer | Choice |
| ----- | ------ |
| Framework | SvelteKit with Svelte 5 runes |
| Language | strict TypeScript |
| Package manager | Bun, never npm or pnpm |
| Styling | Tailwind CSS through its Vite plugin; no `tailwind.config.*` |
| Color | OKLCH tokens in CSS custom properties |
| Theme | class-based, dark-first design |
| Hosting | Cloudflare using its currently supported SvelteKit runtime |
| Database | Cloudflare D1 (SQLite) |
| Authentication | WebAuthn passkeys |
| Tests | Vitest |
| Build | Vite |

## Workflow

### 1. Inspect The Environment

Read applicable project instructions and inspect the target, parent directory,
available CLIs, and existing local-development conventions. Keep unrelated
files intact. Do not initialize or overwrite an existing application unless the
user clearly asked to adopt it.

### 2. Verify Evolving Choices

Before writing files, consult current official documentation, package metadata,
and CLI help. Do not rely on remembered flags, configuration shapes, or package
versions. Determine:

1. the supported non-interactive SvelteKit scaffold flow;
2. the current Cloudflare deployment model, adapter, Wrangler configuration,
   and D1 binding flow, including whether Pages or Workers is supported;
3. the smallest maintained D1 access layer appropriate for the app;
4. the maintained WebAuthn server/browser packages and runtime requirements;
5. the current Tailwind and Vitest integration; and
6. optional UI, icon, class-composition, and animation packages only when the
   requested interface needs them.

Prefer official support, active maintenance, Svelte 5 compatibility, and fewer
dependencies. Let the official scaffold and Bun resolve current versions; do
not guess or manually pin versions. Retain the generated Bun lockfile.

Summarize consequential decisions briefly. Ask the user only when multiple
viable choices would materially change the product; proceed on clear technical
winners.

### 3. Register Local Routing

Use the documented local dev-routing helper when available. Otherwise, search
the repository and dotfiles for the documented routing command; do not invent
one. Register the target name and capture its assigned port and
`https://<project>.localhost` origin.

Store local values in the gitignored environment file. Configure Vite to read
the assigned port through the mechanism supported by the current Vite docs;
never hardcode it. Use the local URL as the WebAuthn origin. If the routing
infrastructure is unavailable, stop and report the missing setup rather than
creating a partially configured app.

### 4. Resolve Visual Direction

Infer as much as possible from the product description. In one compact prompt,
ask only for missing choices that materially affect the design:

- tone or personality;
- color temperature, saturation, and any required brand colors; and
- typography direction.

Honor "surprise me" by choosing a coherent direction. Build an accessible,
responsive interface with a deliberate type system, generous spacing, a
dominant OKLCH palette plus restrained accents, and visible focus states. Avoid
generic default typography and cookie-cutter layouts. Set the initial document
theme to dark while keeping the token model ready for a light theme.

### 5. Scaffold And Configure

Use the official scaffold in non-interactive mode when its current help shows
flags that satisfy the fixed preferences. Otherwise create the smallest valid
SvelteKit project manually. Do not guess CLI flags.

Install only the dependencies selected above with `bun add` or `bun add -d`.
Configure from current package documentation rather than copying a frozen
template:

- strict SvelteKit TypeScript and Svelte 5 runes;
- SvelteKit and Tailwind Vite plugins;
- the current Cloudflare adapter/runtime and Wrangler configuration;
- a D1 binding, local migration workflow, and placeholder for the deployed
  database identifier;
- Vitest with the minimum environment needed by the tests; and
- package scripts for development, checking, testing, building, and deployment.

Keep the deployment script consistent with the selected current Cloudflare
model. Do not mix Pages commands with Workers configuration or vice versa.

### 6. Build The Starter

Create a coherent, minimal vertical slice:

- app shell, global Tailwind CSS, favicon, root layout, and designed home page;
- OKLCH semantic tokens for background, foreground, surfaces, actions,
  borders, inputs, rings, and destructive states;
- D1 schema and migrations for users, passkey credentials, and sessions;
- runtime-safe database access for local development and Cloudflare;
- complete WebAuthn registration, authentication, logout, and session flows;
- at least one reusable button or action primitive consistent with the chosen
  component approach; and
- focused tests for security-sensitive behavior and important boundaries.

Follow the chosen libraries' current server/browser APIs. Validate WebAuthn
origin and RP ID, protect challenges against tampering, expiry, and replay, and
use secure session-cookie defaults with a documented finite lifetime. Keep
secrets server-only. Do not ship a production fallback secret or silently
weaken authentication in development.

### 7. Finish Local Configuration

Create a `.gitignore` that excludes dependencies, generated output, local
Cloudflare/D1 state, local databases, and environment files while retaining
`.env.example`. Document only the environment variable names and safe example
values needed by the selected implementation, including the assigned dev port,
WebAuthn RP ID and origin, and challenge/session secret.

Create the gitignored local environment file with the routing values and a
generated development secret. Leave production database creation, IDs, and
secrets as explicit deployment tasks.

### 8. Verify

Run the project's actual scripts after dependency installation. At minimum:

1. generate/sync framework types when required;
2. run the Svelte/TypeScript check;
3. run focused tests and the full Vitest suite; and
4. build for the selected Cloudflare target.

Fix failures introduced by the scaffold. Do not report completion with type,
test, or build failures. If an external Cloudflare resource is the only missing
piece, verify everything possible locally and state the exact remaining command
or value.

## Completion

Report the target path, local URL, start command, selected packages and
deployment model, verification results, and remaining Cloudflare setup. Remind
the user to configure real production secrets without displaying secret values.
