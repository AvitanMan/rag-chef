import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const dir = await mkdtemp(join(tmpdir(), 'assistant-'));
after(() => rm(dir, { recursive: true, force: true }));
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"(?:@\/app\/lib|\.)\/([\w-]+)"/g, '"./$1.mjs"');
for (const file of await readdir(new URL('../app/lib/', import.meta.url))) if (file.endsWith('.ts')) await writeFile(join(dir, file.replace(/\.ts$/, '.mjs')), compile(await readFile(new URL(`../app/lib/${file}`, import.meta.url), 'utf8')));
const load = file => import(pathToFileURL(join(dir, `${file}.mjs`)));
const { buildKitchenActionDraft: build, applyKitchenActionDraft: apply, assistantToday, assistantHash, validateAssistantIntent } = await load('assistant-engine');
const { validateAssistantInterpretation: interpret, interpretAssistantRequest } = await load('assistant-interpretation');
const { defaultPlanIntent, resolveChefPlanIntent } = await load('chef-plan-intent');
const { buildChefPlanDraft } = await load('chef-plan');
const { editableAssistantIntent, assistantReplacement, assistantKeep, assistantDinnerCount } = await load('assistant-controls');
const { EMPTY_KITCHEN, DEFAULT_COOKING_PROFILE } = await load('kitchen-types');
const { createPlannedMeal } = await load('kitchen-state');
const { shoppingForWeek } = await load('shopping-purchases');
const { serializeKitchenBackup, parseKitchenBackup } = await load('kitchen-backup');
const actor = { householdId: 'home-a', userId: 'alice' }, today='2026-11-04', week='2026-11-02';
const recipe = (id, name='rice', cuisine='Italian') => ({ id, title:`${id} dinner`, servings:2, category:'Dinner', cuisine, source:{name:'Original',url:'https://example.com'}, sourceUrl:'https://example.com', image:null,tags:[],ingredients:[{name,measure:'200 g'}],instructions:['Follow original source directions.'] });
const recipes = [recipe('a-rice'),recipe('b-beans','beans','Mexican'),recipe('c-lentil','lentils','Indian')];
const catalog = { recipes,metadata:{},contentHashes:Object.fromEntries(recipes.map(row=>[row.id,'source-hash'])) };
const stock=(id,name,measure,useBy)=>({id,name,measure,...(useBy?{useBy}:{})});
const state=(pantry=[])=>({...structuredClone(EMPTY_KITCHEN),cookingProfile:structuredClone(DEFAULT_COOKING_PROFILE),pantry});
const intent=(pantry=[],rest={})=>({pantry,tastes:[],...rest});
const input=(operations,kitchen=state(),rest={})=>({actor,kitchen,revision:5,catalog,intent:operations,week,today,id:'review-one',createdAt:'2026-11-04T10:00:00.000Z',...rest});
const request=(pantry=[],rest={})=>({pantry,tastes:[],planningQuery:null,completion:null,clarification:null,...rest});
const modelAction=(kind,name,measure,evidence,rest={})=>({kind,name,measure,stockId:null,useBy:null,useBySpecified:false,evidence,...rest});
const context=(query,kitchen=state(),rest={})=>({query,kitchen,catalog,today,...rest});

test('compound pantry then planning is read-only until Apply and uses exact post-pantry shopping',async()=>{
  const data=input(intent([{kind:'add',name:'rice',measure:'500 g',useBy:'2026-11-05'}],{planning:{...defaultPlanIntent(week,today),count:1,recipeQuery:'rice'}}));
  const before=structuredClone(data),draft=await build(data);
  assert.deepEqual(data,before); assert.equal(draft.planDraft.changes.length,1); assert.equal(draft.shopping.length,0);
  const applied=await apply({...data,draft}); assert.equal(applied.state.pantry[0].measure,'500 g'); assert.deepEqual(shoppingForWeek(applied.state,week,today),draft.shopping);
  assert.equal(applied.state.recentActionReceipts[0].memberId,'alice'); assert.equal(applied.state.recentActionReceipts[0].appliedRevision,6);
  const replay=await apply({...data,kitchen:applied.state,revision:6,draft}); assert.equal(replay.alreadyApplied,true); assert.deepEqual(replay.state,applied.state);
});

test('subtract converts compatible units, never consumes raw as cooked, and preserves other batches',async()=>{
  const kitchen=state([stock('rice','rice','1 kg'),stock('cooked','cooked rice','300 g')]);
  const data=input(intent([{kind:'subtract',name:'rice',measure:'250 g'}]),kitchen);
  const draft=await build(data),result=await apply({...data,draft});
  assert.equal(result.state.pantry.find(row=>row.id==='rice').measure,'750 g'); assert.equal(result.state.pantry.find(row=>row.id==='cooked').measure,'300 g');
  assert.deepEqual(kitchen.pantry,[stock('rice','rice','1 kg'),stock('cooked','cooked rice','300 g')]);
});

test('duplicate batches return concrete choices, then a selected batch revises without writes',async()=>{
  const kitchen=state([stock('first','rice','500 g','2026-11-05'),stock('second','rice','700 g','2026-11-10')]);
  const data=input(intent([{kind:'subtract',name:'rice',measure:'100 g'}]),kitchen),draft=await build(data);
  assert.equal(draft.unresolved[0].blocking,true); assert.deepEqual(draft.unresolved[0].choices.map(row=>row.stockId),['first','second']);
  await assert.rejects(apply({...data,draft}),/Resolve/);
  const revised=await build({...data,previousDraft:draft,intent:intent([{kind:'subtract',name:'rice',measure:'100 g',stockId:'second'}])});
  const applied=await apply({...data,draft:revised}); assert.equal(applied.state.pantry.find(row=>row.id==='first').measure,'500 g'); assert.equal(applied.state.pantry.find(row=>row.id==='second').measure,'600 g');
});

