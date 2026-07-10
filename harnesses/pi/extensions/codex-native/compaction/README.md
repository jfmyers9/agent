# OpenAI Native Compaction Pi Extension

Vendored from [`jordyvandomselaar/pi-openai-compaction`](https://github.com/jordyvandomselaar/pi-openai-compaction) under the MIT license.

Local notes:

- Kept as a submodule of the local `codex-native` Pi extension under `pi/agent/extensions/codex-native/compaction/`.
- Settings use the upstream `openaiNativeCompaction` key and `PI_OPENAI_NATIVE_COMPACTION_` environment overrides.
- Local edits keep debug artifact failures fail-open and use portable temporary paths in tests.
