import { execFile } from "node:child_process";
import { createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { isPrivateIPv4 } from "./local-server.mjs";

const exec = promisify(execFile);
const DAY = 86_400_000;

export function validateLocalName(name = "ragchef.local") {
  if (typeof name !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(name)) throw new Error("Use a lowercase local name such as ragchef.local.");
  return name;
}

export function mdnsArgs({ name = "ragchef.local", address, port = 3443, interfaceName }) {
  validateLocalName(name);
  if (!isPrivateIPv4(address)) throw new Error("The local certificate address must be a private IPv4 address.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The local HTTPS port must be from 1 to 65535.");
  if (interfaceName !== undefined && (typeof interfaceName !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(interfaceName))) throw new Error("Invalid network interface name.");
  return [...(interfaceName ? ["-i", interfaceName] : []), "-P", "RAG Chef", "_https._tcp", "local.", String(port), `${name}.`, address, "path=/"];
}

async function regularFile(path) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`Expected a regular certificate file: ${path}`);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function openssl(args, directory) {
  try { await exec("openssl", args, { cwd: directory, timeout: 60_000, maxBuffer: 128_000 }); }
  catch (error) {
    throw new Error(error.code === "ENOENT" ? "OpenSSL is required to prepare local HTTPS certificates." : "OpenSSL could not prepare the local HTTPS certificates. Existing CA files were preserved.");
  }
}

function matchingPrivateKey(cert, pem) {
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails.modulusLength >= 2048 && cert.checkPrivateKey(key);
  } catch { return false; }
}

function validAt(cert, now, remainingDays) {
  return Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) >= now + remainingDays * DAY;
}

async function readCA(caCert, caKey) {
  try {
    const cert = new X509Certificate(await readFile(caCert));
    if (!cert.ca || !validAt(cert, Date.now(), 90) || !cert.verify(cert.publicKey) || !matchingPrivateKey(cert, await readFile(caKey))) throw new Error();
    return cert;
  } catch {
    throw new Error("The existing local CA is invalid, expiring, or its key does not match. It was not replaced. Restore its files or deliberately set up a new certificate directory and trust its new CA on your devices.");
  }
}

async function validLeaf(certPath, keyPath, ca, name, address) {
  try {
    if (!await regularFile(certPath) || !await regularFile(keyPath)) return false;
    const cert = new X509Certificate(await readFile(certPath));
    return !cert.ca && validAt(cert, Date.now(), 30) && cert.verify(ca.publicKey)
      && cert.checkHost(name, { subject: "never", wildcards: false }) === name && cert.checkIP(address) === address
      && cert.keyUsage?.includes("1.3.6.1.5.5.7.3.1") && matchingPrivateKey(cert, await readFile(keyPath));
  } catch { return false; }
}

/** Prepares only local files. It never installs a CA in any operating-system trust store. */
export async function ensureLocalTLS({ directory, name = "ragchef.local", address }) {
  validateLocalName(name);
  if (!isPrivateIPv4(address)) throw new Error("The local certificate address must be a private IPv4 address.");
  if (typeof directory !== "string" || !directory.trim()) throw new Error("Choose a local certificate directory.");
  const target = resolve(directory);
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (!(await lstat(target)).isDirectory()) throw new Error("The local certificate directory must not be a symlink.");
  await chmod(target, 0o700);
  const lock = join(target, ".setup-lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Local certificate setup is already running. If it was interrupted, remove ${lock} after checking no setup process is active.`);
    throw error;
  }
  let stage;
  try {
    const caCert = join(target, "root-ca.pem"), caKey = join(target, "root-ca-key.pem"), caDer = join(target, "root-ca.cer");
    const cert = join(target, "server.pem"), key = join(target, "server-key.pem");
    // Never follow certificate-file symlinks or silently replace a partial CA.
    const caExists = await regularFile(caCert), keyExists = await regularFile(caKey);
    for (const path of [caDer, cert, key]) await regularFile(path);
    if (caExists !== keyExists) throw new Error("The local CA is incomplete. Restore both root-ca.pem and root-ca-key.pem; setup will not silently replace a trusted CA.");
    stage = await mkdtemp(join(target, ".prepare-"));
    await chmod(stage, 0o700);
    if (!caExists) {
      const config = join(stage, "ca.cnf");
      await writeFile(config, `[req]\nprompt = no\ndistinguished_name = subject\nx509_extensions = ca\n[subject]\nCN = RAG Chef Local CA\n[ca]\nbasicConstraints = critical, CA:TRUE, pathlen:0\nkeyUsage = critical, keyCertSign, cRLSign\nsubjectKeyIdentifier = hash\n`, { mode: 0o600 });
      await openssl(["req", "-new", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256", "-days", "3650", "-config", config, "-keyout", join(stage, "root-ca-key.pem"), "-out", join(stage, "root-ca.pem")], stage);
      await chmod(join(stage, "root-ca-key.pem"), 0o600);
      await rename(join(stage, "root-ca-key.pem"), caKey);
      await rename(join(stage, "root-ca.pem"), caCert);
    }
    await chmod(caKey, 0o600);
    const ca = await readCA(caCert, caKey);
    const renewed = !await validLeaf(cert, key, ca, name, address);
    if (renewed) {
      const pendingCert = join(stage, "server.pem"), pendingKey = join(stage, "server-key.pem"), csr = join(stage, "server.csr"), extensions = join(stage, "leaf.cnf");
      await writeFile(extensions, `basicConstraints = critical, CA:FALSE\nkeyUsage = critical, digitalSignature, keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = DNS:${name},IP:${address}\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid,issuer\n`, { mode: 0o600 });
      await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", pendingKey, "-out", csr, "-subj", `/CN=${name}`], stage);
      await chmod(pendingKey, 0o600);
      await openssl(["x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-set_serial", `0x${randomBytes(16).toString("hex")}`, "-days", "90", "-sha256", "-extfile", extensions, "-out", pendingCert], stage);
      if (!await validLeaf(pendingCert, pendingKey, ca, name, address)) throw new Error("The generated HTTPS certificate failed validation. Existing server files were preserved.");
      await rename(pendingKey, key);
      await rename(pendingCert, cert);
    }
    await chmod(key, 0o600);
    // Only the public CA is exported for importing on a phone.
    const pendingDer = join(stage, "root-ca.cer");
    await writeFile(pendingDer, ca.raw, { mode: 0o644 });
    await rename(pendingDer, caDer);
    return { caCert, caDer, cert, key, fingerprint: ca.fingerprint256, renewed };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