test('missing quantities, unknown packages, incompatible units and overdraws block Apply',async()=>{
  const kitchen=state([stock('rice','rice','100 g')]);
  for(const action of [{kind:'add',name:'rice'},{kind:'add',name:'rice',measure:'1 bag'},{kind:'subtract',name:'rice',measure:'1 cup'},{kind:'subtract',name:'rice',measure:'150 g'}]){
    const data=input(intent([action]),kitchen),draft=await build(data);assert.ok(draft.unresolved.some(row=>row.blocking));await assert.rejects(apply({...data,draft}));
  }
});

test('use-by correction and clearing retain amount and never infer dates',async()=>{
  const kitchen=state([stock('r','rice','100 g','2026-11-05')]);
  for(const useBy of ['2026-11-09',null]){
    const data=input(intent([{kind:'set_use_by',name:'rice',useBy}]),kitchen),draft=await build(data),result=await apply({...data,draft});
    assert.equal(result.state.pantry[0].measure,'100 g');assert.equal(result.state.pantry[0].useBy,useBy??undefined);
  }
  const unknown=await build(input(intent([{kind:'set_use_by',name:'rice'}]),kitchen));assert.ok(unknown.unresolved[0].blocking);
});

test('taste feedback is attributed, reversible, household visible, and weaker than stock/hard constraints',async()=>{
  const kitchen=state(),data=input(intent([],{tastes:[{recipeId:'b-beans',preference:'cook_again'}]}),kitchen);
  const draft=await build(data),result=await apply({...data,draft});assert.equal(result.state.tastePreferences[0].memberId,'alice');
  const planned=await buildChefPlanDraft({kitchen:result.state,revision:6,catalog,intent:{...defaultPlanIntent(week,today),count:1}});assert.equal(planned.changes[0].meal.recipeId,'b-beans');
  const stocked={...result.state,pantry:[stock('rice','rice','200 g','2026-11-04')]};
  const waste=await buildChefPlanDraft({kitchen:stocked,revision:6,catalog,intent:{...defaultPlanIntent(week,today),count:1}});assert.equal(waste.changes[0].meal.recipeId,'a-rice');
  const other={...result.state,tastePreferences:[...result.state.tastePreferences,{memberId:'bob',recipeId:'b-beans',preference:'less_often',updatedAt:data.createdAt}]};
  const clearData=input(intent([],{tastes:[{recipeId:'b-beans',preference:'clear'}]}),other,{revision:6,id:'clear-preference'}),clear=await build(clearData);
  assert.deepEqual((await apply({...clearData,draft:clear})).state.tastePreferences.map(row=>row.memberId),['bob']);
  const roundTrip=parseKitchenBackup(serializeKitchenBackup(result.state));assert.deepEqual(roundTrip.state.tastePreferences,result.state.tastePreferences);assert.deepEqual(roundTrip.state.recentActionReceipts,result.state.recentActionReceipts);
});

test('cooking completion shows exact measured deductions and is retried only once',async()=>{
  const kitchen=state([stock('r','rice','500 g')]);kitchen.meals[today]=createPlannedMeal(today,recipes[0]);
  const data=input(intent([],{completion:{date:today,deductStock:true}}),kitchen),draft=await build(data);
  assert.equal(draft.completionChange.after.status,'cooked');assert.equal(draft.pantryChanges[0].after.measure,'300 g');assert.equal(kitchen.pantry[0].measure,'500 g');
  const result=await apply({...data,draft});assert.equal(result.state.pantry[0].measure,'300 g');assert.equal((await apply({...data,kitchen:result.state,revision:6,draft})).alreadyApplied,true);
});

test('stale revision, household/member mismatch, changed source, midnight, and tampered previews reject',async()=>{
  const data=input(intent([{kind:'add',name:'rice',measure:'200 g'}],{planning:{...defaultPlanIntent(week,today),count:1,recipeQuery:'rice'}})),draft=await build(data);
  for(const patch of [{revision:6},{actor:{...actor,userId:'bob'}},{actor:{...actor,householdId:'home-b'}},{today:'2026-11-05'},{catalog:{...catalog,recipes:recipes.map(row=>({...row,instructions:['New source directions.']}))}}]) await assert.rejects(apply({...data,...patch,draft}));
  const forged=structuredClone(draft);forged.pantryChanges[0].after.measure='900 g';delete forged.reviewHash;forged.reviewHash=await assistantHash(forged);
  await assert.rejects(apply({...data,draft:forged}),/reviewed action/);
});

test('expanded planning filters cuisines/dishes/ingredients without weakening hard exclusions',async()=>{
  for(const query of ['Plan one Mexican dinner','Plan one dinner using lentils','Plan one Italian dinner']){
    const resolved=resolveChefPlanIntent(query,defaultPlanIntent(week,today),{},catalog).intent;
    assert.ok(resolved.recipeQuery);const planned=await buildChefPlanDraft({kitchen:state(),revision:5,catalog,intent:resolved});assert.equal(planned.changes.length,1);
    assert.ok(query.includes('Mexican')?planned.changes[0].meal.recipeId==='b-beans':query.includes('lentils')?planned.changes[0].meal.recipeId==='c-lentil':planned.changes[0].meal.recipeId==='a-rice');
  }
  const constrained=resolveChefPlanIntent('Plan one Mexican dinner without beans',defaultPlanIntent(week,today),{},catalog).intent;
  assert.equal((await buildChefPlanDraft({kitchen:state(),revision:5,catalog,intent:constrained})).changes.length,0);
});

