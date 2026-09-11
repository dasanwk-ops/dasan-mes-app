// NOT RUN in the supplied report: dependencies/emulator were unavailable.
// Run only using firebase emulators:exec --project demo-dasan-mes.
import assert from 'node:assert/strict';
import {initializeApp,deleteApp} from 'firebase/app';
import {getAuth,connectAuthEmulator,signInAnonymously} from 'firebase/auth';
import * as fs from 'firebase/firestore';
import {configureDatabase,installFirestoreDriver,runTransaction,doc} from '../../src/mesDatabase.mjs';
import {createOperations} from '../../src/mesOperations.mjs';
const project='demo-dasan-mes';
for(const [key,expected]of [['FIRESTORE_EMULATOR_HOST','127.0.0.1:8080'],['FIREBASE_AUTH_EMULATOR_HOST','127.0.0.1:9099']]){
  if(process.env[key]!==expected)throw new Error(`Refusing to run: ${key} must equal ${expected}. No cloud fallback.`);
}
if(process.env.GCLOUD_PROJECT && process.env.GCLOUD_PROJECT!==project)throw new Error('Refusing non-demo project.');
const app=initializeApp({projectId:project,apiKey:'demo-api-key',authDomain:`${project}.firebaseapp.com`},`native-test-${Date.now()}`);
const db=fs.getFirestore(app),auth=getAuth(app);
fs.connectFirestoreEmulator(db,'127.0.0.1',8080);connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
installFirestoreDriver(fs);
const root='artifacts/mes-safety-integration/public/data';
configureDatabase(db,{root,canWrite:()=>true,actor:()=>auth.currentUser?.uid||'TEST'});
const ops=createOperations(db,root,()=>true),ref=(c,id)=>doc(db,`${root}/${c}/${id}`);
try{
 await signInAnonymously(auth);
 const id=`w-${Date.now()}`,w={id,mixLot:`MIX-DEMO-${id}`,type:'345 BL3',height:'25',qty:10,currentStep:'step6',details:'NATIVE TEST',orderId:''};
 await fs.setDoc(ref('wipList',id),w);
 const results=await Promise.allSettled([ops.advance(w,'step7',{operator:'T'}),ops.advance(w,'step7',{operator:'T'})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 console.log('PASS native Firestore duplicate completion');
 const before=(await fs.getDocFromServer(ref('wipList',id))).data();
 const audits=(await fs.getDocsFromServer(fs.collection(db,`${root}/mesAudit`))).size;
 await assert.rejects(runTransaction(db,tx=>{tx.update(ref('wipList',id),{qty:9});tx.set(ref('denied','reject-me'),{test:true});}));
 assert.deepEqual((await fs.getDocFromServer(ref('wipList',id))).data(),before);
 assert.equal((await fs.getDocsFromServer(fs.collection(db,`${root}/mesAudit`))).size,audits);
 console.log('PASS native permission-denied rolls back stock, audit and control');
 await ops.cancelOrEdit(before,{cancel:true,operator:'T',reason:'native test'});
 assert.equal((await fs.getDocFromServer(ref('wipList',id))).exists(),false);
 assert.equal((await fs.getDocFromServer(ref('wipArchive',id))).data().qty,10);
 await assert.rejects(ops.advance(w,'step7',{operator:'T'}));
 console.log('PASS native archive plus stale-write rejection');
}finally{await fs.terminate(db);await deleteApp(app);}
