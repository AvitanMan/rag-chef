import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "catalog-worker-entrypoints", overrides: {
  "app/lib/catalog-read-service.ts": `
    export const catalogReadScope = () => ({ hosted: false, sourceIds: [] });
    export const localCatalogReadService = {};
    export const createRuntimeCatalogReadService = () => localCatalogReadService;
  `,
  "app/lib/catalog-job-runner.ts": `
    export const fixture = { calls: [], fail: new Set(), wait: undefined };
    export async function drainCatalogJobs(options) {
      fixture.calls.push(options);
      if (fixture.wait) await fixture.wait;
      if (fixture.fail.has(options?.jobId)) throw new Error('Temporary persistence outage');
      return { processed: 1 };
    }
  `,
} });
const { default: worker } = await sources.import("worker/catalog.ts");
const { fixture } = await sources.import("app/lib/catalog-job-runner.ts");
after(() => sources.dispose());
beforeEach(() => { fixture.calls.length = 0; fixture.fail.clear(); fixture.wait = undefined; });

function message(body) {
  const result = { body, acknowledged: 0, retries: [] };
  return Object.assign(result, { ack() { result.acknowledged++; }, retry(options) { result.retries.push(options); } });
}

test("Catalog queue delivery drives only the requested durable jobs and acknowledges completed handling", async () => {
  const messages = [message({ jobId: "first-job" }), message({ jobId: "second-job" })];
  await worker.queue({ messages }, {});
  assert.deepEqual(fixture.calls, [{ jobId: "first-job" }, { jobId: "second-job" }]);
  for (const delivery of messages) { assert.equal(delivery.acknowledged, 1); assert.deepEqual(delivery.retries, []); }
});

test("Catalog queue retries transient runner failure without acknowledging or losing the remaining deliveries", async () => {
  fixture.fail.add("failed-job");
  const failed = message({ jobId: "failed-job" }), next = message({ jobId: "next-job" });
  await worker.queue({ messages: [failed, next] }, {});
  assert.deepEqual(fixture.calls, [{ jobId: "failed-job" }, { jobId: "next-job" }]);
  assert.equal(failed.acknowledged, 0); assert.deepEqual(failed.retries, [{ delaySeconds: 10 }]);
  assert.equal(next.acknowledged, 1); assert.deepEqual(next.retries, []);
});

test("malformed queue deliveries cannot select or execute durable jobs", async () => {
  const messages = [message(null), message({}), message({ jobId: 42 }), message({ household: "untrusted", input: { kind: "sync" } })];
  await worker.queue({ messages }, {});
  assert.deepEqual(fixture.calls, []);
  for (const delivery of messages) { assert.equal(delivery.acknowledged, 1); assert.deepEqual(delivery.retries, []); }
});

test("scheduled recovery awaits the durable runner without limiting it to a queue message", async () => {
  let release, settled = false;
  fixture.wait = new Promise(resolve => { release = resolve; });
  const pending = worker.scheduled({}, {}).then(() => { settled = true; });
  await Promise.resolve();
  assert.deepEqual(fixture.calls, [undefined]); assert.equal(settled, false);
  release(); await pending; assert.equal(settled, true);
});
