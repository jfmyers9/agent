import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Use the package's recorded source revision and normal Pi cache location.
const entry = createRequire(import.meta.url).resolve("@luan.sh/pi-code-mode");
const runtime = (await import(new URL("./host/binary.ts", pathToFileURL(entry)).href)) as {
	resolveCodeModeHostBinary(): Promise<string>;
};
console.log(`Code Mode runtime: ${await runtime.resolveCodeModeHostBinary()}`);
