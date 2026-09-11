import { initializeApp } from 'firebase/app';
import { getAuth as realGetAuth, onAuthStateChanged as realOnAuthStateChanged, signInAnonymously as realSignInAnonymously, connectAuthEmulator } from 'firebase/auth';
import * as firestore from 'firebase/firestore';
import { createMemoryDatabase, configureDatabase, installFirestoreDriver } from './mesDatabase.mjs';
import { makeDemoData } from './mesDemoData.mjs';
import { modePolicy } from './mesModePolicy.mjs';
export const ROOT = 'artifacts/dasan-mes-app/public/data';
const envMode = process.env.REACT_APP_MES_MODE || 'demo';
const hostname = typeof window === 'undefined' ? '' : window.location.hostname;
const allowedHost = process.env.REACT_APP_MES_PRODUCTION_HOST || '';
const policy = modePolicy({mode:envMode,hostname,allowedHost,
  apiKey:process.env.REACT_APP_FIREBASE_API_KEY,authDomain:process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId:process.env.REACT_APP_FIREBASE_PROJECT_ID,allowWrites:process.env.REACT_APP_MES_ALLOW_WRITES==='true'});
export const runtimeError = policy.error;
export const MES_MODE = policy.mode;
export const LIVE_WRITES_ENABLED = policy.liveWrites;
export const EXTERNAL_SYNC_ENABLED = LIVE_WRITES_ENABLED && process.env.REACT_APP_MES_ENABLE_SHEETS === 'true';
installFirestoreDriver(firestore);
let db, auth;
if (MES_MODE === 'demo' || MES_MODE === 'blocked') {
  db = createMemoryDatabase(MES_MODE === 'demo' ? makeDemoData(ROOT) : {});
  auth = {__mesDemo:true};
} else {
  const isEmu = MES_MODE === 'emulator';
  const app = initializeApp(isEmu ? {apiKey:'demo-api-key',projectId:'demo-dasan-mes',authDomain:'demo-dasan-mes.firebaseapp.com'} : {
    apiKey:process.env.REACT_APP_FIREBASE_API_KEY,
    authDomain:process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId:process.env.REACT_APP_FIREBASE_PROJECT_ID
  });
  db = firestore.getFirestore(app); auth = realGetAuth(app);
  if (isEmu) { firestore.connectFirestoreEmulator(db,'127.0.0.1',8080); connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true}); }
}
configureDatabase(db,{root:ROOT,canWrite:()=>MES_MODE === 'demo'||MES_MODE === 'emulator'||LIVE_WRITES_ENABLED,actor:()=>auth.currentUser?.uid||'DEMO'});
export const getFirestore = () => db;
export const getAuth = () => auth;
export const signInAnonymously = a => a.__mesDemo ? Promise.resolve({user:{uid:'demo-local'}}) : realSignInAnonymously(a);
export function onAuthStateChanged(a,next) {
  if(!a.__mesDemo)return realOnAuthStateChanged(a,next);
  let closed=false;queueMicrotask(()=>{if(!closed)next({uid:'demo-local'});});return ()=>{closed=true;};
}
