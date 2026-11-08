import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localCredentials, secureSchemaCheckArgs, parseSecureServerArgs, secureServerArgs } from "../tools/secure-local-server.mjs";

test("secure launcher accepts only explicit private hosts and local names with HTTPS defaults", () => {
  assert.deepEqual(parseSecureServerArgs([]), { name: "ragchef.local", host: undefined, port: 3443, help: false });
  for (const args of [["--name"], ["--name=example.com"], ["--name=*.local"], ["--name=x.local", "--name=y.local"], ["--host", "0.0.0.0"], ["--port", "0"], ["--remote"]]) assert.throws(() => parseSecureServerArgs(args));
  const args = secureServerArgs({ address: "192.168.1.20", port: 3443, name: "kitchen.local", tls: { cert: "/tmp/public.pem", key: "/tmp/private.pem" }, passwordHash: "a".repeat(64) });
  for (const pair of [["--local-protocol", "https"], ["--ip", "192.168.1.20"], ["--inspector-ip", "127.0.0.1"], ["--https-key-path", "/tmp/private.pem"]]) assert.equal(args[args.indexOf(pair[0]) + 1], pair[1]);
  assert.ok(args.includes("RAG_CHEF_LAN_AUTH:1")); assert.ok(args.includes("RAG_CHEF_HOSTED:0"));
  assert.ok(args.includes("RAG_CHEF_LAN_ORIGINS:https://kitchen.local:3443,https://192.168.1.20:3443"));
});

test("shared login stays private and stable across launches; process arguments use only its hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chef-secure-login-"));
  try {
    const first = await localCredentials(directory), next = await localCredentials(directory);
    const login = JSON.parse(await readFile(first.path, "utf8"));
    assert.deepEqual(first, next); assert.equal(login.username, "chef"); assert.match(login.password, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(first.hash, createHash("sha256").update(`chef:${login.password}`).digest("hex"));
    assert.equal((await stat(directory)).mode & 0o777, 0o700); assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    const args = secureServerArgs({ address: "192.168.1.20", port: 3443, name: "ragchef.local", tls: { cert: "cert", key: "key" }, passwordHash: first.hash });
    assert.ok(!args.join(" ").includes(login.password));
    await rm(first.path); await symlink("/dev/null", first.path);
    await assert.rejects(localCredentials(directory), /invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an explicitly configured username and six-character test password are reused without regeneration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chef-configured-login-"));
  const login = { username: "admin", password: "N6!qZ2" };
  try {
    const path = join(directory, "credentials.json");
    await writeFile(path, JSON.stringify(login), { mode: 0o600 });
    const first = await localCredentials(directory), next = await localCredentials(directory);
    assert.deepEqual(first, next);
    assert.equal(first.hash, createHash("sha256").update(`${login.username}:${login.password}`).digest("hex"));
    assert.notEqual(first.hash, createHash("sha256").update(`chef:${login.password}`).digest("hex"));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), login);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const args = secureServerArgs({ address: "192.168.1.20", port: 3443, name: "ragchef.local", tls: { cert: "cert", key: "key" }, passwordHash: first.hash });
    assert.ok(!args.join(" ").includes(login.password));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("configured local credentials reject empty, control-character and out-of-bounds values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chef-invalid-login-"));
  try {
    const path = join(directory, "credentials.json");
    const cases = [
      { username: "", password: "N6!qZ2" }, { username: "admin\n", password: "N6!qZ2" }, { username: "ad min", password: "N6!qZ2" }, { username: "ad:min", password: "N6!qZ2" }, { username: "a".repeat(65), password: "N6!qZ2" },
      { username: "admin", password: "" }, { username: "admin", password: "short" }, { username: "admin", password: "line\nbreak" }, { username: "admin", password: "line\rbreak" }, { username: "admin", password: "nul\u0000value" }, { username: "admin", password: "a".repeat(129) },
    ];
    for (const login of cases) {
      await writeFile(path, JSON.stringify(login), { mode: 0o600 });
      await assert.rejects(localCredentials(directory), /invalid/i);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), login, "Invalid saved credentials must not be silently replaced");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("secure launcher checks session schema without applying migrations or querying credentials", () => {
  const args = secureSchemaCheckArgs();
  assert.ok(args.includes("--local")); assert.ok(!args.includes("--remote"));
  const query = args[args.indexOf("--command") + 1];
  assert.match(query, /FROM local_auth_sessions LIMIT 0/); assert.match(query, /FROM local_auth_attempts LIMIT 0/);
  assert.ok(!/INSERT|UPDATE|DELETE|CREATE|ALTER/.test(query));
});