test('count and priority language still produces a complete reviewed dinner draft',async()=>{
  for(const query of ['Plan two dinners with variety.','Plan a couple of dinners.','Plan a pair of dinners using perishable food.','Plan two dinners with less waste.','Plan two dinners using up food.']){
    const resolved=resolveChefPlanIntent(query,defaultPlanIntent(week,today),{},catalog).intent;
    assert.equal(resolved.recipeQuery,undefined,query);assert.equal(resolved.count,2);
    const data=input(intent([],{planning:resolved})),draft=await build(data);
    assert.equal(draft.planDraft.changes.length,2,query);
    const result=await apply({...data,draft});assert.deepEqual(shoppingForWeek(result.state,week,today),draft.shopping);
  }
});

test('explicit dinner imperatives omitted by the model use the validated planner, not clarification',async()=>{
  const modelPlan={count:null,servings:null,batches:null,dates:[],excludedIngredients:[],diets:[],excludedEquipment:[],maxTotalMinutes:null,priority:null,allowRepeats:null,evidence:Object.fromEntries(['count','servings','batches','excludedIngredients','diets','excludedEquipment','maxTotalMinutes','priority','allowRepeats'].map(key=>[key,'']))};
  for(const query of ['Please prepare one rice dinner.','Choose a pair of dinners.','Suggest one Mexican meal for two people.']){
    let calls=0;
    const interpreted=await interpretAssistantRequest({...context(query),week,infer:async()=>++calls===1?request([],{clarification:'Which action?'}):modelPlan});
    assert.equal(interpreted.clarification,undefined,query);assert.ok(interpreted.intent.planning);assert.equal(calls,2);
    const data=input(interpreted.intent),draft=await build(data);assert.equal(draft.planDraft.changes.length,query.includes('pair')?2:1,query);
    assert.deepEqual((await apply({...data,draft})).state.meals,Object.fromEntries(draft.planDraft.changes.map(change=>[change.date,change.meal])));
  }
  for(const query of ["Don't prepare one rice dinner.",'Never choose a rice meal.','Prepare no dinners.','I prepared one rice dinner.','How do I prepare a rice dinner?','Prepare recipe instructions.','Make rice dinners less often.','Make a-rice dinner again.']){
    assert.equal(interpret(request(),context(query)).planningQuery,undefined,query);
  }
  const preference='Make a-rice dinner again';
  assert.equal(interpret(request([],{tastes:[{recipeId:'a-rice',preference:'cook_again',evidence:preference}]}),context(preference)).planningQuery,undefined);
});

test('household dates use the configured timezone across UTC midnight',()=>{
  const now=new Date('2026-11-04T00:30:00Z');assert.equal(assistantToday('America/Los_Angeles',now),'2026-11-03');assert.equal(assistantToday('Asia/Jerusalem',now),'2026-11-04');
});

test('model pantry operations require exact action and amount evidence, preserving preparations',()=>{
  const valid=modelAction('add','rice','500 g','I bought 500 g rice');assert.equal(interpret(request([valid]),context(valid.evidence)).intent.pantry[0].measure,'500 g');
  for(const [action,query] of [[{...valid,measure:'900 g'},valid.evidence],[{...valid,evidence:'I bought 500 g rice'},'Do not add rice'],[modelAction('subtract','rice','100 g','I used 100 g cooked rice'),'I used 100 g cooked rice'],[modelAction('add','rice','500 g','I bought 500 g rice',{useBySpecified:true,useBy:'2026-11-10'}),'I bought 500 g rice']]) assert.throws(()=>interpret(request([action]),context(query)));
  const explicit=modelAction('set_use_by','rice',null,'Set rice use-by to tomorrow',{useBySpecified:true,useBy:'2026-11-05'});assert.equal(interpret(request([explicit]),context(explicit.evidence)).intent.pantry[0].useBy,'2026-11-05');
});

test('model cannot choose among duplicate stock batches without user evidence',()=>{
  const kitchen=state([stock('first','rice','500 g'),stock('second','rice','700 g')]);
  const action=modelAction('subtract','rice','100 g','I used 100 g rice',{stockId:'second'});
  assert.equal(interpret(request([action]),context(action.evidence,kitchen)).intent.pantry[0].stockId,undefined);
});

test('invalid action schema and other-member feedback cannot be smuggled into a manual intent',()=>{
  assert.throws(()=>validateAssistantIntent(intent([{kind:'set',name:'rice',measure:'2 g',unexpected:true}])));
  assert.throws(()=>validateAssistantIntent(intent([],{tastes:[{recipeId:'a-rice',preference:'cook_again',memberId:'bob'}]})));
});

