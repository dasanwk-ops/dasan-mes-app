import React, { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, runTransaction, serverTimestamp, addDoc } from "firebase/firestore";
import { LayoutDashboard, Package, Beaker, BoxSelect, Cylinder, Flame, Microscope, Wind, Printer, Plus, ArrowRight, CheckCircle2, AlertCircle, ShoppingCart, Calculator, History, X, Layers, Split, Edit2, Trash2, Save, Play, Thermometer, Droplets, Archive, Truck, Search, Database, RefreshCcw, Boxes, Lock, Settings } from "lucide-react";

// ==========================================
// [1] 대한민국 시간(KST) 및 유틸리티 함수
// ==========================================
const KST_TIMEZONE = "Asia/Seoul";
const formatKST = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: KST_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
};
const getKST = () => formatKST();
const getKSTDateOnly = () => getKST().slice(2, 10).replace(/-/g, "");
const cloneDeep = (value) => JSON.parse(JSON.stringify(value));

// ==========================================
// 제품군(345 / 234) 표시 및 기존 데이터 호환 유틸리티
// 기존 데이터가 BL3처럼 색상만 저장되어 있으면 345 제품군으로 간주합니다.
// ==========================================
const normalizeProductType = (value = "") => {
  const raw = String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
  if (!raw) return "";
  if (/^(345|234)\s+/.test(raw)) return raw;
  return `345 ${raw}`;
};

const getProductShade = (value = "") => {
  const normalized = normalizeProductType(value);
  const parts = normalized.split(" ");
  return parts.length > 1 ? parts.slice(1).join(" ") : normalized;
};
const getProductLabel = (value = "") => normalizeProductType(value);

// ==========================================
// [2] TEST MES 안전 격리 환경
// ==========================================
// 이 파일은 TEST 전용입니다.
// - Firebase 프로젝트는 dasan-mes-test로 강제 고정합니다.
// - Firestore 내부 컬렉션명/경로는 양산과 동일하게 유지합니다.
// - Google Sheets 등 양산 외부 전송은 강제로 차단합니다.
// - 양산 Firebase projectId로 변경되면 앱 실행을 즉시 중단합니다.
const IS_TEST = true;
const MES_ENV = "test";

const firebaseConfig = {
  apiKey: "AIzaSyAhFnQLQGvkC7Fzq0C5w9o7th5fOBmu--8",
  authDomain: "dasan-mes-test.firebaseapp.com",
  projectId: "dasan-mes-test",
  storageBucket: "dasan-mes-test.firebasestorage.app",
  messagingSenderId: "41323517813",
  appId: "1:41323517813:web:c33e9386b0315a1f39653c",
};

