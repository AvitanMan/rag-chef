import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrivateIPv4, localServerArgs, parseLocalServerArgs, privateAddresses, selectLocalAddress } from "../tools/local-server.mjs";

const ipv4 = (address, internal = false) => ({ address, internal, family: "IPv4" });

test("LAN launcher selects a physical private interface and ignores public, internal, and IPv6 addresses", () => {
  const candidates = privateAddresses({
    utun0: [ipv4("10.0.2.1")], en1: [ipv4("192.168.2.30")], en0: [ipv4("192.168.1.20"), ipv4("8.8.8.8"), { address: "fd00::1", family: "IPv6", internal: false }],
    lo0: [ipv4("127.0.0.1", true), ipv4("10.1.2.3", true)], awdl0: [ipv4("169.254.1.2")], empty: undefined,
  });
  assert.deepEqual(candidates, [{ name: "en0", address: "192.168.1.20" }, { name: "en1", address: "192.168.2.30" }, { name: "utun0", address: "10.0.2.1" }]);
  assert.equal(selectLocalAddress(candidates).address, "192.168.1.20");
  assert.equal(selectLocalAddress(candidates, "192.168.2.30").name, "en1");
  assert.throws(() => selectLocalAddress(candidates, "192.168.9.99"), /not assigned/);
  assert.throws(() => selectLocalAddress([]), /No private IPv4/);
});

test("LAN host validation admits only canonical RFC1918 IPv4 addresses", () => {
  for (const address of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.0.1"]) assert.equal(isPrivateIPv4(address), true, address);
  for (const address of ["0.0.0.0", "127.0.0.1", "172.15.0.1", "172.32.0.1", "192.169.0.1", "8.8.8.8", "169.254.1.1", "100.64.1.1", "192.168.01.2", "::", "fd00::1", "localhost", "192.168.1.2:3000", "http://192.168.1.2", "192.168.1.2\n", undefined]) assert.equal(isPrivateIPv4(address), false, String(address));
});

test("LAN CLI has strict host and port options without arbitrary forwarded Wrangler flags", () => {
  assert.deepEqual(parseLocalServerArgs([]), { host: undefined, port: 3000, help: false });
  assert.deepEqual(parseLocalServerArgs(["--", "--host=192.168.1.20", "--port", "3001"]), { host: "192.168.1.20", port: 3001, help: false });
  assert.equal(parseLocalServerArgs(["--help"]).help, true);
  for (const args of [["--port"], ["--port", "0"], ["--port", "65536"], ["--port", "1.5"], ["--port", "1e3"], ["--port", "3000abc"], ["--port", "3000", "--port", "3001"], ["--host", "0.0.0.0"], ["--host", "localhost"], ["--host", "--port", "3000"], ["--remote"], ["--tunnel"], ["--var", "RAG_CHEF_HOSTED:1"]]) assert.throws(() => parseLocalServerArgs(args), undefined, args.join(" "));
});

test("LAN runtime stays local, uses the existing D1 state, and permits only its explicit HTTP origin", () => {
  const args = localServerArgs("192.168.1.20", 3001);
  assert.deepEqual(args, ["node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--config", "dist/server/wrangler.json", "--persist-to", ".wrangler/state", "--ip", "192.168.1.20", "--port", "3001", "--local-protocol", "http", "--inspector-ip", "127.0.0.1", "--inspector-port", "0", "--var", "RAG_CHEF_HOSTED:0", "--var", "RAG_CHEF_LAN_ORIGINS:http://192.168.1.20:3001"]);
  assert.ok(!args.includes("--remote"));
  assert.ok(!args.includes("--tunnel"));
  assert.throws(() => localServerArgs("0.0.0.0", 3000));
  assert.throws(() => localServerArgs("192.168.1.20", 65536));
});
