// Exercise the real DashboardView with synthetic data only. No Firebase initialization.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const babel=require('@babel/core'),{JSDOM}=require('jsdom');
const dom=new JSDOM('<div id="root"></div><div id="master-finished-goods"></div>',{url:'https://test.invalid'});
global.window=dom.window;global.document=dom.window.document;global.HTMLElement=dom.window.HTMLElement;
Object.defineProperty(global,'navigator',{value:dom.window.navigator,configurable:true});
global.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{createRoot}=require('react-dom/client'),{act,Simulate}=require('react-dom/test-utils');
const source=fs.readFileSync(path.join(__dirname,'../src/App.js'),'utf8');
const ast=babel.parseSync(source,{babelrc:false,configFile:false,parserOpts:{sourceType:'module',plugins:['jsx']}});
const names=new Set(['normalizeProductType','getProductLabel','getOrderProgress','compareFinishedProductGroups','groupDashboardProducts','PROCESS_STEPS']);
const functions=new Set(['DashboardView','DashboardProductBreakdown']);
const nodes=ast.program.body.filter(n=>n.type==='VariableDeclaration' && n.declarations.some(d=>names.has(d.id?.name)) || n.type==='FunctionDeclaration' && functions.has(n.id.name));
const selected=nodes.map(n=>source.slice(n.start,n.end)).join('\n');
let databaseCalls=0,scrollCalls=0;const navigation=[];
const noWrite=()=>{databaseCalls++;throw Error('Production access forbidden in fixture');};
HTMLElement.prototype.scrollIntoView=function(){scrollCalls++;};
const sandbox={React,console,...require('lucide-react'),Map,Set,document,window,
  getKST:()=> '2026-11-06 12:00:00',FinishedGoodsMaster:()=>null,getPackagingLot:item=>item.packLot || '',getTraceMixLot:item=>item.mixLot || item.productionLot || '',
  setDoc:noWrite,deleteDoc:noWrite,runTransaction:noWrite,fetch:noWrite,syncToGoogleSheets:noWrite,
  getDocRef:noWrite,getColRef:noWrite,db:{},serverTimestamp:noWrite};
vm.runInNewContext(babel.transformSync(selected+'\nthis.api={Screen:DashboardView,group:groupDashboardProducts,progress:getOrderProgress};',{babelrc:false,configFile:false,presets:[require.resolve('@babel/preset-react')]}).code,sandbox);
const api=sandbox.api,plain=value=>JSON.parse(JSON.stringify(value));
const helperInput=[{type:'BL3',height:25,qty:40},{type:'345 BL3',height:'25',qty:'44'},{type:'234 BL3',height:25,qty:94},{type:'234 A1',height:16,qty:0},{qty:3}];
const helperBefore=JSON.stringify(helperInput),grouped=api.group(helperInput);
assert.equal(grouped.length,3);assert.equal(grouped.find(g=>g.type==='345 BL3').qty,84);assert.equal(grouped.reduce((s,g)=>s+g.qty,0),181);assert.equal(JSON.stringify(helperInput),helperBefore);
assert.deepEqual(plain(api.group([])),[]);
const make=(id,type,height,qty,currentStep,extra={})=>({id,type,height,qty,currentStep,mixLot:`MIX-${id}`,details:'unchanged history',...extra});
const wip=[
  make('wait','234 A1',16,192,'step1',{orderId:'need'}),make('press','234 A1',16,96,'step3',{orderId:'need'}),
  make('heat-a','345 BL3',25,300,'step5'),make('heat-b','234 B1',25,270,'step5'),make('inspect','345 B1',30,194,'step6'),
  make('dry-a','345 BL3',25,100,'step7'),make('dry-b','234 BL3',25,187,'step7_drying'),make('pack','345 BL3',25,193,'step8'),
  make('fg-a','345 BL3',25,300,'done'),make('fg-b','BL3','25',326,'done'),make('fg-c','345 BL3',30,99,'done'),
  make('fg-d','345 B1',25,489,'done'),make('fg-e','345 B1',30,197,'done'),make('fg-f','234 BL3',25,94,'done'),make('fg-g','234 B1',25,96,'done')];
