import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "kitchen-request-body" });
const { configureHouseholdRuntime } = await sources.import("app/lib/household.ts");
const snapshot = await sources.import("app/api/kitchen/route.ts");
const commands = await sources.import("app/api/kitchen/commands/route.ts");
const { readHouseholdBody } = await sources.import("app/lib/household-management.ts");
after(() => sources.dispose());

for (const [name, method, path, limit, execute] of [
  ["snapshot", "PUT", "/api/kitchen", 2_000_000, snapshot.PUT],
  ["command", "POST", "/api/kitchen/commands", 2_000_000, commands.POST],
  ["household", "POST", "/api/household", 16_384, readHouseholdBody],
]) test(`oversized ${name} bodies stop without waiting for stream cancellation cleanup`, async () => {
  let cancellations = 0, timer;
  configureHouseholdRuntime({ DB: { prepare: () => assert.fail("Rejected request bodies cannot reach storage") } });
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(limit + 1)); },
    cancel() { cancellations++; return new Promise(() => {}); },
  });
  const request = new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body, duplex: "half" });
  try {
    const status = await Promise.race([
      execute(request).then(response => response.status, error => error.status),
      new Promise(resolve => { timer = setTimeout(() => resolve("still-pending"), 100); }),
    ]);
    assert.equal(status, 413);
    assert.equal(cancellations, 1);
    assert.equal(body.locked, false);
  } finally { clearTimeout(timer); }
});

for (const [name, method, path, execute] of [
  ["snapshot", "PUT", "/api/kitchen", snapshot.PUT],
  ["command", "POST", "/api/kitchen/commands", commands.POST],
]) for (const declared of [true, false]) test(`${name} ${declared ? "declared oversize" : "invalid UTF-8"} rejection closes its body producer`, async () => {
  let cancellations = 0;
  configureHouseholdRuntime({ DB: { prepare: () => assert.fail("Rejected request bodies cannot reach storage") } });
  const body = new ReadableStream({
    start(controller) { if (!declared) controller.enqueue(new Uint8Array([0xc3, 0x28])); },
    cancel() { cancellations++; return new Promise(() => {}); },
  });
  const request = new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", ...(declared ? { "content-length": "2000001" } : {}) }, body, duplex: "half" });
  const response = await execute(request);
  assert.equal(response.status, declared ? 413 : 400);
  assert.equal(cancellations, 1);
  assert.equal(body.locked, false);
});
