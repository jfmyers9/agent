# Codex-native Pi extension

This opt-in extension currently provides OpenAI native compaction for
`openai-codex` and compatible Responses API providers. It is intentionally not
registered in `harnesses/pi/settings.json`, so installing this repository does
not change the configured provider, model, authentication, or compaction
behavior.

To evaluate it explicitly, add `extensions/codex-native/index.ts` to the Pi
`extensions` setting. Configuration is read from an `openaiNativeCompaction`
block in global or project Pi settings; defaults are in
`compaction/settings.json`.

The broader upstream extension also includes native web search, image
generation, and Codex Apps support. Those features are not included here
because they depend on a newer shared TUI/image stack and the upstream
freeform apply-patch provider.