const orders=[{id:'need',color:'234 A1',height:16,qty:576},{id:'cancel',color:'345 BL3',height:25,qty:999,status:'취소'}];
const ctx={showToast:noWrite,showConfirm:noWrite};
let props={inventory:[],wipList:wip,orderList:orders,inventoryHistory:[],shippingHistory:[],furnaces:{},setActiveStep:step=>navigation.push(step),ctx,masterSettings:{MATERIAL_TYPES:[]},isAdmin:false,user:null};
const snapshot=JSON.stringify({wip,orders});
const root=createRoot(document.getElementById('root'));
const render=async()=>{await act(async()=>root.render(React.createElement(api.Screen,props)));};
const byId=id=>document.querySelector(`[data-testid="${id}"]`);
const list=scope=>byId(`dashboard-products-${scope}`);
const rows=scope=>[...list(scope).querySelectorAll('[data-testid="dashboard-product-row"]')];
const total=scope=>Number(byId(`dashboard-total-${scope}`).textContent.replace(/[^0-9-]/g,''));
const stageTotal=step=>Number(byId(`dashboard-stage-${step}`).querySelector('[data-testid="dashboard-stage-total"]').textContent.replace(/[^0-9-]/g,''));
const click=async el=>{assert(el);await act(async()=>el.click());};
const expand=async scope=>{const toggle=list(scope).querySelector('button');if(toggle && toggle.getAttribute('aria-expanded')==='false')await click(toggle);};
const sumRows=scope=>rows(scope).reduce((sum,row)=>sum+Number(row.getAttribute('data-qty')),0);
(async()=>{
  await render();
  assert.deepEqual(['pending','wip','ready'].map(total),[288,1532,1601]);
  for(const scope of ['pending','wip','ready']){await expand(scope);assert.equal(sumRows(scope),total(scope));}
  assert.equal(rows('ready').length,6);
  assert.deepEqual(rows('ready').map(r=>r.getAttribute('data-product')+' '+r.getAttribute('data-height')),['345 BL3 25','345 BL3 30','345 B1 25','345 B1 30','234 BL3 25','234 B1 25']);
  assert.equal(rows('ready')[0].getAttribute('data-qty'),'626');
  assert.equal(rows('pending')[0].getAttribute('data-product'),'234 A1');assert.equal(rows('pending')[0].getAttribute('data-height'),'16');
  assert.match(byId('dashboard-warehouse-note').textContent,/192 EA/);
  const expectedStages={step2:0,step3:96,step4:0,step5:570,step5_shrink:0,step6:194,step7:287,step8:193};
  for(const [step,qty] of Object.entries(expectedStages)){assert.equal(stageTotal(step),qty);await expand(step);assert.equal(sumRows(step),qty);}
  assert.equal(document.querySelectorAll('[data-testid^="dashboard-stage-step"]').length,8);
  assert.equal(rows('step7').length,2);
  assert.equal(databaseCalls,0);assert.equal(navigation.length,0);assert.equal(JSON.stringify({wip,orders}),snapshot);
  console.log('PASS dashboard: 288/1532/1601 totals, per-product sum equality, all 8 original steps, drying combined and warehouse waiting included.');
  await click(byId('dashboard-stage-step5').querySelector('[data-testid="dashboard-stage-link"]'));assert.deepEqual(navigation,['step5']);
  await click(byId('dashboard-summary-ready'));assert.equal(scrollCalls,1);
  const extras=['234 A1','234 A2','345 A1','345 A2'].map((type,i)=>make('extra-'+i,type,16+i,10,'step5'));
  props={...props,wipList:[...wip,...extras,make('fg-extra-a','234 A1',16,10,'done'),make('fg-extra-b','234 A2',16,20,'done')]};
  await render();assert.equal(rows('step5').length,4);assert.equal(rows('ready').length,6);
  const navBefore=navigation.length,scrollBefore=scrollCalls;
  await expand('step5');assert.equal(rows('step5').length,6);assert.equal(sumRows('step5'),610);assert.equal(navigation.length,navBefore);
  await expand('ready');assert.equal(rows('ready').length,8);assert.equal(sumRows('ready'),1631);assert.equal(scrollCalls,scrollBefore);
  await click(list('step5').querySelector('button'));assert.equal(rows('step5').length,4);
  assert.equal(databaseCalls,0);
  console.log('PASS more/less lists: independent expansion, all products retained, no unintended stage navigation or finished-stock jump.');
  const progressWip=[make('linked','345 B1',25,30,'step3',{orderId:'o1'}),make('linked-done','345 B1',25,20,'done',{orderId:'o1'})];
  props={...props,wipList:progressWip,orderList:[{id:'o1',color:'345 B1',height:25,qty:100},{id:'o2',color:'B1',height:'25',qty:15},{id:'cancel',status:'취소',qty:999}],shippingHistory:[{id:'shipment',orderId:'o1',qty:10}]};
  await render();assert.equal(total('pending'),55);assert.equal(sumRows('pending'),55);assert.equal(rows('pending').length,1);assert.equal(total('wip'),30);assert.equal(total('ready'),20);
  if(source.includes('const remainderClosed =')){props={...props,orderList:[...props.orderList,{id:'closed',color:'234 A1',height:16,qty:500,status:'잔량마감'}]};await render();assert.equal(total('pending'),55);assert.equal(sumRows('pending'),55);}
  props={...props,wipList:progressWip.map(w=>w.id==='linked'?{...w,currentStep:'done',qty:25}:w)};
  await render();assert.equal(total('wip'),0);assert.equal(total('ready'),45);assert.equal(sumRows('ready'),45);assert.equal(stageTotal('step3'),0);
  props={...props,wipList:[],orderList:[],shippingHistory:[]};await render();
  assert.deepEqual(['pending','wip','ready'].map(total),[0,0,0]);for(const scope of ['pending','wip','ready',...Object.keys(expectedStages)])assert.equal(rows(scope).length,0);
  assert.equal(databaseCalls,0);assert.equal(JSON.stringify({wip,orders}),snapshot);
  await act(async()=>root.unmount());
  console.log('PASS remaining-order logic, cancellations, shipped quantities, runtime close guard, live stage changes and empty states; zero database/Sheets calls.');
})().catch(error=>{console.error(error);process.exit(1);});
