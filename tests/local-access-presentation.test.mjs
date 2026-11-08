import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const dir = await mkdtemp(join(tmpdir(), "jff-local-access-"));
after(() => rm(dir, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
for (const [folder, name, extension] of [["components", "LocalDeviceAccess", "tsx"], ["lib", "app-session", "tsx"], ["lib", "private-storage", "ts"]]) {
  const source = await readFile(new URL(`../app/${folder}/${name}.${extension}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/"(react(?:\/jsx-runtime)?)"/g, (_, module) => JSON.stringify(pathToFileURL(require.resolve(module)).href))
    .replace(/"\.{1,2}\/(?:lib\/)?([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(dir, `${name}.mjs`), compiled);
}
const { LocalDeviceAccessDetails } = await import(pathToFileURL(join(dir, "LocalDeviceAccess.mjs")).href);
const expiresAt = "2026-11-04T12:00:00.000Z";
const protectedSession = remembered => ({ mode: "local", authenticated: true, localServer: { requiresPassword: true, origins: ["https://other-private-address.test"] }, localAccess: { sessionId: "private-session-scope", expiresAt, remembered } });
const render = (session, props = {}) => renderToStaticMarkup(createElement(LocalDeviceAccessDetails, { session, signOut() {}, origin: "https://kitchen.local:3443", ...props }));

test("device access distinguishes remembered and twelve-hour sign-ins without exposing scope or other addresses", () => {
  for (const remembered of [false, true]) {
    const html = render(protectedSession(remembered));
    assert.match(html, remembered ? /Remembered on this browser/ : /12-hour sign-in/);
    assert.match(html, remembered ? /up to 30 days/ : /up to 12 hours/);
    assert.match(html, /datetime="2026-11-04T12:00:00.000Z"/i);
    assert.match(html, /UTC/);
    assert.match(html, /https:\/\/kitchen.local:3443/);
    assert.match(html, /different kitchen address needs its own sign-in/);
    assert.match(html, /Sign out of this device/);
    assert.doesNotMatch(html, /private-session-scope|other-private-address/);
  }
});

test("expiry uses the supplied browser timezone while the initial render has a stable UTC fallback", () => {
  const session = protectedSession(false);
  const utc = render(session);
  assert.match(utc, /12:00 PM UTC/);
  assert.match(render(session, { timeZone: "America/Los_Angeles" }), /4:00 AM PST/);
  assert.equal(render(session, { timeZone: "not-a-timezone" }), utc);
});

test("missing or invalid session details never show a fabricated expiry or remembered state", () => {
  for (const localAccess of [undefined, { sessionId: "scope", expiresAt: "invalid", remembered: false }]) {
    const html = render({ ...protectedSession(false), localAccess });
    assert.match(html, /end time is unavailable/);
    assert.doesNotMatch(html, /<time|Invalid Date|Remembered on this browser/);
  }
  const plain = render({ mode: "local", authenticated: true });
  assert.match(plain, /Your local kitchen/);
  assert.doesNotMatch(plain, /<time|Sign out|sign-in end time|Remembered/);
  assert.equal(render({ mode: "local", authenticated: false, localServer: { requiresPassword: true } }), "");
  assert.equal(render({ mode: "hosted", authenticated: true }), "");
});
