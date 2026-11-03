import { mkdtemp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ASSISTANT_CASES, ASSISTANT_EVAL_RECIPES, ASSISTANT_EVAL_DATE as today, ASSISTANT_EVAL_WEEK as week } from './assistant-cases.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)), directory=await mkdtemp(join(tmpdir(),'assistant-evaluation-'));
const args=process.argv.slice(2), option=(name,fallback)=>{const index=args.indexOf(name);return index>=0?args[index+1]:fallback;};
const reportPath=resolve(root,option('--report','output/playwright/assistant-quality.json'));
const replayPath=option('--replay',''), replay=replayPath?JSON.parse(await readFile(resolve(root,replayPath),'utf8')):null;
const model=option('--model','qwen3.5:9b'),baseUrl=option('--base-url',process.env.OLLAMA_BASE_URL||'http://127.0.0.1:11434');
const selected=option('--case',''), split=option('--split',''), track=option('--track',''), cases=ASSISTANT_CASES.filter(row=>(!selected||row.id===selected)&&(!split||row.split===split)&&(!track||row.track===track));
if(!cases.length)throw new Error('Unknown evaluation case.');
const sha=value=>createHash('sha256').update(value).digest('hex');
let evaluatedModules=[];
const fingerprint=async()=>{const rows=new Map();const visit=async name=>{if(rows.has(name))return;const file=join(root,'app/lib',`${name}.ts`);const code=ts.transpileModule(await readFile(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,removeComments:true}}).outputText;rows.set(name,sha(code));for(const match of code.matchAll(/from ["']\.\/([\w-]+)["']/g))await visit(match[1]);};await visit('assistant-engine');await visit('assistant-interpretation');evaluatedModules=[...rows.keys()].sort();return sha(JSON.stringify([...rows].sort(([a],[b])=>a.localeCompare(b))));};
const catalogFiles=async()=>{try{return (await readdir(join(root,'.wrangler/state/v3/d1/miniflare-D1DatabaseObject'))).filter(file=>file.endsWith('.sqlite')&&file!=='metadata.sqlite').map(file=>join(root,'.wrangler/state/v3/d1/miniflare-D1DatabaseObject',file));}catch{return [];}};
const localFingerprints=async()=>Promise.all((await catalogFiles()).map(async file=>[file,sha(await readFile(file))]));
const originalBefore=await localFingerprints(), sourceBefore=await fingerprint(), corpusDigest=sha(JSON.stringify(ASSISTANT_EVAL_RECIPES)), caseDigest=sha(JSON.stringify(ASSISTANT_CASES));
let calls=0, generated=[], inferenceTimings=[], replayRow, replayIndex=0;
try{
  for(const file of (await readdir(join(root,'app/lib'))).filter(file=>file.endsWith('.ts'))) {
    const source=await readFile(join(root,'app/lib',file),'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/"\.\/([\w-]+)"/g,'"./$1.mjs"');
    await writeFile(join(directory,file.replace(/\.ts$/,'.mjs')),code);
  }
  const load=name=>import(pathToFileURL(join(directory,`${name}.mjs`)));
  const {interpretAssistantRequest}=await load('assistant-interpretation');
  const {buildKitchenActionDraft,applyKitchenActionDraft}=await load('assistant-engine');
  const {EMPTY_KITCHEN,DEFAULT_COOKING_PROFILE}=await load('kitchen-types');
  const {parseMeasure}=await load('quantities');
  const {retrievalTerms}=await load('retrieval-ranking');
  const catalog={recipes:ASSISTANT_EVAL_RECIPES,metadata:{},contentHashes:Object.fromEntries(ASSISTANT_EVAL_RECIPES.map(row=>[row.id,sha(JSON.stringify(row))]))};
  const tags=replay?{models:[{name:model,digest:replay.modelDigest}]}:await(await fetch(`${baseUrl}/api/tags`,{signal:AbortSignal.timeout(5000)})).json();
  const modelDigest=tags.models?.find(row=>row.name===model||row.name===`${model}:latest`)?.digest??null;
  const infer=async request=>{
    calls++;const started=performance.now();
    if(replay){const result=replayRow?.generated[replayIndex++];if(result===undefined)throw new Error('Recorded model output is missing for this inference phase');generated.push(structuredClone(result));inferenceTimings.push({elapsedMs:0,modelLoadMs:null,replayed:true});return structuredClone(result);}
    const response=await fetch(`${baseUrl}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(60_000),body:JSON.stringify({model,stream:false,think:false,format:request.schema,messages:request.messages,options:{temperature:0,num_predict:request.maxOutputTokens??1600}})});
    if(!response.ok)throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0,200)}`);
    const data=await response.json();if(data.done_reason==='length')throw new Error('Incomplete model output');const result=JSON.parse(data.message.content);generated.push(result);inferenceTimings.push({elapsedMs:Math.round(performance.now()-started),modelLoadMs:typeof data.load_duration==='number'?Math.round(data.load_duration/1e6):null});return result;
  };
  const results=[];
  for(const entry of cases){
    generated=[];inferenceTimings=[];replayIndex=0;replayRow=replay?.results.find(row=>row.id===entry.id);const started=performance.now(),beforeCalls=calls,kitchen={...structuredClone(EMPTY_KITCHEN),cookingProfile:structuredClone(DEFAULT_COOKING_PROFILE),pantry:structuredClone(entry.pantry)},before=JSON.stringify(kitchen);
    const actor={householdId:'synthetic-household',userId:'synthetic-member'};
    let draft,clarification,error,passed=false,exactApplied=false;
    try{
      const interpreted=await interpretAssistantRequest({query:entry.query,week,today,kitchen,catalog,infer});clarification=interpreted.clarification;
      if(interpreted.intent)draft=await buildKitchenActionDraft({actor,kitchen,revision:1,catalog,intent:interpreted.intent,week,today,id:`evaluation:${entry.id}`,createdAt:'2026-11-04T12:00:00.000Z'});
      if(entry.track==='pantry'){
        const action=draft?.intent.pantry[0],expected=entry.expect;
        const expectedAmount=expected.amount===null?null:parseMeasure(expected.amount),actualAmount=action?.measure?parseMeasure(action.measure):null;
        const amountMatches=expectedAmount===null?actualAmount===null:Boolean(actualAmount&&actualAmount.dimension===expectedAmount.dimension&&Math.abs(actualAmount.quantity-expectedAmount.quantity)<1e-8);
        const blocked=Boolean(draft?.unresolved.some(row=>row.blocking)||clarification);
        passed=blocked===expected.blocked && Boolean(action&&action.kind===expected.kind&&action.name.toLowerCase()===expected.name&&amountMatches&&draft.intent.pantry.length===1&&!draft.intent.planning&&!draft.intent.tastes.length&&!draft.intent.completion);
        if(action?.kind==='set_use_by'){
          const expectedDate=entry.query.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]??(/\btomorrow\b/i.test(entry.query)?'2026-11-05':null);
          passed=passed&&action.useBy===expectedDate;
        }
        if(expected.blocked&&clarification)passed=true;
      }else{
        const changes=draft?.planDraft?.changes??[];const terms=retrievalTerms(entry.expect.match.toLowerCase());
        passed=!clarification&&Boolean(draft?.intent.planning)&&changes.length===entry.expect.count&&changes.every(change=>{
          const recipe=change.meal.recipe;const words=new Set(retrievalTerms([recipe.title,recipe.cuisine,recipe.category,...recipe.ingredients.map(row=>row.name)].join(' ')));
          return terms.every(term=>words.has(term))&&entry.expect.excluded.every(term=>!recipe.ingredients.some(row=>row.name.toLowerCase().includes(term)));
        })&&draft.intent.pantry.length===0&&draft.intent.tastes.length===0&&!draft.intent.completion;
      }
      if(draft&&!draft.unresolved.some(row=>row.blocking)&&(draft.pantryChanges.length||draft.planDraft?.changes.length||draft.tasteChanges.length||draft.completionChange)){
        const applied=await applyKitchenActionDraft({actor,kitchen,revision:1,catalog,draft,today});exactApplied=applied.state.recentActionReceipts?.length===1;
        if(!exactApplied)passed=false;
      }
    }catch(cause){error=cause instanceof Error?cause.message:String(cause);passed=false;}
    const unchanged=before===JSON.stringify(kitchen);if(!unchanged)passed=false;
    const result={id:entry.id,track:entry.track,split:entry.split,query:entry.query,expected:entry.expect,generated,inferenceTimings,passed,unchanged,exactApplied,elapsedMs:Math.round(performance.now()-started),modelCalls:replay?0:calls-beforeCalls,inferencePhases:calls-beforeCalls,...(draft?{intent:draft.intent,unresolved:draft.unresolved,recipeIds:draft.planDraft?.changes.map(row=>row.meal.recipeId),shopping:draft.shopping}:{}),...(clarification?{clarification}:{}),...(error?{error}:{})};
    results.push(result);console.log(JSON.stringify({case:entry.id,passed,elapsedMs:result.elapsedMs,...(error?{error}:{})}));
  }
  const p95=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null;};
  const groups=['pantry','expanded_planning'].flatMap(track=>['development','held_out'].map(split=>{const rows=results.filter(row=>row.track===track&&row.split===split);return {track,split,total:rows.length,passed:rows.filter(row=>row.passed).length,accuracy:rows.length?rows.filter(row=>row.passed).length/rows.length:null};}));
  const sourceAfter=await fingerprint(),originalAfter=await localFingerprints();
  const report={version:1,complete:!selected&&!split&&!track,execution:replay?'Recorded model-output replay against current deterministic code; not an independent model evaluation': 'Pure canonical assistant and planner with real local structured inference; no HTTP/auth/browser quality claim',replaySource:replayPath||null,model,modelDigest,corpusDigest,caseDigest,sourceFingerprint:sourceBefore,evaluatedModules,selection:{case:selected||null,split:split||null,track:track||null},sourceUnchanged:sourceBefore===sourceAfter,originalCatalogUnchanged:JSON.stringify(originalBefore)===JSON.stringify(originalAfter),kitchenWrites:0,fullCaseCount:ASSISTANT_CASES.length,groups,firstRequestMs:results[0]?.elapsedMs,coldStartMeasured:option('--cold-start','false')==='true',modelLoadDurationsMs:results.flatMap(row=>row.inferenceTimings.map(item=>item.modelLoadMs)),warmP95Ms:replay?null:p95(results.slice(1).map(row=>row.elapsedMs)),processingP95Ms:replay?p95(results.map(row=>row.elapsedMs)):null,modelCalls:replay?0:calls,inferencePhases:calls,results};
  await mkdir(resolve(reportPath,'..'),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  const passed=!selected&&groups.filter(group=>(!split||group.split===split)&&(!track||group.track===track)).every(group=>group.total===20&&group.accuracy>=.9)&&report.sourceUnchanged&&report.originalCatalogUnchanged&&results.every(row=>row.unchanged);
  console.log(JSON.stringify({report:reportPath,passed,groups,warmP95Ms:report.warmP95Ms,originalCatalogUnchanged:report.originalCatalogUnchanged}));process.exitCode=passed?0:1;
}finally{await rm(directory,{recursive:true,force:true});}
