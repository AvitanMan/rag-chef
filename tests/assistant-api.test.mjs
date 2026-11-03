import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const dir=await mkdtemp(join(tmpdir(),'assistant-api-'));
after(()=>{delete globalThis.assistantApi;return rm(dir,{recursive:true,force:true});});
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/"(?:@\/app\/lib|\.)\/([\w-]+)"/g,'"./$1.mjs"');
for(const file of await readdir(new URL('../app/lib/',import.meta.url))) if(file.endsWith('.ts'))await writeFile(join(dir,file.replace(/\.ts$/,'.mjs')),compile(await readFile(new URL(`../app/lib/${file}`,import.meta.url),'utf8')));
await writeFile(join(dir,'household.mjs'),`export async function requireHousehold(request){return {mode:'local',householdId:request.headers.get('x-home')||'a',userId:request.headers.get('x-member')||'alice',role:'member',timezone:'Asia/Jerusalem',assistantEnabled:true};}`);
await writeFile(join(dir,'recipe-store.mjs'),`export async function listCatalogRecipes(){const test=globalThis.assistantApi;test.events.push('catalog');const rows=structuredClone(test.catalog);if(test.catalogChangeDuringLoad)test.catalogRevision++;return rows;}`);
await writeFile(join(dir,'ai-inference.mjs'),`export async function createAiWorkflow(){return {infer:async()=>{throw new Error('Unexpected model call')}}} export function aiWorkflowResponse(){return undefined}`);
await writeFile(join(dir,'kitchen-store.mjs'),`
export class KitchenConflictError extends Error{constructor(current){super('changed');this.current=current;}}
export async function readCatalogRevision(){const test=globalThis.assistantApi;test.events.push('catalog_revision');return test.catalogRevision;}
export async function getKitchenDocument(context){if(!context?.householdId)throw new Error('Missing scope');return structuredClone(globalThis.assistantApi.documents[context.householdId]);}
export async function saveKitchenDocument(revision,state,context,options={}){const test=globalThis.assistantApi,current=test.documents[context.householdId];test.events.push('save:'+options.catalogRevision);test.lastSaveOptions=options;if(options.catalogRevision!==test.catalogRevision)throw Object.assign(new Error('The catalog changed. Review a fresh draft.'),{status:409,code:'catalog_changed'});if(revision!==current.revision)throw new KitchenConflictError(structuredClone(current));test.writes++;const document={revision:revision+1,state:structuredClone(state),updatedAt:'2026-11-04T12:00:00Z'};test.documents[context.householdId]=document;return structuredClone(document);}
`);
for(const [name,suffix]of [['prepare',''],['apply','/apply']])await writeFile(join(dir,`${name}.mjs`),compile(await readFile(new URL(`../app/api/assistant${suffix}/route.ts`,import.meta.url),'utf8')));
const {POST:prepare}=await import(pathToFileURL(join(dir,'prepare.mjs'))),{POST:apply}=await import(pathToFileURL(join(dir,'apply.mjs')));
const {EMPTY_KITCHEN}=await import(pathToFileURL(join(dir,'kitchen-types.mjs')));
const {defaultPlanIntent}=await import(pathToFileURL(join(dir,'chef-plan-intent.mjs')));
const recipe={id:'rice',title:'Rice',servings:2,category:'Dinner',cuisine:'Home',source:{name:'Original',url:'https://example.com'},sourceUrl:'https://example.com',image:null,tags:[],ingredients:[{name:'rice',measure:'200 g'}],instructions:['Cook from the original directions.']};
function reset(){globalThis.assistantApi={documents:{a:{revision:1,state:structuredClone(EMPTY_KITCHEN),updatedAt:null},b:{revision:7,state:structuredClone(EMPTY_KITCHEN),updatedAt:null}},writes:0,catalogRevision:7,events:[],catalog:[{recipe:structuredClone(recipe),contentHash:'recipehash'}]};}
const request=(body,headers={})=>new Request('http://localhost:3000/api/assistant',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
const input=()=>({week:'2026-11-02',today:'2026-11-04',kitchenRevision:1,intent:{pantry:[{kind:'add',name:'rice',measure:'500 g'}],tastes:[],planning:{...defaultPlanIntent('2026-11-02','2026-11-04'),count:1}}});

test('compound preview writes nothing; concurrent Apply saves once and returns an idempotent receipt',async()=>{
  reset();const before=structuredClone(globalThis.assistantApi.documents),response=await prepare(request(input()));assert.equal(response.status,200);const {draft}=await response.json();
  assert.deepEqual(globalThis.assistantApi.documents,before);assert.equal(globalThis.assistantApi.writes,0);assert.equal(draft.shopping.length,0);
  const responses=await Promise.all([apply(request({draft})),apply(request({draft}))]);assert.ok(responses.every(row=>row.status===200));
  const results=await Promise.all(responses.map(row=>row.json()));assert.equal(results.filter(row=>row.alreadyApplied).length,1);assert.equal(globalThis.assistantApi.writes,1);
  assert.equal(results[0].receipt.memberId,'alice');assert.equal(globalThis.assistantApi.documents.a.state.pantry[0].measure,'500 g');assert.deepEqual(globalThis.assistantApi.documents.b,before.b);
});

test('cross-household/member replay, stale sources/revisions, and cross-origin requests never write',async()=>{
  for(const change of ['household','member','source','revision','origin']){
    reset();const {draft}=await(await prepare(request(input()))).json();let headers={};
    if(change==='household')headers={'x-home':'b'};
    if(change==='member')headers={'x-member':'bob'};
    if(change==='source')globalThis.assistantApi.catalog[0].recipe.instructions=['Changed source'];
    if(change==='revision')globalThis.assistantApi.documents.a.revision++;
    if(change==='origin')headers={origin:'https://evil.example'};
    const response=await apply(request({draft},headers));assert.ok([400,403,409].includes(response.status),`${change}:${response.status}`);assert.equal(globalThis.assistantApi.writes,0);
  }
});

test('ambiguous pantry batch preview cannot partially save its other actions',async()=>{
  reset();globalThis.assistantApi.documents.a.state.pantry=[{id:'one',name:'rice',measure:'100 g'},{id:'two',name:'rice',measure:'200 g'}];
  const requestInput=input();requestInput.intent.pantry=[{kind:'add',name:'beans',measure:'100 g'},{kind:'subtract',name:'rice',measure:'50 g'}];
  const {draft}=await(await prepare(request(requestInput))).json();assert.equal(draft.pantryChanges.length,1);assert.equal(draft.unresolved[0].choices.length,2);assert.equal(draft.planDraft,undefined);
  assert.equal((await apply(request({draft}))).status,400);assert.equal(globalThis.assistantApi.writes,0);assert.equal(globalThis.assistantApi.documents.a.state.pantry.length,2);
});

test('malformed and oversized requests do not reach mutations or model inference',async()=>{
  reset();for(const body of [{...input(),householdId:'b'},{...input(),previousDraft:{version:1,changes:[null]}},{...input(),query:'x'.repeat(1_500_001)}]){
    const response=await prepare(request(body));assert.ok([400,409,413].includes(response.status));
  }assert.equal(globalThis.assistantApi.writes,0);
});

test('content-free operation metrics distinguish saved Apply, idempotent replay, and conflicts',async()=>{
  reset();const metrics=[],original=console.info;console.info=value=>metrics.push(JSON.parse(value));
  try{
    const {draft}=await(await prepare(request(input()))).json(),{draft:stale}=await(await prepare(request(input()))).json();
    assert.equal((await apply(request({draft}))).status,200);assert.equal((await apply(request({draft}))).status,200);assert.equal((await apply(request({draft:stale}))).status,409);
  }finally{console.info=original;}
  assert.deepEqual(metrics.map(row=>row.outcome),['draft','draft','applied','replay','conflict']);
  for(const row of metrics){assert.deepEqual(Object.keys(row).sort(),['durationMs','event','measurement','operation','outcome','resumed','status']);assert.equal(row.measurement,'server_phase');assert.ok(Number.isFinite(row.durationMs));}
});

test('assistant Apply captures the catalog token before reading recipes and refuses a change before save',async()=>{
  for(const changed of [false,true]){
    reset();const {draft}=await(await prepare(request(input()))).json();
    globalThis.assistantApi.events=[];globalThis.assistantApi.catalogChangeDuringLoad=changed;
    const response=await apply(request({draft}));
    assert.deepEqual(globalThis.assistantApi.events,['catalog_revision','catalog','save:7']);
    assert.deepEqual(globalThis.assistantApi.lastSaveOptions,{assistantAction:true,catalogRevision:7});
    assert.equal(response.status,changed?409:200);assert.equal(globalThis.assistantApi.writes,changed?0:1);
    if(changed){assert.equal((await response.json()).error.code,'catalog_changed');assert.equal(globalThis.assistantApi.documents.a.revision,1);}
  }
});