test('cropped evidence cannot hide a negated pantry, taste, or completion instruction',()=>{
  for(const [action,query] of [
    [modelAction('add','rice','2 kg','add 2 kg rice'),"Don't add 2 kg rice; add 3 kg beans"],
    [modelAction('set','rice','2 kg','set rice to 2 kg'),'Do not set rice to 2 kg'],
    [modelAction('subtract','rice','100 g','subtract 100 g rice'),'Do not subtract 100 g rice'],
    [modelAction('remove','rice',null,'remove rice'),"Don't remove rice"],
  ])assert.throws(()=>interpret(request([action]),context(query)),query);
  assert.throws(()=>interpret(request([],{tastes:[{recipeId:'a-rice',preference:'cook_again',evidence:'cook a-rice dinner again'}]}),context("Don't cook a-rice dinner again")));
  assert.throws(()=>interpret(request([],{completion:{date:today,deductStock:false,evidence:'mark today dinner cooked'}}),context("Don't mark today dinner cooked")));
});

test('amount evidence stays attached to its ingredient in compound grocery requests',()=>{
  const query='Add 1 kg rice and 2 kg beans';
  assert.throws(()=>interpret(request([modelAction('add','rice','2 kg',query)]),context(query)));
  assert.throws(()=>interpret(request([modelAction('add','beans','1 kg',query)]),context(query)));
  const correct=interpret(request([modelAction('add','rice','1 kg',query),modelAction('add','beans','2 kg',query)]),context(query));
  assert.deepEqual(correct.intent.pantry.map(row=>[row.name,row.measure]),[['rice','1 kg'],['beans','2 kg']]);
});

test('pantry verbs cannot be borrowed across ingredient clauses, even with cropped or broad evidence',()=>{
  const kitchen=state([stock('beans','beans','500 g')]);
  for(const [query,kind,name,measure,evidence] of [
    ['Remove rice and add 2 kg beans.','remove','beans',null,'add 2 kg beans'],
    ['Remove rice and add 2 kg beans.','remove','beans',null,'beans'],
    ['Remove rice and add 2 kg beans.','remove','beans',null,'Remove rice and add 2 kg beans.'],
    ['Add 2 kg rice and remove beans.','add','beans','2 kg','remove beans'],
    ['Add 2 kg rice and remove beans.','add','beans',null,'Add 2 kg rice and remove beans.'],
    ['Subtract 100 g rice and add 2 kg beans.','subtract','beans','2 kg','2 kg beans'],
    ['Set rice to 1 kg and remove beans.','set','beans','1 kg','Set rice to 1 kg and remove beans.'],
    ['Remove rice, add 2 kg beans.','remove','beans',null,'beans'],
    ['Remove rice then add 2 kg beans.','remove','beans',null,'beans'],
    ['Remove rice and add 2 kg rice.','remove','rice',null,'add 2 kg rice'],
    ['Add 2 kg rice and remove rice.','add','rice','2 kg','remove rice'],
    ['Remove rice and add 2 kg rice.','remove','rice',null,'rice'],
    ['Remove rice and add 2 kg rice.','remove','rice',null,'Remove rice and add 2 kg rice.'],
    ['Remove rice and add 2 kg rice.','add','rice','2 kg','Remove rice and add 2 kg rice.'],
    ['Remove rice add 2 kg beans.','remove','beans',null,'beans'],
  ]) assert.throws(()=>interpret(request([modelAction(kind,name,measure,evidence)]),context(query,kitchen)),{code:'invalid_interpretation'},`${query} / ${evidence}`);
  assert.deepEqual(kitchen.pantry,[stock('beans','beans','500 g')]);
});

test('coordinated pantry actions and shared verbs retain local amounts, dates and identities',async()=>{
  for(const query of ['Add 1 kg rice and 2 kg beans','Add 1 kg rice, 2 kg beans','Add 1 kg rice and add 2 kg beans']){
    const actions=[modelAction('add','rice','1 kg',query),modelAction('add','beans','2 kg',query)];
    const result=interpret(request(actions),context(query));
    const data=input(result.intent),draft=await build(data),applied=await apply({...data,draft});
    assert.deepEqual(applied.state.pantry.map(row=>[row.name,row.measure]),[['rice','1000 g'],['beans','2000 g']]);
  }
  const query='Remove rice and add 2 kg beans.',kitchen=state([stock('rice','rice','100 g'),stock('beans','beans','500 g')]);
  const result=interpret(request([modelAction('remove','rice',null,query),modelAction('add','beans','2 kg',query)]),context(query,kitchen));
  const data=input(result.intent,kitchen),draft=await build(data),applied=await apply({...data,draft});
  assert.deepEqual(applied.state.pantry.map(row=>[row.name,row.measure]),[['beans','500 g'],['beans','2000 g']]);
  const repeated='Remove rice and add 2 kg rice.';
  assert.deepEqual(interpret(request([modelAction('remove','rice',null,'Remove rice'),modelAction('add','rice','2 kg','add 2 kg rice')]),context(repeated)).intent.pantry.map(row=>row.kind),['remove','add']);
  const dated='Add 1 kg brown rice use-by tomorrow and 2 kg red lentils use-by 2026-11-09';
  const actions=[modelAction('add','brown rice','1 kg',dated,{useBySpecified:true,useBy:'2026-11-05'}),modelAction('add','red lentils','2 kg',dated,{useBySpecified:true,useBy:'2026-11-09'})];
  assert.deepEqual(interpret(request(actions),context(dated)).intent.pantry.map(row=>row.useBy),['2026-11-05','2026-11-09']);
  assert.throws(()=>interpret(request([{...actions[0],useBy:'2026-11-09'}]),context(dated)));
  assert.throws(()=>interpret(request([{...actions[1],measure:'1 kg'}]),context(dated)));
});

