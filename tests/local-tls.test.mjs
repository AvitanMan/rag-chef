import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ensureLocalTLS, mdnsArgs, validateLocalName } from "../tools/local-tls.mjs";

const exec = promisify(execFile);
const address = "192.168.1.20";

test("local HTTPS and mDNS names cannot become public names, shell arguments, or network-wide binds", () => {
  assert.equal(validateLocalName(), "ragchef.local");
  assert.equal(validateLocalName("kitchen-2.local"), "kitchen-2.local");
  for (const name of ["RagChef.local", "localhost", "ragchef.com", "x.y.local", "*.local", "-bad.local", "bad-.local", "x.local\n", "a".repeat(64) + ".local"]) assert.throws(() => validateLocalName(name));
  assert.deepEqual(mdnsArgs({ address, interfaceName: "en0" }), ["-i", "en0", "-P", "RAG Chef", "_https._tcp", "local.", "3443", "ragchef.local.", address, "path=/"]);
  for (const options of [{ address: "0.0.0.0" }, { address: "8.8.8.8" }, { address, port: 0 }, { address, port: "3443" }, { address, interfaceName: "--remote" }]) assert.throws(() => mdnsArgs(options));
});

test("local TLS creates a verified 90-day server chain and reuses the trusted CA across leaf changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rag-chef-tls-"));
  try {
    const first = await ensureLocalTLS({ directory, address });
    assert.equal(first.renewed, true);
    const ca = new X509Certificate(await readFile(first.caCert));
    const leaf = new X509Certificate(await readFile(first.cert));
    const caKey = join(dirname(first.caCert), "root-ca-key.pem");
    assert.equal(ca.ca, true);
    assert.equal(leaf.ca, false);
    assert.equal(leaf.checkHost("ragchef.local"), "ragchef.local");
    assert.equal(leaf.checkIP(address), address);
    assert.equal(leaf.checkHost("evil.example"), undefined);
    assert.equal(leaf.checkIP("192.168.1.21"), undefined);
    assert.equal(leaf.verify(ca.publicKey), true);
    assert.equal(leaf.checkPrivateKey(createPrivateKey(await readFile(first.key))), true);
    assert.ok(leaf.keyUsage.includes("1.3.6.1.5.5.7.3.1"));
    assert.equal(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom), 90 * 86_400_000);
    assert.equal(new X509Certificate(await readFile(first.caDer)).fingerprint256, first.fingerprint);
    assert.match((await exec("openssl", ["verify", "-CAfile", first.caCert, "-purpose", "sslserver", "-verify_hostname", "ragchef.local", "-verify_ip", address, first.cert])).stdout, /: OK/);
    for (const path of [first.key, caKey]) assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);

    const unchanged = await ensureLocalTLS({ directory, address });
    assert.equal(unchanged.renewed, false);
    assert.equal(new X509Certificate(await readFile(unchanged.cert)).fingerprint256, leaf.fingerprint256);
    const changed = await ensureLocalTLS({ directory, name: "dinner.local", address: "192.168.1.21" });
    assert.equal(changed.renewed, true);
    assert.equal(changed.fingerprint, first.fingerprint);
    const changedLeaf = new X509Certificate(await readFile(changed.cert));
    assert.equal(changedLeaf.checkHost("dinner.local"), "dinner.local");
    assert.equal(changedLeaf.checkIP("192.168.1.21"), "192.168.1.21");
    assert.equal(changedLeaf.checkHost("ragchef.local"), undefined);

    // A damaged leaf key is repaired without changing the CA that phones trust.
    await writeFile(changed.key, "invalid private key", { mode: 0o600 });
    const repaired = await ensureLocalTLS({ directory, name: "dinner.local", address: "192.168.1.21" });
    assert.equal(repaired.renewed, true);
    assert.equal(repaired.fingerprint, first.fingerprint);
    assert.equal(new X509Certificate(await readFile(repaired.cert)).checkPrivateKey(createPrivateKey(await readFile(repaired.key))), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("local TLS renews an expiring leaf and refuses to silently replace an incomplete or invalid CA", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rag-chef-tls-renew-"));
  try {
    const first = await ensureLocalTLS({ directory, address });
    const caKey = join(directory, "root-ca-key.pem"), csr = join(directory, "renew.csr"), extensions = join(directory, "renew.cnf");
    await exec("openssl", ["req", "-new", "-key", first.key, "-out", csr, "-subj", "/CN=ragchef.local"]);
    await writeFile(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:ragchef.local,IP:${address}\n`);
    await exec("openssl", ["x509", "-req", "-in", csr, "-CA", first.caCert, "-CAkey", caKey, "-set_serial", "2", "-days", "20", "-sha256", "-extfile", extensions, "-out", first.cert]);
    const renewal = await ensureLocalTLS({ directory, address });
    assert.equal(renewal.renewed, true);
    assert.equal(renewal.fingerprint, first.fingerprint);
    assert.ok(Date.parse(new X509Certificate(await readFile(renewal.cert)).validTo) > Date.now() + 89 * 86_400_000);
    const originalCA = await readFile(first.caCert);
    await writeFile(caKey, "invalid CA key", { mode: 0o600 });
    await assert.rejects(ensureLocalTLS({ directory, address }), /existing local CA is invalid/);
    assert.deepEqual(await readFile(first.caCert), originalCA);
    assert.equal(await readFile(caKey, "utf8"), "invalid CA key");
    await rm(caKey);
    await assert.rejects(ensureLocalTLS({ directory, address }), /local CA is incomplete/);
    assert.deepEqual(await readFile(first.caCert), originalCA);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
