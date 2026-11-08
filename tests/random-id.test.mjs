import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const directory = await mkdtemp(join(tmpdir(), "jff-random-id-"));
after(() => rm(directory, { recursive: true, force: true }));
const source = await readFile(new URL("../app/lib/random-id.ts", import.meta.url), "utf8");
await writeFile(join(directory, "random-id.mjs"), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const { randomId } = await import(pathToFileURL(join(directory, "random-id.mjs")));
function mockCrypto(t, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value });
  t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
}

test("record IDs use native randomUUID when the browser provides it", t => {
  const native = "978c455c-9549-4340-95ac-28deaa78fa41";
  mockCrypto(t, { randomUUID: () => native, getRandomValues: () => { throw new Error("Native UUID should be preferred."); } });
  assert.equal(randomId(), native);
});

test("local HTTP browsers without randomUUID create UUIDv4 IDs from cryptographic random bytes", t => {
  let calls = 0;
  mockCrypto(t, { getRandomValues: bytes => {
    assert.ok(bytes instanceof Uint8Array); assert.equal(bytes.length, 16);
    return bytes.fill(calls++ === 0 ? 255 : 0);
  } });
  assert.equal(randomId(), "ffffffff-ffff-4fff-bfff-ffffffffffff");
  assert.equal(randomId(), "00000000-0000-4000-8000-000000000000");
  assert.equal(calls, 2, "Each record needs fresh cryptographic randomness.");
});