test('shared verbs retain negative context and do not leak batch or date evidence',()=>{
  for(const query of ["Don't add 1 kg rice and 2 kg beans",'Never add 1 kg rice and 2 kg beans','Do not remove rice and beans']){
    const removing=query.includes('remove');
    assert.throws(()=>interpret(request([modelAction(removing?'remove':'add','beans',removing?null:'2 kg',removing?'beans':'2 kg beans')]),context(query)));
  }
  const query="Remove rice and don't add 2 kg beans";
  assert.throws(()=>interpret(request([modelAction('add','beans','2 kg','add 2 kg beans')]),context(query)));
  assert.throws(()=>interpret(request([modelAction('add','beans','2 kg','add 2 kg beans')]),context("Don't add rice and add 2 kg beans")));
  const clearing='Add 1 kg rice and clear beans expiry';
  assert.throws(()=>interpret(request([modelAction('add','beans',null,clearing)]),context(clearing)));
  assert.equal(interpret(request([modelAction('set_use_by','beans',null,clearing,{useBySpecified:true,useBy:null})]),context(clearing)).intent.pantry[0].useBy,null);
  const dated='Add 1 kg rice tomorrow and 2 kg beans';
  assert.throws(()=>interpret(request([modelAction('add','beans','2 kg',dated,{useBySpecified:true,useBy:'2026-11-05'})]),context(dated)));
  const kitchen=state([stock('small','beans','100 g'),stock('large','beans','200 g')]);
  const batches='Remove rice from batch large and subtract 50 g beans';
  assert.equal(interpret(request([modelAction('subtract','beans','50 g',batches,{stockId:'large'})]),context(batches,kitchen)).intent.pantry[0].stockId,undefined);
  const removing='Remove beans from the batch expiring 2026-11-09';
  const datedKitchen=state([stock('small','beans','100 g','2026-11-05'),stock('large','beans','200 g','2026-11-09')]);
  assert.equal(interpret(request([modelAction('remove','beans',null,removing,{stockId:'large'})]),context(removing,datedKitchen)).intent.pantry[0].stockId,'large');
  const selected='Remove rice and subtract 50 g beans from batch large';
  assert.equal(interpret(request([modelAction('subtract','beans','50 g',selected,{stockId:'large'})]),context(selected,kitchen)).intent.pantry[0].stockId,'large');
});

test('compound ingredient names stay intact and cannot authorize destructive fragments',async()=>{
  for(const name of ['macaroni and cheese','sweet and sour sauce']){
    const query=`Remove ${name}`,kitchen=state([stock('whole',name,'100 g'),stock('fragment',name.split(' and ')[1],'200 g')]);
    for(const evidence of [query,name]){
      const result=interpret(request([modelAction('remove',name,null,evidence)]),context(query,kitchen));
      const data=input(result.intent,kitchen),draft=await build(data),applied=await apply({...data,draft});
      assert.deepEqual(applied.state.pantry,[kitchen.pantry[1]]);
    }
    for(const fragment of name.split(' and ')) for(const evidence of [query,fragment]){
      assert.throws(()=>interpret(request([modelAction('remove',fragment,null,evidence)]),context(query,kitchen)),{code:'invalid_interpretation'});
    }
    const adding=`Add 1 kg ${name}`;
    assert.equal(interpret(request([modelAction('add',name,'1 kg',adding)]),context(adding)).intent.pantry[0].name,name);
  }
  for(const query of ['Remove rice and beans','Remove rice, beans','Subtract 100 g rice and 50 g beans','Set rice to 100 g and 50 g beans']){
    const kind=query.startsWith('Subtract')?'subtract':query.startsWith('Set')?'set':'remove';
    assert.throws(()=>interpret(request([modelAction(kind,'beans',kind==='remove'?null:'50 g','beans')]),context(query)),{code:'invalid_interpretation'});
  }
  const explicit='Remove rice and remove beans';
  assert.deepEqual(interpret(request([modelAction('remove','rice',null,explicit),modelAction('remove','beans',null,explicit)]),context(explicit)).intent.pantry.map(row=>row.name),['rice','beans']);
});

test('trailing date cues cannot split compound names into destructive targets',async()=>{
  for(const name of ['macaroni and cheese','sweet and sour sauce']){
    const fragments=name.split(' and '),kitchen=state([stock('whole',name,'100 g'),...fragments.map((fragment,index)=>stock(`fragment-${index}`,fragment,'200 g'))]);
    const before=structuredClone(kitchen);
    for(const annotation of ['expires tomorrow','expires 2026-11-09']){
      const query=`Remove ${name} ${annotation}`;
      for(const fragment of fragments) for(const evidence of [query,`Remove ${fragments[0]}`,fragment]){
        assert.throws(()=>interpret(request([modelAction('remove',fragment,null,evidence)]),context(query,kitchen)),{code:'invalid_interpretation'},`${query} / ${fragment} / ${evidence}`);
      }
      for(const evidence of [query,name]){
        const result=interpret(request([modelAction('remove',name,null,evidence)]),context(query,kitchen));
        assert.deepEqual(result.intent.pantry,[{kind:'remove',name}]);
        const data=input(result.intent,kitchen),draft=await build(data),applied=await apply({...data,draft});
        assert.deepEqual(applied.state.pantry,kitchen.pantry.slice(1));
      }
      assert.deepEqual(kitchen,before);
    }
    for(const annotation of ['use-by tomorrow','expiry tomorrow','was purchased yesterday','is left in the pantry','is for the dinner plan']){
      const query=`Remove ${name} ${annotation}`;
      assert.throws(()=>interpret(request([modelAction('remove',fragments[0],null,query)]),context(query,kitchen)),{code:'invalid_interpretation'},query);
    }
  }
  for(const prefix of ['', 'please ', 'also ']){
    const query=`Remove rice and ${prefix}add 2 kg beans`;
    assert.deepEqual(interpret(request([modelAction('remove','rice',null,query),modelAction('add','beans','2 kg',query)]),context(query)).intent.pantry.map(row=>row.kind),['remove','add']);
  }
});

