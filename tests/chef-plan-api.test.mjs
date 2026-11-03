import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const dir = await mkdtemp(join(tmpdir(), "chef-plan-api-"));
after(() => { delete globalThis.planApiTest; return rm(dir, { recursive: true, force: true }); });
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"(?:@\/app\/lib|\.)\/([\w-]+)"/g, '"./$1.mjs"');
for (const file of await readdir(new URL('../app/lib/', import.meta.url))) if (file.endsWith('.ts')) await writeFile(join(dir, file.replace(/\.ts$/, '.mjs')), compile(await readFile(new URL(`../app/lib/${file}`, import.meta.url), "utf8")));
await writeFile(join(dir, "household-real.mjs"), await readFile(join(dir, "household.mjs"), "utf8"));
await writeFile(join(dir, "household.mjs"), `export * from './household-real.mjs'; import { requireHousehold as realRequireHousehold } from './household-real.mjs'; export async function requireHousehold(request) { return globalThis.planApiTest?.context ?? realRequireHousehold(request); }`);
await writeFile(join(dir, "recipe-store.mjs"), `export async function listCatalogRecipes() { const test=globalThis.planApiTest; test.events.push('catalog');const rows=structuredClone(test.catalog);if(test.catalogChangeDuringLoad)test.catalogRevision++;return rows; }`);
await writeFile(join(dir, "kitchen-store.mjs"), `
export class KitchenConflictError extends Error { constructor(current) { super('changed'); this.current = current; } }
export async function readCatalogRevision(){const test=globalThis.planApiTest;test.events.push('catalog_revision');return test.catalogRevision;}
export async function getKitchenDocument() { return structuredClone(globalThis.planApiTest.document); }
export async function saveKitchenDocument(revision,state,context,options={}) { const test = globalThis.planApiTest;test.events.push('save:'+options.catalogRevision);test.lastSaveOptions=options;if(options.catalogRevision!==test.catalogRevision)throw Object.assign(new Error('The catalog changed. Review a fresh plan.'),{status:409,code:'catalog_changed'}); if(revision !== test.document.revision) throw new KitchenConflictError(test.document); test.writes++; test.document = {revision:revision+1,state:structuredClone(state),updatedAt:'2026-11-03T12:00:00Z'}; return structuredClone(test.document); }
`);
for (const [name, location] of [["preview", "plan"], ["apply", "plan/apply"]]) await writeFile(join(dir, `${name}.mjs`), compile(await readFile(new URL(`../app/api/chef/${location}/route.ts`, import.meta.url), "utf8")));
const { POST: preview } = await import(pathToFileURL(join(dir, "preview.mjs")));
const { POST: apply } = await import(pathToFileURL(join(dir, "apply.mjs")));
const { EMPTY_KITCHEN } = await import(pathToFileURL(join(dir, "kitchen-types.mjs")));
const { defaultPlanIntent } = await import(pathToFileURL(join(dir, "chef-plan-intent.mjs")));
const reset = () => { globalThis.planApiTest = { document: {revision:1,state:structuredClone(EMPTY_KITCHEN),updatedAt:null}, writes:0, catalogRevision:9, events:[], catalog: ["Rice", "Beans", "Pasta"].map((title,index) => ({ recipe: { id:`recipe-${index}`, title, servings:2, category:"main", cuisine:"test", source:{name:"Original",url:"https://example.invalid"}, sourceUrl:"https://example.invalid/recipe", image:null, tags:[], ingredients:[{name:title.toLowerCase(),measure:"200 g"}], instructions:["Cook the ingredients."] }, contentHash:`hash-${index}` })) }; };
const request = (body, headers = {}) => new Request("http://localhost:3000/api/chef/plan", { method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body) });
const input = () => ({ week:"2026-11-02",today:"2026-11-03",kitchenRevision:globalThis.planApiTest.document.revision,intent:{...defaultPlanIntent("2026-11-02","2026-11-03"),count:2} });
test("manual preview is read-only; apply persists exact reviewed meals and replay cannot write twice", async () => {
  reset(); const original = structuredClone(globalThis.planApiTest.document), fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Manual planning must never call a model"); };
  try {
    const response = await preview(request(input())); assert.equal(response.status,200);
    const { draft } = await response.json(); assert.equal(draft.changes.length,2); assert.equal(draft.interpretation,"manual");
    assert.deepEqual(globalThis.planApiTest.document,original); assert.equal(globalThis.planApiTest.writes,0);
    const saved = await apply(request({draft})); assert.equal(saved.status,200); const document = await saved.json();
    for (const change of draft.changes) assert.deepEqual(document.state.meals[change.date], change.meal);
    assert.equal(globalThis.planApiTest.writes,1); assert.equal((await apply(request({draft}))).status,409); assert.equal(globalThis.planApiTest.writes,1);
  } finally { globalThis.fetch = fetch; }
});
test("stale kitchen, changed source, tampered amounts and cross-origin apply are rejected without writes", async () => {
  for (const mutation of ["kitchen","source","amounts","origin"]) {
    reset(); const {draft} = await (await preview(request(input()))).json();
    if(mutation==="kitchen") globalThis.planApiTest.document.revision++;
    if(mutation==="source") globalThis.planApiTest.catalog.find(row=>row.recipe.id===draft.changes[0].meal.recipeId).recipe.instructions[0]="Changed source directions.";
    if(mutation==="amounts") draft.changes[0].meal.servings=20;
    const response=await apply(request({draft},mutation==="origin"?{origin:"https://example.com"}:{}));
    assert.ok([400,403,409].includes(response.status), `${mutation}: ${response.status}`); assert.equal(globalThis.planApiTest.writes,0);
  }
});
test("planning boundary rejects malformed previous context and oversized input",async()=>{
  reset(); const malformed={...input(),intent:undefined,query:"Plan two dinners",previousDraft:{version:1,kitchenRevision:1,intent:input().intent,changes:[null]}};
  assert.equal((await preview(request(malformed))).status,400);
  assert.equal((await preview(request({...input(),query:"x".repeat(1_500_001)}))).status,413);
  assert.equal((await preview(request(input(),{origin:"https://example.com"}))).status,403);
  assert.equal(globalThis.planApiTest.writes,0);
});
test("disabling the hosted assistant blocks legacy manual preview and applying an earlier draft", async () => {
  reset();
  const { draft } = await (await preview(request(input()))).json();
  globalThis.planApiTest.context = { mode: "hosted", userId: "member", householdId: "family", role: "member", timezone: "UTC", assistantEnabled: false };
  for (const response of [await preview(request(input())), await apply(request({ draft }))]) {
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "assistant_disabled");
  }
  assert.equal(globalThis.planApiTest.writes, 0);
});

test('legacy plan Apply captures catalog revision before loading and passes it to the atomic save',async()=>{
  for(const changed of [false,true]){
    reset();const {draft}=await(await preview(request(input()))).json();
    globalThis.planApiTest.events=[];globalThis.planApiTest.catalogChangeDuringLoad=changed;
    const response=await apply(request({draft}));
    assert.deepEqual(globalThis.planApiTest.events,['catalog_revision','catalog','save:9']);
    assert.deepEqual(globalThis.planApiTest.lastSaveOptions,{catalogRevision:9});
    assert.equal(response.status,changed?409:200);assert.equal(globalThis.planApiTest.writes,changed?0:1);
    if(changed){assert.equal((await response.json()).error.code,'catalog_changed');assert.equal(globalThis.planApiTest.document.revision,1);}
  }
});
