import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLocalServerArgs, privateAddresses, selectLocalAddress } from "./local-server.mjs";
import { ensureLocalTLS, mdnsArgs, validateLocalName } from "./local-tls.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const usage = `Start a password-protected HTTPS kitchen on your home network.

  pnpm start:secure
  pnpm start:secure --name ragchef.local --host 192.168.1.20 --port 3443

Creates a private local certificate authority and a random shared login under
.wrangler/local-https/. Install only the public CA certificate on your phone.
The launcher does not change your system trust store or publish an internet site.
Stop with Ctrl+C. Requires OpenSSL; friendly-name discovery uses macOS dns-sd.`;

export function parseSecureServerArgs(args) {
  let name = "ragchef.local", seen = false;
  const rest = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--name" || args[index].startsWith("--name=")) {
      if (seen) throw new Error("Specify --name only once.");
      seen = true;
      const arg = args[index];
      name = arg === "--name" ? args[++index] : arg.slice(7);
      if (typeof name !== "string" || !name || name.startsWith("--")) throw new Error("--name needs a local hostname.");
    } else rest.push(args[index]);
  }
  if (!rest.some(arg => arg === "--port" || arg.startsWith("--port="))) rest.push("--port", "3443");
  return { ...parseLocalServerArgs(rest), name: validateLocalName(name) };
}

export async function localCredentials(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Local login directory must not be a symlink.");
  await chmod(directory, 0o700);
  const path = join(directory, "credentials.json");
  let login;
  try { if (!(await lstat(path)).isFile()) throw new Error("Not a regular login file"); login = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error("Local login file is invalid. Restore it or remove it to generate a new shared password.");
    login = { username: "chef", password: randomBytes(24).toString("base64url") };
    await writeFile(path, JSON.stringify(login, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  if (typeof login?.username !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(login.username) || typeof login.password !== "string" || !/^[\x21-\x7e]{6,128}$/.test(login.password)) throw new Error("Invalid local login file. Remove it to generate a new shared password.");
  await chmod(path, 0o600);
  return { path, hash: createHash("sha256").update(`${login.username}:${login.password}`).digest("hex") };
}

export function secureServerArgs({ address, port, name, tls, passwordHash }) {
  const options = parseSecureServerArgs(["--host", address, "--port", String(port), "--name", name]);
  if (!/^[a-f0-9]{64}$/.test(passwordHash)) throw new Error("A valid local password hash is required.");
  const origins = `https://${options.name}:${options.port},https://${options.host}:${options.port}`;
  return ["node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--config", "dist/server/wrangler.json", "--persist-to", ".wrangler/state",
    "--ip", options.host, "--port", String(options.port), "--local-protocol", "https", "--upstream-protocol", "https", "--https-key-path", tls.key, "--https-cert-path", tls.cert,
    "--inspector-ip", "127.0.0.1", "--inspector-port", "0", "--var", "RAG_CHEF_HOSTED:0", "--var", `RAG_CHEF_LAN_ORIGINS:${origins}`,
    "--var", "RAG_CHEF_LAN_AUTH:1", "--var", `RAG_CHEF_LAN_PASSWORD_SHA256:${passwordHash}`];
}

async function checkPort(host, port) {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", error => reject(new Error(`Cannot listen on ${host}:${port}: ${error.message}`))); socket.listen(port, host, accept); });
  await new Promise((accept, reject) => socket.close(error => error ? reject(error) : accept()));
}

async function main() {
  const options = parseSecureServerArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  const selected = selectLocalAddress(privateAddresses(networkInterfaces()), options.host);
  await checkPort(selected.address, options.port);
  const directory = join(root, ".wrangler", "local-https");
  const tls = await ensureLocalTLS({ directory, name: options.name, address: selected.address });
  const login = await localCredentials(directory);
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`, WRANGLER_LOG_PATH: join(root, ".wrangler", "wrangler.log") };
  let active, advertiser, stopping;
  const stop = signal => { stopping = signal; active?.kill(signal); advertiser?.kill(signal); };
  const interrupt = () => stop("SIGINT"), terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  const run = args => new Promise((accept, reject) => {
    active = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    active.once("error", reject);
    active.once("exit", (code, signal) => { active = undefined; if (stopping || signal) reject(new Error("Server stopped.")); else if (code !== 0) reject(new Error(`Command exited with status ${code}.`)); else accept(); });
  });
  try {
    console.log("Building the current app for protected local HTTPS…");
    await run(["node_modules/vinext/dist/cli.js", "build"]);
    if (stopping) return;
    if (process.platform === "darwin") {
      advertiser = spawn("/usr/bin/dns-sd", mdnsArgs({ name: options.name, address: selected.address, port: options.port, interfaceName: selected.name }), { stdio: "ignore" });
      advertiser.once("error", () => console.warn("Friendly-name discovery is unavailable. Use the HTTPS IP address below."));
      advertiser.once("exit", code => { if (!stopping && code !== 0) console.warn("Friendly-name registration failed. Use the HTTPS IP address below or choose another --name."); });
    } else console.log("Configure your router/local DNS for the friendly name, or use the HTTPS IP address below.");
    console.log(`\nKitchen: https://${options.name}:${options.port}\nIP fallback: https://${selected.address}:${options.port}`);
    console.log(`Phone trust certificate (public): ${tls.caDer}\nCA fingerprint: ${tls.fingerprint}`);
    console.log(`Shared login file (private): ${login.path}\nKeep private keys on this computer; only transfer the public CA certificate.\nStop with Ctrl+C.`);
    await run(secureServerArgs({ address: selected.address, port: options.port, name: options.name, tls, passwordHash: login.hash }));
  } catch (error) { if (!stopping) throw error; }
  finally {
    advertiser?.kill();
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
    if (stopping) process.exitCode = stopping === "SIGINT" ? 130 : 143;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