test('keep and planning clauses cannot inherit pantry operations',()=>{
  for(const instruction of ['keep the beans','plan dinner with beans','cook dinner with beans','leave the beans in the pantry']){
    for(const [verb,kind,measure] of [['Remove','remove',null],['Add','add',null],['Subtract 50 g','subtract','50 g']]){
      const query=`${verb} rice and ${instruction}`;
      for(const evidence of [query,instruction,'beans']) assert.throws(()=>interpret(request([modelAction(kind,'beans',measure,evidence)]),context(query)),{code:'invalid_interpretation'},query);
    }
    const query=`Remove rice and ${instruction}`;
    assert.equal(interpret(request([modelAction('remove','rice',null,'Remove rice')]),context(query)).intent.pantry[0].name,'rice');
  }
  const query='Remove rice and keep the beans and 2 kg lentils';
  assert.throws(()=>interpret(request([modelAction('remove','lentils',null,'lentils')]),context(query)),{code:'invalid_interpretation'});
});

test('amount updates retain attached date annotations without borrowing another ingredient date',async()=>{
  for(const [verb,kind] of [['Add','add'],['Set','set']]) for(const separator of [' ', ', ', ' and ']){
    const query=kind==='set'?`${verb} rice to 1 kg${separator}use-by tomorrow`:`${verb} 1 kg rice${separator}use-by tomorrow`;
    for(const evidence of [query,'rice']){
      const result=interpret(request([modelAction(kind,'rice','1 kg',evidence,{useBySpecified:true,useBy:'2026-11-05'})]),context(query));
      assert.deepEqual(result.intent.pantry,[{kind,name:'rice',measure:'1 kg',useBy:'2026-11-05'}]);
      const data=input(result.intent,state([stock('r','rice','100 g')])),draft=await build(data),applied=await apply({...data,draft});
      assert.ok(applied.state.pantry.some(row=>row.measure==='1000 g'&&row.useBy==='2026-11-05'));
    }
  }
  const query='Set rice to 1 kg, use-by tomorrow and add 2 kg beans, use-by 2026-11-09';
  const actions=[modelAction('set','rice','1 kg',query,{useBySpecified:true,useBy:'2026-11-05'}),modelAction('add','beans','2 kg',query,{useBySpecified:true,useBy:'2026-11-09'})];
  assert.deepEqual(interpret(request(actions),context(query)).intent.pantry.map(row=>row.useBy),['2026-11-05','2026-11-09']);
  for(const [index,date] of [[0,'2026-11-09'],[1,'2026-11-05']]) assert.throws(()=>interpret(request([{...actions[index],useBy:date}]),context(query)),{code:'invalid_interpretation'});
  for(const measure of ['1 bunch','2','half kg']){
    const query=`Set rice to ${measure} use-by tomorrow`;
    assert.equal(interpret(request([modelAction('set','rice',measure,query,{useBySpecified:true,useBy:'2026-11-05'})]),context(query)).intent.pantry[0].measure,measure);
  }
  const dateOnly='Set rice use-by tomorrow';
  assert.equal(interpret(request([modelAction('set_use_by','rice',null,dateOnly,{useBySpecified:true,useBy:'2026-11-05'})]),context(dateOnly)).intent.pantry[0].kind,'set_use_by');
});

test('clause grounding preserves pronoun corrections and unchanged cumulative actions',async()=>{
  const previousDraft=await build(input(intent([{kind:'add',name:'rice',measure:'500 g'}])));
  const query='Actually set it to 300 g';
  const result=interpret(request([modelAction('set','rice','300 g','set it to 300 g')]),context(query,state(),{previousDraft}));
  assert.deepEqual(result.intent.pantry,[{kind:'set',name:'rice',measure:'300 g'}]);
  const cumulative='Add 2 kg beans and 100 g red lentils';
  const updated=interpret(request([modelAction('add','rice','500 g',''),modelAction('add','beans','2 kg',cumulative),modelAction('add','red lentils','100 g',cumulative)]),context(cumulative,state(),{previousDraft}));
  assert.deepEqual(updated.intent.pantry.map(row=>row.name),['rice','beans','red lentils']);
});

test('an additive followup preserves prior pantry and taste changes omitted by the model',async()=>{
  const previousDraft=await build(input(intent([{kind:'add',name:'rice',measure:'500 g'}],{tastes:[{recipeId:'b-beans',preference:'cook_again'}]})));
  const query='Also add 200 g beans';
  const result=interpret(request([modelAction('add','beans','200 g',query)]),context(query,state(),{previousDraft}));
  assert.deepEqual(new Set(result.intent.pantry.map(row=>row.name)),new Set(['rice','beans']));
  assert.deepEqual(result.intent.tastes,previousDraft.intent.tastes);
});

