const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname,'..');
const code = fs.readFileSync(path.join(root,'src/sandbox/firestore.js'),'utf8');
const api = '({getFirestore,doc,collection,setDoc,onSnapshot,runTransaction,sandboxFetch})';
function setup() {
  const store = new Map();
  const context = vm.createContext({queueMicrotask,window:{sessionStorage:{
    getItem:key=>store.get(key),setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key),
  }}});
  return vm.runInContext(code.replaceAll('export const ','const ') + ';'+api,context);
}
const read = async (sdk,r) => {
  let result;
  await sdk.runTransaction(sdk.getFirestore(),async tx => { result = (await tx.get(r)).data(); });
  return JSON.parse(JSON.stringify(result));
};
test('preview imports only the offline adapter and shadows every Sheets request',()=>{
  const app = fs.readFileSync(path.join(root,'src/App.js'),'utf8');
  assert.doesNotMatch(app, /from ["']firebase\//);
  assert.match(app, /sandboxFetch as fetch/);
  assert.doesNotMatch(code, /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'vercel.json'))).headers[0].headers[0].value.includes("connect-src 'none'"),true);
});
test('sandbox transaction failure rolls back every write',async()=>{
  const sdk=setup(), db=sdk.getFirestore(), r=sdk.doc(db,'example','one');
  await sdk.setDoc(r,{qty:6});
  await assert.rejects(sdk.runTransaction(db,async tx=>{tx.update(r,{qty:0});throw Error('simulated failure');}));
  assert.deepEqual(await read(sdk,r),{qty:6});
});
test('sandbox retains unrelated records and serializes writes',async()=>{
  const sdk=setup(),db=sdk.getFirestore(),r=sdk.doc(db,'example','one'),other=sdk.doc(db,'example','two');
  await sdk.setDoc(r,{qty:0});await sdk.setDoc(other,{history:['old']});
  await Promise.all([1,2,3].map(()=>sdk.runTransaction(db,async tx=>{
    const snap=await tx.get(r);tx.update(r,{qty:snap.data().qty+1});
  })));
  assert.deepEqual(await read(sdk,r),{qty:3});
  assert.deepEqual(await read(sdk,other),{history:['old']});
  assert.equal((await sdk.sandboxFetch('https://invalid.example')).ok,true);
});
