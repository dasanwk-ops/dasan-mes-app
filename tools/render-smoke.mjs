// Component-construction test with a minimal hook stub. NOT a React/browser test.
// Requires TypeScript locally, or MES_TYPESCRIPT_PATH to an installed compiler.
import {createRequire} from 'node:module';import fs from 'node:fs';import vm from 'node:vm';import path from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
import * as status from '../src/mesProcessStatus.mjs';
import * as shrinkReview from '../src/mesShrinkReview.mjs';
import * as shrinkQueue from '../src/mesShrinkQueue.mjs';
import * as store from '../src/mesDatabase.mjs';import * as core from '../src/mesSafetyCore.mjs';import * as operations from '../src/mesOperations.mjs';import {makeDemoData} from '../src/mesDemoData.mjs';
const require=createRequire(import.meta.url),ts=require(process.env.MES_TYPESCRIPT_PATH||'typescript');const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root='artifacts/dasan-mes-app/public/data',db=store.createMemoryDatabase(makeDemoData(root));store.configureDatabase(db,{root,canWrite:()=>true,actor:()=> 'DEMO'});
let current;const effects=[];
const React={createElement:(type,props,...children)=>({type,props:props||{},children}),useState:(initial)=>{const i=current.n++,c=current;if(!(i in c.state))c.state[i]=typeof initial==='function'?initial():initial;return[c.state[i],v=>{c.state[i]=typeof v==='function'?v(c.state[i]):v;}];},useRef:v=>{const i=current.n++;return current.state[i]??(current.state[i]={current:v});},useEffect:(fn,deps)=>{effects.push(fn);},useMemo:fn=>fn(),Fragment:'Fragment'};
const modules={'react':{...React,default:React},'lucide-react':new Proxy({},{get:(_,name)=>function Icon(){return{name};}}),'./mesProcessStatus.mjs':status,'./mesShrinkReview.mjs':shrinkReview,'./mesShrinkQueue.mjs':shrinkQueue,'./mesDatabase.mjs':store,'./mesSafetyCore.mjs':core,'./mesOperations.mjs':operations,'./mesRuntime.mjs':{ROOT:root,MES_MODE:'demo',runtimeError:'',EXTERNAL_SYNC_ENABLED:false,LIVE_WRITES_ENABLED:false,getAuth:()=>({__mesDemo:true}),getFirestore:()=>db,onAuthStateChanged:()=>()=>{},signInAnonymously:()=>Promise.resolve({})}};
const source=fs.readFileSync(path.join(base,'src/App.js'),'utf8');
const names=[...source.matchAll(/^(?:export default )?function (\w+)/gm)].map(x=>x[1]);
const compiled=ts.transpileModule(source+'\nexports.__components = {'+names.join(',')+',DEFAULT_MASTER_SETTINGS};',{fileName:'App.jsx',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
const exports={};const sandbox={exports,require:n=>{if(!(n in modules))throw new Error(`Unexpected dependency ${n}`);return modules[n];},console,URLSearchParams,Intl,Date,Number,String,Math,Map,Set,Promise,window:{location:{search:'',hostname:'localhost'},confirm:()=>true,prompt:()=>null,addEventListener:()=>{},removeEventListener:()=>{}},document:{querySelector:()=>({}),getElementById:()=>null,createElement:()=>({}),head:{appendChild:()=>{}}},setTimeout:()=>0,clearTimeout:()=>{},navigator:{onLine:true},localStorage:{getItem:()=>null,setItem:()=>{}},fetch:()=>{throw new Error('Network is prohibited in smoke test');}};
vm.runInNewContext(compiled,sandbox,{filename:'App.transpiled.cjs'});
const list=c=>[...db.docs].filter(([p])=>p.startsWith(`${root}/${c}/`)).map(([,v])=>v);
const props={inventory:list('inventory'),inventoryHistory:[],wipList:list('wipList'),orderList:list('orderList'),shippingHistory:[],wipArchive:[],mesAudit:[],furnaces:db.docs.get(`${root}/equipment/furnaces`),dryingRoom:db.docs.get(`${root}/equipment/dryingRoom`),masterSettings:exports.__components.DEFAULT_MASTER_SETTINGS,setActiveStep:()=>{},ctx:{showToast:()=>{},showConfirm:()=>{},isAdmin:true}};
let tested=0;for(const name of names.filter(x=>x==='DasanMES'||x==='DashboardView'||x.startsWith('Step'))){current={n:0,state:[]};effects.length=0;const tree=exports.__components[name](props);assert.ok(tree,`${name} did not construct a tree`);console.log(`PASS component-construction: ${name}`);tested++;}
// Dashboard navigation callbacks resolve the provided navigation prop.
current={n:0,state:[]};let navigation='';const tree=exports.__components.DashboardView({...props,setActiveStep:v=>navigation=v});
const walk=t=>t&&typeof t==='object'?[t,...(t.children||[]).flat(Infinity).flatMap(walk)]:[];
const items=walk(tree).filter(n=>n.props?.onClick&&String(n.props?.className||'').includes('flex-1 flex flex-col items-center'));
assert.ok(items.length);items[0].props.onClick();assert.ok(navigation);
console.log(`PASS ${tested} component constructions and dashboard navigation; React effects, DOM and browser NOT tested.`);

// RC2 checks both the badge and the current option while a row is being edited.
const w005=props.wipList.find(w=>w.mixLot==='MIX-DEMO-005');
const assignedFurnaces=heating=>({'1':{isHeating:heating,slotData:{L1:{wipId:w005.id,qty:10}}}});
const textOf=t=>t===null||t===undefined?'':Array.isArray(t)?t.map(textOf).join(''):typeof t==='object'?textOf(t.children||[]):String(t);
for(const [heating,label] of [[false,'\uc804\uae30\ub85c \ubc30\uc815 (1\ud638\uae30)'],[true,'\uc5f4\ucc98\ub9ac \uc911 (1\ud638\uae30)']]){
  current={n:0,state:[]};
  const dashboard=exports.__components.DashboardView({...props,furnaces:assignedFurnaces(heating)});
  assert.ok(walk(dashboard).some(n=>n.type==='span'&&textOf(n)===label));
  current={n:0,state:[w005.id,{...w005}]};
  const editTree=exports.__components.DashboardView({...props,furnaces:assignedFurnaces(heating)});
  const selected=walk(editTree).find(n=>n.type==='option'&&n.props.value==='step5');
  assert.equal(textOf(selected),'\ud604\uc7ac: '+label);
  console.log(`PASS RC2 dashboard display and edit option: ${label}`);
}