test('a model clarification flag cannot override complete explicitly supported pantry actions',async()=>{
  const query='Add 500 g rice';let calls=0;
  const result=await interpretAssistantRequest({...context(query),week,infer:async()=>{calls++;return request([modelAction('add','rice','500 g',query)],{clarification:'How much rice should I add?'});}});
  assert.equal(result.clarification,undefined);assert.equal(result.intent.pantry[0].measure,'500 g');assert.equal(calls,1);
});

test('a cuisine requested for one date cannot silently replace the whole draft cuisine',()=>{
  const prior={...defaultPlanIntent(week,today),count:2,dates:['2026-11-04','2026-11-06'],recipeQuery:'Mexican'};
  for(const query of ['Make Friday Italian','Italian on Friday only']){
    const result=resolveChefPlanIntent(query,prior,{},catalog);
    assert.ok(result.clarification,query);assert.equal(result.intent,undefined);
  }
  const negated=resolveChefPlanIntent('Do not make Friday Italian; keep Wednesday',prior,{},catalog).intent;
  assert.equal(negated.recipeQuery,'Mexican');assert.deepEqual(negated.keepDates,['2026-11-04']);
  assert.equal(resolveChefPlanIntent('Make all dinners Italian',prior,{},catalog).intent.recipeQuery.toLowerCase(),'italian');
});

test('same-ingredient additive followups preserve separate batches, while explicit corrections replace',async()=>{
  const previousDraft=await build(input(intent([{kind:'add',name:'rice',measure:'500 g'}])));
  const query='Also add 200 g rice';
  const result=interpret(request([modelAction('add','rice','200 g',query)]),context(query,state(),{previousDraft}));
  assert.deepEqual(result.intent.pantry.map(row=>row.measure).sort(),['200 g','500 g']);
  const correction='Actually add 300 g rice instead';
  const revised=interpret(request([modelAction('add','rice','300 g',correction)]),context(correction,state(),{previousDraft}));
  assert.deepEqual(revised.intent.pantry.map(row=>row.measure),['300 g']);
  const cancelled=interpret(request([modelAction('add','rice','500 g','')]),context("Don't add rice",state(),{previousDraft}));
  assert.deepEqual(cancelled.intent.pantry,[]);
});

test('malformed action drafts and altered attribution summaries never apply',async()=>{
  const data=input(intent([{kind:'add',name:'rice',measure:'200 g'}])),draft=await build(data);
  for(const patch of [{unresolved:[null]},{pantryChanges:null},{summary:['Different reviewed action.']}]){
    const changed={...draft,...patch};delete changed.reviewHash;changed.reviewHash=await assistantHash(changed);
    await assert.rejects(apply({...data,draft:changed}));
  }
});

test('cropped planning evidence cannot authorize a negated plan and negative pantry amounts cannot turn positive',()=>{
  assert.throws(()=>interpret(request([],{planningQuery:'plan Friday dinner'}),context('Do not plan Friday dinner; add 500 g rice')));
  assert.throws(()=>interpret(request([modelAction('add','rice','100 g','Add -100 g rice')]),context('Add -100 g rice')));
});

test('an absent requested cuisine, dish, or ingredient stays mandatory instead of falling back',async()=>{
  for(const query of ['Plan one Ethiopian dinner','Plan one dinner using artichokes','Make all dinners Ethiopian','Plan biryani']){
    const resolved=resolveChefPlanIntent(query,defaultPlanIntent(week,today),{},catalog).intent;
    assert.ok(resolved.recipeQuery,query);
    const draft=await buildChefPlanDraft({kitchen:state(),revision:5,catalog,intent:resolved});
    assert.equal(draft.changes.length,0,query);assert.ok(draft.unresolved.some(message=>message.includes(resolved.recipeQuery)),query);
  }
  for(const query of ['Plan three dinners for four people using food that expires soon','Plan two dinners with fewer groceries','Keep Friday and replace Thursday']){
    const resolved=resolveChefPlanIntent(query,defaultPlanIntent(week,today),{},catalog).intent;
    assert.equal(resolved.recipeQuery,undefined,query);
  }
});

test('assistant controls consume swaps, preserve reviewed quantities and Keep, and revoke saved replacements',async()=>{
  const kitchen=state();kitchen.meals[today]=createPlannedMeal(today,recipes[0]);
  const data=input(intent([],{planning:{...defaultPlanIntent(week,today),count:1,dates:[today],replaceDates:[today]}}),kitchen);
  const first=await build(data),chosen=first.planDraft.changes[0].meal.recipeId;
  assert.notEqual(chosen,kitchen.meals[today].recipeId);
  const editable=editableAssistantIntent(first);assert.deepEqual(editable.planning.replaceDates,[]);assert.deepEqual(editable.planning.authorizedReplacementDates,[today]);
  editable.planning.servings=4;
  const revised=await build({...data,intent:editable,previousDraft:first});
  assert.equal(revised.planDraft.changes[0].meal.recipeId,chosen);assert.equal(revised.planDraft.changes[0].meal.servings,4);
  const kept=editableAssistantIntent(revised);kept.planning=assistantKeep(assistantReplacement(kept.planning,today,true),today,true,true);
  assert.deepEqual(kept.planning.replaceDates,[]);
  const keptDraft=await build({...data,intent:kept,previousDraft:revised});
  assert.equal(keptDraft.planDraft.changes[0].meal.recipeId,chosen);assert.equal((await apply({...data,draft:keptDraft})).state.meals[today].recipeId,chosen);
  const revoked=editableAssistantIntent(keptDraft);revoked.planning=assistantReplacement(revoked.planning,today,false);
  assert.deepEqual(revoked.planning.authorizedReplacementDates,[]);
  const revokedDraft=await build({...data,intent:revoked,previousDraft:keptDraft});
  assert.equal(revokedDraft.planDraft.changes.length,0);assert.equal(kitchen.meals[today].recipeId,recipes[0].id);
  const reset=assistantDinnerCount(editable.planning,2);assert.deepEqual(reset.dates,[]);assert.deepEqual(reset.authorizedReplacementDates,[]);assert.equal(reset.count,2);
});