// 🚨 TEST 안전장치: 어떤 배포 설정에서도 양산 Firebase 접속 금지
if (firebaseConfig.projectId !== "dasan-mes-test") {
  throw new Error(
    `[MES 안전차단] TEST MES는 dasan-mes-test Firebase만 사용할 수 있습니다. actual=${firebaseConfig.projectId}`
  );
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// 양산과 TEST의 내부 데이터 구조는 동일.
// 데이터 격리는 Firebase 프로젝트 자체로 수행합니다.
const appId = "dasan-mes-app";
const getColRef = (colName) => collection(db, "artifacts", appId, "public", "data", colName);
const getDocRef = (colName, docId) => doc(db, "artifacts", appId, "public", "data", colName, String(docId));

// ==========================================
// [3] TEST 외부 전송 차단
// ==========================================
const syncToGoogleSheets = async (orderList, wipList, inventoryHistory, shippingHistory, ctx) => {
  console.log("[TEST MES] 실제 Google Sheets 전송이 안전하게 차단되었습니다.");
  if (ctx) ctx.showToast("[TEST] Google Sheets 전송이 차단되었습니다.", "success");
  return;
};

const logProcessToGoogleSheet = async (stepId, wipItem, operator, extraData = {}) => {
  console.log(`[TEST MES 공정 로그 차단] ${stepId}`, wipItem, operator, extraData);
  return;
};

// ==========================================
// 발주 수량 통합 계산 엔진
// Source of Truth: 현재 WIP + 누적 출고 이력
// releasedQty는 기존 데이터 호환용으로만 남기고 잔량 계산에는 사용하지 않습니다.
// ==========================================
const getOrderProgress = (order, wipList = [], shippingHistory = []) => {
  const orderQty = Math.max(0, Number(order?.qty) || 0);
  const orderId = String(order?.id || "");

  const linkedWip = (wipList || []).filter(
    (w) => String(w.orderId || "") === orderId
  );
  const linkedShipping = (shippingHistory || []).filter(
    (h) => String(h.orderId || "") === orderId
  );

  const wipQty = linkedWip.reduce(
    (sum, w) => sum + Math.max(0, Number(w.qty) || 0),
    0
  );

  const finishedStockQty = linkedWip
    .filter((w) => w.currentStep === "done")
    .reduce((sum, w) => sum + Math.max(0, Number(w.qty) || 0), 0);

  const shippedQty = linkedShipping.reduce(
    (sum, h) => sum + Math.max(0, Number(h.qty) || 0),
    0
  );

  // 과거 데이터 중 이미 완전히 종료됐지만 WIP/출고 이력이 남아있지 않은 건 보호
  const legacyClosed =
    linkedWip.length === 0 &&
    linkedShipping.length === 0 &&
    ["완료", "출고완료"].includes(order?.status);

  const rawCoveredQty = legacyClosed ? orderQty : wipQty + shippedQty;
  const coveredQty = Math.min(orderQty, rawCoveredQty);
  const remainingQty = Math.max(0, orderQty - coveredQty);
  const overQty = Math.max(0, rawCoveredQty - orderQty);

  let status = "대기중";
  if (order?.status === "취소") status = "취소";
  else if (legacyClosed || (orderQty > 0 && shippedQty >= orderQty)) status = "출고완료";
  else if (orderQty > 0 && finishedStockQty + shippedQty >= orderQty) status = "생산완료";
  else if (orderQty > 0 && coveredQty >= orderQty) status = "생산중";
  else if (coveredQty > 0) status = "부분투입";

  return {
    orderQty,
    wipQty,
    finishedStockQty,
    shippedQty,
    rawCoveredQty,
    coveredQty,
    remainingQty,
    overQty,
    percent: orderQty > 0
      ? Math.min(100, Math.floor((coveredQty / orderQty) * 100))
      : 0,
    status,
  };
};


const DEFAULT_MASTER_SETTINGS = {
  MATERIAL_TYPES: ["4Y-W", "4Y-W-S", "4Y-Y", "5E-P", "4Y-G"],
  PRODUCT_COLORS: [
    "345 BL0", "345 BL1", "345 BL2", "345 BL3", "345 A1", "345 A2", "345 B1",
    "234 BL2", "234 BL3", "234 B1"
  ],
  PRODUCT_HEIGHTS: ["20", "22", "25", "30", "35"],
  WEIGHT_BY_HEIGHT: { 20: 502, 22: 553, 25: 628, 30: 754, 35: 879 },
  RATIO_BY_COLOR: {
    // 3:45 제품군: 기존 BOM 그대로 유지
    "345 BL0": { "4Y-W": 1.0,   "4Y-W-S": 0.0, "4Y-Y": 0.0,   "5E-P": 0.0,   "4Y-G": 0.0 },
    "345 BL1": { "4Y-W": 0.961, "4Y-W-S": 0.0, "4Y-Y": 0.03,  "5E-P": 0.004, "4Y-G": 0.005 },
    "345 BL2": { "4Y-W": 0.931, "4Y-W-S": 0.0, "4Y-Y": 0.055, "5E-P": 0.006, "4Y-G": 0.008 },
    "345 BL3": { "4Y-W": 0.915, "4Y-W-S": 0.0, "4Y-Y": 0.079, "5E-P": 0.006, "4Y-G": 0.0 },
    "345 A1":  { "4Y-W": 0.83,  "4Y-W-S": 0.0, "4Y-Y": 0.15,  "5E-P": 0.02,  "4Y-G": 0.0 },
    "345 A2":  { "4Y-W": 0.786, "4Y-W-S": 0.0, "4Y-Y": 0.174, "5E-P": 0.02,  "4Y-G": 0.02 },
    "345 B1":  { "4Y-W": 0.869, "4Y-W-S": 0.0, "4Y-Y": 0.12,  "5E-P": 0.011, "4Y-G": 0.0 },

    // 2:34 제품군: 4Y-W-S 전용 주원료 사용
    "234 BL2": { "4Y-W": 0.0, "4Y-W-S": 0.9565, "4Y-Y": 0.0390, "5E-P": 0.0045, "4Y-G": 0.0 },
    "234 BL3": { "4Y-W": 0.0, "4Y-W-S": 0.9380, "4Y-Y": 0.0560, "5E-P": 0.0060, "4Y-G": 0.0 },
    "234 B1":  { "4Y-W": 0.0, "4Y-W-S": 0.9004, "4Y-Y": 0.0920, "5E-P": 0.0076, "4Y-G": 0.0 },
  },
  TARGET_PRESSURE: { step3: "70", step4A: "250", step4B: "250" },
  TARGET_TEMPERATURE: { furnace1: "1050", furnace2: "1050" },
  SAFETY_THRESHOLD: { "4Y-W": "50", "4Y-W-S": "50", "4Y-Y": "50", "5E-P": "50", "4Y-G": "50" }
};

// 기존 MAIN Firebase 설정은 유지하면서 새 원재료/제품군만 안전하게 병합합니다.
// 기존 BL0~B1 키는 345 제품군으로 해석하여 저장된 BOM 값을 보존합니다.
const mergeMasterSettings = (loaded = {}) => {
  const merged = cloneDeep(DEFAULT_MASTER_SETTINGS);
  if (!loaded || typeof loaded !== "object") return merged;

  const loadedMaterialTypes = Array.isArray(loaded.MATERIAL_TYPES) ? loaded.MATERIAL_TYPES : [];
  merged.MATERIAL_TYPES = [
    ...DEFAULT_MASTER_SETTINGS.MATERIAL_TYPES,
    ...loadedMaterialTypes.filter((t) => !DEFAULT_MASTER_SETTINGS.MATERIAL_TYPES.includes(t)),
  ];

  merged.PRODUCT_COLORS = cloneDeep(DEFAULT_MASTER_SETTINGS.PRODUCT_COLORS);
  merged.PRODUCT_HEIGHTS = Array.isArray(loaded.PRODUCT_HEIGHTS) && loaded.PRODUCT_HEIGHTS.length > 0
    ? loaded.PRODUCT_HEIGHTS
    : cloneDeep(DEFAULT_MASTER_SETTINGS.PRODUCT_HEIGHTS);

  merged.WEIGHT_BY_HEIGHT = {
    ...DEFAULT_MASTER_SETTINGS.WEIGHT_BY_HEIGHT,
    ...(loaded.WEIGHT_BY_HEIGHT || {}),
  };
  merged.TARGET_PRESSURE = {
    ...DEFAULT_MASTER_SETTINGS.TARGET_PRESSURE,
    ...(loaded.TARGET_PRESSURE || {}),
  };
  merged.TARGET_TEMPERATURE = {
    ...DEFAULT_MASTER_SETTINGS.TARGET_TEMPERATURE,
    ...(loaded.TARGET_TEMPERATURE || {}),
  };
  merged.SAFETY_THRESHOLD = {
    ...DEFAULT_MASTER_SETTINGS.SAFETY_THRESHOLD,
    ...(loaded.SAFETY_THRESHOLD || {}),
  };

  const loadedRatios = loaded.RATIO_BY_COLOR || {};
  Object.entries(loadedRatios).forEach(([rawProduct, ratios]) => {
    const normalizedProduct = normalizeProductType(rawProduct);
    if (!merged.RATIO_BY_COLOR[normalizedProduct] || !ratios || typeof ratios !== "object") return;
    merged.RATIO_BY_COLOR[normalizedProduct] = {
      ...merged.RATIO_BY_COLOR[normalizedProduct],
      ...ratios,
    };
  });

  merged.PRODUCT_COLORS.forEach((product) => {
    if (!merged.RATIO_BY_COLOR[product]) merged.RATIO_BY_COLOR[product] = {};
    merged.MATERIAL_TYPES.forEach((mat) => {
      if (merged.RATIO_BY_COLOR[product][mat] === undefined) merged.RATIO_BY_COLOR[product][mat] = 0;
    });
  });

  return merged;
};

const getProductRatios = (settings, productType) => {
  const normalized = normalizeProductType(productType);
  const legacyShade = getProductShade(productType);
  return (
    settings?.RATIO_BY_COLOR?.[normalized] ||
    settings?.RATIO_BY_COLOR?.[legacyShade] ||
    DEFAULT_MASTER_SETTINGS.RATIO_BY_COLOR?.[normalized] ||
    { "4Y-W": 1.0 }
  );
};

const PROCESS_STEPS = [
  { id: "dashboard", name: "대시보드", icon: LayoutDashboard },
  { id: "step0", name: "발주 관리", icon: ShoppingCart },
  { id: "step1", name: "원재료 창고", icon: Package },
  { id: "step2", name: "혼합", icon: Beaker },
  { id: "step3", name: "1차 성형", icon: Boxes },
  { id: "step4", name: "2차 성형", icon: Cylinder },
  { id: "step5", name: "열처리", icon: Flame },
  { id: "step5_shrink", name: "수축률 측정", icon: Calculator }, // 🌟 공정 분리 신설
  { id: "step6", name: "검수/가공", icon: Microscope },
  { id: "step7", name: "건조", icon: Wind },
  { id: "step8", name: "포장 (라벨링)", icon: Printer },
  { id: "step9", name: "완제품 창고", icon: Archive },
  { id: "tracking", name: "로트 이력 추적", icon: Search },
];

const DEFAULT_FURNACES = {
  1: { isHeating: false, temp: "1050", operator: "", memo: "", slotData: {} },
  2: { isHeating: false, temp: "1050", operator: "", memo: "", slotData: {} },
  3: { isHeating: false },
  4: { isHeating: false },
};

const DEFAULT_DRYING_ROOM = { cartItems: [], temp: "60", humidity: "20", isDrying: false, operator: "", completionData: {}, dryingWipIds: [] };

const SyncInput = ({ value, onChange, ...props }) => {
  const [localVal, setLocalVal] = useState(value || "");
  useEffect(() => { setLocalVal(value || ""); }, [value]);
  return <input {...props} value={localVal} onChange={(e) => setLocalVal(e.target.value)} onBlur={() => onChange(localVal)} />;
};

export default function DasanMES() {
  const MASTER_PIN = "7777";
  const PROCESS_PIN = "15938";
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [pinInput, setPinInput] = useState("");

  const urlParams = new URLSearchParams(window.location.search);
  const initialStep = urlParams.get("step") || "dashboard";

  const [user, setUser] = useState(null);
  const [activeStep, setActiveStep] = useState(initialStep);
  const [toast, setToast] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [inventory, setInventory] = useState([]);
  const [inventoryHistory, setInventoryHistory] = useState([]);
  const [wipList, setWipList] = useState([]);
  const [orderList, setOrderList] = useState([]);
  const [shippingHistory, setShippingHistory] = useState([]);
  const [furnaces, setFurnaces] = useState(cloneDeep(DEFAULT_FURNACES));
  const [dryingRoom, setDryingRoom] = useState(cloneDeep(DEFAULT_DRYING_ROOM));
  const [masterSettings, setMasterSettings] = useState(DEFAULT_MASTER_SETTINGS);

  const prevSyncCount = useRef({ finished: 0, shipped: 0 });

  useEffect(() => {
    if (!isUnlocked) return;
    const currentFinished = wipList.filter((w) => w.currentStep === "done").length;
    const currentShipped = shippingHistory.length;
    if (currentFinished > prevSyncCount.current.finished || currentShipped > prevSyncCount.current.shipped) {
      syncToGoogleSheets(orderList, wipList, inventoryHistory, shippingHistory, null);
    }
    prevSyncCount.current = { finished: currentFinished, shipped: currentShipped };
  }, [wipList, shippingHistory, orderList, inventoryHistory, isUnlocked]);

  const showToast = (msg, type = "error") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };
  const showConfirm = (msg, onConfirm) => { setConfirmDialog({ msg, onConfirm }); };
  const ctx = { showToast, showConfirm };

  useEffect(() => {
    let meta = document.querySelector('meta[name="robots"]');
    if (!meta) { meta = document.createElement("meta"); meta.name = "robots"; document.head.appendChild(meta); }
    meta.content = "noindex, nofollow";
  }, []);

  useEffect(() => {
    signInAnonymously(auth);
    onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    if (!user || !isUnlocked) return;
    const setupListener = (col, setter) => onSnapshot(getColRef(col), (snap) => setter(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    setupListener("inventory", setInventory);
    setupListener("inventoryHistory", (d) => setInventoryHistory(d.sort((a, b) => b.id - a.id)));
    setupListener("wipList", setWipList);
    setupListener("orderList", (d) => setOrderList(d.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate))));
    setupListener("shippingHistory", (d) => setShippingHistory(d.sort((a, b) => b.id - a.id)));
    
    onSnapshot(getColRef("equipment"), (snap) => {
      snap.docs.forEach((d) => {
        if (d.id === "furnaces") {
          const loaded = d.data();
          const mergedFurnaces = cloneDeep(DEFAULT_FURNACES);
          Object.keys(mergedFurnaces).forEach(k => {
             if (loaded[k]) mergedFurnaces[k] = { ...mergedFurnaces[k], ...loaded[k] };
          });
          setFurnaces(mergedFurnaces);
        }
        if (d.id === "dryingRoom") setDryingRoom(d.data());
        if (d.id === "settings") {
            if(d.data() && Object.keys(d.data()).length > 0) setMasterSettings(mergeMasterSettings(d.data()));
        }
      });
    });
  }, [user, isUnlocked]);

  if (!isUnlocked) {
    return (
      <div className="flex h-screen bg-slate-900 text-white items-center justify-center flex-col relative overflow-hidden">
        {toast && <div className="absolute top-10 px-6 py-3 bg-red-500 text-white rounded-xl shadow-2xl font-bold animate-in fade-in slide-in-from-top-4">{toast.msg}</div>}
        <div className="bg-slate-800 p-10 rounded-3xl shadow-2xl flex flex-col items-center border border-slate-700 w-full max-w-sm">
          <div className="bg-indigo-500/20 p-4 rounded-full mb-6"><Lock className="w-10 h-10 text-indigo-400" /></div>
          <h1 className="text-2xl font-black mb-2 tracking-tight text-center">다산산업 TEST MES<br />보안 시스템</h1>
          <p className="text-slate-400 text-sm mb-8 text-center">허가된 관계자 외의 접근을 엄격히 금지합니다.</p>
          <form onSubmit={(e) => {
              e.preventDefault();
              if (pinInput === MASTER_PIN) { setIsUnlocked(true); setIsAdmin(true); } 
              else if (pinInput === PROCESS_PIN) {
                if (activeStep === "dashboard" || activeStep === "tracking") { showToast("해당 화면은 마스터 핀 번호가 필요합니다.", "error"); } 
                else { setIsUnlocked(true); setIsAdmin(false); }
              } else { showToast("접근 권한이 없습니다 (PIN 불일치)", "error"); }
            }} className="flex flex-col gap-4 w-full">
            <input type="password" value={pinInput} onChange={(e) => setPinInput(e.target.value)} className="text-slate-900 px-5 py-3.5 rounded-xl font-black outline-none text-center text-xl tracking-widest focus:ring-2 focus:ring-indigo-500" placeholder="PIN 번호" autoFocus />
            <button type="submit" className="bg-indigo-600 px-5 py-3.5 rounded-xl font-bold hover:bg-indigo-500 transition-colors shadow-lg shadow-indigo-900/50">MES 시스템 접속</button>
          </form>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    const props = { inventory, wipList, orderList, inventoryHistory, shippingHistory, furnaces, dryingRoom, masterSettings, setActiveStep, ctx };
    switch (activeStep) {
      case "dashboard": return <DashboardView {...props} />;
      case "step0": return <Step0OrderManagement {...props} />;
      case "step1": return <Step1MaterialWarehouse {...props} />;
      case "step2": return <Step2Mixing {...props} />;
      case "step3": return <Step3FirstMolding {...props} />;
      case "step4": return <Step4SecondMolding {...props} />;
      case "step5": return <Step5HeatTreatment {...props} />;
      case "step5_shrink": return <Step5_5Shrinkage {...props} />; // 🌟 수축률 컴포넌트 마운트
      case "step6": return <Step6Inspection {...props} />;
      case "step7": return <Step7Drying {...props} />;
      case "step8": return <Step8Packaging {...props} />;
      case "step9": return <Step9FinishedGoods {...props} />;
      case "tracking": return <StepTracking {...props} />;
      case "settings": return <Step10Settings {...props} />;
      default: return <DashboardView {...props} />;
    }
  };

  return (
    <div className="flex h-screen bg-slate-50 text-slate-800">
      {toast && <div className={`fixed top-6 right-6 px-6 py-4 rounded-xl shadow-2xl text-white font-black z-50 ${toast.type === "error" ? "bg-red-600" : "bg-green-600"}`}>{toast.msg}</div>}
      {confirmDialog && (
        <div className="fixed inset-0 bg-slate-900/60 z-50 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-white p-8 rounded-2xl shadow-2xl w-96">
            <h3 className="text-xl font-black mb-4 flex items-center"><AlertCircle className="w-6 h-6 mr-2 text-indigo-500" /> 확인 필요</h3>
            <p className="text-slate-600 mb-8 font-medium">{confirmDialog.msg}</p>
            <div className="flex justify-end space-x-3">
              <button onClick={() => setConfirmDialog(null)} className="px-5 py-2 bg-slate-100 rounded-xl font-bold">취소</button>
              <button onClick={() => { confirmDialog.onConfirm(); setConfirmDialog(null); }} className="px-5 py-2 bg-indigo-600 text-white rounded-xl font-bold">확인</button>
            </div>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="w-64 bg-slate-900 text-slate-300 flex flex-col shadow-xl z-20">
          <div className="p-5 bg-slate-950 border-b border-slate-800 text-center">
            <div className="text-xl font-bold text-white tracking-wide">다산산업 TEST MES</div>
            <div className="text-xs text-amber-400 mt-1">공정관리 TEST · 양산 DB 완전 분리</div>
          </div>
          <div className="flex-1 overflow-y-auto py-4">
            <ul className="space-y-1">
              {PROCESS_STEPS.map((step) => (
                <li key={step.id}>
                  <button onClick={() => setActiveStep(step.id)} className={`w-full flex items-center px-6 py-3 text-sm font-medium transition-colors ${activeStep === step.id ? "bg-blue-600 text-white shadow-md" : "hover:bg-slate-800"}`}>
                    <step.icon className={`w-5 h-5 mr-3 ${activeStep === step.id ? "text-blue-200" : "text-slate-500"}`} /> {step.name}
                  </button>
                </li>
              ))}
              <li className="mt-4 border-t border-slate-800 pt-4">
                  <button onClick={() => setActiveStep("settings")} className={`w-full flex items-center px-6 py-3 text-sm font-medium transition-colors ${activeStep === "settings" ? "bg-red-600 text-white shadow-md" : "hover:bg-slate-800 text-red-400"}`}>
                    <Settings className={`w-5 h-5 mr-3 ${activeStep === "settings" ? "text-white" : "text-red-400"}`} /> 마스터 환경설정
                  </button>
              </li>
            </ul>
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="bg-white border-b border-slate-200 px-8 py-5 flex justify-between items-center shadow-sm z-10">
          <div className="flex items-center">
            <h1 className="text-2xl font-bold text-slate-800">{PROCESS_STEPS.find((s) => s.id === activeStep)?.name}</h1>
            <span className="ml-4 bg-amber-100 text-amber-800 px-3 py-1 rounded-full text-xs font-black border border-amber-300">TEST 환경</span>
            {!isAdmin && <span className="ml-4 bg-orange-100 text-orange-700 px-3 py-1 rounded-full text-xs font-black border border-orange-200">현장 전용 모드</span>}
          </div>
          <div className="text-sm text-slate-600 bg-slate-100 px-3 py-1.5 rounded-full flex items-center font-bold">
            <span className="w-2 h-2 rounded-full bg-amber-500 mr-2 animate-pulse"></span> TEST Firebase: {firebaseConfig.projectId}
          </div>
        </header>
        <main className="flex-1 overflow-y-auto bg-slate-50 p-8">
          <div className="max-w-7xl mx-auto">{renderContent()}</div>
        </main>
      </div>
    </div>
  );
}

// ==========================================
// Dashboard View 
// ==========================================
function DashboardView({ inventory, wipList, orderList = [], inventoryHistory, shippingHistory, furnaces, setActiveStep, ctx, masterSettings }) {
  const stockForecast = React.useMemo(() => {
    const getBOM = (color, singleWeight, qty) => {
      const baseKg = (Number(singleWeight) * Number(qty)) / 1000;
      const totalKg = baseKg * 1.01 + 0.2;
      const ratios = getProductRatios(masterSettings, color);
      const req = {};
      for (const [mat, ratio] of Object.entries(ratios)) {
        if (ratio > 0) req[mat] = totalKg * ratio;
      }
      return req;
    };
    return masterSettings.MATERIAL_TYPES.map((type) => {
      const currentStock = inventory.filter((i) => i.type === type).reduce((sum, i) => sum + i.weight, 0);
      const reqFromOrders = orderList.reduce((sum, o) => {
        if (o.status === "취소") return sum;
        const { remainingQty } = getOrderProgress(o, wipList, shippingHistory);
        if (remainingQty <= 0) return sum;
        const bom = getBOM(o.color, o.singleWeight, remainingQty);
        return sum + (bom[type] || 0);
      }, 0);
     const reqFromPendingLots = (wipList || [])
  .filter((w) => ["step1", "step2"].includes(w.currentStep))
  .reduce((sum, w) => {
    const bom = getBOM(w.type, w.singleWeight || 628, w.qty);
    return sum + (bom[type] || 0);
  }, 0);
      const totalRequired = reqFromOrders + reqFromPendingLots;
      const expectedStock = currentStock - totalRequired;
      return { type, current: currentStock, required: totalRequired, expected: expectedStock, isShort: expectedStock < 0 };
    });
  }, [inventory, orderList, wipList, shippingHistory, masterSettings]);

  const pendingOrdersQty = orderList.reduce((sum, o) => {
    if (o.status === "취소") return sum;
    return sum + getOrderProgress(o, wipList, shippingHistory).remainingQty;
  }, 0);
  const wipQty = (wipList || []).filter((w) => w.currentStep !== "done").reduce((sum, w) => sum + (Number(w.qty) || 0), 0);
  const readyToShipQty = (wipList || []).filter((w) => w.currentStep === "done").reduce((sum, w) => sum + (Number(w.qty) || 0), 0);
  const pipelineSteps = PROCESS_STEPS.filter((s) => s.id.startsWith("step") && !["step0", "step1", "step9"].includes(s.id));
  const activeWipList = (wipList || []).filter((w) => w.currentStep !== "done");

  const [editingId, setEditingId] = React.useState(null);
  const [editData, setEditData] = React.useState({});
  const [editingInvId, setEditingInvId] = React.useState(null);
  const [editInvData, setEditInvData] = React.useState({});
  const [showInvHistory, setShowInvHistory] = React.useState(false);
  const [selectedMaterial, setSelectedMaterial] = React.useState(null);
  const [isInventoryAuditOpen, setIsInventoryAuditOpen] = React.useState(false);
  const [inventoryAuditData, setInventoryAuditData] = React.useState({
    type: masterSettings.MATERIAL_TYPES?.[0] || "",
    lot: "",
    actualWeight: "",
    date: getKST().split(" ")[0],
    operator: "",
    reason: "실사 재고 보정",
  });

  const WIP_STEPS = [
    { value: "step1", label: "소재창고 대기" },
    { value: "step2", label: "배합 대기" },
    { value: "step3", label: "1차 성형 대기" },
    { value: "step4", label: "2차 성형 대기" },
    { value: "step5", label: "열처리 대기" },
    { value: "step5_shrink", label: "수축률 측정 대기" },
    { value: "step6", label: "검수 대기" },
    { value: "step7", label: "건조 대기" },
    { value: "step7_drying", label: "건조 진행중" },
    { value: "step8", label: "포장 대기" },
  ];

  const handleSyncGoogleSheet = async () => { await syncToGoogleSheets(orderList, wipList, inventoryHistory, shippingHistory, ctx); };

  const handleSaveWip = async (wip) => {
    const safeQty = Number(editData.qty);
    if (!Number.isInteger(safeQty) || safeQty < 0) {
      return ctx.showToast("수량은 0 이상의 정수로 입력해주세요.", "error");
    }

    const targetStep = editData.currentStep || wip.currentStep;
    const currentIndex = WIP_STEPS.findIndex((s) => s.value === wip.currentStep);
    const targetIndex = WIP_STEPS.findIndex((s) => s.value === targetStep);
    const correctionReason = String(editData.correctionReason || "").trim();
    const qtyChanged = safeQty !== Number(wip.qty);

    // 대시보드 수정에서는 현재 공정보다 뒤 단계로 건너뛰는 것은 막습니다.
    if (currentIndex >= 0 && targetIndex > currentIndex) {
      return ctx.showToast(
        "대시보드에서는 현재 또는 이전 공정으로만 변경할 수 있습니다.",
        "error"
      );
    }

    // 작업자 오입력 보정은 반드시 사유를 남겨 추후 추적 가능하게 합니다.
    if (qtyChanged && !correctionReason) {
      return ctx.showToast(
        "수량을 수정할 때는 관리자 보정 사유를 입력해주세요.",
        "error"
      );
    }

    const saveChanges = async () => {
      try {
        await runTransaction(db, async (transaction) => {
          const wipRef = getDocRef("wipList", wip.id);
          const liveSnap = await transaction.get(wipRef);

          if (!liveSnap.exists()) {
            throw new Error("수정 대상 작업지시가 존재하지 않습니다.");
          }

          const live = liveSnap.data();
          const liveQty = Number(live.qty) || 0;
          const liveStep = live.currentStep;
          const structuralChange =
            safeQty !== liveQty || targetStep !== liveStep;

          // 전기로 슬롯에 이미 배정된 상태에서 WIP만 수정하면
          // 슬롯 합계와 WIP 수량이 달라지므로 수정 금지.
          if (structuralChange && liveStep === "step5") {
            const furnaceRef = getDocRef("equipment", "furnaces");
            const furnaceSnap = await transaction.get(furnaceRef);
            const liveFurnaces = furnaceSnap.exists() ? furnaceSnap.data() : {};

            let allocatedQty = 0;
            Object.values(liveFurnaces || {}).forEach((f) => {
              Object.values(f?.slotData || {}).forEach((slot) => {
                if (String(slot?.wipId || "") === String(wip.id)) {
                  allocatedQty += Number(slot?.qty) || 0;
                }
              });
            });

            if (allocatedQty > 0) {
              throw new Error(
                `전기로에 ${allocatedQty}EA가 이미 배정되어 있습니다. 가동 전이면 열처리 화면에서 슬롯 배정을 먼저 해제한 뒤 수정해주세요.`
              );
            }
          }

          // 수축률 측정대는 슬롯별 수량이 이후 최종 WIP 수량의 근거가 되므로
          // WIP만 수정하면 다음 단계에서 다시 원래 슬롯 합계로 덮어써집니다.
          if (structuralChange && liveStep === "step5_shrink") {
            const shrinkRef = getDocRef("equipment", "shrinkDesks");
            const shrinkSnap = await transaction.get(shrinkRef);
            const desks = shrinkSnap.exists() ? shrinkSnap.data() : {};

            let slotQty = 0;
            Object.values(desks || {}).forEach((desk) => {
              Object.values(desk?.slotData || {}).forEach((slot) => {
                if (String(slot?.wipId || "") === String(wip.id)) {
                  slotQty += Number(slot?.qty) || 0;
                }
              });
            });

            if (slotQty > 0) {
              throw new Error(
                `수축률 측정대에 슬롯 수량 ${slotQty}EA가 연결되어 있습니다. 이 단계는 슬롯별 수량을 함께 보정해야 하므로 WIP 단독 수정은 차단됩니다.`
              );
            }
          }

          const now = getKST();
          const notes = [];

          if (safeQty !== liveQty) {
            notes.push(
              `[${now}] [관리자 수량보정] ${liveQty}EA → ${safeQty}EA | 사유:${correctionReason}`
            );
          }

          if (targetStep !== liveStep) {
            const fromLabel =
              WIP_STEPS.find((s) => s.value === liveStep)?.label || liveStep;
            const toLabel =
              WIP_STEPS.find((s) => s.value === targetStep)?.label || targetStep;
            notes.push(
              `[${now}] [관리자 공정롤백] ${fromLabel} → ${toLabel}`
            );
          }

          const updateData = {
            qty: safeQty,
            currentStep: targetStep,
            shrinkageRate:
              editData.shrinkageRate || live.shrinkageRate || "",
            details:
              notes.length > 0
                ? `${live.details || ""}\n${notes.join("\n")}`
                : live.details || "",
          };

          // step1/step2는 아직 실제 배합 완료 전이므로 수량을 고치면
          // 배합 지시 중량도 새 수량 기준으로 다시 맞춥니다.
          if (
            safeQty !== liveQty &&
            ["step1", "step2"].includes(liveStep)
          ) {
            const totalWeight =
              safeQty > 0
                ? ((Number(live.singleWeight || 0) * safeQty) / 1000) *
                    1.01 +
                  0.2
                : 0;
            updateData.weight = totalWeight.toFixed(3);
          }

          if (safeQty !== liveQty) {
            updateData.lastQtyCorrection = {
              before: liveQty,
              after: safeQty,
              reason: correctionReason,
              correctedAt: now,
              correctedBy: "MASTER",
            };
          }

          transaction.update(wipRef, updateData);
        });

        setEditingId(null);
        setEditData({});
        ctx.showToast(
          targetStep !== wip.currentStep
            ? "관리자 보정 및 공정 롤백 완료"
            : qtyChanged
            ? "수량 보정 완료 — 발주 잔량에 자동 반영됩니다."
            : "수정 완료",
          "success"
        );
      } catch (e) {
        ctx.showToast(e?.message || "수정 실패", "error");
      }
    };

    if (targetStep !== wip.currentStep) {
      const fromLabel =
        WIP_STEPS.find((s) => s.value === wip.currentStep)?.label ||
        wip.currentStep;
      const toLabel =
        WIP_STEPS.find((s) => s.value === targetStep)?.label || targetStep;
      ctx.showConfirm(
        `${fromLabel} → ${toLabel}로 롤백하시겠습니까?\n\n※ 진행 상태만 변경되며 기존 공정 기록, 원재료 입출고 이력, 장비 데이터는 자동으로 삭제하거나 복원하지 않습니다.`,
        saveChanges
      );
      return;
    }

    if (qtyChanged) {
      ctx.showConfirm(
        `${wip.mixLot} 수량을 ${wip.qty}EA → ${safeQty}EA로 보정하시겠습니까?\n\n사유: ${correctionReason}\n발주 잔량은 보정 직후 자동 재계산됩니다.`,
        saveChanges
      );
      return;
    }

    await saveChanges();
  };

  const handleDeleteWip = (id) => {
    const target = (wipList || []).find((w) => w.id === id);
    if (!target) {
      return ctx.showToast("해당 작업지시를 찾을 수 없습니다.", "error");
    }

    // step1은 원재료가 실제 차감되기 전이라 삭제 가능.
    // 이후 공정은 원재료/장비/공정 이력이 연결되므로 강제 삭제 금지.
    if (target.currentStep !== "step1") {
      return ctx.showToast(
        "원재료 창고 이후의 작업은 강제 삭제할 수 없습니다. 수량 오입력은 '수정' 기능의 관리자 보정으로 처리해주세요.",
        "error"
      );
    }

    ctx.showConfirm(
      `${target.mixLot} 작업지시 ${target.qty}EA를 삭제하시겠습니까?\n삭제 즉시 해당 수량은 발주 잔량으로 자동 복구됩니다.`,
      async () => {
        try {
          await deleteDoc(getDocRef("wipList", id));
          ctx.showToast(
            "작업지시 삭제 완료 — 발주 잔량 자동 복구",
            "success"
          );
        } catch (e) {
          ctx.showToast("삭제 실패", "error");
        }
      }
    );
  };

  const handleSaveInv = async (item) => {
    const safeWeight = Number(editInvData.weight);
    const newLot = String(editInvData.lot || item.lot || "").trim().toUpperCase();
    const reason = String(editInvData.adjustReason || "").trim();
    const oldWeight = Number(item.weight) || 0;
    const oldLot = String(item.lot || "").trim().toUpperCase();
    const changed = safeWeight !== oldWeight || newLot !== oldLot;

    if (!newLot) return ctx.showToast("LOT 번호를 입력해주세요.", "error");
    if (!Number.isFinite(safeWeight) || safeWeight < 0) {
      return ctx.showToast("올바른 중량을 입력해주세요.", "error");
    }
    if (changed && !reason) {
      return ctx.showToast("재고 수정 시 보정 사유를 반드시 입력해주세요.", "error");
    }

    // 다른 살아있는 문서와 LOT가 겹치면 개별 수정 대신 실사보정에서 통합합니다.
    const duplicate = (inventory || []).find(
      (inv) =>
        inv.id !== item.id &&
        String(inv.lot || "").trim().toUpperCase() === newLot &&
        inv.type === item.type &&
        Number(inv.weight) > 0
    );
    if (newLot !== oldLot && duplicate) {
      return ctx.showToast(
        `같은 품목의 ${newLot} LOT가 이미 존재합니다. '실사 재고 보정 / LOT 복구' 기능으로 통합해주세요.`,
        "error"
      );
    }

    const save = async () => {
      try {
        await runTransaction(db, async (transaction) => {
          const invRef = getDocRef("inventory", item.id);
          const invSnap = await transaction.get(invRef);
          if (!invSnap.exists()) throw new Error("재고 LOT가 존재하지 않습니다.");

          const live = invSnap.data();
          const liveWeight = Number(live.weight) || 0;
          const liveLot = String(live.lot || "").trim().toUpperCase();
          const now = getKST();
          const finalStatus = safeWeight <= 0 ? "소진" : "실사보정";

          transaction.update(invRef, {
            lot: newLot,
            weight: safeWeight,
            status: finalStatus,
            lastInventoryAdjustment: {
              beforeWeight: liveWeight,
              afterWeight: safeWeight,
              beforeLot: liveLot,
              afterLot: newLot,
              reason,
              adjustedAt: now,
              adjustedBy: "MASTER",
            },
          });

          if (changed) {
            const histId = Date.now().toString() + Math.random().toString().slice(2, 7);
            transaction.set(getDocRef("inventoryHistory", histId), {
              id: histId,
              date: now.slice(0, 16),
              type: "ADJUST",
              materialType: live.type || item.type,
              lot: newLot,
              qty: Number((safeWeight - liveWeight).toFixed(3)),
              beforeWeight: liveWeight,
              afterWeight: safeWeight,
              note: `관리자 재고보정 | ${liveLot !== newLot ? `LOT:${liveLot}→${newLot} | ` : ""}${reason}`,
              operator: "MASTER",
              createdAt: serverTimestamp(),
            });
          }
        });

        setEditingInvId(null);
        setEditInvData({});
        ctx.showToast("재고 보정 완료 — 변경 이력이 보존되었습니다.", "success");
      } catch (e) {
        ctx.showToast(e?.message || "재고 수정 실패", "error");
      }
    };

    if (!changed) {
      setEditingInvId(null);
      setEditInvData({});
      return;
    }

    ctx.showConfirm(
      `${item.type} ${oldLot}\n${oldWeight.toFixed(3)}kg → ${safeWeight.toFixed(3)}kg로 보정하시겠습니까?\n\n사유: ${reason}`,
      save
    );
  };

  // 원재료 LOT 문서는 추적성 때문에 절대 Hard Delete 하지 않습니다.
  const handleDeleteInv = () => {
    ctx.showToast(
      "원재료 LOT 삭제는 안전장치로 차단되어 있습니다. 0kg 소진처리 또는 '실사 재고 보정 / LOT 복구'를 사용해주세요.",
      "error"
    );
  };

  // 입출고/보정 이력 역시 감사 추적성을 위해 삭제를 금지합니다.
  const handleDeleteInvHistory = () => {
    ctx.showToast(
      "원재료 이력 삭제는 안전장치로 차단되어 있습니다. 잘못된 재고는 새 '실사보정' 이력으로 정정해주세요.",
      "error"
    );
  };

  const resetInventoryAuditForm = () => {
    setInventoryAuditData({
      type: masterSettings.MATERIAL_TYPES?.[0] || "",
      lot: "",
      actualWeight: "",
      date: getKST().split(" ")[0],
      operator: "",
      reason: "실사 재고 보정",
    });
  };

  const handleInventoryAuditAdjust = async () => {
    const type = String(inventoryAuditData.type || "").trim();
    const lot = String(inventoryAuditData.lot || "").trim().toUpperCase();
    const actualWeight = Number(inventoryAuditData.actualWeight);
    const operator = String(inventoryAuditData.operator || "").trim();
    const reason = String(inventoryAuditData.reason || "").trim();
    const auditDate = inventoryAuditData.date || getKST().split(" ")[0];

    if (!type) return ctx.showToast("품목을 선택해주세요.", "error");
    if (!lot) return ctx.showToast("LOT 번호를 입력해주세요.", "error");
    if (!Number.isFinite(actualWeight) || actualWeight < 0) {
      return ctx.showToast("실재고 중량을 0 이상의 숫자로 입력해주세요.", "error");
    }
    if (!operator) return ctx.showToast("실사/보정 담당자를 입력해주세요.", "error");
    if (!reason) return ctx.showToast("보정 사유를 입력해주세요.", "error");

    const normalizedMatches = (inventory || []).filter(
      (inv) =>
        inv.type === type &&
        String(inv.lot || "").trim().toUpperCase() === lot
    );

    const otherTypeMatch = (inventory || []).find(
      (inv) =>
        inv.type !== type &&
        String(inv.lot || "").trim().toUpperCase() === lot &&
        Number(inv.weight) > 0
    );
    if (otherTypeMatch) {
      return ctx.showToast(
        `${lot} LOT가 현재 ${otherTypeMatch.type} 품목에 등록되어 있습니다. 품목 오등록 여부를 먼저 확인해주세요.`,
        "error"
      );
    }

    const currentTotal = normalizedMatches.reduce(
      (sum, inv) => sum + (Number(inv.weight) || 0),
      0
    );
    const delta = Number((actualWeight - currentTotal).toFixed(3));
    const docCount = normalizedMatches.length;

    const applyAudit = async () => {
      try {
        await runTransaction(db, async (transaction) => {
          // Firestore transaction은 READ를 먼저 끝낸 후 WRITE 합니다.
          const sortedMatches = [...normalizedMatches].sort((a, b) => {
            const da = String(a.date || "");
            const dbb = String(b.date || "");
            if (da !== dbb) return da.localeCompare(dbb);
            return String(a.id).localeCompare(String(b.id));
          });

          const liveDocs = [];
          for (const inv of sortedMatches) {
            const ref = getDocRef("inventory", inv.id);
            const snap = await transaction.get(ref);
            if (snap.exists()) liveDocs.push({ ref, data: snap.data(), id: inv.id });
          }

          const liveBeforeTotal = liveDocs.reduce(
            (sum, x) => sum + (Number(x.data.weight) || 0),
            0
          );
          const now = getKST();
          let primaryId = "";

          if (liveDocs.length === 0) {
            // 과거처럼 inventory 문서가 사라진 LOT도 대시보드에서 복구 가능.
            const newId = Date.now().toString() + Math.random().toString().slice(2, 7);
            primaryId = newId;
            transaction.set(getDocRef("inventory", newId), {
              id: newId,
              lot,
              type,
              weight: actualWeight,
              date: auditDate,
              status: actualWeight <= 0 ? "소진" : "실사복구",
              createdAt: serverTimestamp(),
              lastInventoryAdjustment: {
                beforeWeight: 0,
                afterWeight: actualWeight,
                reason,
                adjustedAt: now,
                adjustedBy: operator,
                mode: "LOT_RECOVERY",
              },
            });
          } else {
            // 같은 LOT가 여러 inventory 문서로 나뉘어 있어도 삭제하지 않고
            // 첫 문서에 실재고를 통합, 나머지는 0kg '실사통합'으로 보존.
            const primary = liveDocs[0];
            primaryId = primary.id;
            transaction.update(primary.ref, {
              lot,
              type,
              weight: actualWeight,
              status: actualWeight <= 0 ? "소진" : "실사보정",
              lastInventoryAdjustment: {
                beforeWeight: liveBeforeTotal,
                afterWeight: actualWeight,
                reason,
                adjustedAt: now,
                adjustedBy: operator,
                mode: liveDocs.length > 1 ? "LOT_CONSOLIDATION" : "STOCKTAKE",
              },
            });

            for (const extra of liveDocs.slice(1)) {
              transaction.update(extra.ref, {
                weight: 0,
                status: "실사통합",
                mergedInto: primary.id,
                lastInventoryAdjustment: {
                  beforeWeight: Number(extra.data.weight) || 0,
                  afterWeight: 0,
                  reason: `${reason} (동일 LOT 통합)`,
                  adjustedAt: now,
                  adjustedBy: operator,
                  mode: "LOT_CONSOLIDATION",
                },
              });
            }
          }

          const histId = Date.now().toString() + Math.random().toString().slice(2, 7);
          transaction.set(getDocRef("inventoryHistory", histId), {
            id: histId,
            date: now.slice(0, 16),
            type: "ADJUST",
            materialType: type,
            lot,
            qty: Number((actualWeight - liveBeforeTotal).toFixed(3)),
            beforeWeight: liveBeforeTotal,
            afterWeight: actualWeight,
            note: `실사 재고 보정 | ${reason} | 문서:${liveDocs.length || 0}→1(보존통합)`,
            operator,
            primaryInventoryId: primaryId,
            createdAt: serverTimestamp(),
          });
        });

        resetInventoryAuditForm();
        setIsInventoryAuditOpen(false);
        ctx.showToast(
          docCount === 0
            ? `${lot} 누락 LOT 복구 완료 (${actualWeight.toFixed(3)}kg)`
            : `${lot} 실사 재고 보정 완료 (${actualWeight.toFixed(3)}kg)`,
          "success"
        );
      } catch (e) {
        ctx.showToast(e?.message || "실사 재고 보정 실패", "error");
      }
    };

    ctx.showConfirm(
      `${type} ${lot}\n현재 MES 합계: ${currentTotal.toFixed(3)}kg (${docCount}개 문서)\n실사 재고: ${actualWeight.toFixed(3)}kg\n차이: ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}kg\n\n실사 기준으로 보정하시겠습니까?\n※ 기존 LOT 문서는 삭제하지 않습니다.`,
      applyAudit
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-6 rounded-xl shadow-sm border border-slate-100">
        <div>
          <h2 className="text-2xl font-black text-slate-800 tracking-tight">통합 관리자 대시보드</h2>
          <p className="text-slate-500 text-sm mt-1">내열 소재 생산 지시 및 공정 이력을 통합 관리합니다.</p>
        </div>
        <button onClick={handleSyncGoogleSheet} className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-5 py-2.5 rounded-lg shadow-sm font-bold transition-all">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg> 구글 시트 동기화
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-100 flex flex-col items-center">
          <div className="text-slate-500 text-xs font-bold mb-1">추가 생산 필요 수량</div>
          <div className="text-3xl font-black text-indigo-600">{pendingOrdersQty.toLocaleString()} EA</div>
        </div>
        <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-100 flex flex-col items-center">
          <div className="text-slate-500 text-xs font-bold mb-1">진행 중 공정 물량</div>
          <div className="text-3xl font-black text-blue-600">{wipQty.toLocaleString()} EA</div>
        </div>
        <div onClick={() => document.getElementById("master-finished-goods")?.scrollIntoView({ behavior: "smooth" })} className="bg-white rounded-xl p-6 shadow-sm border border-slate-100 flex flex-col items-center cursor-pointer hover:border-green-400 transition-all group relative overflow-hidden">
          <div className="text-slate-500 text-xs font-bold mb-1">출고대기 완제품</div>
          <div className="text-3xl font-black text-green-600">{readyToShipQty.toLocaleString()} EA</div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
        <h3 className="text-lg font-bold mb-6 text-slate-800 flex items-center"><ArrowRight className="w-5 h-5 mr-2 text-blue-600" /> 공정 상황 퀵 네비게이션</h3>
        <div className="flex justify-between items-start w-full">
          {pipelineSteps.map((step, idx) => {
  const dashboardStepMap = {
    step2: ["step2"],
    step3: ["step3"],
    step4: ["step4"],
    step5: ["step5"],
    step5_shrink: ["step5_shrink"],
    step6: ["step6"],
    step7: ["step7", "step7_drying"],
    step8: ["step8"],
  };

  const validSteps = dashboardStepMap[step.id] || [step.id];

  const count = wipList
    .filter((w) => validSteps.includes(w.currentStep))
    .reduce((sum, w) => sum + (Number(w.qty) || 0), 0);
            const Icon = step.icon;
            return (
              <div key={step.id} onClick={() => setActiveStep(step.id)} className="flex-1 flex flex-col items-center relative group cursor-pointer hover:bg-slate-50 rounded-xl py-2">
                {idx < pipelineSteps.length - 1 && <div className="absolute top-6 left-1/2 w-full h-0.5 bg-slate-100 -z-10"></div>}
                <div className={`w-10 h-10 rounded-2xl flex items-center justify-center mb-2 shadow-sm ${count > 0 ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-400"}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="text-center w-full">
                  <div className="text-[10px] font-bold text-slate-500 mb-0.5">{step.name}</div>
                  <div className={`text-sm font-black ${count > 0 ? "text-blue-700" : "text-slate-300"}`}>{count}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 space-y-6">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold text-slate-800">소재 창고 현황 및 필요 소요량 예측</h3>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button
              onClick={() => {
                if (!isInventoryAuditOpen) resetInventoryAuditForm();
                setIsInventoryAuditOpen(!isInventoryAuditOpen);
              }}
              className="text-xs font-black px-3 py-1.5 rounded border transition-colors shadow-sm bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700"
            >
              {isInventoryAuditOpen ? "실사 보정 닫기" : "실사 재고 보정 / LOT 복구"}
            </button>
            <button onClick={() => setShowInvHistory(!showInvHistory)} className="text-xs font-bold px-3 py-1.5 rounded border transition-colors shadow-sm bg-white text-slate-600 border-slate-300 hover:bg-slate-50">
              소진 LOT {showInvHistory ? "숨기기" : "포함"}
            </button>
            <span className="text-xs font-bold text-red-500 bg-red-50 px-2 py-1 rounded border border-red-100 uppercase">마스터 권한</span>
          </div>
        </div>

        {isInventoryAuditOpen && (
          <div className="bg-indigo-50 border-2 border-indigo-200 rounded-2xl p-5 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-end gap-4">
              <div className="flex-1 min-w-[140px]">
                <label className="block text-[11px] font-black text-slate-600 mb-1">품목</label>
                <select
                  value={inventoryAuditData.type}
                  onChange={(e) => setInventoryAuditData({ ...inventoryAuditData, type: e.target.value })}
                  className="w-full border-2 border-indigo-200 bg-white rounded-lg p-2.5 font-black text-indigo-700 outline-none focus:border-indigo-500"
                >
                  {masterSettings.MATERIAL_TYPES.map((mat) => <option key={mat} value={mat}>{mat}</option>)}
                </select>
              </div>
              <div className="flex-[1.4] min-w-[180px]">
                <label className="block text-[11px] font-black text-slate-600 mb-1">LOT No.</label>
                <input
                  type="text"
                  placeholder="예: EN2600011"
                  value={inventoryAuditData.lot}
                  onChange={(e) => setInventoryAuditData({ ...inventoryAuditData, lot: e.target.value.toUpperCase() })}
                  className="w-full border-2 border-indigo-200 bg-white rounded-lg p-2.5 font-mono font-black text-indigo-700 outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex-1 min-w-[140px]">
                <label className="block text-[11px] font-black text-slate-600 mb-1">실사 현재재고 (kg)</label>
                <input
                  type="number"
                  min="0"
                  step="0.001"
                  placeholder="0.000"
                  value={inventoryAuditData.actualWeight}
                  onChange={(e) => setInventoryAuditData({ ...inventoryAuditData, actualWeight: e.target.value })}
                  className="w-full border-2 border-indigo-200 bg-white rounded-lg p-2.5 text-right font-black text-indigo-700 outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex-1 min-w-[140px]">
                <label className="block text-[11px] font-black text-slate-600 mb-1">실사 기준일</label>
                <input
                  type="date"
                  value={inventoryAuditData.date}
                  onChange={(e) => setInventoryAuditData({ ...inventoryAuditData, date: e.target.value })}
                  className="w-full border-2 border-indigo-200 bg-white rounded-lg p-2.5 font-bold outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[180px_1fr_auto] gap-4 mt-4 items-end">
              <div>
                <label className="block text-[11px] font-black text-slate-600 mb-1">실사/보정 담당자</label>
                <input
                  type="text"
                  placeholder="성명"
                  value={inventoryAuditData.operator}
                  onChange={(e) => setInventoryAuditData({ ...inventoryAuditData, operator: e.target.value })}
                  className="w-full border-2 border-indigo-200 bg-white rounded-lg p-2.5 text-center font-bold outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-[11px] font-black text-slate-600 mb-1">보정 사유</label>
                <input
                  type="text"
                  placeholder="예: 2026-08-28 원재료 실사 기준 재고 보정"
                  value={inventoryAuditData.reason}
                  onChange={(e) => setInventoryAuditData({ ...inventoryAuditData, reason: e.target.value })}
                  className="w-full border-2 border-indigo-200 bg-white rounded-lg p-2.5 font-bold outline-none focus:border-indigo-500"
                />
              </div>
              <button
                onClick={handleInventoryAuditAdjust}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-lg font-black shadow-md whitespace-nowrap"
              >
                실사 재고로 보정
              </button>
            </div>

            {inventoryAuditData.lot && (() => {
              const auditLot = String(inventoryAuditData.lot || "").trim().toUpperCase();
              const matches = (inventory || []).filter(
                (inv) => inv.type === inventoryAuditData.type && String(inv.lot || "").trim().toUpperCase() === auditLot
              );
              const current = matches.reduce((sum, inv) => sum + (Number(inv.weight) || 0), 0);
              return (
                <div className={`mt-4 p-3 rounded-xl border text-xs font-bold ${matches.length === 0 ? "bg-orange-50 border-orange-200 text-orange-700" : "bg-white border-indigo-100 text-slate-600"}`}>
                  {matches.length === 0
                    ? `현재 MES에 ${auditLot} LOT 문서가 없습니다. 저장 시 누락 LOT를 새로 복구합니다.`
                    : `현재 MES ${auditLot}: ${current.toFixed(3)}kg / ${matches.length}개 문서 ${matches.length > 1 ? "(저장 시 한 LOT로 안전 통합, 기존 문서는 0kg로 보존)" : ""}`}
                </div>
              );
            })()}
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {stockForecast.map((item) => (
            <div key={item.type} onClick={() => setSelectedMaterial(selectedMaterial === item.type ? null : item.type)} className={`p-4 rounded-2xl border transition-all cursor-pointer ${selectedMaterial === item.type ? "ring-2 ring-indigo-500 shadow-md" : ""} ${item.isShort ? "bg-red-50 border-red-200" : "bg-slate-50 border-slate-100 hover:bg-slate-100"}`}>
              <div className="flex justify-between items-center mb-3">
                <span className="font-black text-slate-700 text-base">{item.type}</span>
                {item.isShort ? <span className="bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full font-black animate-pulse">부족</span> : <span className="bg-emerald-500 text-white text-[10px] px-2 py-0.5 rounded-full font-black">안전</span>}
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between items-baseline mb-1">
                  <span className="text-slate-400 font-bold text-[10px]">현 창고 실재고</span>
                  <span className="text-slate-900 font-black text-xl tracking-tighter">{item.current.toFixed(2)} <span className="text-[10px] font-bold text-slate-500 uppercase ml-0.5">kg</span></span>
                </div>
                <div className="flex justify-between text-[11px]"><span className="text-slate-400 font-bold">생산지시 소요예정</span><span className="text-orange-500 font-black">- {item.required.toFixed(2)} kg</span></div>
                <div className="pt-2 mt-1 border-t border-slate-200 flex justify-between items-end">
                  <span className="text-[10px] font-bold text-slate-400">투입 후 잔량</span>
                  <span className={`text-lg font-black tracking-tighter ${item.isShort ? "text-red-600" : "text-indigo-700"}`}>{item.expected.toFixed(2)} <span className="text-[10px]">kg</span></span>
                </div>
              </div>
            </div>
          ))}
        </div>

       <div className="overflow-x-auto max-h-[400px] border rounded-lg">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0 shadow-sm border-b">
              <tr><th className="px-4 py-3 text-center">입고일자</th><th className="px-4 py-3">소재 종류</th><th className="px-4 py-3">공급처 로트</th><th className="px-4 py-3 text-right">잔여 중량 (kg)</th><th className="px-4 py-3 text-center text-red-600">관리</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {selectedMaterial ? (inventoryHistory || []).filter((h) => h.materialType === selectedMaterial).sort((a, b) => new Date(b.date) - new Date(a.date)).map((item) => (
                <tr key={item.id} className="bg-slate-50/50 hover:bg-slate-100 transition-colors">
                  <td className="px-4 py-3 text-slate-500 font-medium text-center">
                    {item.date}
                    <span className={`text-[10px] font-bold ml-1 ${item.type === "IN" ? "text-blue-500" : item.type === "ADJUST" ? "text-violet-600" : "text-red-400"}`}>
                      ({item.type === "IN" ? "입고" : item.type === "ADJUST" ? "보정" : "출고"})
                    </span>
                  </td>
                  <td className="px-4 py-3 font-black text-slate-800">{item.materialType}</td>
                  <td className="px-4 py-3 font-mono text-indigo-600">{item.lot}</td>
                  <td className={`px-4 py-3 text-right font-black ${item.type === "ADJUST" ? "text-violet-700" : ""}`}>{Number(item.qty || 0).toLocaleString()} <span className="text-[10px] font-normal text-slate-400">kg</span></td>
                  <td className="px-4 py-3 text-center"><span className="inline-flex items-center gap-1 text-[10px] font-black text-slate-500 bg-slate-100 border px-2 py-1 rounded"><Lock className="w-3 h-3" /> 이력보호</span></td>
                </tr>
              )) : inventory.filter((i) => (showInvHistory ? true : i.weight > 0)).map((item) => {
                const isEditing = editingInvId === item.id;
                const isDrained = item.weight <= 0;
                return (
                  <tr key={item.id} className={`transition-colors ${isDrained ? "bg-slate-50 opacity-60" : "hover:bg-slate-50"}`}>
                    <td className="px-4 py-3 text-slate-500 font-medium text-center">{item.date} {isDrained && <span className="text-[10px] text-red-400 ml-1">(소진)</span>}</td>
                    <td className="px-4 py-3 font-black text-slate-800">{item.type}</td>
                    <td className="px-4 py-3 font-mono text-indigo-600">{isEditing ? <input type="text" value={editInvData.lot} onChange={(e) => setEditInvData({ ...editInvData, lot: e.target.value })} className="border p-1 w-full rounded bg-orange-50 font-bold" /> : item.lot}</td>
                    <td className="px-4 py-3 text-right font-black">
                      {isEditing ? (
                        <div className="flex flex-col items-end gap-1">
                          <input type="number" step="0.001" min="0" value={editInvData.weight} onChange={(e) => setEditInvData({ ...editInvData, weight: e.target.value })} className="border p-1 w-28 text-right rounded bg-orange-50" />
                          <input type="text" placeholder="보정 사유 필수" value={editInvData.adjustReason || ""} onChange={(e) => setEditInvData({ ...editInvData, adjustReason: e.target.value })} className="border border-orange-200 p-1 w-44 text-[10px] rounded bg-orange-50" />
                        </div>
                      ) : Number(item.weight || 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex justify-center gap-1.5 items-center">
                        {isEditing ? (
                          <><button onClick={() => handleSaveInv(item)} className="bg-orange-500 text-white p-1.5 rounded shadow-sm">저장</button><button onClick={() => { setEditingInvId(null); setEditInvData({}); }} className="bg-slate-200 text-slate-700 p-1.5 rounded shadow-sm">취소</button></>
                        ) : (
                          <><button onClick={() => { setEditingInvId(item.id); setEditInvData({ ...item, adjustReason: "" }); }} className="text-slate-500 hover:text-indigo-600 p-1 bg-white border rounded shadow-sm">수정</button><span title="LOT 문서는 삭제되지 않습니다" className="inline-flex items-center gap-1 text-[10px] font-black text-slate-500 bg-slate-100 border px-2 py-1 rounded"><Lock className="w-3 h-3" /> 삭제보호</span></>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold flex items-center text-slate-800"><Layers className="w-5 h-5 mr-2 text-slate-400" /> 공정 진행 현황 상세 (마스터)</h3>
          <span className="text-xs font-bold text-red-500 bg-red-50 px-2 py-1 rounded border border-red-100 uppercase">마스터 권한</span>
        </div>
        <div className="overflow-x-auto max-h-[500px] border rounded-lg">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0 shadow-sm border-b">
              <tr><th className="px-4 py-3">내부 LOT</th><th className="px-4 py-3">분류</th><th className="px-4 py-3 text-center">수량</th><th className="px-4 py-3 text-center">수축률(%)</th><th className="px-4 py-3">진행 상태</th><th className="px-4 py-3 w-1/3 text-center">메모</th><th className="px-4 py-3 text-center text-red-600">관리</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activeWipList.map((wip) => {
                const isEditing = editingId === wip.id;
                const currentStepIndex = WIP_STEPS.findIndex((s) => s.value === wip.currentStep);
                const rollbackSteps = currentStepIndex >= 0 ? WIP_STEPS.slice(0, currentStepIndex + 1) : WIP_STEPS;
                return (
                  <tr key={wip.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-blue-600">{wip.mixLot}</td>
                    <td className="px-4 py-3 font-bold text-slate-800">{getProductLabel(wip.type)} {wip.height}T</td>
                    <td className="px-4 py-3 text-center font-bold">
                      {isEditing ? (
                        <div className="flex flex-col items-center gap-1">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={editData.qty}
                            onChange={(e) =>
                              setEditData({ ...editData, qty: e.target.value })
                            }
                            className="border p-1 w-20 text-center rounded bg-orange-50 font-black"
                          />
                          {Number(editData.qty) !== Number(wip.qty) && (
                            <input
                              type="text"
                              value={editData.correctionReason || ""}
                              onChange={(e) =>
                                setEditData({
                                  ...editData,
                                  correctionReason: e.target.value,
                                })
                              }
                              placeholder="수정 사유 필수"
                              className="border border-orange-300 p-1 w-32 text-[10px] rounded bg-orange-50"
                            />
                          )}
                        </div>
                      ) : (
                        wip.qty
                      )}
                    </td>
                    <td className="px-4 py-3 text-center font-bold text-indigo-600">
                      {isEditing ? <input type="number" step="0.01" value={editData.shrinkageRate || ""} onChange={(e) => setEditData({ ...editData, shrinkageRate: e.target.value })} className="border p-1 w-16 text-center rounded bg-orange-50 font-black" /> : wip.shrinkageRate || "0.00"}
                    </td>
                    <td className="px-4 py-3">
                      {isEditing ? (
                        <select
                          value={editData.currentStep || wip.currentStep}
                          onChange={(e) => setEditData({ ...editData, currentStep: e.target.value })}
                          className="border border-orange-300 bg-orange-50 rounded p-1.5 text-[11px] font-black text-orange-700 outline-none focus:border-orange-500"
                        >
                          {rollbackSteps.map((step) => (
                            <option key={step.value} value={step.value}>
                              {step.value === wip.currentStep ? `현재: ${step.label}` : `↩ ${step.label}`}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={`px-2 py-1 border rounded text-[10px] font-bold ${wip.currentStep.includes("heating") ? "bg-orange-50 text-orange-700" : "bg-white text-slate-600"}`}>
                          {WIP_STEPS.find((s) => s.value === wip.currentStep)?.label || "대기중"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 truncate max-w-[150px] text-center">{wip.details}</td>
                   <td className="px-4 py-3 text-center">
                      <div className="flex justify-center gap-1.5">
                        {isEditing ? (
                          <><button onClick={() => handleSaveWip(wip)} className="bg-orange-500 text-white p-1.5 rounded shadow-sm">저장</button><button onClick={() => setEditingId(null)} className="bg-slate-200 text-slate-700 p-1.5 rounded shadow-sm">취소</button></>
                        ) : (
                          <><button onClick={() => { setEditingId(wip.id); setEditData({ ...wip, correctionReason: "" }); }} className="text-slate-500 hover:text-indigo-600 p-1 bg-white border rounded shadow-sm">수정</button><button onClick={() => handleDeleteWip(wip.id)} className="text-red-400 hover:bg-red-500 hover:text-white p-1 bg-white border rounded shadow-sm transition-colors">삭제</button></>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// Step 0: Order Management 
// ==========================================
function Step0OrderManagement({ orderList, wipList, shippingHistory, masterSettings, ctx }) {
  const [newOrder, setNewOrder] = useState({ date: getKST().split(" ")[0], color: "345 BL3", height: "25", singleWeight: masterSettings.WEIGHT_BY_HEIGHT["25"] || 628, qty: 100 });
  const [editingId, setEditingId] = useState(null);
  const [editData, setEditData] = useState({});
  const [releaseQtyMap, setReleaseQtyMap] = useState({});

  const calcBOM = (color, singleWeight, qty) => {
    const baseKg = (singleWeight * parseInt(qty)) / 1000;
    const totalKg = baseKg * 1.01 + 0.2;
    const ratios = getProductRatios(masterSettings, color);
    const reqBOM = {};
    for (const [mat, ratio] of Object.entries(ratios)) { if (ratio > 0) reqBOM[mat] = totalKg * ratio; }
    return reqBOM;
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newOrder.qty || newOrder.qty <= 0) return;
    const sWeight = Number(newOrder.singleWeight) || masterSettings.WEIGHT_BY_HEIGHT[newOrder.height];
    const reqBOM = calcBOM(newOrder.color, sWeight, newOrder.qty);
    const newItem = {
      id: Date.now().toString(), orderNo: `ORD-${newOrder.date.replace(/-/g, "").slice(2)}-${Math.floor(Math.random() * 1000)}`,
      orderDate: newOrder.date, productCode: `HR-${getProductShade(newOrder.color)}${newOrder.height}`, color: normalizeProductType(newOrder.color), height: newOrder.height,
      singleWeight: sWeight, qty: parseInt(newOrder.qty), releasedQty: 0, reqBOM, status: "대기중", createdAt: serverTimestamp(),
    };
    try { await setDoc(getDocRef("orderList", newItem.id), newItem); ctx.showToast("생산 지시가 등록되었습니다.", "success"); } catch (err) { ctx.showToast("등록 실패", "error"); }
  };

  const handleReleaseToWIP = async (order) => {
    const inputQty = parseInt(releaseQtyMap[order.id]);
    const progress = getOrderProgress(order, wipList, shippingHistory);
    const remaining = progress.remainingQty;

    if (!inputQty || inputQty <= 0) {
      return ctx.showToast("투입할 수량을 입력해주세요.");
    }
    if (inputQty > remaining) {
      return ctx.showToast(
        `현재 추가 생산 필요 수량은 ${remaining}EA입니다.`,
        "error"
      );
    }

    ctx.showConfirm(
      `${getProductLabel(order.color)} ${order.height}T ${inputQty}개를 소재 창고로 보내시겠습니까?\n\n현재 추가 생산 필요: ${remaining}EA`,
      async () => {
        try {
          const newWipId =
            Date.now().toString() + Math.random().toString().slice(2, 6);

          // releasedQty를 잔량의 근거로 사용하지 않습니다.
          // WIP 생성 자체가 발주 확보수량으로 자동 집계됩니다.
          await setDoc(getDocRef("wipList", newWipId), {
            id: newWipId,
            orderId: order.id,
            mixLot: `MIX-${getKSTDateOnly()}-${
              Math.floor(Math.random() * 900) + 100
            }`,
            type: normalizeProductType(order.color),
            height: order.height,
            singleWeight: order.singleWeight,
            qty: inputQty,
            currentStep: "step1",
            details: `[${getKST()}] 지시분할투입 (원본:${order.orderNo})`,
          });

          setReleaseQtyMap({ ...releaseQtyMap, [order.id]: "" });
          ctx.showToast(
            `${inputQty}개 소재 창고로 전송 완료`,
            "success"
          );
          logProcessToGoogleSheet(
            "step0",
            {
              mixLot: `투입-${order.orderNo}`,
              type: normalizeProductType(order.color),
              height: order.height,
              qty: inputQty,
            },
            "시스템",
            { details: `[발주 투입] 원본번호: ${order.orderNo}` }
          );
        } catch (e) {
          ctx.showToast("투입 처리 중 오류 발생", "error");
        }
      }
    );
  };

  const handleDel = async (id) => {
    const linkedWipCount = (wipList || []).filter(
      (w) => String(w.orderId || "") === String(id)
    ).length;
    const linkedShippingCount = (shippingHistory || []).filter(
      (h) => String(h.orderId || "") === String(id)
    ).length;

    if (linkedWipCount > 0 || linkedShippingCount > 0) {
      return ctx.showToast(
        "생산 또는 출고 이력이 연결된 발주는 삭제할 수 없습니다.",
        "error"
      );
    }

    ctx.showConfirm("삭제하시겠습니까?", async () => {
      try {
        await deleteDoc(getDocRef("orderList", id));
        ctx.showToast("삭제됨", "success");
      } catch (e) {
        ctx.showToast("삭제 실패", "error");
      }
    });
  };

  const activeOrders = orderList.filter((o) => {
    if (o.status === "취소") return false;
    return getOrderProgress(o, wipList, shippingHistory).remainingQty > 0;
  });

  const pbBOM = calcBOM(newOrder.color, newOrder.singleWeight || masterSettings.WEIGHT_BY_HEIGHT[newOrder.height], newOrder.qty || 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="bg-white rounded-xl shadow-sm border p-6 lg:col-span-1 h-fit">
        <h3 className="text-lg font-bold mb-4 text-slate-800">신규 생산 지시 등록</h3>
        <form onSubmit={handleAdd} className="space-y-5">
          <div><label className="block text-sm font-medium mb-1">지시 일자</label><input type="date" required className="w-full border rounded-md p-2" value={newOrder.date} onChange={(e) => setNewOrder({ ...newOrder, date: e.target.value })} /></div>
          <div>
            <label className="block text-sm font-medium mb-2">분류</label>
            <div className="space-y-3">
              {["345", "234"].map((series) => (
                <div key={series} className="border rounded-lg p-3 bg-slate-50">
                  <div className="text-[11px] font-black text-slate-500 mb-2">{series} 제품군</div>
                  <div className="flex flex-wrap gap-2">
                    {masterSettings.PRODUCT_COLORS.filter((c) => c.startsWith(`${series} `)).map((c) => (
                      <button key={c} type="button" onClick={() => setNewOrder({ ...newOrder, color: c })} className={`px-3 py-1.5 rounded-md text-sm font-bold border ${newOrder.color === c ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-700"}`}>{c}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">내열 두께 (T)</label>
            <div className="flex flex-wrap gap-2">
              {masterSettings.PRODUCT_HEIGHTS.map((h) => (
                <button key={h} type="button" onClick={() => setNewOrder({ ...newOrder, height: h, singleWeight: masterSettings.WEIGHT_BY_HEIGHT[h] })} className={`px-3 py-1.5 rounded-md text-sm font-medium border ${newOrder.height === h ? "bg-indigo-600 text-white" : "bg-white"}`}>{h}T</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium mb-1">단중 (g)</label><input type="number" required min="1" className="w-full border rounded-md p-2 font-bold text-indigo-700 bg-indigo-50" value={newOrder.singleWeight || ""} onChange={(e) => setNewOrder({ ...newOrder, singleWeight: e.target.value })} /></div>
            <div><label className="block text-sm font-medium mb-1">수량 (EA)</label><input type="number" required min="1" className="w-full border rounded-md p-2" value={newOrder.qty} onChange={(e) => setNewOrder({ ...newOrder, qty: e.target.value })} /></div>
          </div>
          <div className="p-4 bg-indigo-50 rounded-lg border mt-4">
            <div className="text-xs font-semibold mb-2">예상 소재 소요량 (BOM)</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(pbBOM).map(([mat, kg]) => (
                <div key={mat} className="flex justify-between px-3 py-2 bg-white rounded border flex-1"><span className="font-bold text-xs">{mat}</span><span className="font-black text-indigo-700">{kg.toFixed(3)}kg</span></div>
              ))}
            </div>
          </div>
          <button type="submit" className="w-full bg-indigo-600 text-white py-2.5 rounded-md font-bold">생산 지시 등록</button>
        </form>
      </div>

      <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border p-6">
        <h3 className="text-lg font-bold mb-4">생산 지시 현황 및 공정 투입 관리</h3>
        <div className="overflow-x-auto max-h-[650px]">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="bg-slate-50 sticky top-0 text-xs text-slate-500 uppercase border-b">
              <tr><th className="px-4 py-3">지시정보</th><th className="px-4 py-3">전체/남은수량</th><th className="px-4 py-3">투입 진행률</th><th className="px-4 py-3 text-center">공정 투입</th><th className="px-4 py-3 text-center">관리</th></tr>
            </thead>
            <tbody>
              {activeOrders.map((order) => {
                const progress = getOrderProgress(order, wipList, shippingHistory);
                const released = progress.coveredQty;
                const remaining = progress.remainingQty;
                const percent = progress.percent;
                return (
                  <tr key={order.id} className="border-b hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-4"><div className="text-[10px] text-slate-400 font-mono mb-1">{order.orderNo}</div><div className="font-black text-slate-800 text-base">{getProductLabel(order.color)} {order.height}T</div></td>
                    <td className="px-4 py-4"><div className="font-bold text-slate-700">{order.qty} EA</div><div className="text-xs font-black text-orange-600">잔량: {remaining} EA</div></td>
                    <td className="px-4 py-4 min-w-[120px]">
                      <div className="flex items-center gap-2"><div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-indigo-500 transition-all" style={{ width: `${percent}%` }}></div></div><span className="text-[10px] font-black text-slate-500">{percent}%</span></div>
                      <div className="text-[10px] font-bold text-slate-400 mt-1">{progress.status}</div>
                      <div className="text-[9px] text-slate-400 mt-0.5">
                        공정/재고 {progress.wipQty} · 출고 {progress.shippedQty}
                        {progress.overQty > 0 ? ` · 초과생산 ${progress.overQty}` : ""}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center justify-center gap-2">
                        <input type="number" placeholder="수량" value={releaseQtyMap[order.id] || ""} onChange={(e) => setReleaseQtyMap({ ...releaseQtyMap, [order.id]: e.target.value })} className="w-20 border rounded p-1.5 text-center font-bold text-indigo-600 outline-none focus:border-indigo-400" />
                        <button onClick={() => handleReleaseToWIP(order)} className="bg-indigo-600 text-white px-3 py-1.5 rounded font-bold text-xs hover:bg-indigo-700 whitespace-nowrap">공정 투입</button>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-center">
                      <div className="flex justify-center gap-2"><button onClick={() => handleDel(order.id)} className="text-red-300 hover:text-red-600"><Trash2 className="w-4 h-4" /></button></div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// Step 1: Material Warehouse (배합 공정으로 이관만 담당)
// ==========================================
function Step1MaterialWarehouse({ inventory, inventoryHistory, wipList, masterSettings, ctx }) {
  const makeEmptyInboundItems = (types) =>
    types.map((t) => ({
      type: t,
      lots: Array.from({ length: 4 }, () => ({ lot: "", weight: "" })),
    }));

  const [inboundItems, setInboundItems] = useState(() => makeEmptyInboundItems(masterSettings.MATERIAL_TYPES));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [operators, setOperators] = useState({});
  const [detailModalType, setDetailModalType] = useState(null);
  const [detailModalTab, setDetailModalTab] = useState("lots");
  const pendingLots = (wipList || []).filter((w) => w.currentStep === "step1");

  useEffect(() => {
    if (!isModalOpen) setInboundItems(makeEmptyInboundItems(masterSettings.MATERIAL_TYPES));
  }, [masterSettings.MATERIAL_TYPES, isModalOpen]);

  const updateInboundLot = (materialIdx, lotIdx, field, value) => {
    setInboundItems((prev) =>
      prev.map((item, mIdx) =>
        mIdx !== materialIdx
          ? item
          : {
              ...item,
              lots: item.lots.map((lotItem, lIdx) =>
                lIdx !== lotIdx ? lotItem : { ...lotItem, [field]: value }
              ),
            }
      )
    );
  };

  const calcPartialBOM = (color, singleWeight, qty) => {
    const baseKg = (Number(singleWeight) * Number(qty)) / 1000;
    const totalKg = baseKg * 1.01 + 0.2;
    const ratios = getProductRatios(masterSettings, color);
    const reqBOM = {};
    for (const [mat, ratio] of Object.entries(ratios)) { if (ratio > 0) reqBOM[mat] = totalKg * ratio; }
    return reqBOM;
  };

  const handleAdd = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const flatItems = inboundItems.flatMap((item) =>
      item.lots.map((lotItem) => ({ type: item.type, lot: lotItem.lot, weight: lotItem.weight }))
    );

    const incompleteItem = flatItems.find((item) => {
      const hasLot = Boolean(item.lot && item.lot.trim() !== "");
      const hasWeight = item.weight !== "" && item.weight !== null && item.weight !== undefined;
      return hasLot !== hasWeight;
    });

    if (incompleteItem) {
      return ctx.showToast(`[${incompleteItem.type}] LOT 번호와 중량을 한 쌍으로 입력해주세요.`, "error");
    }

    const validItems = flatItems.filter(
      (item) => item.lot && item.lot.trim() !== "" && item.weight !== "" && item.weight !== null && item.weight !== undefined
    );

    if (validItems.length === 0) {
      return ctx.showToast("로트번호와 중량을 모두 입력한 항목이 없습니다.", "error");
    }

    for (let item of validItems) {
      if (isNaN(parseFloat(item.weight)) || parseFloat(item.weight) <= 0) {
        return ctx.showToast(`[${item.type}] 올바른 중량 숫자를 입력해주세요.`, "error");
      }
    }

    const dStr = getKST().split(" ")[0];
    const timeStr = getKST().slice(0, 16);

    try {
      for (let item of validItems) {
        const wVal = parseFloat(item.weight);
        const newId = Date.now().toString() + Math.random().toString().slice(2, 7);
        const histId = Date.now().toString() + Math.random().toString().slice(2, 7);

        await setDoc(getDocRef("inventory", newId), {
          id: newId,
          lot: item.lot.trim(),
          type: item.type,
          weight: wVal,
          date: dStr,
          status: "입고완료",
          createdAt: serverTimestamp()
        });

        await setDoc(getDocRef("inventoryHistory", histId), {
          id: histId,
          date: timeStr,
          type: "IN",
          materialType: item.type,
          lot: item.lot.trim(),
          qty: wVal,
          note: "일괄입고",
          createdAt: serverTimestamp()
        });
      }

      setInboundItems(makeEmptyInboundItems(masterSettings.MATERIAL_TYPES));
      setIsModalOpen(false);
      ctx.showToast(`${validItems.length}개 LOT 입고 완료! 재고에 반영되었습니다.`, "success");
    } catch (err) {
      console.error("입고 처리 에러:", err);
      ctx.showToast(`입고 실패: ${err.message || err}`, "error");
    }
  };

  const handleOutboundLot = async (lot) => {
    const op = operators[lot.id];
    if (!op) return ctx.showToast("작업자 성명을 입력해주세요.", "error");
    const neededBOM = calcPartialBOM(lot.type, lot.singleWeight, lot.qty);
    const totalW = Object.values(neededBOM).reduce((a, b) => a + b, 0);

    try {
      await setDoc(getDocRef("wipList", lot.id), {
        ...lot,
        weight: totalW.toFixed(3),
        currentStep: "step2",
        details: `${lot.details || ""}\n[${getKST()}] [소재창고] 배합 대기로 이관 (담당:${op})`
      });
      ctx.showToast(`로트 ${lot.mixLot} 배합 공정으로 이관 완료`, "success");
      logProcessToGoogleSheet("step1", lot, op, { details: "배합 공정 이관 완료" });
    } catch (e) {
      console.error("배합실 이관 오류:", e);
      ctx.showToast(`오류 발생: ${e.message || e}`, "error");
    }
  };

  return (
    <div className="space-y-8 relative">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-bold text-slate-800 flex items-center"><Package className="w-5 h-5 mr-2 text-indigo-600" /> 소재 재고 요약</h3>
        {!isModalOpen && <button onClick={() => setIsModalOpen(true)} className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center hover:bg-indigo-700 transition-colors"><Plus className="w-4 h-4 mr-1" /> 일괄 입고 등록</button>}
      </div>

      {isModalOpen && (
        <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 mb-6 relative">
          <div className="flex justify-between items-center mb-6">
            <h4 className="font-black text-lg text-slate-800 flex items-center"><Plus className="w-5 h-5 mr-2 text-indigo-500" /> 소재 일괄 입고</h4>
            <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600 bg-slate-100 p-1.5 rounded-full"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {inboundItems.map((item, materialIdx) => (
              <div key={item.type} className="bg-slate-50 p-4 rounded-xl border border-slate-200 shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-black text-indigo-700 text-base">{item.type}</span>
                  <span className="text-[10px] font-bold text-slate-400 bg-white border px-2 py-1 rounded-full">최대 4 LOT</span>
                </div>
                <div className="space-y-2">
                  {item.lots.map((lotItem, lotIdx) => (
                    <div key={lotIdx} className="grid grid-cols-[28px_minmax(0,1fr)_120px] gap-2 items-center">
                      <span className="text-xs font-black text-slate-400 text-center">{lotIdx + 1}</span>
                      <input type="text" placeholder={`LOT ${lotIdx + 1} 번호`} className="w-full border border-slate-300 p-2.5 rounded-lg text-sm font-mono focus:border-indigo-400 outline-none" value={lotItem.lot} onChange={(e) => updateInboundLot(materialIdx, lotIdx, "lot", e.target.value)} />
                      <div className="relative">
                        <input type="number" step="0.001" placeholder="중량" className="w-full border border-slate-300 p-2.5 rounded-lg text-sm text-right font-bold pr-7 focus:border-indigo-400 outline-none" value={lotItem.weight} onChange={(e) => updateInboundLot(materialIdx, lotIdx, "weight", e.target.value)} />
                        <span className="absolute right-2 top-2.5 text-xs font-bold text-slate-400">kg</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex justify-end"><button onClick={handleAdd} className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-black shadow-md hover:bg-indigo-700 transition-transform flex items-center"><CheckCircle2 className="w-5 h-5 mr-2" /> 입고 처리</button></div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
        {masterSettings.MATERIAL_TYPES.map((type) => {
          const totalW = inventory.filter((i) => i.type === type).reduce((s, i) => s + i.weight, 0);
          const safetyThreshold = Number(masterSettings?.SAFETY_THRESHOLD?.[type]) || 50;
          const isWarning = totalW <= safetyThreshold;
          return (
            <div key={type} onClick={() => { setDetailModalType(type); setDetailModalTab("lots"); }} className={`rounded-2xl shadow-sm border bg-white p-6 cursor-pointer transition-all ${isWarning ? "border-red-300 bg-red-50/50" : "hover:border-indigo-400 hover:shadow-md"}`}>
              <div className="text-sm font-bold text-slate-500 mb-3 flex justify-between items-center"><span>{type}</span>{isWarning && <span className="text-[10px] text-red-500 bg-red-100 border border-red-200 px-1.5 py-0.5 rounded font-black animate-pulse">부족</span>}</div>
              <div className={`text-3xl font-black mb-4 ${isWarning ? "text-red-600" : "text-slate-800"}`}>{totalW.toLocaleString()} <span className="text-base font-bold text-slate-500">kg</span></div>
            </div>
          );
        })}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
        <div className="px-6 py-5 bg-slate-50 border-b"><h3 className="font-bold text-lg text-slate-800">생산 투입 로트 (출고 대기)</h3></div>
        <table className="w-full text-sm text-left">
          <thead className="bg-white border-b text-xs text-slate-500 uppercase tracking-wider">
            <tr><th className="px-6 py-4">로트 번호</th><th className="px-6 py-4">분류</th><th className="px-4 py-4 text-center">수량</th><th className="px-6 py-4">소요 소재 (BOM)</th><th className="px-6 py-4 text-center">작업</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pendingLots.length === 0 && <tr><td colSpan="5" className="text-center py-20 text-slate-400 font-medium italic">대기 중인 로트가 없습니다.</td></tr>}
            {pendingLots.map((lot) => {
              const neededBOM = calcPartialBOM(lot.type, lot.singleWeight, lot.qty);
              const totalBOMWeight = Object.values(neededBOM).reduce((a, b) => a + b, 0);
              return (
                <tr key={lot.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-6 py-4 font-mono font-bold text-indigo-600">{lot.mixLot}</td>
                  <td className="px-6 py-4 font-black">{getProductLabel(lot.type)} {lot.height}T</td>
                  <td className="px-4 py-4 font-black text-blue-600 text-center text-lg">{lot.qty} EA</td>
                  <td className="px-6 py-4">
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {Object.entries(neededBOM).map(([m, k]) => <div key={m} className="px-2 py-1 bg-indigo-50 border border-indigo-100 rounded text-[10px] font-bold text-indigo-700">{m}: {k.toFixed(3)}kg</div>)}
                      <div className="px-2.5 py-1 bg-emerald-100 border border-emerald-300 rounded text-[10px] font-black text-emerald-800 shadow-sm">합계: {totalBOMWeight.toFixed(3)} kg</div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-2 items-center">
                      <input type="text" placeholder="작업자" value={operators[lot.id] || ""} onChange={(e) => setOperators({ ...operators, [lot.id]: e.target.value })} className="border p-2 text-xs text-center font-bold rounded-lg w-24 outline-none focus:border-indigo-500" />
                      <button onClick={() => handleOutboundLot(lot)} className="bg-blue-600 text-white px-4 py-2 rounded-xl text-xs font-black hover:bg-blue-700 shadow-md">배합실 이관</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {detailModalType && (
        <div className="fixed inset-0 bg-slate-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex justify-between items-center p-6 border-b border-slate-200 bg-slate-50"><h3 className="text-xl font-black text-slate-800">{detailModalType} 상세 정보</h3><button onClick={() => setDetailModalType(null)} className="text-slate-400 hover:text-slate-600"><X className="w-6 h-6" /></button></div>
            <div className="flex border-b px-6 bg-white">
              <button onClick={() => setDetailModalTab("lots")} className={`py-3 px-4 font-bold text-sm border-b-2 transition-colors ${detailModalTab === "lots" ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}>로트별 잔여량</button>
              <button onClick={() => setDetailModalTab("history")} className={`py-3 px-4 font-bold text-sm border-b-2 transition-colors ${detailModalTab === "history" ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}>입출고 내역</button>
            </div>
            <div className="p-6 overflow-y-auto flex-1 bg-slate-50">
              {detailModalTab === "lots" && (
                <table className="w-full text-sm text-left bg-white border rounded-lg overflow-hidden shadow-sm">
                  <thead className="bg-slate-100 text-slate-500 text-xs uppercase"><tr><th className="p-3">입고일자</th><th className="p-3">로트 번호</th><th className="p-3 text-right">잔여 중량</th><th className="p-3 text-center">상태</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {inventory
                      .filter((i) => i.type === detailModalType)
                      .sort((a, b) => {
                        const aActive = Number(a.weight) > 0 ? 1 : 0;
                        const bActive = Number(b.weight) > 0 ? 1 : 0;
                        if (aActive !== bActive) return bActive - aActive;
                        return String(b.date || "").localeCompare(String(a.date || ""));
                      })
                      .map((item) => {
                        const isDepleted = Number(item.weight) <= 0;
                        return (
                          <tr key={item.id} className={isDepleted ? "bg-slate-50 opacity-60" : "hover:bg-slate-50"}>
                            <td className="p-3">{item.date}</td>
                            <td className="p-3 font-mono font-bold text-indigo-600">{item.lot}</td>
                            <td className="p-3 text-right font-black">{Number(item.weight || 0).toLocaleString()} kg</td>
                            <td className="p-3 text-center">
                              <span className={`px-2 py-1 rounded text-[10px] font-bold ${isDepleted ? "bg-slate-200 text-slate-600" : "bg-green-100 text-green-700"}`}>
                                {isDepleted ? (item.status || "소진") : (item.status || "사용중")}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    {inventory.filter((i) => i.type === detailModalType).length === 0 && <tr><td colSpan="4" className="text-center p-6 text-slate-400">등록된 LOT가 없습니다.</td></tr>}
                  </tbody>
                </table>
              )}
              {detailModalTab === "history" && (
                <table className="w-full text-sm text-left bg-white border rounded-lg overflow-hidden shadow-sm">
                  <thead className="bg-slate-100 text-slate-500 text-xs uppercase"><tr><th className="p-3">일시</th><th className="p-3 text-center">구분</th><th className="p-3">로트 번호</th><th className="p-3 text-right">수량</th><th className="p-3">비고</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {(inventoryHistory || []).filter((h) => h.materialType === detailModalType).map((h) => {
                      const historyLabel = h.type === "IN" ? "입고" : h.type === "ADJUST" ? "보정" : "출고";
                      const historyClass = h.type === "IN" ? "bg-blue-100 text-blue-700" : h.type === "ADJUST" ? "bg-violet-100 text-violet-700" : "bg-red-100 text-red-700";
                      return (
                        <tr key={h.id} className="hover:bg-slate-50">
                          <td className="p-3 text-xs text-slate-500">{h.date}</td>
                          <td className="p-3 text-center"><span className={`px-2 py-1 rounded text-[10px] font-bold ${historyClass}`}>{historyLabel}</span></td>
                          <td className="p-3 font-mono font-bold text-slate-700">{h.lot}</td>
                          <td className={`p-3 text-right font-black ${h.type === "ADJUST" ? "text-violet-700" : ""}`}>{Number(h.qty || 0).toLocaleString()} kg</td>
                          <td className="p-3 text-xs text-slate-600">{h.note}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// Step 2: Mixing (로트 지정 차감 및 실 생산수량 자동 반영)
// ==========================================
function Step2Mixing({ wipList, inventory, inventoryHistory, orderList, masterSettings, ctx }) {
  const pendingWip = (wipList || []).filter((w) => w.currentStep === "step2");
  const [activeMixId, setActiveMixId] = useState(null);
  const [isShortageMode, setIsShortageMode] = useState(false);
  const [selectedLots, setSelectedLots] = useState({});
  const [operator, setOperator] = useState("");
  const [specialNote, setSpecialNote] = useState("");

  // 부족 수량 입력용 상태
  const [completedBatches, setCompletedBatches] = useState("");
  const [residualMaterial, setResidualMaterial] = useState("");
  const [residualGrams, setResidualGrams] = useState("");

  useEffect(() => {
    if (!activeMixId && pendingWip.length > 0) {
      setActiveMixId(pendingWip[0].id);
      setIsShortageMode(false);
    } else if (activeMixId && !pendingWip.find((w) => w.id === activeMixId)) {
      setActiveMixId(pendingWip.length > 0 ? pendingWip[0].id : null);
      setIsShortageMode(false);
    }
  }, [pendingWip, activeMixId]);

  const activeJob = pendingWip.find((w) => w.id === activeMixId);
  const ratios = activeJob ? getProductRatios(masterSettings, activeJob.type) : {};
  const activeMaterials = Object.keys(ratios).filter((m) => ratios[m] > 0);

  useEffect(() => {
    if (activeMaterials.length > 0 && !activeMaterials.includes(residualMaterial)) {
      setResidualMaterial(activeMaterials[0]);
    }
  }, [activeJob, activeMaterials, residualMaterial]);

  // 기본 원본 수치
  const origTotalWeight = activeJob ? parseFloat(activeJob.weight) : 0;
  const fullBatches = Math.floor(origTotalWeight / 15);
  const remainder = Number((origTotalWeight % 15).toFixed(3));

  // 원료 부족(부분 배합) 시 실 배합량 및 생산 가능 수량 산출
  const batchesCount = parseInt(completedBatches) || 0;
  const resKg = (parseFloat(residualGrams) || 0) / 1000;
  const resMatRatio = ratios[residualMaterial] || 1;
  const residualCanisterWeight = resMatRatio > 0 ? resKg / resMatRatio : 0;
  const actualMixedTotalKg = (batchesCount * 15) + residualCanisterWeight;

  // 실제 생산 가능 수량 (EA) 및 부족 수량
  const actualQty = origTotalWeight > 0
    ? Math.min(activeJob?.qty || 0, Math.floor(((activeJob?.qty || 0) * actualMixedTotalKg) / origTotalWeight))
    : 0;
  const shortageQty = activeJob ? Math.max(0, activeJob.qty - actualQty) : 0;

  // 배합 완료 처리 (원재료 창고 실물 로트 차감 + 실 생산수량 반영)
  const handleCompleteMix = async () => {
    if (!activeJob) return ctx.showToast("진행할 배합 작업이 없습니다.", "error");
    if (!operator) return ctx.showToast("작업자 성명을 입력해주세요.", "error");

    for (const mat of activeMaterials) {
      if (!selectedLots[mat]) return ctx.showToast(`[${mat}] 원재료 로트를 선택해주세요.`, "error");
    }

    const finalMixedWeight = isShortageMode ? actualMixedTotalKg : origTotalWeight;
    const finalProducedQty = isShortageMode ? actualQty : activeJob.qty;

    if (!Number.isFinite(finalMixedWeight) || finalMixedWeight <= 0) {
      return ctx.showToast("배합 중량이 올바르지 않습니다.", "error");
    }
    if (finalProducedQty <= 0) return ctx.showToast("배합 수량이 올바르지 않습니다.", "error");
    if (isShortageMode && finalMixedWeight > origTotalWeight) {
      return ctx.showToast("실제 배합량이 원래 지시 중량을 초과할 수 없습니다.", "error");
    }

    // 소모 분말 중량 계산
    const consumedBOM = {};
    for (const mat of activeMaterials) {
      consumedBOM[mat] = Number((finalMixedWeight * ratios[mat]).toFixed(3));
    }

    // 재고 잔량 검증
    for (const mat of activeMaterials) {
      const targetLotId = selectedLots[mat];
      const invItem = (inventory || []).find((i) => i.id === targetLotId);
      if (!invItem || Number(invItem.weight) < consumedBOM[mat]) {
        return ctx.showToast(
          `선택한 [${mat}] 로트의 잔량이 부족합니다! (필요: ${consumedBOM[mat]}kg, 잔여: ${invItem?.weight || 0}kg)`,
          "error"
        );
      }
    }

  try {
  const curTime = getKST();

  // Firestore Transaction:
  // 재고 차감 + 출고이력 + WIP 이동을 한 번에 처리
  let recordDetails = "";

  await runTransaction(db, async (transaction) => {

    // ==========================================
    // 1. 필요한 문서 REF 준비
    // ==========================================
    const inventoryRefs = {};

    for (const mat of activeMaterials) {
      inventoryRefs[mat] = getDocRef(
        "inventory",
        selectedLots[mat]
      );
    }

    const wipRef = getDocRef("wipList", activeJob.id);


    // ==========================================
    // 2. READ 단계
    //    반드시 실제 Firestore 최신값 기준
    // ==========================================

    const inventorySnaps = {};

    for (const mat of activeMaterials) {
      inventorySnaps[mat] =
        await transaction.get(inventoryRefs[mat]);
    }

    const wipSnap = await transaction.get(wipRef);


    // ==========================================
    // 3. WIP 중복 처리 방지
    // ==========================================

    if (!wipSnap.exists()) {
      throw new Error("배합 대상 로트가 존재하지 않습니다.");
    }

    if (wipSnap.data().currentStep !== "step2") {
      throw new Error(
        "이미 다른 작업자가 처리한 배합 로트입니다."
      );
    }


    // ==========================================
    // 4. 실제 재고 최신값 검증
    // ==========================================

    const liveInventory = {};

    for (const mat of activeMaterials) {

      const snap = inventorySnaps[mat];

      if (!snap.exists()) {
        throw new Error(
          `[${mat}] 선택한 원재료 LOT가 존재하지 않습니다.`
        );
      }

      const invItem = snap.data();

      if (
        Number(invItem.weight) <
        Number(consumedBOM[mat])
      ) {
        throw new Error(
          `[${mat}] LOT ${invItem.lot} 재고 부족 ` +
          `(필요 ${consumedBOM[mat]}kg / ` +
          `현재 ${invItem.weight}kg)`
        );
      }

      liveInventory[mat] = invItem;
    }


    // ==========================================
    // 5. 사용 LOT 정보 생성
    // ==========================================

    const usedLotInfoStr = activeMaterials
      .map((mat) => {
        const invItem = liveInventory[mat];

        return (
          `${mat}:${invItem.lot}` +
          `(${consumedBOM[mat]}kg)`
        );
      })
      .join(", ");


    // ==========================================
    // 6. 원재료 실제 차감
    // ==========================================

    for (const mat of activeMaterials) {

      const invItem = liveInventory[mat];

      const remainW = Number(
        (
          Number(invItem.weight) -
          Number(consumedBOM[mat])
        ).toFixed(3)
      );

      // LOT 추적성 보호: 잔량이 0이 되어도 inventory 문서를 삭제하지 않습니다.
      // 과거처럼 삭제되면 입출고 이력은 남는데 현재 LOT가 사라지는 문제가 생길 수 있습니다.
      const safeRemainW = Math.max(0, remainW);
      transaction.update(
        inventoryRefs[mat],
        {
          weight: safeRemainW,
          status: safeRemainW <= 0 ? "소진" : "사용중",
          lastUsedAt: curTime
        }
      );


      // ----------------------------------------
      // 출고 이력 생성
      // ----------------------------------------

      const histId =
        Date.now().toString() +
        Math.random().toString().slice(2, 7);

      const histRef =
        getDocRef(
          "inventoryHistory",
          histId
        );

      transaction.set(
        histRef,
        {
          id: histId,
          date: curTime.slice(0, 16),
          type: "OUT",
          materialType: mat,
          lot: invItem.lot,
          qty: consumedBOM[mat],
          note: `배합투입(${activeJob.mixLot})`,
          createdAt: serverTimestamp()
        }
      );
    }

    // ==========================================
    // 7. WIP → Step 3 (실 생산수량이 발주 잔량에 자동 반영)

    // ==========================================

    const shortageNote =
      isShortageMode
        ? ` [원료부족 부분배합: ${shortageQty}EA 추가 생산 필요 자동 반영]`
        : "";

    recordDetails =
      `[${curTime}] [배합완료] ` +
      `투입로트(${usedLotInfoStr})` +
      `${shortageNote} | 담당:${operator} ` +
      `${specialNote ? `[메모:${specialNote}]` : ""}`;

    const currentWip = wipSnap.data();

    transaction.update(
      wipRef,
      {
        qty: finalProducedQty,
        weight: finalMixedWeight.toFixed(3),
        currentStep: "step3",
        details:
          `${currentWip.details || ""}\n` +
          recordDetails
      }
    );
  });


  // ==========================================
  // Transaction 성공 이후 화면 초기화
  // ==========================================

  setOperator("");
  setSpecialNote("");
  setIsShortageMode(false);
  setCompletedBatches("");
  setResidualGrams("");
  setSelectedLots({});

  ctx.showToast(
    `배합 완료! ${finalProducedQty}EA 1차 성형으로 이관되었습니다.`,
    "success"
  );

  logProcessToGoogleSheet(
    "step2",
    {
      ...activeJob,
      qty: finalProducedQty
    },
    operator,
    {
      details: recordDetails
    }
  );

} catch (err) {

  console.error(
    "배합 처리 오류:",
    err
  );

  ctx.showToast(
    `배합 처리 중 오류 발생: ${err.message || err}`,
    "error"
  );
}
  };

  return (
    <div className="space-y-8">
      {pendingWip.length > 1 && (
        <div className="bg-white border rounded-2xl p-4 shadow-sm">
          <div className="text-xs font-bold text-slate-500 mb-2">배합 대상 LOT 선택</div>
          <div className="flex flex-wrap gap-2">
            {pendingWip.map((w) => (
              <button
                key={w.id}
                onClick={() => { setActiveMixId(w.id); setSelectedLots({}); setIsShortageMode(false); setCompletedBatches(""); setResidualGrams(""); }}
                className={`px-3 py-2 rounded-lg text-xs font-black border ${activeMixId === w.id ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-200"}`}
              >
                {w.mixLot} · {getProductLabel(w.type)} {w.height}T
              </button>
            ))}
          </div>
        </div>
      )}

      {activeJob ? (
        <div className="bg-white rounded-2xl shadow-md border overflow-hidden">
          <div className="bg-indigo-600 px-6 py-4 flex justify-between items-center text-white">
            <h3 className="text-xl font-black flex items-center"><Beaker className="w-6 h-6 mr-2 opacity-80" /> 소재 배합 지시서 및 실물 차감</h3>
            <span className="bg-indigo-800 text-sm px-4 py-1.5 rounded-full font-mono font-bold shadow-inner">{activeJob.mixLot}</span>
          </div>

          <div className="flex border-b bg-slate-50">
            <button onClick={() => setIsShortageMode(false)} className={`flex-1 py-4 text-sm font-bold flex items-center justify-center ${!isShortageMode ? "bg-white text-indigo-700 border-b-2 border-indigo-600" : "text-slate-500"}`}>
              <Cylinder className="w-4 h-4 mr-2" /> 정상 전체 배합 (15kg 기준)
            </button>
            <button onClick={() => setIsShortageMode(true)} className={`flex-1 py-4 text-sm font-bold flex items-center justify-center ${isShortageMode ? "bg-orange-50 text-orange-700 border-b-2 border-orange-600" : "text-slate-500"}`}>
              <Split className="w-4 h-4 mr-2" /> 원료 부족 부분 배합 (추가 생산 자동 반영)
            </button>
          </div>

          <div className="p-8">
            <div className="flex justify-between mb-8 pb-6 border-b gap-6">
              <div>
                <div className="text-sm font-bold text-slate-500 mb-1">작업 대상 제품</div>
                <div className="text-3xl font-black flex items-center">
                  {getProductLabel(activeJob.type)} <span className="text-indigo-600 ml-2">{activeJob.height}T</span>
                  <span className="text-xl font-bold text-indigo-600 ml-3 bg-indigo-50 px-3 py-1 rounded-lg">지시: {activeJob.qty} EA</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold text-slate-500 mb-1">지시 총 배합 중량</div>
                <div className="text-4xl font-black">{origTotalWeight.toFixed(3)} <span className="text-xl font-medium text-slate-400">kg</span></div>
              </div>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 mb-8">
              <h4 className="font-black text-base text-slate-800 mb-4 flex items-center">
                <Package className="w-5 h-5 mr-2 text-indigo-600" /> 투입 원재료 LOT 번호 지정 (창고 재고에서 차감)
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {activeMaterials.map((mat) => {
                  const availableLots = (inventory || []).filter((i) => i.type === mat && Number(i.weight) > 0);
                  const selectedItem = availableLots.find((i) => i.id === selectedLots[mat]);
                  return (
                    <div key={mat} className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-black text-indigo-700 text-sm">{mat}</span>
                        {selectedItem && <span className="text-xs font-bold text-emerald-600">잔량: {Number(selectedItem.weight).toFixed(2)}kg</span>}
                      </div>
                      <select value={selectedLots[mat] || ""} onChange={(e) => setSelectedLots({ ...selectedLots, [mat]: e.target.value })} className="w-full border p-2 rounded-lg text-xs font-bold text-slate-700 bg-slate-50 focus:border-indigo-500 outline-none">
                        <option value="">LOT 번호 선택...</option>
                        {availableLots.map((item) => (
                          <option key={item.id} value={item.id}>LOT: {item.lot} ({Number(item.weight).toFixed(2)}kg)</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>

            {!isShortageMode ? (
              <>
                <div className="bg-slate-50 rounded-2xl p-6 border mb-8 flex justify-center gap-12">
                  <div className="text-center"><Cylinder className="w-12 h-12 text-indigo-500 mb-3 mx-auto" /><div className="font-bold text-slate-600">15kg 꽉 찬 통</div><div className="text-3xl font-black text-indigo-700 mt-1">{fullBatches} 통</div></div>
                  <div className="text-4xl font-black text-slate-300 mt-6">+</div>
                  <div className={`text-center ${remainder > 0 ? "" : "opacity-30 grayscale"}`}><Cylinder className="w-12 h-12 text-orange-400 mb-3 mx-auto" /><div className="font-bold text-slate-600">나머지 미달 통</div><div className="text-3xl font-black text-orange-600 mt-1">{remainder > 0 ? 1 : 0} 통</div>{remainder > 0 && <div className="text-sm font-black text-orange-700 mt-2">{remainder.toFixed(3)} kg</div>}</div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                  <div className="border-2 border-indigo-100 bg-indigo-50/40 rounded-2xl p-6 relative overflow-hidden shadow-sm">
                    <div className="absolute top-0 left-0 w-2 h-full bg-indigo-500"></div>
                    <h4 className="text-xl font-black text-indigo-900 mb-5 flex items-center"><span className="bg-indigo-600 text-white w-8 h-8 rounded-full inline-flex items-center justify-center text-base mr-3 shadow-md">{fullBatches}</span> 15kg 통 1개당 투입량</h4>
                    <div className="space-y-3">
                      {Object.entries(ratios).map(([mat, ratio]) => ratio > 0 ? (
                        <div key={mat} className="flex justify-between items-center bg-white p-4 rounded-xl shadow-sm border border-indigo-100"><span className="font-black text-slate-700 text-lg">{mat}</span><span className="font-black text-indigo-700 text-2xl">{(15 * ratio).toFixed(3)} <span className="text-sm text-slate-400">kg</span></span></div>
                      ) : null)}
                    </div>
                  </div>

                  {remainder > 0 ? (
                    <div className="border-2 border-orange-100 bg-orange-50/40 rounded-2xl p-6 relative overflow-hidden shadow-sm">
                      <div className="absolute top-0 left-0 w-2 h-full bg-orange-400"></div>
                      <h4 className="text-xl font-black text-orange-900 mb-5 flex items-center"><span className="bg-orange-500 text-white w-8 h-8 rounded-full inline-flex items-center justify-center text-base mr-3 shadow-md">1</span> 최종 미달 통 ({remainder.toFixed(3)}kg) 투입량</h4>
                      <div className="space-y-3">
                        {Object.entries(ratios).map(([mat, ratio]) => ratio > 0 ? (
                          <div key={mat} className="flex justify-between items-center bg-white p-4 rounded-xl shadow-sm border border-orange-100"><span className="font-black text-slate-700 text-lg">{mat}</span><span className="font-black text-orange-600 text-2xl">{(remainder * ratio).toFixed(3)} <span className="text-sm text-slate-400">kg</span></span></div>
                        ) : null)}
                      </div>
                    </div>
                  ) : <div className="border-2 border-dashed border-slate-200 bg-slate-50/80 rounded-2xl p-6 flex flex-col items-center justify-center text-slate-400 min-h-[250px]"><CheckCircle2 className="w-16 h-16 mb-3 opacity-30 text-indigo-500" /><div className="font-black text-lg text-slate-500">나머지 미달 통 없음</div></div>}
                </div>
              </>
            ) : (
              <div className="bg-orange-50 border border-orange-200 rounded-2xl p-6 mb-8">
                <div className="mb-6"><h4 className="text-lg font-black text-orange-800 flex items-center mb-1"><AlertCircle className="w-5 h-5 mr-2 text-orange-500" /> 원료 부족 시 실배합량 입력 (자동 롤백)</h4><p className="text-xs text-orange-600 font-bold">실제로 배합 완료된 통 수와 마지막 잔여 분말의 양을 입력하면 실 생산수량이 재계산되고 부족량은 발주관리의 추가 생산 필요 수량에 자동 반영됩니다.</p></div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 bg-white p-6 rounded-xl border border-orange-200 mb-6">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-2">혼합 완료된 15kg 통 수</label>
                    <div className="relative"><input type="number" min="0" max={fullBatches} placeholder="예: 5" value={completedBatches} onChange={(e) => setCompletedBatches(e.target.value)} className="w-full border-2 border-slate-300 rounded-lg p-2.5 font-black text-indigo-700 outline-none focus:border-orange-500 text-center text-lg pr-8" /><span className="absolute right-3 top-3 text-xs font-bold text-slate-400">통</span></div>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-2">잔여 분말 종류 선택</label>
                    <select value={residualMaterial} onChange={(e) => setResidualMaterial(e.target.value)} className="w-full border-2 border-slate-300 rounded-lg p-3 font-bold text-indigo-700 bg-slate-50 focus:border-orange-500 outline-none text-sm">
                      {activeMaterials.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-2">해당 분말 잔여 중량 (g)</label>
                    <div className="relative"><input type="number" min="0" step="1" placeholder="예: 300" value={residualGrams} onChange={(e) => setResidualGrams(e.target.value)} className="w-full border-2 border-slate-300 rounded-lg p-2.5 font-black text-orange-600 outline-none focus:border-orange-500 text-center text-lg pr-8" /><span className="absolute right-3 top-3 text-xs font-bold text-slate-400">g</span></div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="bg-white border-2 border-orange-300 rounded-xl p-4 text-center"><div className="text-xs font-bold text-slate-500 mb-1">실제 배합 완료 중량</div><div className="text-2xl font-black text-indigo-700">{actualMixedTotalKg.toFixed(3)} kg</div></div>
                  <div className="bg-white border-2 border-emerald-300 rounded-xl p-4 text-center"><div className="text-xs font-bold text-slate-500 mb-1">실제 생산 진행 수량</div><div className="text-2xl font-black text-emerald-600">{actualQty} EA</div></div>
                  <div className="bg-white border-2 border-red-300 rounded-xl p-4 text-center"><div className="text-xs font-bold text-slate-500 mb-1">추가 생산 필요 수량</div><div className="text-2xl font-black text-red-600">{shortageQty} EA</div></div>
                </div>
              </div>
            )}

            <div className="mt-8 flex justify-end gap-4 border-t pt-6">
              <input type="text" placeholder="특이사항 메모" className="border rounded-lg p-3 text-sm w-64 focus:border-indigo-400 outline-none" value={specialNote} onChange={(e) => setSpecialNote(e.target.value)} />
              <input type="text" placeholder="작업자 성명" className="border rounded-lg p-3 text-sm w-40 text-center font-bold focus:border-indigo-400 outline-none" value={operator} onChange={(e) => setOperator(e.target.value)} />
              <button onClick={handleCompleteMix} className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-xl font-black shadow flex items-center transition-transform hover:scale-105">
                <CheckCircle2 className="w-5 h-5 mr-2" /> 배합 완료 및 재고 차감
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border p-12 text-center text-slate-400">
          <Beaker className="w-16 h-16 mx-auto mb-4" />
          <h3 className="text-xl font-bold">진행할 배합 작업이 없습니다.</h3>
        </div>
      )}
    </div>
  );
}

// ==========================================
// Step 3: First Molding
// ==========================================
function Step3FirstMolding({ wipList, masterSettings, ctx }) { 
  const pendingWip = wipList.filter((w) => w.currentStep === "step3");
  const [formData, setFormData] = useState({});
  const handleDataChange = (id, f, v) => setFormData((p) => ({ ...p, [id]: { ...(p[id] || {}), [f]: v } }));
  const calcAvg = (v1, v2, v3, dec = 2) => v1 && v2 && v3 ? ((Number(v1) + Number(v2) + Number(v3)) / 3).toFixed(dec) : (0).toFixed(dec);

  const moveNext = async (id) => {
    const d = formData[id] || {};
    if (!d.operator) return ctx.showToast("작업자 성명을 입력해주세요.", "error");

    const wItem = wipList.find((w) => w.id === id);
    const aQty = parseInt(d.actualQty !== undefined ? d.actualQty : wItem.qty) || 0;
    const defQty = parseInt(d.defects) || 0;

    const dAvg = calcAvg(d.d1, d.d2, d.d3, 2);
    const hAvg = calcAvg(d.h1, d.h2, d.h3, 2);
    const wAvg = calcAvg(d.w1, d.w2, d.w3, 1);

    const defectStr = defQty > 0 ? ` [불량 ${defQty}개: ${d.defectReason || "사유미상"}]` : "";
    const noteStr = d.specialNote ? ` [메모: ${d.specialNote}]` : "";
    const recordDetails = `[${getKST()}] [1차성형] 압력:${d.pressure || 0} | 직경:${dAvg}mm | 높이:${hAvg}mm | 무게:${wAvg}g | 담당:${d.operator}${defectStr}${noteStr}`;

    try {
      await runTransaction(db, async (transaction) => {
        const docRef = getDocRef("wipList", id);
        const docSnap = await transaction.get(docRef);
        if (!docSnap.exists()) throw "이미 삭제된 로트입니다.";
        if (docSnap.data().currentStep !== "step3") throw "이미 다른 작업자가 처리한 로트입니다.";
        transaction.update(docRef, { qty: Math.max(0, aQty - defQty), currentStep: "step4", details: `${docSnap.data().details || ""}\n${recordDetails}` });
      });
      ctx.showToast("1차 성형 완료", "success");
      logProcessToGoogleSheet("step3", { ...wItem, qty: aQty - defQty }, d.operator, { defects: defQty, defectReason: d.defectReason || "-", conditions: `압력:${d.pressure || 0}ton`, measurements: `직경:${dAvg}mm, 높이:${hAvg}mm, 무게:${wAvg}g`, details: d.specialNote || "-" });
    } catch (err) { ctx.showToast(typeof err === "string" ? err : "오류 발생", "error"); }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
      <h3 className="text-lg font-bold mb-2">1차 성형 (프레스 건식성형)</h3>
      <p className="text-sm text-slate-500 mb-6">성형 압력 및 특이사항 입력 필수. 수축률 측정용 시편 (7T) 포함 성형.</p>
      <div className="space-y-6">
        {pendingWip.length === 0 && <div className="text-center py-12 text-slate-400 border-2 border-dashed border-slate-100 rounded-xl">대기 중인 반제품이 없습니다.</div>}
        {pendingWip.map((wip) => {
          const d = formData[wip.id] || {};
          const dAvg = calcAvg(d.d1, d.d2, d.d3, 2);
          const hAvg = calcAvg(d.h1, d.h2, d.h3, 2);
          const wAvg = calcAvg(d.w1, d.w2, d.w3, 1);
          const actualQtyValue = d.actualQty !== undefined ? d.actualQty : wip.qty;
          return (
            <div key={wip.id} className="border border-slate-200 rounded-xl p-5 bg-slate-50">
              <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center mb-5 border-b border-slate-200 pb-4 gap-4">
                <div className="flex items-center space-x-4">
                  <span className="font-mono font-bold text-indigo-700 bg-indigo-100 px-3 py-1.5 rounded-lg border border-indigo-200">{wip.mixLot}</span>
                  <span className="font-black text-slate-800 text-xl tracking-wide">{getProductLabel(wip.type)}<span className="text-indigo-600 ml-1">{wip.height}T</span></span>
                  <div className="flex items-center bg-white border border-slate-300 rounded-lg shadow-sm px-3 py-1.5">
                    <span className="text-xs font-bold text-slate-500 mr-2 whitespace-nowrap">실 성형수량</span>
                    <input type="number" min="1" value={actualQtyValue} onChange={(e) => handleDataChange(wip.id, "actualQty", e.target.value)} className="w-16 text-center font-black text-indigo-700 outline-none bg-transparent" />
                    <span className="text-xs font-bold text-slate-500 ml-1">EA</span>
                  </div>
                </div>
                <div className="flex items-center space-x-3 w-full xl:w-auto">
                  <label className="flex items-center space-x-2 text-sm font-bold text-slate-700 bg-white px-3 py-2 rounded-lg border border-slate-200 shadow-sm cursor-pointer whitespace-nowrap"><input type="checkbox" className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4" defaultChecked /><span>수축률 시편 포함</span></label>
                  <div className="relative flex-1 xl:flex-none">
                    <input type="text" placeholder="작업자 성명" value={d.operator || ""} onChange={(e) => handleDataChange(wip.id, "operator", e.target.value)} className={`border rounded-lg p-2 text-sm w-full xl:w-32 text-center font-bold shadow-sm focus:ring-2 outline-none ${d.error ? "border-red-400 bg-red-50 focus:ring-red-200" : "border-slate-300 focus:border-indigo-500 focus:ring-indigo-200"}`} />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
               <div className="xl:col-span-2 bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-center space-y-4">
                  <div>
                    <label className="text-xs font-bold text-slate-500 mb-2 flex items-center justify-between"><div className="flex items-center"><Cylinder className="w-3.5 h-3.5 mr-1" /> 성형 압력</div><span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">목표: {masterSettings?.TARGET_PRESSURE?.step3 || "70"}ton</span></label>
                    <input type="text" placeholder="실제 압력 기입" value={d.pressure || ""} onChange={(e) => handleDataChange(wip.id, "pressure", e.target.value)} className="border border-slate-300 rounded-lg p-2.5 text-sm font-black text-indigo-600 w-full text-center" />
                  </div>
                  <div><label className="text-xs font-bold text-slate-500 mb-2 block">특이사항 (메모)</label><input type="text" placeholder="특이사항 기입" value={d.specialNote || ""} onChange={(e) => handleDataChange(wip.id, "specialNote", e.target.value)} className="border border-slate-300 rounded-lg p-2 text-xs w-full" /></div>
                </div>
                <div className="xl:col-span-7 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                    <div>
                      <label className="text-[11px] font-bold text-slate-500 mb-2 flex justify-between items-center"><span>직경 (3회)</span><span className="text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded font-bold border border-indigo-100">Avg: {dAvg} mm</span></label>
                      <div className="flex space-x-1.5">
                        <input type="text" inputMode="decimal" placeholder="#1" value={d.d1 || ""} onChange={(e) => handleDataChange(wip.id, "d1", e.target.value)} className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold" />
                        <input type="text" inputMode="decimal" placeholder="#2" value={d.d2 || ""} onChange={(e) => handleDataChange(wip.id, "d2", e.target.value)} className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold" />
                        <input type="text" inputMode="decimal" placeholder="#3" value={d.d3 || ""} onChange={(e) => handleDataChange(wip.id, "d3", e.target.value)} className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold" />
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] font-bold text-slate-500 mb-2 flex justify-between items-center"><span>높이 (3회)</span><span className="text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded font-bold border border-indigo-100">Avg: {hAvg} mm</span></label>
                      <div className="flex space-x-1.5">
                        <input type="text" inputMode="decimal" placeholder="#1" value={d.h1 || ""} onChange={(e) => handleDataChange(wip.id, "h1", e.target.value)} className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold" />
                        <input type="text" inputMode="decimal" placeholder="#2" value={d.h2 || ""} onChange={(e) => handleDataChange(wip.id, "h2", e.target.value)} className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold" />
                        <input type="text" inputMode="decimal" placeholder="#3" value={d.h3 || ""} onChange={(e) => handleDataChange(wip.id, "h3", e.target.value)} className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold" />
                      </div>
                    </div>
                    <div>
                      <label className="text-[11px] font-bold text-slate-500 mb-2 flex justify-between items-center"><span>무게 (3회)</span><span className="text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded font-bold border border-indigo-100">Avg: {wAvg} g</span></label>
                      <div className="flex space-x-1.5">
                        <input type="text" inputMode="decimal" placeholder="#1" value={d.w1 || ""} onChange={(e) => handleDataChange(wip.id, "w1", e.target.value)} className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold" />
                        <input type="text" inputMode="decimal" placeholder="#2" value={d.w2 || ""} onChange={(e) => handleDataChange(wip.id, "w2", e.target.value)} className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold" />
                        <input type="text" inputMode="decimal" placeholder="#3" value={d.w3 || ""} onChange={(e) => handleDataChange(wip.id, "w3", e.target.value)} className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold" />
                      </div>
                    </div>
                  </div>
                </div>
                <div className="xl:col-span-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between space-y-3">
                  <div className="flex flex-col space-y-1.5">
                    <label className="text-[11px] font-bold text-red-500 mb-0.5 block">불량 (수량/사유)</label>
                    <div className="flex space-x-1.5">
                      <input type="text" inputMode="numeric" placeholder="0" value={d.defects || ""} onChange={(e) => handleDataChange(wip.id, "defects", e.target.value)} className="border border-red-300 rounded p-1.5 text-sm font-bold text-red-600 w-1/3 text-center bg-red-50 focus:ring-red-200 outline-none" />
                      <input type="text" placeholder="사유기입" value={d.defectReason || ""} onChange={(e) => handleDataChange(wip.id, "defectReason", e.target.value)} className="border border-slate-300 rounded p-1.5 text-xs w-2/3 focus:ring-indigo-200 outline-none" />
                    </div>
                  </div>
                  <button onClick={() => moveNext(wip.id)} className="w-full text-sm bg-blue-600 text-white py-2.5 rounded-lg font-bold hover:bg-blue-700 transition-colors shadow-sm flex items-center justify-center"><CheckCircle2 className="w-4 h-4 mr-1.5" /> 1차 성형 완료</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ==========================================
// Step 4: Second Molding
// ==========================================
function Step4SecondMolding({ wipList, masterSettings, ctx }) {
  const pendingWip = wipList.filter((w) => w.currentStep === "step4");
  const [formData, setFormData] = useState({});
  const handleDataChange = (id, f, v) => setFormData((p) => ({ ...p, [id]: { ...(p[id] || {}), [f]: v } }));
  const calcAvg = (v1, v2, v3, dec = 2) => v1 && v2 && v3 ? ((Number(v1) + Number(v2) + Number(v3)) / 3).toFixed(dec) : (0).toFixed(dec);

  const moveNext = async (id) => {
    const d = formData[id] || {};
    if (!d.operator) return ctx.showToast("작업자 성명을 필수로 입력해주세요.", "error");

    const qtyA = parseInt(d.qtyA) || 0; const defA = parseInt(d.defectA) || 0;
    const qtyB = parseInt(d.qtyB) || 0; const defB = parseInt(d.defectB) || 0;
    const wipItem = wipList.find((w) => w.id === id);

    if (qtyA === 0 && qtyB === 0) return ctx.showToast("A호기 또는 B호기 중 정상 생산 수량을 배정해주세요!", "error");
    if (qtyA + defA + qtyB + defB !== wipItem.qty) return ctx.showToast("입력한 수량 합계(정상+불량)가 대기 수량과 불일치합니다.", "error");

    const dAvgA = calcAvg(d.d1A, d.d2A, d.d3A, 2); const hAvgA = calcAvg(d.h1A, d.h2A, d.h3A, 2); const pressA = d.pressureA || 0;
    const dAvgB = calcAvg(d.d1B, d.d2B, d.d3B, 2); const hAvgB = calcAvg(d.h1B, d.h2B, d.h3B, 2); const pressB = d.pressureB || 0;
    const noteStr = d.specialNote ? ` [메모:${d.specialNote}]` : "";
    const curTime = getKST(); 

    try {
      await runTransaction(db, async (transaction) => {
        const docRef = getDocRef("wipList", id);
        const docSnap = await transaction.get(docRef);
        if (!docSnap.exists()) throw "이미 삭제된 로트입니다.";
        if (docSnap.data().currentStep !== "step4") throw "이미 다른 작업자가 처리한 로트입니다.";
        const currentData = docSnap.data();

        // 🌟 수정: Step5 (열처리 대기) 로 넘어갑니다.
        if (qtyA > 0) {
          const defStrA = defA > 0 ? ` [불량 ${defA}개: ${d.defectReasonA || "사유미상"}]` : "";
          const idA = Date.now().toString() + "A";
          transaction.set(getDocRef("wipList", idA), {
            ...currentData, id: idA, mixLot: `${currentData.mixLot}-A`, qty: qtyA, currentStep: "step5",
            details: `${currentData.details || ""}\n[${curTime}] [2차성형 A호기] 압력:${pressA} | 직경:${dAvgA}mm | 높이:${hAvgA}mm | 담당:${d.operator}${defStrA}${noteStr}`,
          });
        }
        if (qtyB > 0) {
          const defStrB = defB > 0 ? ` [불량 ${defB}개: ${d.defectReasonB || "사유미상"}]` : "";
          const idB = Date.now().toString() + "B";
          transaction.set(getDocRef("wipList", idB), {
            ...currentData, id: idB, mixLot: `${currentData.mixLot}-B`, qty: qtyB, currentStep: "step5",
            details: `${currentData.details || ""}\n[${curTime}] [2차성형 B호기] 압력:${pressB} | 직경:${dAvgB}mm | 높이:${hAvgB}mm | 담당:${d.operator}${defStrB}${noteStr}`,
          });
        }
        transaction.delete(docRef);
      });
      ctx.showToast("2차 성형 완료 및 열처리 이관", "success");
      if (qtyA > 0) logProcessToGoogleSheet("step4", { ...wipItem, qty: qtyA }, d.operator, { defects: defA, defectReason: d.defectReasonA || "-", equipment: "A호기", conditions: `압력:${d.pressureA || 0}MPa`, measurements: `직경:${dAvgA}mm, 높이:${hAvgA}mm`, details: d.specialNote || "-" });
      if (qtyB > 0) logProcessToGoogleSheet("step4", { ...wipItem, qty: qtyB }, d.operator, { defects: defB, defectReason: d.defectReasonB || "-", equipment: "B호기", conditions: `압력:${d.pressureB || 0}MPa`, measurements: `직경:${dAvgB}mm, 높이:${hAvgB}mm`, details: d.specialNote || "-" });
    } catch (err) { ctx.showToast(typeof err === "string" ? err : "오류 발생", "error"); }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
      <h3 className="text-lg font-bold mb-2">2차 성형 (A/B 호기)</h3>
      <p className="text-sm text-slate-500 mb-6">A/B 호기별로 수량(정상/불량)을 배정하고 압력 및 측정값을 기록하세요. 수량 분배가 완료되어야 다음 공정으로 넘어갑니다.</p>
      <div className="space-y-6">
        {pendingWip.length === 0 && <div className="text-center py-12 text-slate-400 border-2 border-dashed rounded-xl">대기 중인 반제품이 없습니다.</div>}
        {pendingWip.map((wip) => {
          const d = formData[wip.id] || {};
          const qtyA = parseInt(d.qtyA) || 0; const defA = parseInt(d.defectA) || 0;
          const qtyB = parseInt(d.qtyB) || 0; const defB = parseInt(d.defectB) || 0;
          const dAvgA = calcAvg(d.d1A, d.d2A, d.d3A, 2); const hAvgA = calcAvg(d.h1A, d.h2A, d.h3A, 2);
          const dAvgB = calcAvg(d.d1B, d.d2B, d.d3B, 2); const hAvgB = calcAvg(d.h1B, d.h2B, d.h3B, 2);

          return (
            <div key={wip.id} className="border border-slate-200 rounded-xl p-5 bg-slate-50 relative">
              <div className="flex justify-between items-center mb-4 border-b pb-4">
                <div className="flex items-center space-x-3">
                  <span className="font-mono font-bold text-indigo-700 bg-indigo-100 px-3 py-1 rounded-lg">{wip.mixLot}</span>
                  <span className="font-black text-xl">{getProductLabel(wip.type)} {wip.height}T</span>
                  <span className="font-bold text-slate-600 bg-white border px-3 py-1 rounded-lg shadow-sm">대상: {wip.qty} EA</span>
                </div>
                <div className="flex items-center space-x-2">
                  <input type="text" placeholder="공통 메모/특이사항" value={d.specialNote || ""} onChange={(e) => handleDataChange(wip.id, "specialNote", e.target.value)} className="border rounded-lg p-2 text-xs w-40" />
                  <input type="text" placeholder="작업자 성명" value={d.operator || ""} onChange={(e) => handleDataChange(wip.id, "operator", e.target.value)} className={`border rounded-lg p-2 text-sm w-32 text-center font-bold ${d.error && !d.operator ? "border-red-400 bg-red-50" : ""}`} />
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* A호기 */}
                <div className={`border-2 rounded-xl p-4 transition-all ${qtyA > 0 || defA > 0 ? "border-indigo-300 bg-white shadow-sm" : "border-slate-200 bg-slate-100/50"}`}>
                  <div className="flex justify-between items-center mb-4">
                    <h4 className="font-black text-indigo-800 bg-indigo-100 px-3 py-1 rounded-md">A호기 라인</h4>
                    <div className="flex space-x-2">
                      <div className="flex items-center border border-indigo-200 rounded p-1 bg-white"><span className="text-xs font-bold text-indigo-600 w-10 text-center">정상</span><input type="text" inputMode="numeric" placeholder="0" value={d.qtyA || ""} onChange={(e) => handleDataChange(wip.id, "qtyA", e.target.value)} className="w-12 text-center text-sm font-black outline-none" /></div>
                      <div className="flex items-center border border-red-200 rounded p-1 bg-white"><span className="text-xs font-bold text-red-600 w-10 text-center">불량</span><input type="text" inputMode="numeric" placeholder="0" value={d.defectA || ""} onChange={(e) => handleDataChange(wip.id, "defectA", e.target.value)} className="w-12 text-center text-sm font-black text-red-600 outline-none" /></div>
                    </div>
                  </div>
                  <div className={`space-y-3 ${qtyA > 0 ? "opacity-100" : "opacity-40 grayscale pointer-events-none"}`}>
                    <div className="flex items-center space-x-2"><span className="text-xs font-bold text-slate-500 w-12 flex flex-col"><span>압력</span><span className="text-[9px] text-blue-500 mt-0.5">목표:{masterSettings?.TARGET_PRESSURE?.step4A || "250"}</span></span><input type="text" placeholder="실제 압력" value={d.pressureA || ""} onChange={(e) => handleDataChange(wip.id, "pressureA", e.target.value)} className="border rounded p-1.5 text-xs w-full" /></div>
                    <div className="flex items-center space-x-2"><span className="text-xs font-bold text-slate-500 w-12">직경(3)</span><input type="text" inputMode="decimal" placeholder="#1" value={d.d1A || ""} onChange={(e) => handleDataChange(wip.id, "d1A", e.target.value)} className="border rounded p-1.5 text-xs w-1/3 text-center" /><input type="text" inputMode="decimal" placeholder="#2" value={d.d2A || ""} onChange={(e) => handleDataChange(wip.id, "d2A", e.target.value)} className="border rounded p-1.5 text-xs w-1/3 text-center" /><input type="text" inputMode="decimal" placeholder="#3" value={d.d3A || ""} onChange={(e) => handleDataChange(wip.id, "d3A", e.target.value)} className="border rounded p-1.5 text-xs w-1/3 text-center" /><span className="text-xs font-bold text-indigo-600 w-12 text-right">{dAvgA}</span></div>
                    <div className="flex items-center space-x-2"><span className="text-xs font-bold text-slate-500 w-12">높이(3)</span><input type="text" inputMode="decimal" placeholder="#1" value={d.h1A || ""} onChange={(e) => handleDataChange(wip.id, "h1A", e.target.value)} className="border rounded p-1.5 text-xs w-1/3 text-center" /><input type="text" inputMode="decimal" placeholder="#2" value={d.h2A || ""} onChange={(e) => handleDataChange(wip.id, "h2A", e.target.value)} className="border rounded p-1.5 text-xs w-1/3 text-center" /><input type="text" inputMode="decimal" placeholder="#3" value={d.h3A || ""} onChange={(e) => handleDataChange(wip.id, "h3A", e.target.value)} className="border rounded p-1.5 text-xs w-1/3 text-center" /><span className="text-xs font-bold text-indigo-600 w-12 text-right">{hAvgA}</span></div>
                    {defA > 0 && <input type="text" placeholder="A호기 불량 사유 기입" value={d.defectReasonA || ""} onChange={(e) => handleDataChange(wip.id, "defectReasonA", e.target.value)} className="border border-red-300 bg-red-50 rounded p-1.5 text-xs w-full outline-none focus:ring-red-200" />}
                  </div>
                </div>

                {/* B호기 */}
                <div className={`border-2 rounded-xl p-4 transition-all ${qtyB > 0 || defB > 0 ? "border-blue-300 bg-white shadow-sm" : "border-slate-200 bg-slate-100/50"}`}>
                  <div className="flex justify-between items-center mb-4">
                    <h4 className="font-black text-blue-800 bg-blue-100 px-3 py-1 rounded-md">B호기 라인</h4>
                    <div className="flex space-x-2">
                      <div className="flex items-center border border-blue-200 rounded p-1 bg-white"><span className="text-xs font-bold text-blue-600 w-10 text-center">정상</span><input type="text" inputMode="numeric" placeholder="0" value={d.qtyB || ""} onChange={(e) => handleDataChange(wip.id, "qtyB", e.target.value)} className="w-12 text-center text-sm font-black outline-none" /></div>
                      <div className="flex items-center border border-red-200 rounded p-1 bg-white"><span className="text-xs font-bold text-red-600 w-10 text-center">불량</span><input type="text" inputMode="numeric" placeholder="0" value={d.defectB || ""} onChange={(e) => handleDataChange(wip.id, "defectB", e.target.value)} className="w-12 text-center text-sm font-black text-red-600 outline-none" /></div>
                    </div>
                  </div>
                  <div className={`space-y-3 ${qtyB > 0 ? "opacity-100" : "opacity-40 grayscale pointer-events-none"}`}>
                  <div className="flex items-center space-x-2"><span className="text-xs font-bold text-slate-500 w-12 flex flex-col"><span>압력</span><span className="text-[9px] text-blue-500 mt-0.5">목표:{masterSettings?.TARGET_PRESSURE?.step4B || "250"}</span></span><input type="text" placeholder="실제 압력" value={d.pressureB || ""} onChange={(e) => handleDataChange(wip.id, "pressureB", e.target.value)} className="border rounded p-1.5 text-xs w-full" /></div>
                    <div className="flex items-center space-x-2"><span className="text-xs font-bold text-slate-500 w-12">직경(3)</span><input type="text" inputMode="decimal" placeholder="#1" value={d.d1B || ""} onChange={(e) => handleDataChange(wip.id, "d1B", e.target.value)} className="border rounded p-1.5 text-xs w-1/3 text-center" /><input type="text" inputMode="decimal" placeholder="#2" value={d.d2B || ""} onChange={(e) => handleDataChange(wip.id, "d2B", e.target.value)} className="border rounded p-1.5 text-xs w-1/3 text-center" /><input type="text" inputMode="decimal" placeholder="#3" value={d.d3B || ""} onChange={(e) => handleDataChange(wip.id, "d3B", e.target.value)} className="border rounded p-1.5 text-xs w-1/3 text-center" /><span className="text-xs font-bold text-blue-600 w-12 text-right">{dAvgB}</span></div>
                    <div className="flex items-center space-x-2"><span className="text-xs font-bold text-slate-500 w-12">높이(3)</span><input type="text" inputMode="decimal" placeholder="#1" value={d.h1B || ""} onChange={(e) => handleDataChange(wip.id, "h1B", e.target.value)} className="border rounded p-1.5 text-xs w-1/3 text-center" /><input type="text" inputMode="decimal" placeholder="#2" value={d.h2B || ""} onChange={(e) => handleDataChange(wip.id, "h2B", e.target.value)} className="border rounded p-1.5 text-xs w-1/3 text-center" /><input type="text" inputMode="decimal" placeholder="#3" value={d.h3B || ""} onChange={(e) => handleDataChange(wip.id, "h3B", e.target.value)} className="border rounded p-1.5 text-xs w-1/3 text-center" /><span className="text-xs font-bold text-blue-600 w-12 text-right">{hAvgB}</span></div>
                    {defB > 0 && <input type="text" placeholder="B호기 불량 사유 기입" value={d.defectReasonB || ""} onChange={(e) => handleDataChange(wip.id, "defectReasonB", e.target.value)} className="border border-red-300 bg-red-50 rounded p-1.5 text-xs w-full outline-none focus:ring-red-200" />}
                  </div>
                </div>
              </div>
              <div className="mt-6 flex flex-col items-center border-t pt-4">
                {(() => {
                  const remaining = wip.qty - qtyA - defA - qtyB - defB;
                  if (remaining !== 0) return <div className={`text-xs font-bold mb-2 ${remaining < 0 ? "text-red-500" : "text-orange-500"}`}>수량 합계 불일치 ({remaining > 0 ? `${remaining}개 미배정` : `${Math.abs(remaining)}개 초과`})</div>;
                  return null;
                })()}
                <button onClick={() => moveNext(wip.id)} className="w-full md:w-1/2 bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 shadow-md flex items-center justify-center transition-transform hover:scale-105"><CheckCircle2 className="w-5 h-5 mr-2" /> 2차 성형 데이터 저장 및 열처리 이관</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ==========================================
// Step 5: Heat Treatment (순수 열처리 로딩/언로딩만 담당)
// ==========================================
function Step5HeatTreatment({ wipList, furnaces, masterSettings, ctx }) { 
  const [selectedWipId, setSelectedWipId] = useState(null);
  const [alertModal, setAlertModal] = useState({ isOpen: false, message: "", type: "info" });
  const [promptData, setPromptData] = useState({ isOpen: false, message: "", max: 0, val: "", fid: null, slotId: null });

  const slots = [
    { id: "L6", label: "좌측 6층" }, { id: "R6", label: "우측 6층" },
    { id: "L5", label: "좌측 5층" }, { id: "R5", label: "우측 5층" },
    { id: "L4", label: "좌측 4층" }, { id: "R4", label: "우측 4층" },
    { id: "L3", label: "좌측 3층" }, { id: "R3", label: "우측 3층" },
    { id: "L2", label: "좌측 2층" }, { id: "R2", label: "우측 2층" },
    { id: "L1", label: "좌측 1층" }, { id: "R1", label: "우측 1층" }
  ];

  const getRemainingQty = (wipId) => {
    const w = wipList.find(i => i.id === wipId);
    if (!w) return 0;
    let used = 0;
    [1, 2].forEach(fid => {
      const f = furnaces[fid] || {};
      Object.values(f.slotData || {}).forEach(s => { if (s.wipId === wipId) used += Number(s.qty); });
    });
    return w.qty - used;
  };

  const updateSlotData = async (fid, newSlotData) => {
    const newFurnaces = cloneDeep(furnaces);
    newFurnaces[fid].slotData = newSlotData;
    await setDoc(getDocRef("equipment", "furnaces"), newFurnaces);
  };

  const handleSlotClick = (fid, slotId) => {
    const f = furnaces[fid] || {};
    if (f.isHeating) return;
    
    if (!selectedWipId) {
      setAlertModal({ isOpen: true, message: "왼쪽 대기열에서 제품을 먼저 클릭해서 선택하세요!", type: "warning" });
      return;
    }
    const remain = getRemainingQty(selectedWipId);
    if (remain <= 0) {
      setAlertModal({ isOpen: true, message: "이 제품은 이미 다 배정되었습니다.", type: "info" });
      return;
    }
    
    const defaultQty = Math.min(28, remain);
    setPromptData({ isOpen: true, message: `[${slotId}] 칸에 배정할 수량을 입력하세요. (최대 ${remain}개 가능)`, max: remain, val: defaultQty.toString(), fid: fid, slotId: slotId });
  };

  const confirmPrompt = async () => {
    const qty = parseInt(promptData.val);
    if (isNaN(qty) || qty <= 0 || qty > promptData.max) {
      setAlertModal({ isOpen: true, message: `수량은 1에서 ${promptData.max} 사이로 입력해주세요.`, type: "warning" });
      return;
    }
    const w = wipList.find(i => i.id === selectedWipId);
    const fid = promptData.fid;
    const f = furnaces[fid] || {};
    
    const newSlotData = { ...f.slotData, [promptData.slotId]: { 
        wipId: selectedWipId, mixLot: w.mixLot, type: w.type, height: w.height, qty: qty
    }};

    await updateSlotData(fid, newSlotData);
    setPromptData({ isOpen: false, message: "", max: 0, val: "", fid: null, slotId: null });
  };

  const handleRemoveSlot = async (fid, slotId, e) => {
    e.stopPropagation();
    const f = furnaces[fid] || {};
    const newData = { ...f.slotData };
    delete newData[slotId];
    await updateSlotData(fid, newData);
  };

  const handleFurnaceInfo = async (fid, field, val) => {
    const newFurnaces = cloneDeep(furnaces);
    if (!newFurnaces[fid]) return;
    newFurnaces[fid][field] = val;
    await setDoc(getDocRef("equipment", "furnaces"), newFurnaces);
  };

  const toggleHeating = async (fid) => {
    const f = furnaces[fid] || {};
    const db = getFirestore();
    
    if (!f.isHeating) {
      if (Object.keys(f.slotData || {}).length === 0) {
         setAlertModal({ isOpen: true, message: "전기로가 비어있습니다. 제품을 배정해주세요.", type: "warning" });
         return;
      }
      if (!f.operator || f.operator.trim() === "") {
        setAlertModal({ isOpen: true, message: "담당 작업자 이름을 입력해주세요.", type: "warning" });
        return;
      }
      const newFurnaces = cloneDeep(furnaces);
      newFurnaces[fid].isHeating = true;
      await setDoc(getDocRef("equipment", "furnaces"), newFurnaces);
      ctx.showToast("열처리 가동이 시작되었습니다.", "success");
    } else {
      // 🌟 가동 종료 (트랜잭션 규칙 엄격하게 적용: READ 먼저, WRITE 나중에)
      const slotData = f.slotData || {};
      const grouped = {};

      Object.entries(slotData).forEach(([slotId, s]) => {
         if (!grouped[s.wipId]) {
            grouped[s.wipId] = { qty: 0, furnaceSlots: [] }; 
         }
         grouped[s.wipId].qty += Number(s.qty);
         grouped[s.wipId].furnaceSlots.push({ fid, slotId, qty: Number(s.qty) }); 
      });

      try {
        await runTransaction(db, async (transaction) => {
           // ==========================================
           // 1. [READ 단계] 업데이트할 모든 문서를 먼저 읽어옵니다.
           // ==========================================
           const wipSnaps = {};
           for (const wId of Object.keys(grouped)) {
             wipSnaps[wId] = await transaction.get(getDocRef("wipList", wId));
           }
           const shrinkRef = getDocRef("equipment", "shrinkDesks");
           const shrinkSnap = await transaction.get(shrinkRef);
           const furnaceRef = getDocRef("equipment", "furnaces");
           const furnaceSnap = await transaction.get(furnaceRef);

           // ==========================================
           // 2. [WRITE 단계] 읽어온 문서를 바탕으로 업데이트를 수행합니다.
           // ==========================================
           // A. 기존 제품을 수축률 대기로 상태 변경
           for (const wId of Object.keys(grouped)) {
             const snap = wipSnaps[wId];
             if (snap && snap.exists()) {
               transaction.update(snap.ref, { 
                 currentStep: "step5_shrink",
                 furnaceSlots: grouped[wId].furnaceSlots 
               });
             }
           }

           // B. 수축률 측정대로 12칸 데이터 복사
           const currentDesks = shrinkSnap.exists() ? shrinkSnap.data() : { 1: {step: 0, slotData: {}}, 2: {step: 0, slotData: {}} };
           const newShrinkSlotData = {};
           Object.entries(slotData).forEach(([slotId, s]) => {
              newShrinkSlotData[slotId] = {
                  wipId: s.wipId, mixLot: s.mixLot, type: s.type, height: s.height, qty: s.qty,
                  measurements: [{ preArea: "", postArea: "", calcShrink: "", calcExpand: "" }]
              };
           });
           currentDesks[fid] = {
              step: 1, // 1: 소결 전 면적 입력 단계
              operator: f.operator || "",
              memo: f.memo || "",
              slotData: newShrinkSlotData
           };
           transaction.set(shrinkRef, currentDesks);

           // C. 가동 종료된 전기로 완벽 초기화
           const currentFurnaces = furnaceSnap.exists() ? furnaceSnap.data() : { 1: {}, 2: {} };
           currentFurnaces[fid] = { isHeating: false, temp: f.temp || "1050", operator: "", memo: "", slotData: {} };
           transaction.set(furnaceRef, currentFurnaces);
        });

        setAlertModal({ isOpen: true, message: `✅ 가동 종료!\n\n전기로가 비워졌으며, 배정되었던 위치 그대로 [수축률 측정 대기]로 이관되었습니다.`, type: "success" });
      } catch (error) {
        console.error("이관 에러:", error);
        // 에러의 정확한 이유를 팝업창에 띄워줍니다.
        setAlertModal({ isOpen: true, message: `이관 중 오류가 발생했습니다.\n사유: ${error.message}`, type: "error" });
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 font-sans">
      <div className="max-w-[1500px] mx-auto">
        <div className="bg-white rounded-2xl shadow-lg border-b-4 border-orange-500 mb-6 overflow-hidden flex items-center p-5">
          <Flame className="w-8 h-8 text-orange-500 mr-3" />
          <h1 className="font-black text-2xl text-slate-800 tracking-wide">열처리 전기로 가동 관리</h1>
        </div>
        <div className="flex flex-col xl:flex-row gap-6">
          
          {/* ======================= 왼쪽: 대기열 ======================= */}
          <div className="w-full xl:w-1/4 flex flex-col gap-6">
            <div className="bg-white border rounded-2xl overflow-hidden h-fit shadow-lg">
              <div className="bg-slate-700 text-white font-bold p-4 text-center flex items-center justify-center gap-2">
                <BoxSelect className="w-5 h-5" /> 대기열 (클릭 선택)
              </div>
              <div className="p-4 space-y-3 bg-slate-50 max-h-[70vh] overflow-y-auto">
                {wipList.filter(w => w.currentStep === "step5").map(wip => {
                  const remain = getRemainingQty(wip.id);
                  if (remain <= 0) return null;
                  const isSel = selectedWipId === wip.id;
                  return (
                    <div key={wip.id} onClick={() => setSelectedWipId(wip.id)} className={`p-4 border-2 rounded-xl cursor-pointer transition-all ${isSel ? 'bg-indigo-50 border-indigo-500 shadow-md transform scale-[1.02]' : 'bg-white hover:border-slate-300'}`}>
                      <div className="text-xs text-slate-500 font-mono mb-1 bg-slate-100 inline-block px-2 py-0.5 rounded">{wip.mixLot}</div>
                      <div className="font-black text-slate-800 text-lg mt-1">{getProductLabel(wip.type)} <span className="text-slate-500">{wip.height}T</span></div>
                      <div className="text-sm font-bold text-indigo-600 mt-2">잔여 수량: {remain}개</div>
                    </div>
                  );
                })}
                {wipList.filter(w => w.currentStep === "step5" && getRemainingQty(w.id) > 0).length === 0 && (
                  <div className="text-center text-slate-500 py-6 font-bold text-sm bg-white rounded-xl border border-dashed">대기 중인 제품이 없습니다.</div>
                )}
              </div>
            </div>
          </div>

          {/* ======================= 오른쪽: 전기로 패널 ======================= */}
          <div className="w-full xl:w-3/4 grid grid-cols-1 lg:grid-cols-2 gap-6">
            {[1, 2].map(id => {
              const f = furnaces[id] || {};
              const isH = f.isHeating;
              const hasData = Object.keys(f.slotData || {}).length > 0;
              
              let cardStyle = isH ? "border-orange-500 shadow-orange-200 shadow-xl bg-orange-50/30" : "border-slate-300 bg-white shadow-md"; 
              let headerStyle = isH ? "bg-orange-500 text-white animate-pulse" : "bg-slate-500 text-white"; 
              let headerText = isH ? `🔥 ${id}호기 열처리 가동 중` : `🧊 ${id}호기 배정 대기`; 

              return (
                <div key={id} className={`flex flex-col border-4 rounded-2xl overflow-hidden transition-all duration-300 ${cardStyle}`}>
                  <div className={`p-4 text-center font-black text-xl flex justify-center items-center ${headerStyle}`}>{headerText}</div>
                  <div className="flex flex-col flex-grow p-4 sm:p-5">
                    {!isH && <div className="text-center font-bold mb-4 text-sm py-2.5 rounded-lg border shadow-sm text-indigo-800 bg-indigo-50 border-indigo-200">빈칸을 클릭하여 제품을 배정하세요.</div>}
                    
                    <div className={`grid grid-cols-2 gap-2 sm:gap-3 p-3 sm:p-4 rounded-xl border-4 mb-auto ${hasData ? 'bg-slate-100 border-slate-300' : 'bg-slate-200 border-slate-300'}`}>
                      {slots.map(slot => {
                        const sData = f.slotData?.[slot.id];
                        const isEmpty = !sData;
                        if (isEmpty) return (
                            <div key={slot.id} onClick={() => handleSlotClick(id, slot.id)} className={`border-2 border-dashed border-slate-300 rounded-xl p-2 min-h-[60px] flex items-center justify-center ${!isH ? 'bg-white hover:bg-indigo-50 cursor-pointer' : 'bg-white/50 cursor-not-allowed'}`}>
                              <span className="text-xs text-slate-400 font-bold">{slot.label} {!isH && "+"}</span>
                            </div>
                        );

                        return (
                          <div key={slot.id} className={`relative border-2 rounded-xl p-2 sm:p-3 flex flex-col items-center justify-center transition-all min-h-[80px] bg-white shadow-md ${isH ? 'border-orange-300' : 'border-indigo-300'}`}>
                            <div className="absolute top-1 left-2 text-[10px] sm:text-xs font-black px-1.5 py-0.5 rounded text-indigo-600 bg-indigo-50">{slot.label}</div>
                            {!isH && <button onClick={(e) => handleRemoveSlot(id, slot.id, e)} className="absolute top-1 right-1 text-red-400 hover:text-red-600 font-black text-xs bg-white rounded-full w-5 h-5 flex items-center justify-center shadow border border-red-100">✕</button>}
                            
                            <div className="w-full flex flex-col items-center mt-3">
                              <div className="text-[10px] font-mono text-slate-500 mb-0.5 bg-slate-100 px-1 rounded truncate max-w-full">{sData.mixLot.slice(-6)}</div>
                              <div className="font-black text-slate-800 text-sm sm:text-base mt-1 leading-tight">{getProductLabel(sData.type)} {sData.height}T</div>
                              <div className="text-xs font-bold text-indigo-600 mt-1 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">{sData.qty}개</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-4 pt-4 border-t-2 border-dashed border-slate-200">
                      <div className="flex gap-3 mb-4">
                        <div className="w-1/2">
                          <label className="block text-xs font-bold text-slate-500 mb-1 flex items-center justify-between">목표 가동 온도 <span className="text-[8px] text-orange-500 border border-orange-200 bg-orange-50 px-1 rounded">목표:{masterSettings?.TARGET_TEMPERATURE?.[`furnace${id}`] || "1050"}</span></label>
                          <SyncInput type="number" value={f.temp} onChange={(val) => handleFurnaceInfo(id, 'temp', val)} disabled={isH} className="w-full border-2 border-slate-200 bg-slate-50 text-slate-800 font-black text-center p-2.5 rounded-xl focus:border-indigo-400 outline-none disabled:opacity-60" />
                        </div>
                        <div className="w-1/2">
                          <label className="block text-xs font-bold text-slate-500 mb-1">담당 작업자</label>
                          <SyncInput type="text" placeholder="성명" value={f.operator} onChange={(val) => handleFurnaceInfo(id, 'operator', val)} disabled={isH} className="w-full border-2 border-slate-200 p-2.5 rounded-xl text-center font-bold text-slate-800 focus:border-indigo-400 outline-none disabled:opacity-60" />
                        </div>
                      </div>

                      {isH && (
                        <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-xl animate-fade-in">
                          <label className="block text-xs font-bold text-orange-800 mb-1">가동 특이사항(메모)</label>
                          <SyncInput type="text" placeholder="특이사항이나 메모를 입력하세요" value={f.memo} onChange={(val) => handleFurnaceInfo(id, 'memo', val)} disabled={!isH} className="w-full border border-orange-300 p-2.5 rounded-lg font-bold text-slate-700 focus:outline-none" />
                        </div>
                      )}

                      <button onClick={() => toggleHeating(id)} className={`w-full py-4 rounded-xl font-black text-lg shadow-md text-white transition-transform active:scale-95 ${isH ? 'bg-rose-500 hover:bg-rose-600 animate-pulse' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                        {isH ? "가동 종료 (측정 대기로 이관)" : "전기로 가동 시작"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {alertModal.isOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-2xl max-w-sm w-full transform transition-all border-t-8 border-indigo-500">
            <h3 className={`text-xl font-black mb-4 flex items-center gap-2 ${alertModal.type === 'success' ? 'text-teal-600' : 'text-indigo-800'}`}>{alertModal.type === 'success' ? '🎉 성공' : '🔔 알림'}</h3>
            <p className="text-slate-600 font-bold mb-8 leading-relaxed whitespace-pre-line text-lg">{alertModal.message}</p>
            <button onClick={() => setAlertModal({ isOpen: false, message: '', type: 'info' })} className={`w-full text-white py-3 sm:py-4 rounded-xl font-black text-lg transition-colors outline-none ${alertModal.type === 'success' ? 'bg-teal-600 hover:bg-teal-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>확인</button>
          </div>
        </div>
      )}

      {promptData.isOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-2xl max-w-sm w-full transform transition-all border-2 border-slate-200">
            <h3 className="text-xl font-black text-slate-800 mb-3 flex items-center gap-2">📦 수량 배정</h3>
            <p className="text-slate-600 font-medium mb-6">{promptData.message}</p>
            <div className="mb-8"><input type="number" max={promptData.max} min="1" value={promptData.val} onChange={(e) => setPromptData({ ...promptData, val: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && confirmPrompt()} className="w-full border-2 border-indigo-200 focus:border-indigo-500 p-4 rounded-xl text-center text-3xl font-black text-indigo-700 outline-none" autoFocus /></div>
            <div className="flex gap-3">
              <button onClick={() => setPromptData({ isOpen: false, message: '', max: 0, val: '', fid: null, slotId: null })} className="w-1/3 bg-slate-100 hover:bg-slate-200 text-slate-700 py-3 rounded-xl font-bold text-lg outline-none">취소</button>
              <button onClick={confirmPrompt} className="w-2/3 bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-xl font-bold text-lg shadow-lg shadow-indigo-200 outline-none">확인</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// [신규] Step 5.5: Shrinkage Measurement (수축률 측정)
// ==========================================
function Step5_5Shrinkage({ wipList, ctx }) {
  const pendingWip = wipList.filter(w => w.currentStep === "step5_shrink");
  const [selectedWipId, setSelectedWipId] = useState(null);

  const [shrinkDesks, setShrinkDesks] = useState({
    1: { step: 0, operator: "", memo: "", slotData: {} },
    2: { step: 0, operator: "", memo: "", slotData: {} }
  });

  useEffect(() => {
    const db = getFirestore();
    const unsub = onSnapshot(getDocRef("equipment", "shrinkDesks"), (docSnap) => {
      if (docSnap.exists()) {
        const loaded = docSnap.data();
        setShrinkDesks({
          1: { step: 0, operator: "", memo: "", slotData: {}, ...loaded[1] },
          2: { step: 0, operator: "", memo: "", slotData: {}, ...loaded[2] }
        });
      } else {
        setDoc(getDocRef("equipment", "shrinkDesks"), {
          1: { step: 0, operator: "", memo: "", slotData: {} },
          2: { step: 0, operator: "", memo: "", slotData: {} }
        });
      }
    });
    return () => unsub();
  }, []);

  const updateDesk = async (fid, newData) => {
    const updatedDesks = cloneDeep(shrinkDesks);
    updatedDesks[fid] = newData;
    await setDoc(getDocRef("equipment", "shrinkDesks"), updatedDesks);
  };

  const [alertModal, setAlertModal] = useState({ isOpen: false, message: "", type: "info" });
  const [lotSplitModal, setLotSplitModal] = useState({ isOpen: false, fid: null, lotsToSplit: [], lotsToMerge: [], newSlotDataCache: null });

  const slots = [
    { id: "L6", label: "좌측 6층" }, { id: "R6", label: "우측 6층" },
    { id: "L5", label: "좌측 5층" }, { id: "R5", label: "우측 5층" },
    { id: "L4", label: "좌측 4층" }, { id: "R4", label: "우측 4층" },
    { id: "L3", label: "좌측 3층" }, { id: "R3", label: "우측 3층" },
    { id: "L2", label: "좌측 2층" }, { id: "R2", label: "우측 2층" },
    { id: "L1", label: "좌측 1층" }, { id: "R1", label: "우측 1층" }
  ];

  const handleDeskInfo = async (fid, field, val) => {
    const d = shrinkDesks[fid] || {};
    await updateDesk(fid, { ...d, [field]: val });
  };

  const addMeasurement = async (fid, slotId) => {
    const d = shrinkDesks[fid] || {};
    const newData = cloneDeep(d.slotData);
    if (newData[slotId].measurements.length >= 5) return; 
    newData[slotId].measurements.push({ preArea: "", postArea: "", calcShrink: "", calcExpand: "" });
    await updateDesk(fid, { ...d, slotData: newData });
  };

  const removeMeasurement = async (fid, slotId, idx) => {
    const d = shrinkDesks[fid] || {};
    const newData = cloneDeep(d.slotData);
    newData[slotId].measurements = newData[slotId].measurements.filter((_, i) => i !== idx);
    await updateDesk(fid, { ...d, slotData: newData });
  };

  const handleAreaInput = async (fid, slotId, idx, field, val) => {
    const d = shrinkDesks[fid] || {};
    const newData = cloneDeep(d.slotData);
    const m = newData[slotId].measurements[idx];
    m[field] = val;

    const pre = parseFloat(m.preArea);
    const post = parseFloat(m.postArea);

    if (!isNaN(pre) && !isNaN(post) && pre > 0 && post > 0) {
      const areaRatio = post / pre;
      const shrink = (1 - Math.sqrt(areaRatio)) * 100;
      m.calcShrink = shrink.toFixed(2);
      m.calcExpand = (1 / (1 - (shrink / 100))).toFixed(4);
    } else {
      m.calcShrink = ""; m.calcExpand = "";
    }

    const validShrinks = newData[slotId].measurements.map(x => parseFloat(x.calcShrink)).filter(v => !isNaN(v));
    newData[slotId].slotAvgShrink = validShrinks.length > 0 ? (validShrinks.reduce((a, b) => a + b, 0) / validShrinks.length).toFixed(2) : "";
    newData[slotId].slotAvgExpand = newData[slotId].slotAvgShrink ? (1 / (1 - (parseFloat(newData[slotId].slotAvgShrink) / 100))).toFixed(4) : "";

    await updateDesk(fid, { ...d, slotData: newData });
  };

  const confirmPreSintering = async (fid) => {
    const d = shrinkDesks[fid] || {};
    if (Object.keys(d.slotData || {}).length === 0) return;

    const hasEmptyPreArea = Object.values(d.slotData).some(s => s.measurements.some(m => !m.preArea));
    if (hasEmptyPreArea) {
      return setAlertModal({ isOpen: true, message: "모든 칸의 '소결 전 면적'을 입력해주세요.", type: "warning" });
    }
    
    await updateDesk(fid, { ...d, step: 2 });
    setAlertModal({ isOpen: true, message: "✅ 소결 전 면적이 안전하게 잠금 처리되었습니다.\n하루 뒤 소결 공정이 끝나면, 이어서 '소결 후 면적'을 입력해주세요.", type: "success" });
  };

  const unlockPreSintering = async (fid) => {
    const d = shrinkDesks[fid] || {};
    await updateDesk(fid, { ...d, step: 1 });
  };

  const analyzeAndSaveLots = async (fid) => {
    try {
      const d = shrinkDesks[fid] || {};
      if (!d.operator || d.operator.trim() === "") {
        return setAlertModal({ isOpen: true, message: "담당자 성명을 입력해주세요.", type: "warning" });
      }

      const hasEmptyPostArea = Object.values(d.slotData || {}).some(s => s.measurements.some(m => !m.postArea));
      if (hasEmptyPostArea) {
        return setAlertModal({ isOpen: true, message: "모든 칸의 '소결 후 면적'을 입력해주세요.", type: "warning" });
      }

      let newSlotData = cloneDeep(d.slotData);
      const wipGroups = {};

      Object.entries(newSlotData).forEach(([sId, data]) => {
        if (!wipGroups[data.wipId]) wipGroups[data.wipId] = [];
        const shrinkVal = parseFloat(data.slotAvgShrink); 
        if (!isNaN(shrinkVal)) {
          wipGroups[data.wipId].push({ sId, shrinkVal, mixLot: data.mixLot, type: data.type, height: data.height, qty: data.qty });
        }
      });

      let requiresSplitPrompt = false;
      const lotsToSplit = [];
      const lotsToMerge = [];

      Object.entries(wipGroups).forEach(([wipId, validSlots]) => {
        if (validSlots.length > 0) {
          validSlots.sort((a, b) => a.shrinkVal - b.shrinkVal);
          
          const minVal = validSlots[0].shrinkVal;
          const maxVal = validSlots[validSlots.length - 1].shrinkVal;
          
          if (maxVal - minVal > 0.3) {
            requiresSplitPrompt = true;
            let currentGroupIndex = 0;
            let currentGroupMin = validSlots[0].shrinkVal;
            
            const slotsWithGroup = validSlots.map(vs => {
              if (vs.shrinkVal - currentGroupMin > 0.3) {
                currentGroupIndex++;
                currentGroupMin = vs.shrinkVal;
              }
              return { ...vs, group: String.fromCharCode(65 + currentGroupIndex) };
            });

            lotsToSplit.push({ wipId, baseMixLot: validSlots[0].mixLot.slice(-6), slots: slotsWithGroup });
          } else {
            const overallAvg = (validSlots.reduce((sum, s) => sum + s.shrinkVal, 0) / validSlots.length).toFixed(2);
            lotsToMerge.push({ wipId, finalShrink: overallAvg, slots: validSlots });
          }
        }
      });

      if (requiresSplitPrompt) {
        setLotSplitModal({ isOpen: true, fid: fid, lotsToSplit: lotsToSplit, lotsToMerge: lotsToMerge, newSlotDataCache: newSlotData });
      } else {
        await finalizeProcess(fid, lotsToMerge, []);
      }
    } catch (err) {
      console.error(err);
      setAlertModal({ isOpen: true, message: `분석 중 오류 발생: ${err.message}`, type: "error" });
    }
  };

  const finalizeProcess = async (fid, mergedLots, splitLots) => {
    const d = shrinkDesks[fid];
    const curTime = getKST();
    const db = getFirestore();
    
    try {
        await runTransaction(db, async (transaction) => {
            // 1. [READ] 
            const allWipIds = new Set([...mergedLots.map(m=>m.wipId), ...splitLots.flatMap(s=>s.wipId)]);
            const wipSnaps = {};
            for (const wId of allWipIds) {
                const snap = await transaction.get(getDocRef("wipList", wId));
                if(snap.exists()) wipSnaps[wId] = snap;
            }
            const shrinkDoc = await transaction.get(getDocRef("equipment", "shrinkDesks"));

            // 2. [WRITE]
            for (const wId of allWipIds) {
                if(wipSnaps[wId]) transaction.delete(wipSnaps[wId].ref); 
            }

            // 통합 로트 처리
            mergedLots.forEach(m => {
                const snap = wipSnaps[m.wipId];
                if (!snap) return;
                const orig = snap.data();
                const newId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
                const slotKeysStr = m.slots.map(s => `${fid}호기 ${s.sId}`).join(", ");
                const totalQty = m.slots.reduce((sum, s) => sum + s.qty, 0); 
                
                const recordDetails = `[${curTime}] [수축률확정] 위치(${slotKeysStr}) | 수축률:${m.finalShrink}% | 담당:${d.operator}`;
                const newWip = {
                    ...orig, id: newId, qty: totalQty, currentStep: "step6", shrinkageRate: m.finalShrink,
                    details: `${orig.details || ""}\n${recordDetails}`
                };
                transaction.set(getDocRef("wipList", newId), newWip);
                logProcessToGoogleSheet("step5_shrink", newWip, d.operator, { measurements: `수축률:${m.finalShrink}%`, details: d.memo || "-" });
            });

            // 분할 로트 처리
            splitLots.forEach(lot => {
                const groupMap = {};
                lot.slots.forEach(s => {
                    if (!groupMap[s.group]) groupMap[s.group] = [];
                    groupMap[s.group].push(s);
                });
                
                Object.entries(groupMap).forEach(([gName, sArr]) => {
                    const snap = wipSnaps[lot.wipId];
                    if (!snap) return;
                    const orig = snap.data();
                    
                    const gAvg = (sArr.reduce((sum, s) => sum + s.shrinkVal, 0) / sArr.length).toFixed(2);
                    const newId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
                    const suffix = Object.keys(groupMap).length > 1 ? `-${gName}` : "";
                    const newMixLot = orig.mixLot + suffix;
                    const slotKeysStr = sArr.map(s => `${fid}호기 ${s.sId}`).join(", ");
                    const totalQty = sArr.reduce((sum, s) => sum + s.qty, 0); 

                    const recordDetails = `[${curTime}] [수축률확정] 위치(${slotKeysStr}) | 수축률:${gAvg}% | 분리됨 | 담당:${d.operator}`;
                    const newWip = {
                        ...orig, id: newId, mixLot: newMixLot, qty: totalQty, currentStep: "step6", shrinkageRate: gAvg,
                        details: `${orig.details || ""}\n${recordDetails}`
                    };
                    transaction.set(getDocRef("wipList", newId), newWip);
                });
            });

            // 데스크 비우기 (작업 완료)
            const currentDesks = shrinkDoc.exists() ? shrinkDoc.data() : {};
            currentDesks[fid] = { step: 0, operator: "", memo: "", slotData: {} };
            transaction.set(getDocRef("equipment", "shrinkDesks"), currentDesks);
        });
        
        ctx.showToast("수축률 분석 및 검수 이관 완료", "success");
        setLotSplitModal({ isOpen: false, fid: null, lotsToSplit: [], lotsToMerge: [] });
    } catch (e) {
        setAlertModal({ isOpen: true, message: `이관 중 오류가 발생했습니다.\n사유: ${e.message}`, type: "error" });
    }
  };

  const handleGroupChange = (lotIndex, slotIndex, newGroup) => {
    setLotSplitModal(prev => {
      const newLots = [...prev.lotsToSplit];
      newLots[lotIndex].slots[slotIndex].group = newGroup;
      return { ...prev, lotsToSplit: newLots };
    });
  };

  const applyCustomSplit = async () => {
    await finalizeProcess(lotSplitModal.fid, lotSplitModal.lotsToMerge, lotSplitModal.lotsToSplit);
  };

  const applyMergeAll = async () => {
    const mergedLots = [...lotSplitModal.lotsToMerge];
    lotSplitModal.lotsToSplit.forEach(lot => {
      const overallAvg = (lot.slots.reduce((sum, s) => sum + s.shrinkVal, 0) / lot.slots.length).toFixed(2);
      mergedLots.push({ wipId: lot.wipId, finalShrink: overallAvg, slots: lot.slots });
    });
    await finalizeProcess(lotSplitModal.fid, mergedLots, []);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6 font-sans">
      <div className="max-w-[1200px] mx-auto">
        <div className="bg-white rounded-2xl shadow-lg border-b-4 border-teal-500 mb-6 overflow-hidden flex items-center p-5">
          <Calculator className="w-8 h-8 text-teal-500 mr-3" />
          <h1 className="font-black text-2xl text-slate-800 tracking-wide">수축률 측정 및 로트 분석</h1>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[1, 2].map(id => {
            const d = shrinkDesks[id] || { step: 0, slotData: {} };
            const hasData = Object.keys(d.slotData).length > 0;
            const isStep1 = d.step === 1; // 소결 전
            const isStep2 = d.step === 2; // 소결 후
            
            let cardStyle = "border-slate-300 bg-slate-50 opacity-70";
            let headerStyle = "bg-slate-500 text-white";
            let headerText = `🔒 ${id}호기 (측정 대상 없음)`;
            let phaseMessage = "전기로 가동이 완료되면 이곳으로 제품이 이관됩니다.";

            if (hasData) {
              if (isStep1) {
                cardStyle = "border-indigo-400 shadow-indigo-100 shadow-xl bg-white";
                headerStyle = "bg-indigo-600 text-white";
                headerText = `📝 ${id}호기 : 소결 전 면적 입력 중`;
                phaseMessage = "👉 소결 공정 시작 전, 각 칸의 '소결 전 면적'을 입력하고 저장하세요.";
              } else if (isStep2) {
                cardStyle = "border-orange-400 shadow-orange-100 shadow-xl bg-orange-50/30";
                headerStyle = "bg-orange-500 text-white";
                headerText = `⏳ ${id}호기 : 소결 후 면적 입력 대기`;
                phaseMessage = "👉 소결이 완료되었습니다! '소결 후 면적'을 입력하면 수축률/확대율이 계산됩니다.";
              }
            }

            return (
              <div key={id} className={`flex flex-col border-4 rounded-2xl overflow-hidden transition-all duration-300 ${cardStyle}`}>
                <div className={`p-4 text-center font-black text-xl flex justify-center items-center ${headerStyle}`}>
                  {headerText}
                </div>

                <div className="flex flex-col flex-grow p-4 sm:p-5">
                  {hasData && <div className={`text-center font-bold mb-4 text-sm py-2.5 rounded-lg border shadow-sm ${isStep1 ? 'text-indigo-800 bg-indigo-50 border-indigo-200' : 'text-orange-800 bg-orange-50 border-orange-200'}`}>{phaseMessage}</div>}
                  
                  {/* 12칸 그리드 (기존 레이아웃 복원 & 불량 칸 제거) */}
                  <div className={`grid grid-cols-2 gap-2 sm:gap-3 p-3 sm:p-4 rounded-xl border-4 mb-auto ${hasData ? 'bg-slate-100 border-slate-300' : 'bg-slate-200 border-slate-300'}`}>
                    {slots.map(slot => {
                      const sData = d.slotData[slot.id];
                      const isEmpty = !sData;

                      if (isEmpty) {
                        return (
                          <div key={slot.id} className="border-2 border-dashed border-slate-300 rounded-xl p-2 min-h-[60px] flex items-center justify-center bg-white/50">
                            <span className="text-xs text-slate-400 font-bold">{slot.label} (비어있음)</span>
                          </div>
                        );
                      }

                      const slotBorder = isStep1 ? 'border-indigo-300' : 'border-orange-300';
                      const titleBg = isStep1 ? 'bg-indigo-50 text-indigo-700' : 'bg-orange-50 text-orange-700';

                      return (
                        <div key={slot.id} className={`relative border-2 rounded-xl p-3 flex flex-col justify-start bg-white shadow-sm transition-all ${slotBorder}`}>
                          
                          <div className="flex justify-between items-center mb-3">
                            <div className="flex items-center gap-2">
                                <span className={`px-2 py-1 rounded text-xs font-black ${titleBg}`}>{slot.label}</span>
                                <span className="text-xs font-bold text-slate-500">수량: {sData.qty}개</span>
                            </div>
                          </div>
                          
                          <div className="text-center mb-3">
                            <div className="text-[10px] text-slate-400 font-bold bg-slate-100 inline-block px-2 py-0.5 rounded-full mb-1">{sData.mixLot.slice(-6)}</div>
                            <div className="font-black text-slate-800 text-lg">{getProductLabel(sData.type)} {sData.height}T</div>
                          </div>

                          <div className="flex flex-col gap-2 w-full mt-auto">
                            {/* 헤더 부분 */}
                            <div className="flex text-[9px] font-bold text-slate-500 text-center mb-1">
                                <div className="flex-1">소결 전 면적</div>
                                <div className="flex-1">소결 후 면적</div>
                                <div className="w-12">수축률</div>
                            </div>
                            {sData.measurements.map((m, idx) => (
                              <div key={idx} className="relative flex items-center gap-1 w-full animate-fade-in">
                                {isStep1 && sData.measurements.length > 1 && (
                                  <button onClick={() => removeMeasurement(id, slot.id, idx)} className="absolute -left-2 -top-2 bg-white text-slate-400 hover:text-red-500 rounded-full w-5 h-5 flex items-center justify-center border shadow-sm text-xs font-black z-10">✕</button>
                                )}
                                
                                {isStep1 ? (
                                    <>
                                        <SyncInput type="number" value={m.preArea} onChange={(val) => handleAreaInput(id, slot.id, idx, 'preArea', val)} placeholder="입력" className="flex-1 text-[11px] text-center border border-indigo-300 rounded p-1.5 font-black focus:outline-none focus:border-indigo-500 text-indigo-900" />
                                        <div className="flex-1 bg-slate-100 border border-slate-200 rounded p-1.5 text-center text-[10px] font-bold text-slate-400">대기</div>
                                        <div className="w-12 bg-slate-50 border border-slate-200 rounded p-1.5 text-center text-[10px] font-black text-slate-400">-</div>
                                    </>
                                ) : (
                                    <>
                                        <div className="flex-1 bg-slate-100 border border-slate-200 rounded p-1.5 text-center text-[11px] font-bold text-slate-500 overflow-hidden text-ellipsis">{m.preArea}</div>
                                        <SyncInput type="number" value={m.postArea} onChange={(val) => handleAreaInput(id, slot.id, idx, 'postArea', val)} placeholder="입력" className="flex-1 text-[11px] text-center border border-orange-400 rounded p-1.5 font-black focus:outline-none focus:border-orange-600 text-orange-900 bg-white" />
                                        <div className="w-12 bg-teal-50 border border-teal-200 rounded p-1.5 text-center text-[10px] font-black text-teal-700">{m.calcShrink ? `${m.calcShrink}` : '-'}</div>
                                    </>
                                )}
                              </div>
                            ))}
                            {isStep1 && sData.measurements.length < 5 && <button onClick={() => addMeasurement(id, slot.id)} className="w-full border border-dashed border-slate-300 rounded py-1.5 text-[10px] font-bold text-slate-500 hover:bg-slate-100 transition-colors mt-1">+ 측정 추가</button>}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {hasData && (
                    <div className="mt-4 pt-4 border-t-2 border-dashed border-slate-200">
                      <div className="flex gap-3 mb-4">
                        <div className="w-full">
                          <label className="block text-xs font-bold text-slate-500 mb-1">담당 작업자</label>
                          <SyncInput type="text" placeholder="성명 입력" value={d.operator} onChange={(val) => handleDeskInfo(id, 'operator', val)} className="w-full border-2 border-slate-200 p-2.5 rounded-xl text-center font-bold text-slate-800 focus:border-teal-400 outline-none" />
                        </div>
                      </div>

                      {isStep1 && (
                        <button onClick={() => confirmPreSintering(id)} className="w-full py-4 rounded-xl font-black text-lg shadow-md bg-indigo-600 hover:bg-indigo-700 text-white transition-transform active:scale-95">
                          [1단계] 소결 전 면적 임시저장 및 잠금
                        </button>
                      )}
                      
                      {isStep2 && (
                        <div className="flex flex-col gap-2">
                          <button onClick={() => analyzeAndSaveLots(id)} className="w-full py-4 rounded-xl font-black text-lg shadow-md bg-orange-500 hover:bg-orange-600 text-white transition-transform active:scale-95">
                            [2단계] 수축률 분석 및 결과 확정
                          </button>
                          <button onClick={() => unlockPreSintering(id)} className="w-full py-2.5 rounded-xl font-bold text-sm bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700 border border-slate-300 transition-colors">
                            🔓 소결 전 면적 수정하기 (잠금 해제)
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {alertModal.isOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-2xl max-w-sm w-full transform transition-all border-t-8 border-teal-500">
            <h3 className={`text-xl font-black mb-4 flex items-center gap-2 ${alertModal.type === 'success' ? 'text-teal-600' : 'text-indigo-800'}`}>{alertModal.type === 'success' ? '🎉 성공' : '🔔 알림'}</h3>
            <p className="text-slate-600 font-bold mb-8 leading-relaxed whitespace-pre-line text-lg">{alertModal.message}</p>
            <button onClick={() => setAlertModal({ isOpen: false, message: '', type: 'info' })} className="w-full text-white py-3 sm:py-4 rounded-xl font-black text-lg transition-colors outline-none bg-teal-600 hover:bg-teal-700">확인</button>
          </div>
        </div>
      )}

      {lotSplitModal.isOpen && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-white p-6 sm:p-8 rounded-3xl shadow-2xl max-w-2xl w-full transform transition-all border-4 border-rose-100 flex flex-col max-h-[90vh]">
            <h3 className="text-2xl font-black text-rose-600 mb-4 flex items-center gap-2">🚨 수축률 편차 감지 (0.3% 초과)</h3>
            <div className="text-slate-700 font-medium mb-4 text-sm sm:text-base leading-relaxed">위치 간 수축률 편차가 0.3%를 초과합니다. 같은 로트로 묶을 그룹(A, B, C...)을 직접 지정해 주세요. 지정된 그룹별로 평균 수축률이 산출되며 로트가 분리됩니다.</div>
            
            <div className="overflow-y-auto mb-6 pr-2 space-y-3">
              {lotSplitModal.lotsToSplit?.map((lot, wIdx) => (
                <div key={wIdx} className="mb-6 bg-rose-50 border border-rose-200 rounded-xl p-4">
                  <h4 className="font-black text-rose-800 mb-3 border-b border-rose-200 pb-2">품번: {lot.baseMixLot}</h4>
                  <div className="flex flex-col gap-2">
                    {lot.slots?.map((s, sIdx) => {
                      const slotLabel = slots.find(sl => sl.id === s.sId)?.label || s.sId;
                      return (
                        <div key={sIdx} className="flex justify-between items-center bg-white p-3 rounded-lg border border-rose-100 shadow-sm">
                          <div className="flex items-center gap-3">
                            <span className="font-black text-slate-700 bg-white border border-slate-300 px-2 py-1 rounded text-xs">{lotSplitModal.fid}호기 {slotLabel}</span>
                            <span className="text-sm font-bold text-slate-700">수축률: <span className="text-rose-600 text-lg">{s.shrinkVal}%</span></span>
                          </div>
                          <div className="flex items-center gap-2">
                            <label className="text-xs font-bold text-slate-500">그룹 지정:</label>
                            <select value={s.group} onChange={(e) => handleGroupChange(wIdx, sIdx, e.target.value)} className="border-2 border-slate-300 rounded p-1.5 text-sm font-black text-slate-800 focus:outline-none focus:border-rose-400 bg-white cursor-pointer">
                              <option value="A">Group A</option><option value="B">Group B</option><option value="C">Group C</option><option value="D">Group D</option><option value="E">Group E</option>
                            </select>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-3 mt-auto">
              <button onClick={applyCustomSplit} className="w-full bg-rose-500 hover:bg-rose-600 text-white py-4 rounded-xl font-black text-lg shadow-lg shadow-rose-200 outline-none">지정한 그룹으로 로트 분리 확정</button>
              <button onClick={applyMergeAll} className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 py-4 rounded-xl font-black text-lg outline-none border border-slate-300">무시하고 하나의 로트로 통합 (전체 평균)</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// ==========================================
// Step 6: Inspection & Machining
// ==========================================
function Step6Inspection({ wipList, ctx }) {
  const pendingWip = wipList.filter((w) => w.currentStep === "step6");
  const [formData, setFormData] = useState({});
  const handleDataChange = (id, field, val) => setFormData((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: val } }));

  const moveNext = async (id) => {
    const data = formData[id] || {};
    if (!data.operator) return ctx.showToast("작업자 성명을 입력해주세요.", "error");

    const defectQty = parseInt(data.defects) || 0;
    const defectStr = defectQty > 0 ? ` [불량 ${defectQty}개: ${data.defectReason || "사유미상"}]` : "";

    try {
      const w = wipList.find((i) => i.id === id);
      await setDoc(getDocRef("wipList", id), {
        ...w, qty: Math.max(0, w.qty - defectQty), currentStep: "step7",
        details: `${w.details || ""}\n[${getKST()}] [검수] 내경:${data.innerDia || 0} | 외경:${data.outerDia || 0} | 턱:${data.stepH || 0} | 제품:${data.prodH || 0} | 담당:${data.operator}${defectStr}`,
      });
      ctx.showToast("검수 완료", "success");
      logProcessToGoogleSheet("step6", { ...w, qty: w.qty - defectQty }, data.operator, { defects: defectQty, defectReason: data.defectReason || "-", measurements: `내경:${data.innerDia}, 외경:${data.outerDia}, 턱:${data.stepH}, 제품:${data.prodH}`, details: data.memo || "검수완료" });
    } catch (err) { ctx.showToast("오류 발생", "error"); }
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex justify-between items-center">
        <h3 className="text-lg font-black text-slate-800 flex items-center"><Microscope className="w-5 h-5 mr-2 text-indigo-600" /> 검수 및 가공 현황</h3>
        <span className="text-xs font-bold text-slate-500 bg-white px-3 py-1 rounded-full border">대기: {pendingWip.length}건</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left border-collapse table-fixed">
          <thead>
           <tr className="text-[11px] uppercase tracking-wider text-slate-500 bg-slate-50/50">
              <th className="p-4 font-bold border-b w-40 whitespace-nowrap">로트 / 제품명</th>
              <th className="p-4 font-bold border-b w-20 whitespace-nowrap">현재수량</th>
              <th className="p-4 font-bold border-b text-center w-56 whitespace-nowrap">치수 측정 (내/외/턱/높)</th>
              <th className="p-4 font-bold border-b w-32 whitespace-nowrap">불량 관리</th>
              <th className="p-4 font-bold border-b w-28 whitespace-nowrap">담당자</th>
              <th className="p-4 font-bold border-b min-w-[150px]">메모</th>
              <th className="p-4 font-bold border-b text-center w-24 whitespace-nowrap">작업</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pendingWip.length === 0 ? (
              <tr><td colSpan="7" className="text-center py-20 text-slate-400 font-medium">현재 검수 대기 중인 물량이 없습니다.</td></tr>
            ) : (
              pendingWip.map((wip) => {
                const data = formData[wip.id] || {};
                return (
                  <tr key={wip.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="p-4">
                      <div className="text-[10px] font-mono font-bold text-indigo-600 mb-1">{wip.mixLot}</div>
                      <div className="font-black text-slate-800">{getProductLabel(wip.type)} {wip.height}T</div>
                    </td>
                    <td className="p-4 font-black text-blue-600 text-lg">{wip.qty}</td>
                    <td className="p-4">
                      <div className="grid grid-cols-2 gap-1.5 w-40 mx-auto">
                        <div className="relative"><span className="absolute left-1 top-0.5 text-[8px] text-slate-400 font-bold">내</span><input type="text" value={data.innerDia || ""} onChange={(e) => handleDataChange(wip.id, "innerDia", e.target.value)} className="w-full pl-4 pr-1 py-1 text-[11px] font-bold border rounded bg-white" placeholder="0.0" /></div>
                        <div className="relative"><span className="absolute left-1 top-0.5 text-[8px] text-slate-400 font-bold">외</span><input type="text" value={data.outerDia || ""} onChange={(e) => handleDataChange(wip.id, "outerDia", e.target.value)} className="w-full pl-4 pr-1 py-1 text-[11px] font-bold border rounded bg-white" placeholder="0.0" /></div>
                        <div className="relative"><span className="absolute left-1 top-0.5 text-[8px] text-slate-400 font-bold">턱</span><input type="text" value={data.stepH || ""} onChange={(e) => handleDataChange(wip.id, "stepH", e.target.value)} className="w-full pl-4 pr-1 py-1 text-[11px] font-bold border rounded bg-white" placeholder="0.0" /></div>
                        <div className="relative"><span className="absolute left-1 top-0.5 text-[8px] text-slate-400 font-bold">높</span><input type="text" value={data.prodH || ""} onChange={(e) => handleDataChange(wip.id, "prodH", e.target.value)} className="w-full pl-4 pr-1 py-1 text-[11px] font-bold border rounded bg-white" placeholder="0.0" /></div>
                      </div>
                    </td>
                    <td className="p-4">
                      <div className="flex flex-col gap-1 w-28">
                        <input type="number" onChange={(e) => handleDataChange(wip.id, "defects", e.target.value)} className="w-full border p-1.5 text-xs rounded text-red-600 font-bold border-red-100" placeholder="불량수" />
                        <input type="text" onChange={(e) => handleDataChange(wip.id, "defectReason", e.target.value)} className="w-full border p-1.5 text-[10px] rounded" placeholder="사유" />
                      </div>
                    </td>
                    <td className="p-4"><input type="text" onChange={(e) => handleDataChange(wip.id, "operator", e.target.value)} className="w-20 border p-1.5 text-xs rounded font-bold focus:border-indigo-400 outline-none" placeholder="성명" /></td>
                    <td className="p-4"><input type="text" onChange={(e) => handleDataChange(wip.id, "memo", e.target.value)} className="w-full border p-1.5 text-xs rounded focus:border-indigo-400 outline-none" placeholder="특이사항 입력" /></td>
                    <td className="p-4 text-center"><button onClick={() => moveNext(wip.id)} className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-xs font-black shadow-sm transition-transform active:scale-95">완료</button></td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ==========================================
// Step 7: Drying Room
// ==========================================
function Step7Drying({ wipList, dryingRoom: room, ctx }) {
  const pendingWip = wipList.filter((w) => w.currentStep === "step7");
  const dryingWip = wipList.filter((w) => w.currentStep === "step7_drying");

  const handleRoomConfig = async (field, val) => {
    try { await setDoc(getDocRef("equipment", "dryingRoom"), { ...room, [field]: val }); } catch (e) { console.error("저장 오류:", e); }
  };

  const handleStartDrying = async (wipId) => {
    if (!room?.operator) return ctx.showToast("건조실 담당자를 입력하세요.", "error");
    try {
      const w = wipList.find((i) => i.id === wipId);
      await setDoc(getDocRef("wipList", wipId), { ...w, currentStep: "step7_drying" });
      ctx.showToast("건조 시작", "success");
    } catch (e) { ctx.showToast("오류 발생", "error"); }
  };

  const handleCompData = async (id, field, val) => {
    const cData = room?.completionData || {};
    const tData = cData[id] || {};
    try { await setDoc(getDocRef("equipment", "dryingRoom"), { ...room, completionData: { ...cData, [id]: { ...tData, [field]: val } } }); } catch (e) {}
  };

  const handleCompleteItem = async (targetId) => {
    const w = wipList.find((i) => i.id === targetId);
    if (!w) return;

    const cData = room?.completionData?.[targetId] || {};
    const def = parseInt(cData.defects) || 0;
    const remainQty = w.qty - def;

    if (remainQty < 0) return ctx.showToast("불량 오류", "error");
    const defStr = def > 0 ? ` [불량 ${def}개: ${cData.reason || "사유미상"}]` : "";
    const memoStr = cData.specialNote ? ` [메모: ${cData.specialNote}]` : "";
    const recordDetails = `[${getKST()}] [건조] 온도:${room?.temp || 60}°C | 습도:${room?.humidity || 20}% | 담당:${room?.operator || "미상"}${defStr}${memoStr}`;

    try {
      await setDoc(getDocRef("wipList", targetId), { ...w, qty: remainQty, currentStep: "step8", details: `${w.details || ""}\n${recordDetails}` });
      const newCompData = { ...(room?.completionData || {}) };
      delete newCompData[targetId];
      await setDoc(getDocRef("equipment", "dryingRoom"), { ...room, completionData: newCompData });
      ctx.showToast("건조 완료 및 포장 이관", "success");
      logProcessToGoogleSheet("step7", { ...w, qty: remainQty }, room?.operator, { defects: def, defectReason: cData.reason || "-", conditions: `온도:${room?.temp || 60}°C, 습도:${room?.humidity || 20}%`, details: cData.specialNote || "-" });
    } catch (err) { ctx.showToast("오류 발생", "error"); }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="bg-white border p-6 rounded-xl shadow-sm">
        <h3 className="font-bold text-lg mb-4 flex items-center"><Wind className="w-5 h-5 mr-2 text-cyan-500" /> 건조실 설정 및 대기열</h3>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400 ml-1">온도 (°C)</label><SyncInput type="text" value={room?.temp || ""} onChange={(val) => handleRoomConfig("temp", val)} className="border p-2 w-full rounded text-sm font-bold text-red-500 outline-none" /></div>
          <div className="space-y-1"><label className="text-[10px] font-bold text-slate-400 ml-1">습도 (%)</label><SyncInput type="text" value={room?.humidity || ""} onChange={(val) => handleRoomConfig("humidity", val)} className="border p-2 w-full rounded text-sm font-bold text-blue-500 outline-none" /></div>
        </div>
        <div className="space-y-1 mb-6"><label className="text-[10px] font-bold text-slate-400 ml-1">담당 작업자</label><SyncInput type="text" placeholder="성명 입력" value={room?.operator || ""} onChange={(val) => handleRoomConfig("operator", val)} className="border p-2 w-full rounded text-sm font-bold outline-none" /></div>
        <div className="space-y-2">
          {pendingWip.length === 0 && <div className="text-slate-400 text-sm text-center py-8 border border-dashed rounded-lg">대기 중인 물량이 없습니다.</div>}
          {pendingWip.map((w) => (
            <div key={w.id} className="border p-3 rounded-lg flex justify-between items-center bg-slate-50 border-slate-200">
              <div><div className="text-[10px] font-mono font-bold text-indigo-600">{w.mixLot}</div><div className="text-sm font-black">{getProductLabel(w.type)} {w.height}T<span className="text-slate-400 ml-1">({w.qty}개)</span></div></div>
              <button onClick={() => handleStartDrying(w.id)} className="bg-slate-800 text-white px-4 py-2 text-xs rounded-lg font-bold">건조 시작</button>
            </div>
          ))}
        </div>
      </div>
      <div className="bg-white border p-6 rounded-xl shadow-sm">
        <h3 className="font-bold text-lg mb-4 flex items-center"><Droplets className="w-5 h-5 mr-2 text-blue-500" /> 건조실 내부 (진행 중)</h3>
        <div className="space-y-4">
          {dryingWip.length === 0 && <div className="text-slate-400 text-sm text-center py-16 border border-dashed rounded-lg bg-slate-50">현재 건조 중인 물량이 없습니다.</div>}
          {dryingWip.map((w) => {
            const cData = room?.completionData?.[w.id] || {};
            return (
              <div key={w.id} className="border-2 border-cyan-100 p-4 rounded-xl bg-cyan-50/30">
                <div className="flex justify-between items-start mb-3">
                  <div><div className="text-[10px] font-mono font-bold text-cyan-700">{w.mixLot}</div><div className="font-black text-slate-800">{getProductLabel(w.type)} {w.height}T<span className="text-cyan-600 ml-1">({w.qty}개)</span></div></div>
                </div>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <SyncInput type="number" placeholder="불량 수량" value={cData.defects || ""} onChange={(val) => handleCompData(w.id, "defects", val)} className="border border-red-200 p-2 text-xs rounded bg-white text-red-600 font-bold" />
                  <SyncInput type="text" placeholder="불량 사유" value={cData.reason || ""} onChange={(val) => handleCompData(w.id, "reason", val)} className="border border-slate-200 p-2 text-xs rounded bg-white" />
                </div>
                <div className="flex gap-2">
                  <SyncInput type="text" placeholder="메모" value={cData.specialNote || ""} onChange={(val) => handleCompData(w.id, "specialNote", val)} className="border border-slate-200 p-2 text-xs flex-1 rounded bg-white" />
                  <button onClick={() => handleCompleteItem(w.id)} className="bg-cyan-600 text-white px-4 py-2 rounded-lg text-xs font-black shadow-md">건조 완료</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ==========================================
// Step 8: Packaging
// ==========================================
function Step8Packaging({ wipList, orderList, ctx }) {
  const pendingWip = wipList.filter((w) => w.currentStep === "step8");
  const [formData, setFormData] = useState({});
  const [printedStatus, setPrintedStatus] = useState({}); 

  const handleDataChange = (id, field, val) => setFormData((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: val } }));

  const moveNext = async (wipId) => {
    const data = formData[wipId] || {};
    const wip = wipList.find((w) => w.id === wipId);

    if (!data.operator || !wip?.shrinkageRate) {
      return ctx.showToast("작업자 성명 입력 혹은 열처리 단계 수축률 데이터가 필요합니다.", "error");
    }

    const defectQty = parseInt(data.defects) || 0;
    const defectStr = defectQty > 0 ? ` [불량 ${defectQty}개: ${data.defectReason || "사유미상"}]` : "";

    try {
      const newLot = `F${getKSTDateOnly().slice(-5)}${wip.id.slice(-2)}`;
      await setDoc(getDocRef("wipList", wip.id), {
        ...wip, mixLot: newLot, shrinkageRate: wip.shrinkageRate, qty: Math.max(0, wip.qty - defectQty), currentStep: "done",
        details: `${wip.details || ""}\n[${getKST()}] [포장완료] 담당: ${data.operator} [수축률: ${wip.shrinkageRate}]${defectStr}`,
      });

      ctx.showToast("포장 및 수축률 기록 완료", "success");
      logProcessToGoogleSheet("step8", { ...wip, qty: wip.qty - defectQty }, data.operator, { defects: defectQty, defectReason: data.defectReason || "-", measurements: `S.F:${wip.shrinkageRate}`, details: data.specialNote || "-" });
    } catch (err) { console.error(err); ctx.showToast("오류 발생", "error"); }
  };

  const handlePrintLabel = async (wipId) => {
    const wip = wipList.find((w) => w.id === wipId);
    if (!wip?.shrinkageRate) return ctx.showToast("열처리 단계 수축률 데이터가 없습니다.", "error");

    const data = formData[wipId] || {};
    const defectQty = parseInt(data.defects) || 0;
    const finalQty = Math.max(0, wip.qty - defectQty);
    const finalLot = `F${getKSTDateOnly().slice(-5)}${wip.id.slice(-2)}`;
    const productName = `Z1100VT${getProductShade(wip.type)}${wip.height}`;
    const sizeDisplay = `Φ98 x ${wip.height}mm`;
    
    const s = Number(wip.shrinkageRate);
    const calculatedScaleFactor = (1 / (1 - s / 100)).toFixed(4);

    try {
      const database = getFirestore();
      await addDoc(collection(database, "print-queue"), {
        productName, color: getProductShade(wip.type), height: wip.height, lotNumber: finalLot, shrinkage: wip.shrinkageRate, scaleFactor: calculatedScaleFactor,
        mfgDate: getKST().split(" ")[0], size: sizeDisplay, quantity: finalQty, status: "pending", createdAt: serverTimestamp(),
      });
      ctx.showToast("라벨 출력 명령 전송 완료! 🖨️", "success");
      setPrintedStatus(prev => ({ ...prev, [wipId]: true })); 
    } catch (err) { console.error("전송 에러:", err); ctx.showToast(`전송 실패: ${err.message}`, "error"); }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
      <h3 className="text-lg font-bold mb-2">포장 및 라벨링</h3>
      <p className="text-sm text-slate-500 mb-6">최종 수축률(Scaling Factor)을 입력하고 라벨을 발행합니다.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-y border-slate-200">
            <tr><th className="px-4 py-3">현재 로트</th><th className="px-4 py-3">제품/색상</th><th className="px-4 py-3 text-center">최종수량</th><th className="px-4 py-3 text-blue-600">수축률 (S.F)</th><th className="px-4 py-3 text-red-600">불량(수량/사유)</th><th className="px-4 py-3">메모/작업자</th><th className="px-4 py-3 text-center">작업</th></tr>
          </thead>
          <tbody>
            {pendingWip.length === 0 && <tr><td colSpan="7" className="text-center py-10 text-slate-400 font-bold">포장 대기 중인 제품이 없습니다.</td></tr>}
            {pendingWip.map((wip) => {
              const data = formData[wip.id] || {};
              return (
                <tr key={wip.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-4"><div className="flex flex-col"><span className="text-[10px] text-slate-400 font-bold mb-1 uppercase">원로트: {wip.mixLot}</span><div className="text-lg font-black text-indigo-700 bg-indigo-50 px-4 py-1.5 rounded-lg border border-indigo-200 shadow-sm w-max tracking-widest">F{getKSTDateOnly().slice(-5)}{wip.id.slice(-2)}</div></div></td>
                  <td className="px-4 py-4 font-bold text-slate-800">{getProductLabel(wip.type)} <span className="text-indigo-600">{wip.height}T</span></td>
                  <td className="px-4 py-4 font-black text-indigo-700 text-xl text-center">{wip.qty}</td>
                  <td className="px-4 py-4"><div className="flex flex-col items-center bg-blue-50 px-4 py-1.5 rounded-lg border border-blue-100 shadow-sm min-w-[100px]"><div className="text-[10px] font-bold text-slate-500 mb-0.5">수축률: {wip.shrinkageRate}%</div><div className="text-lg font-black text-blue-700">{(1 / (1 - Number(wip.shrinkageRate) / 100)).toFixed(4)}</div></div></td>
                  <td className="px-4 py-4 w-40"><div className="flex flex-col space-y-1"><input type="number" placeholder="불량" value={data.defects || ""} onChange={(e) => handleDataChange(wip.id, "defects", e.target.value)} className="border border-red-200 rounded p-1.5 text-xs text-center text-red-600 bg-red-50" /><input type="text" placeholder="사유" value={data.defectReason || ""} onChange={(e) => handleDataChange(wip.id, "defectReason", e.target.value)} className="border rounded p-1.5 text-[10px]" /></div></td>
                  <td className="px-4 py-4 w-40"><div className="flex flex-col space-y-1"><input type="text" placeholder="메모" value={data.specialNote || ""} onChange={(e) => handleDataChange(wip.id, "specialNote", e.target.value)} className="border rounded p-1.5 text-[10px]" /><input type="text" placeholder="작업자" value={data.operator || ""} onChange={(e) => handleDataChange(wip.id, "operator", e.target.value)} className="border rounded p-1.5 text-xs text-center font-bold" /></div></td>
                  <td className="px-4 py-4"><div className="flex flex-col space-y-2"><button onClick={() => handlePrintLabel(wip.id)} className={`text-[10px] px-2 py-1.5 rounded font-bold flex items-center justify-center shadow-sm border transition-colors ${printedStatus[wip.id] ? "bg-green-50 text-green-600 border-green-200 hover:bg-green-100" : "bg-slate-100 text-slate-600 border-slate-200 hover:bg-indigo-50 hover:text-indigo-600"}`}><Printer className="w-3 h-3 mr-1" /> {printedStatus[wip.id] ? "재출력" : "라벨출력"}</button><button onClick={() => moveNext(wip.id)} className="text-[10px] bg-indigo-600 text-white px-2 py-1.5 rounded font-bold hover:bg-indigo-700 flex items-center justify-center shadow-sm"><CheckCircle2 className="w-3 h-3 mr-1" /> 포장완료</button></div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ==========================================
// Step 9: Finished Goods
// ==========================================
function Step9FinishedGoods({ wipList, shippingHistory, orderList, ctx }) {
  const finishedWip = wipList.filter((w) => w.currentStep === "done");
  const [shipData, setShipData] = useState({});

  const handleShip = async (wip) => {
    const d = shipData[wip.id] || {};
    const safeQty = parseInt(d.qty);

    if (isNaN(safeQty) || safeQty <= 0) {
      return ctx.showToast(
        "출고 수량을 올바른 숫자로 입력해주세요.",
        "error"
      );
    }
    if (!d.destination || !d.operator) {
      return ctx.showToast(
        "출고처와 담당자를 모두 입력해주세요.",
        "error"
      );
    }
    if (safeQty > Number(wip.qty)) {
      return ctx.showToast(
        `현재고 ${wip.qty}EA보다 많이 출고할 수 없습니다.`,
        "error"
      );
    }

    ctx.showConfirm(
      `${wip.mixLot} ${safeQty}EA를 출고 처리하시겠습니까?`,
      async () => {
        try {
          const hid =
            Date.now().toString() + Math.random().toString().slice(2, 6);
          const curTime = getKST();

          await runTransaction(db, async (transaction) => {
            const wipRef = getDocRef("wipList", wip.id);
            const liveSnap = await transaction.get(wipRef);

            if (!liveSnap.exists()) {
              throw new Error("이미 출고되었거나 삭제된 완제품입니다.");
            }

            const live = liveSnap.data();
            const liveQty = Number(live.qty) || 0;

            if (live.currentStep !== "done") {
              throw new Error("완제품 창고에 있는 제품만 출고할 수 있습니다.");
            }
            if (safeQty > liveQty) {
              throw new Error(
                `현재 최신 재고는 ${liveQty}EA입니다. 출고 수량을 다시 확인해주세요.`
              );
            }

            transaction.set(getDocRef("shippingHistory", hid), {
              id: hid,
              orderId: live.orderId || "",
              lot: live.mixLot,
              type: live.type,
              height: live.height,
              weight: live.weight || "",
              qty: safeQty,
              destination: d.destination,
              operator: d.operator,
              date: curTime.slice(0, 16),
              details: live.details || "",
              createdAt: serverTimestamp(),
            });

            const remainQty = liveQty - safeQty;
            if (remainQty <= 0) {
              transaction.delete(wipRef);
            } else {
              transaction.update(wipRef, { qty: remainQty });
            }
          });

          ctx.showToast(
            "출고 완료 — 발주 진행률에 자동 반영되었습니다.",
            "success"
          );
          logProcessToGoogleSheet(
            "step9",
            { ...wip, qty: safeQty },
            d.operator,
            {
              equipment: d.destination,
              details: wip.details ? "이력포함출고" : "일반출고",
            }
          );
        } catch (e) {
          ctx.showToast(
            e?.message || "출고 중 오류가 발생했습니다.",
            "error"
          );
        }
      }
    );
  };

  const inventorySummary = finishedWip.reduce((acc, curr) => {
    const productType = getProductLabel(curr.type);
    const k = `${productType}_${curr.height}`;
    if (!acc[k]) acc[k] = { type: productType, height: curr.height, qty: 0 };
    acc[k].qty += curr.qty; return acc;
  }, {});

  return (
    <div className="bg-white rounded-xl border p-6 space-y-6">
      <h3 className="text-lg font-bold flex items-center"><Archive className="w-5 h-5 mr-2 text-indigo-500" /> 완제품 현재고 요약</h3>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        {Object.values(inventorySummary).map((i) => (
          <div key={`${i.type}_${i.height}`} className="bg-white p-4 rounded-xl shadow border text-center">
            <div className="text-sm font-bold text-slate-500 mb-1">{i.type} <span className="text-indigo-600">{i.height}T</span></div>
            <div className="text-2xl font-black">{i.qty} EA</div>
          </div>
        ))}
        {Object.keys(inventorySummary).length === 0 && <div className="col-span-full text-center text-slate-400 py-6 bg-white rounded border border-dashed">재고 없음</div>}
      </div>

      <div className="bg-white rounded-xl shadow-sm border p-6">
        <h3 className="text-lg font-bold mb-4">로트별 출고 처리</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="bg-slate-50 border-b text-xs text-slate-500"><tr><th className="p-3">포장 LOT</th><th className="p-3">제품/색상</th><th className="p-3">현재고</th><th className="p-3 w-28">출고 수량</th><th className="p-3 w-48">출고처</th><th className="p-3 w-32">담당자</th><th className="p-3 text-center">작업</th></tr></thead>
            <tbody>
              {finishedWip.length === 0 && <tr><td colSpan="7" className="text-center py-6 text-slate-400">대기 물량 없음</td></tr>}
              {finishedWip.map((w) => {
                const d = shipData[w.id] || {};
                return (
                  <tr key={w.id} className="border-b hover:bg-slate-50">
                    <td className="p-3 font-bold text-slate-700">{w.mixLot}</td>
                    <td className="p-3 font-bold">{getProductLabel(w.type)} {w.height}T</td>
                    <td className="p-3 font-black text-indigo-600 text-lg">{w.qty}</td>
                    <td className="p-3"><input type="number" max={w.qty} min="1" placeholder="수량" value={d.qty || ""} onChange={(e) => setShipData({ ...shipData, [w.id]: { ...d, qty: e.target.value } }) } className="w-full border p-2 rounded text-center font-bold focus:border-indigo-400 outline-none" /></td>
                    <td className="p-3">
                      <div className="flex flex-col gap-2">
                        <select value={d.destSelect || ""} onChange={(e) => { const val = e.target.value; setShipData({ ...shipData, [w.id]: { ...d, destSelect: val, destination: val === "직접입력" ? "" : val } }); }} className="w-full border p-2 rounded text-sm font-bold text-slate-700 focus:border-indigo-400 outline-none">
                          <option value="">출고처 선택</option><option value="이엔씨">이엔씨</option><option value="직접입력">직접입력...</option>
                        </select>
                        {d.destSelect === "직접입력" && <input type="text" placeholder="거래처 직접 입력" value={d.destination || ""} onChange={(e) => setShipData({ ...shipData, [w.id]: { ...d, destination: e.target.value } }) } className="w-full border border-indigo-300 bg-indigo-50 p-2 rounded text-sm focus:border-indigo-500 outline-none" />}
                      </div>
                    </td>
                    <td className="p-3"><input type="text" placeholder="담당자" value={d.operator || ""} onChange={(e) => setShipData({ ...shipData, [w.id]: { ...d, operator: e.target.value } }) } className="w-full border p-2 rounded text-center font-bold focus:border-indigo-400 outline-none" /></td>
                    <td className="p-3 text-center"><button onClick={() => handleShip(w)} className="bg-indigo-600 text-white px-4 py-2.5 rounded-lg font-bold shadow-md hover:bg-indigo-700 flex items-center justify-center transition-transform hover:scale-105 w-full"><Truck className="w-4 h-4 mr-1.5" /> 출고</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border p-6">
        <h3 className="text-lg font-bold mb-4 flex items-center"><History className="w-5 h-5 mr-2 text-slate-500" /> 완제품 출고 이력</h3>
        <div className="overflow-x-auto max-h-60 border rounded-lg">
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 sticky top-0 text-xs text-slate-500"><tr><th className="p-3">출고일시</th><th className="p-3">포장 LOT</th><th className="p-3">제품</th><th className="p-3 text-right pr-6">출고수량</th><th className="p-3">출고처</th><th className="p-3">담당자</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {shippingHistory.map((h) => (
                <tr key={h.id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-3 text-xs text-slate-500">{h.date}</td><td className="p-3 font-mono font-bold text-slate-700">{h.lot}</td><td className="p-3 font-bold text-slate-800">{getProductLabel(h.type)} <span className="text-indigo-600">{h.height}T</span></td><td className="p-3 font-black text-indigo-600 text-right pr-6">{h.qty} EA</td><td className="p-3 font-bold text-slate-700">{h.destination}</td><td className="p-3 font-bold text-slate-600">{h.operator}</td>
                </tr>
              ))}
              {shippingHistory.length === 0 && <tr><td colSpan="6" className="text-center py-6 text-slate-400">출고 이력이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// 추적 화면: Lot Genealogy Tracking 
// ==========================================
function StepTracking({ wipList, shippingHistory, inventoryHistory, orderList, ctx }) {
  const [searchLot, setSearchLot] = useState("");
  const [results, setResults] = useState([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editData, setEditData] = useState({});

  const handleSearch = () => {
    if (!searchLot) return;
    setHasSearched(true);
    const searchTerms = searchLot.trim().toUpperCase().split(/\s+/);
    const isMatch = (item, isShipped) => {
      const productLabel = item.type ? getProductLabel(item.type) : "";
      const searchableText = isShipped
        ? `${item.lot || ""} ${item.originalLot || ""} ${productLabel} ${item.height || ""}T ${item.destination || ""} ${item.operator || ""} ${item.details || ""}`.toUpperCase()
        : `${item.mixLot || ""} ${item.originalLot || ""} ${productLabel} ${item.height || ""}T ${item.details || ""}`.toUpperCase();
      return searchTerms.every((term) => searchableText.includes(term));
    };

    const shippedMatches = shippingHistory.filter((h) => isMatch(h, true));
    const wipMatches = wipList.filter((w) => isMatch(w, false));
    const combined = [...shippedMatches.map((data) => ({ type: "shipped", data, collection: "shippingHistory" })), ...wipMatches.map((data) => ({ type: "wip", data, collection: "wipList" }))];

    setResults(combined);
    setEditingId(null);
    if (combined.length === 0 && ctx) ctx.showToast("검색 결과가 없습니다.", "error");
    else if (ctx) ctx.showToast(`${combined.length}건의 이력을 찾았습니다.`, "success");
  };

  const startEdit = (res) => { setEditData({ ...res.data }); setEditingId(res.data.id); };

  const handleSaveEdit = async (res) => {
    try {
      await setDoc(getDocRef(res.collection, res.data.id), editData);
      if (ctx) ctx.showToast("마스터 권한으로 수정되었습니다.", "success");
      setResults(results.map((r) => r.data.id === res.data.id ? { ...r, data: editData } : r ));
      setEditingId(null);
    } catch (error) { if (ctx) ctx.showToast("수정 실패", "error"); }
  };

  const handleDelete = (res) => {
    const targetLot = res.data.mixLot || res.data.lot;
    if (ctx && ctx.showConfirm) {
      ctx.showConfirm(`[마스터 권한] 정말로 로트(${targetLot}) 데이터를 영구 삭제하시겠습니까?`, async () => {
        try {
          await deleteDoc(getDocRef(res.collection, res.data.id));
          ctx.showToast(`로트(${targetLot}) 영구 삭제 완료`, "success");
          setResults(results.filter((r) => r.data.id !== res.data.id));
        } catch (error) { ctx.showToast("삭제 실패", "error"); }
      });
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-100">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-2xl font-black flex items-center text-slate-800"><Search className="w-6 h-6 mr-2 text-indigo-600" /> 로트 공정 이력 통합 검색</h3>
          <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full text-xs font-black border border-red-200 animate-pulse">Master Mode</span>
        </div>
        <div className="flex gap-3 mb-8">
          <input type="text" placeholder="검색어 입력 (예: 345 BL3 30T, 234 BL2, 이엔씨, 담당자명, 또는 로트번호 일부)" className="flex-1 border-2 border-slate-300 rounded-xl p-4 font-bold text-lg focus:border-indigo-500 outline-none placeholder:text-sm" value={searchLot} onChange={(e) => { setSearchLot(e.target.value); setHasSearched(false); }} onKeyDown={(e) => e.key === "Enter" && handleSearch()} />
          <button onClick={handleSearch} className="bg-indigo-600 text-white px-8 py-4 rounded-xl font-black text-lg shadow-md hover:bg-indigo-700 flex items-center transition-transform hover:scale-105"><Search className="w-5 h-5 mr-2" /> 통합 검색</button>
        </div>

        {hasSearched && results.length === 0 && <div className="text-center py-16 bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200 text-slate-500 font-bold text-lg">일치하는 기록이 없습니다. 검색어를 바꿔보세요.</div>}

        <div className="space-y-6 max-h-[800px] overflow-y-auto pr-2">
          {results.map((result, idx) => {
            const isEditing = editingId === result.data.id;
            let historyLogs = (result.data.details || "").split("\n").filter((line) => line.trim() !== "");
            if (result.type === "shipped") historyLogs.push(`[출고 완료] 출고일시:${result.data.date} | 출고처:${result.data.destination} | 담당:${result.data.operator}`);

            return (
              <div key={idx} className={`border-2 rounded-2xl p-6 transition-all ${isEditing ? "border-orange-400 bg-orange-50/30" : "border-indigo-100 bg-indigo-50/30"}`}>
                <div className={`flex flex-col md:flex-row justify-between items-start md:items-center border-b pb-4 mb-4 gap-4 ${isEditing ? "border-orange-200" : "border-indigo-100"}`}>
                  <div>
                    <span className={`px-3 py-1 rounded-full text-xs font-black mr-3 ${result.type === "shipped" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>{result.type === "shipped" ? "출고 완료 제품" : "생산 진행 중"}</span>
                    <span className="font-black text-2xl text-slate-800">{result.data.lot || result.data.mixLot}</span>
                    {result.data.originalLot && <div className="text-sm font-bold text-slate-400 mt-1">원로트: {result.data.originalLot}</div>}
                  </div>
                  <div className="text-left md:text-right flex flex-col items-start md:items-end">
                    <div className="font-black text-xl text-indigo-700">{getProductLabel(result.data.type)} {result.data.height}T</div>
                    <div className="text-sm font-bold text-slate-500 mt-1">현재 수량: {result.data.qty} EA</div>
                    {result.data.weight && <div className="mt-1.5 text-xs font-black text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded shadow-sm">원료 투입량: {result.data.weight} kg</div>}
                  </div>
                </div>

                <div className="space-y-4">
                  <h4 className="font-black text-slate-700 mb-2 flex items-center">공정 진행 타임라인 {isEditing && <span className="text-orange-600 ml-2 text-sm">(수정 모드)</span>}</h4>
                  <div className="bg-white p-5 rounded-xl border shadow-sm text-sm text-slate-600 leading-relaxed grid grid-cols-1 gap-4">
                    {isEditing ? (
                      <>
                        <div className="flex items-center"><strong className="w-24 text-slate-800">현재 수량:</strong> <input type="number" value={editData.qty || ""} onChange={(e) => setEditData({ ...editData, qty: Number(e.target.value) }) } className="border border-orange-300 rounded p-1.5 w-32 font-bold focus:outline-none" /></div>
                        <div className="flex items-center"><strong className="w-24 text-slate-800">진행 상태:</strong> <input type="text" value={editData.currentStep || ""} onChange={(e) => setEditData({ ...editData, currentStep: e.target.value }) } className="border border-orange-300 rounded p-1.5 flex-1 font-bold text-orange-700 focus:outline-none" /></div>
                        <div className="flex items-start"><strong className="w-24 text-slate-800 mt-1">누적 기록:</strong> <textarea value={editData.details || ""} onChange={(e) => setEditData({ ...editData, details: e.target.value }) } className="border border-orange-300 rounded p-2 flex-1 h-32 text-xs focus:outline-none whitespace-pre-wrap" /></div>
                      </>
                    ) : (
                      <div className="relative pl-4 border-l-2 border-indigo-200 space-y-4 py-2">
                        {historyLogs.map((log, logIdx) => {
                          const isDefect = log.includes("불량");
                          return (
                            <div key={logIdx} className="relative">
                              <div className={`absolute -left-[23px] top-1 w-3 h-3 rounded-full ring-4 ring-white ${isDefect ? "bg-red-500" : "bg-indigo-500"}`}></div>
                              <div className={`font-bold leading-tight ${isDefect ? "text-red-600 bg-red-50 inline-block px-2 py-0.5 rounded shadow-sm" : "text-slate-800"}`}>{log}</div>
                            </div>
                          );
                        })}
                        {historyLogs.length === 0 && <div className="text-slate-400">기록이 없습니다.</div>}
                      </div>
                    )}
                  </div>

                  <div className="mt-6 pt-4 flex justify-between items-center border-t border-slate-200">
                    <button onClick={() => handleDelete(result)} className="flex items-center text-red-500 bg-red-50 hover:bg-red-100 px-4 py-2.5 rounded-xl font-black text-sm transition-colors border border-red-200"><Trash2 className="w-4 h-4 mr-1.5" /> 데이터 영구 삭제</button>
                    <div className="flex space-x-3">
                      {isEditing ? (
                        <><button onClick={() => setEditingId(null)} className="px-6 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl font-bold transition-colors">취소</button><button onClick={() => handleSaveEdit(result)} className="flex items-center px-6 py-2.5 bg-orange-500 hover:bg-orange-600 text-white rounded-xl font-black shadow-md transition-colors"><Save className="w-4 h-4 mr-1.5" /> 강제 수정 저장</button></>
                      ) : (
                        <button onClick={() => startEdit(result)} className="flex items-center px-6 py-2.5 bg-slate-800 hover:bg-slate-900 text-white rounded-xl font-black shadow-md transition-colors"><Edit2 className="w-4 h-4 mr-1.5" /> 데이터 강제 수정</button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ==========================================
// Step 10: Master Settings (환경설정 제어판)
// ==========================================
function Step10Settings({ masterSettings, ctx }) {
  const [settings, setSettings] = useState(masterSettings);

  useEffect(() => { setSettings(masterSettings); }, [masterSettings]);

  const handleRatioChange = (color, material, value) => {
      const newSettings = cloneDeep(settings);
      if (!newSettings.RATIO_BY_COLOR[color]) newSettings.RATIO_BY_COLOR[color] = {};
      newSettings.RATIO_BY_COLOR[color][material] = parseFloat(value) || 0;
      setSettings(newSettings);
  };
  const handleWeightChange = (height, value) => {
      const newSettings = cloneDeep(settings);
      newSettings.WEIGHT_BY_HEIGHT[height] = parseInt(value) || 0;
      setSettings(newSettings);
  };
  const handlePressureChange = (stepKey, value) => {
      const newSettings = cloneDeep(settings);
      if (!newSettings.TARGET_PRESSURE) newSettings.TARGET_PRESSURE = { step3: "70", step4A: "250", step4B: "250" };
      newSettings.TARGET_PRESSURE[stepKey] = value;
      setSettings(newSettings);
  };
  const handleTemperatureChange = (furnaceKey, value) => {
      const newSettings = cloneDeep(settings);
      if (!newSettings.TARGET_TEMPERATURE) newSettings.TARGET_TEMPERATURE = { furnace1: "1050", furnace2: "1050" };
      newSettings.TARGET_TEMPERATURE[furnaceKey] = value;
      setSettings(newSettings);
  };
  const handleSafetyThresholdChange = (type, value) => {
      const newSettings = cloneDeep(settings);
      if (!newSettings.SAFETY_THRESHOLD || typeof newSettings.SAFETY_THRESHOLD !== "object") {
          newSettings.SAFETY_THRESHOLD = { "4Y-W": "50", "4Y-W-S": "50", "4Y-Y": "50", "5E-P": "50", "4Y-G": "50" };
      }
      newSettings.SAFETY_THRESHOLD[type] = value;
      setSettings(newSettings);
  };

  const handleSave = async () => {
      try {
          await setDoc(getDocRef("equipment", "settings"), settings);
          ctx.showToast("마스터 설정이 클라우드에 성공적으로 저장되었습니다.", "success");
      } catch(e) { ctx.showToast("설정 저장 실패", "error"); }
  };

  return (
      <div className="max-w-5xl mx-auto space-y-6">
          <div className="bg-red-50 p-6 rounded-2xl shadow-sm border border-red-200 flex items-start gap-4">
              <div className="bg-red-500 p-3 rounded-full text-white mt-1"><Settings className="w-6 h-6" /></div>
              <div>
                  <h2 className="text-xl font-black text-red-800 tracking-tight">공정 마스터 제어판</h2>
                  <p className="text-red-600/80 text-sm mt-1 font-bold">이곳에서 변경된 기준 수치(단중, 압력, 온도, 배합비율, 종류별 안전재고)는 저장 즉시 전체 태블릿과 생산 현장에 동기화됩니다. 변경에 주의하시기 바랍니다.</p>
              </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
              <div className="space-y-6">
                  <div className="bg-white rounded-xl shadow-sm border p-6">
                      <h3 className="text-lg font-bold mb-4 text-slate-800 border-b pb-2">규격별 기본 단중 (g)</h3>
                      <div className="space-y-3">
                          {settings.PRODUCT_HEIGHTS.map(height => (
                              <div key={height} className="flex justify-between items-center bg-slate-50 p-3 rounded-lg border">
                                  <span className="font-black text-indigo-700 w-20">{height}T 규격</span>
                                  <div className="relative">
                                      <input type="number" value={settings.WEIGHT_BY_HEIGHT[height] || ""} onChange={(e) => handleWeightChange(height, e.target.value)} className="border-2 border-slate-300 rounded-md p-2 w-32 text-right font-bold focus:border-indigo-500 outline-none pr-8" />
                                      <span className="absolute right-3 top-2.5 text-xs text-slate-400 font-bold">g</span>
                                  </div>
                              </div>
                          ))}
                      </div>
                  </div>

                  <div className="bg-white rounded-xl shadow-sm border p-6">
                      <h3 className="text-lg font-bold mb-4 text-slate-800 border-b pb-2">성형 목표 압력 가이드</h3>
                      <div className="space-y-3">
                          <div className="flex justify-between items-center bg-slate-50 p-3 rounded-lg border"><span className="font-black text-indigo-700 w-28">1차 성형 (건식)</span><div className="relative"><input type="text" value={settings.TARGET_PRESSURE?.step3 || ""} onChange={(e) => handlePressureChange("step3", e.target.value)} className="border-2 border-slate-300 rounded-md p-2 w-32 text-right font-bold focus:border-indigo-500 outline-none pr-10" /><span className="absolute right-3 top-2.5 text-xs text-slate-400 font-bold">ton</span></div></div>
                          <div className="flex justify-between items-center bg-slate-50 p-3 rounded-lg border"><span className="font-black text-blue-700 w-28">2차 A호기 (CIP)</span><div className="relative"><input type="text" value={settings.TARGET_PRESSURE?.step4A || ""} onChange={(e) => handlePressureChange("step4A", e.target.value)} className="border-2 border-slate-300 rounded-md p-2 w-32 text-right font-bold focus:border-indigo-500 outline-none pr-10" /><span className="absolute right-3 top-2.5 text-xs text-slate-400 font-bold">MPa</span></div></div>
                          <div className="flex justify-between items-center bg-slate-50 p-3 rounded-lg border"><span className="font-black text-blue-700 w-28">2차 B호기 (CIP)</span><div className="relative"><input type="text" value={settings.TARGET_PRESSURE?.step4B || ""} onChange={(e) => handlePressureChange("step4B", e.target.value)} className="border-2 border-slate-300 rounded-md p-2 w-32 text-right font-bold focus:border-indigo-500 outline-none pr-10" /><span className="absolute right-3 top-2.5 text-xs text-slate-400 font-bold">MPa</span></div></div>
                      </div>
                  </div>

                  <div className="bg-white rounded-xl shadow-sm border p-6">
                      <h3 className="text-lg font-bold mb-4 text-slate-800 border-b pb-2">전기로 목표 온도 가이드</h3>
                      <div className="space-y-3">
                          <div className="flex justify-between items-center bg-slate-50 p-3 rounded-lg border"><span className="font-black text-orange-700 w-28 flex items-center"><Flame className="w-4 h-4 mr-1"/> 1호기 온도</span><div className="relative"><input type="text" value={settings.TARGET_TEMPERATURE?.furnace1 || ""} onChange={(e) => handleTemperatureChange("furnace1", e.target.value)} className="border-2 border-slate-300 rounded-md p-2 w-32 text-right font-bold focus:border-orange-500 outline-none pr-10" /><span className="absolute right-3 top-2.5 text-xs text-slate-400 font-bold">°C</span></div></div>
                          <div className="flex justify-between items-center bg-slate-50 p-3 rounded-lg border"><span className="font-black text-orange-700 w-28 flex items-center"><Flame className="w-4 h-4 mr-1"/> 2호기 온도</span><div className="relative"><input type="text" value={settings.TARGET_TEMPERATURE?.furnace2 || ""} onChange={(e) => handleTemperatureChange("furnace2", e.target.value)} className="border-2 border-slate-300 rounded-md p-2 w-32 text-right font-bold focus:border-orange-500 outline-none pr-10" /><span className="absolute right-3 top-2.5 text-xs text-slate-400 font-bold">°C</span></div></div>
                      </div>
                  </div>

                  <div className="bg-white rounded-xl shadow-sm border p-6">
                      <h3 className="text-lg font-bold mb-4 text-slate-800 border-b pb-2">분말 종류별 안전 재고 기준</h3>
                      <div className="space-y-3">
                          {settings.MATERIAL_TYPES.map(mat => (
                              <div key={mat} className="flex justify-between items-center bg-slate-50 p-3 rounded-lg border">
                                  <span className="font-black text-red-700 w-32 flex items-center">⚠️ {mat} 경고 기준</span>
                                  <div className="relative">
                                      <input type="number" value={settings.SAFETY_THRESHOLD?.[mat] || ""} onChange={(e) => handleSafetyThresholdChange(mat, e.target.value)} className="border-2 border-slate-300 rounded-md p-2 w-32 text-right font-bold focus:border-red-500 outline-none pr-10" />
                                      <span className="absolute right-3 top-2.5 text-xs text-slate-400 font-bold">kg</span>
                                  </div>
                              </div>
                          ))}
                      </div>
                  </div>
              </div>

              <div className="space-y-6">
                  <div className="bg-white rounded-xl shadow-sm border p-6">
                      <h3 className="text-lg font-bold mb-4 text-slate-800 border-b pb-2">분류별 소재 배합 비율 (BOM)</h3>
                      <div className="space-y-5 max-h-[700px] overflow-y-auto pr-2">
                          {["345", "234"].map(series => (
                              <div key={series} className="space-y-3">
                                  <div className={`sticky top-0 z-10 px-3 py-2 rounded-lg text-sm font-black border ${series === "234" ? "bg-amber-50 text-amber-800 border-amber-200" : "bg-indigo-50 text-indigo-800 border-indigo-200"}`}>{series} 제품군 BOM</div>
                                  {settings.PRODUCT_COLORS.filter(color => color.startsWith(`${series} `)).map(color => (
                                      <div key={color} className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                                          <div className="font-black text-lg text-slate-800 mb-3">{color} 배합비율</div>
                                          <div className="grid grid-cols-2 gap-3">
                                              {settings.MATERIAL_TYPES.map(mat => (
                                                  <div key={mat} className="flex flex-col"><label className="text-[10px] font-bold text-slate-500 mb-1 pl-1">{mat}</label><input type="number" step="0.0001" value={settings.RATIO_BY_COLOR?.[color]?.[mat] ?? 0} onChange={(e) => handleRatioChange(color, mat, e.target.value)} className="border rounded p-2 text-sm text-right font-mono" /></div>
                                              ))}
                                          </div>
                                      </div>
                                  ))}
                              </div>
                          ))}
                      </div>
                  </div>
              </div>
          </div>

          <div className="bg-white p-4 rounded-xl shadow-sm border flex justify-end">
              <button onClick={handleSave} className="bg-red-600 hover:bg-red-700 text-white px-8 py-3 rounded-xl font-black text-lg shadow-md transition-all flex items-center">
                  <Save className="w-5 h-5 mr-2" /> 마스터 설정 전체 저장 (시스템 동기화)
              </button>
          </div>
      </div>
  );
}
