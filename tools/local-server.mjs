import { spawn } from "node:child_process";
import { createServer, isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const usage = `Start RAG Chef on your home network after a fresh build.

  pnpm start:lan
  pnpm start:lan --host 192.168.1.20 --port 3000
  node tools/local-server.mjs --help

The host must be a private IPv4 address assigned to this computer.
The default port is 3000. Stop the server with Ctrl+C.`;

export function isPrivateIPv4(address) {
  if (typeof address !== "string" || !isIPv4(address)) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
}

export function parseLocalServerArgs(args) {
  const options = { host: undefined, port: 3000, help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    const [name, inlineValue] = arg.split(/=(.*)/s);
    if (!["--host", "--port"].includes(name)) throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
    if (seen.has(name)) throw new Error(`Specify ${name} only once.`);
    seen.add(name);
    const value = inlineValue ?? args[++index];
    if (typeof value !== "string" || !value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
    if (name === "--host") {
      if (!isPrivateIPv4(value)) throw new Error("--host must be a private IPv4 address, such as 192.168.1.20.");
      options.host = value;
    } else {
      if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) throw new Error("--port must be an integer from 1 to 65535.");
      options.port = Number(value);
    }
  }
  return options;
}

function interfacePriority(name) {
  if (/^(en\d+|eth\d+|wlan\d+|wlp\w+|enp\w+|Wi-?Fi|Ethernet)$/i.test(name)) return 0;
  if (/^(utun|tun|tap|docker|veth|bridge|br-|vmnet|vbox|tailscale|wg|awdl|llw)/i.test(name)) return 2;
  return 1;
}

export function privateAddresses(interfaces) {
  const candidates = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if ((entry.family === "IPv4" || entry.family === 4) && !entry.internal && isPrivateIPv4(entry.address)) {
        candidates.push({ name, address: entry.address });
      }
    }
  }
  candidates.sort((a, b) => interfacePriority(a.name) - interfacePriority(b.name) || a.name.localeCompare(b.name, "en", { numeric: true }) || a.address.localeCompare(b.address));
  return candidates.filter((candidate, index) => candidates.findIndex(other => other.address === candidate.address) === index);
}

export function selectLocalAddress(candidates, requested) {
  if (!candidates.length) throw new Error("No private IPv4 network address found. Connect this computer to your home Wi-Fi or Ethernet, then retry.");
  const selected = requested ? candidates.find(candidate => candidate.address === requested) : candidates[0];
  if (!selected) throw new Error(`The requested host is not assigned to this computer. Available addresses: ${candidates.map(candidate => `${candidate.address} (${candidate.name})`).join(", ")}.`);
  return selected;
}

export function localServerArgs(address, port) {
  // Revalidate at this boundary so callers cannot turn this into a public bind.
  const options = parseLocalServerArgs(["--host", address, "--port", String(port)]);
  return ["node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--config", "dist/server/wrangler.json", "--persist-to", ".wrangler/state",
    "--ip", options.host, "--port", String(options.port), "--local-protocol", "http", "--inspector-ip", "127.0.0.1", "--inspector-port", "0",
    "--var", "RAG_CHEF_HOSTED:0", "--var", `RAG_CHEF_LAN_ORIGINS:http://${options.host}:${options.port}`];
}

async function checkPort(address, port) {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", error => reject(new Error(error.code === "EADDRINUSE" ? `Port ${port} is already in use on ${address}. Stop that server or choose --port ${port === 65535 ? 3001 : port + 1}.` : `Cannot listen on ${address}:${port}: ${error.message}`)));
    server.listen({ host: address, port, exclusive: true }, accept);
  });
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
}

async function main() {
  const options = parseLocalServerArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  const candidates = privateAddresses(networkInterfaces());
  const selected = selectLocalAddress(candidates, options.host);
  const url = `http://${selected.address}:${options.port}`;
  await checkPort(selected.address, options.port);
  console.log(`Using ${selected.name}: ${selected.address}`);
  if (candidates.length > 1) console.log(`Other addresses: ${candidates.filter(candidate => candidate.address !== selected.address).map(candidate => `${candidate.address} (${candidate.name})`).join(", ")}. Select one with --host ADDRESS.`);
  console.log("Building the current app before starting the standalone LAN server…");
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`, RAG_CHEF_HOSTED: "0", RAG_CHEF_LAN_ORIGINS: url, WRANGLER_LOG_PATH: join(root, ".wrangler", "wrangler.log") };
  let active;
  let stopping;
  const stop = signal => { stopping = signal; active?.kill(signal); };
  const interrupt = () => stop("SIGINT"), terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  const run = args => new Promise((accept, reject) => {
    active = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    active.once("error", reject);
    active.once("exit", (code, signal) => {
      active = undefined;
      if (stopping || signal) reject(new Error("Server stopped."));
      else if (code !== 0) reject(new Error(`Command exited with status ${code}.`));
      else accept();
    });
  });
  try {
    await run(["node_modules/vinext/dist/cli.js", "build"]);
    if (stopping) return;
    console.log(`\nOpen on your phone, on the same Wi-Fi: ${url}`);
    console.log("Keep this terminal open. Keep LM Studio running on this computer when using its model; choose LM Studio in the phone’s RAG Chef Settings.");
    console.log("This standalone kitchen is shared with devices that can reach this address. Stop with Ctrl+C.\n");
    await run(localServerArgs(selected.address, options.port));
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
    if (stopping) process.exitCode = stopping === "SIGINT" ? 130 : 143;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