test('a used amount or new date never selects an otherwise ambiguous stock batch',async()=>{
  const kitchen=state([stock('small','rice','100 g','2026-11-05'),stock('large','rice','200 g','2026-11-09')]);
  for(const [query,action]of[
    ['Subtract 100 g rice',modelAction('subtract','rice','100 g','Subtract 100 g rice',{stockId:'small'})],
    ['Set rice use-by to 2026-11-09',modelAction('set_use_by','rice',null,'Set rice use-by to 2026-11-09',{stockId:'large',useBy:'2026-11-09',useBySpecified:true})],
  ]){
    const result=interpret(request([action]),context(query,kitchen));assert.equal(result.intent.pantry[0].stockId,undefined);
    const draft=await build(input(result.intent,kitchen));assert.ok(draft.unresolved.some(row=>row.blocking&&row.choices.length===2));
  }
  for(const [query,id]of[['Subtract 50 g rice from the 100 g batch','small'],['Subtract 50 g rice from batch large','large'],['Subtract 50 g rice from the batch expiring 2026-11-05','small']]){
    const result=interpret(request([modelAction('subtract','rice','50 g',query,{stockId:id})]),context(query,kitchen));assert.equal(result.intent.pantry[0].stockId,id,query);
  }
  const manual=await build(input(intent([{kind:'subtract',name:'rice',measure:'100 g',stockId:'small'}]),kitchen));assert.equal(manual.unresolved.length,0);assert.equal(manual.pantryChanges[0].before.id,'small');
});

test('model ingredient identities retain modifiers and word boundaries',()=>{
  for(const [query,name]of[['I used 100 g brown rice','rice'],['I used 100 g chicken stock','chicken'],['Add 100 g olive oil','oil'],['Add 100 g rice','ice']]){
    assert.throws(()=>interpret(request([modelAction(query.startsWith('Add')?'add':'subtract',name,'100 g',query)]),context(query)),query);
  }
  for(const name of ['brown rice','chicken stock','olive oil','red lentils']){
    const query=`Add 100 g ${name}`;assert.equal(interpret(request([modelAction('add',name,'100 g',query)]),context(query)).intent.pantry[0].name,name);
  }
});

test('omitted prior pantry actions retain their chronological place before a new follow-up operation',async()=>{
  const data=input(intent([{kind:'add',name:'rice',measure:'500 g'}]));
  const previousDraft=await build(data),query='Also subtract 100 g rice';
  const interpreted=interpret(request([modelAction('subtract','rice','100 g',query)]),context(query,state(),{previousDraft}));
  assert.deepEqual(interpreted.intent.pantry.map(row=>row.kind),['add','subtract']);
  const revised=await build({...data,intent:interpreted.intent,previousDraft});
  assert.equal(revised.unresolved.length,0);
  assert.equal((await apply({...data,draft:revised})).state.pantry[0].measure,'400 g');
});

test('negating removal does not cancel a previously reviewed purchase',async()=>{
  const previousDraft=await build(input(intent([{kind:'add',name:'rice',measure:'500 g'}])));
  const preserved=interpret(request(),context('Do not remove rice',state(),{previousDraft}));
  assert.deepEqual(preserved.intent.pantry,previousDraft.intent.pantry);
  const cancelled=interpret(request(),context('Do not add rice',state(),{previousDraft}));
  assert.deepEqual(cancelled.intent.pantry,[]);
});

test('a clarification can select newly proposed stock across revisions without retargeting after edits',async()=>{
  const data=input(intent([{kind:'add',name:'rice',measure:'500 g'},{kind:'add',name:'rice',measure:'200 g'},{kind:'subtract',name:'rice',measure:'100 g'}]),state(),{id:undefined});
  const first=await build(data),choices=first.unresolved.find(row=>row.actionIndex===2).choices;
  assert.equal(choices.length,2);
  const revisedIntent=structuredClone(first.intent);revisedIntent.pantry[2].stockId=choices[1].stockId;
  const revised=await build({...data,intent:revisedIntent,previousDraft:first});
  assert.equal(revised.unresolved.length,0);
  const result=await apply({...data,draft:revised});assert.deepEqual(result.state.pantry.map(row=>row.measure).sort(),['100 g','500 g']);
  const removed=structuredClone(revisedIntent);removed.pantry.splice(0,1);
  const afterRemoval=await build({...data,intent:removed,previousDraft:revised});
  assert.equal(afterRemoval.unresolved.length,0);assert.equal((await apply({...data,draft:afterRemoval})).state.pantry[0].measure,'100 g');
  const changed=structuredClone(revisedIntent);changed.pantry[1].measure='300 g';
  const afterEdit=await build({...data,intent:changed,previousDraft:revised});
  assert.ok(afterEdit.unresolved.some(row=>row.blocking));
});
