# fileops backend boundary

`fileops` owns the local file-operation workflow: `edit`, `read`, `search`,
`find`, `write`, hashline snapshots, grammar loading, and the copied OMP
hashline core.

The backend strategy is a narrow TypeScript adapter around the copied OMP core:

- the copied `hashline/` module stays runtime-agnostic;
- `CwdHashlineFilesystem` is the Pi-specific filesystem adapter;
- tool definitions translate Pi tool calls into the core interfaces.

A Rust backend in `ct` or a separate binary remains possible behind the same
adapter boundary, but is not required for the current OMP hashline core because
the upstream implementation being copied is TypeScript.

## Explicit non-parity

The Pi adapter intentionally covers text-file workflow parity only: `read`,
`search`, `find`, `write`, and `edit` over local filesystem paths. OMP runtime
features that depend on services Pi does not expose here are not silently
emulated: archive reads/writes, SQLite table reads, notebook serialization,
generated-file guards, and LSP formatting/diagnostics are unsupported until a
dedicated adapter exists.
