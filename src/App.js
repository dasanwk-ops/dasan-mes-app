import React, { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithCustomToken,
} from "firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import {
  LayoutDashboard,
  Package,
  Beaker,
  BoxSelect,
  Cylinder,
  Flame,
  Microscope,
  Wind,
  Printer,
  Plus,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  ShoppingCart,
  Calculator,
  History,
  X,
  Layers,
  Split,
  Edit2,
  Trash2,
  Save,
  Play,
  Thermometer,
  Droplets,
  Archive,
  Truck,
  Search,
  Database,
  RefreshCcw,
  Boxes,
  Lock,
} from "lucide-react";

// ==========================================
// [1] 대한민국 시간(KST) 및 유틸리티 함수
// ==========================================
const KST_TIMEZONE = "Asia/Seoul";

const formatKST = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: KST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get(
    "minute"
  )}:${get("second")}`;
};

const getKST = () => formatKST();
const getKSTDateOnly = () => getKST().slice(2, 10).replace(/-/g, "");
const cloneDeep = (value) => JSON.parse(JSON.stringify(value));

// 🚀 [글로벌 엔진] 구글 시트 데이터 전송 및 리포트 자동 생성 (출고 누락 방지 탑재)
const syncToGoogleSheets = async (
  orderList,
  wipList,
  inventoryHistory,
  shippingHistory,
  ctx
) => {
  // 🌟 대표님이 새로 발급받으신 최종 웹 앱 URL 적용
  const APPS_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbxFqyQaps_suzkAmQnOgDDOU_A1p--lmvAIOLZEo8LSPIAQ5mVLofzfFZo0Rmvq7LI7DA/exec";

  // 🌟 [핵심 로직] 창고 잔여 물량과 이미 출고된 물량을 합쳐서 '총 생산량'을 복원합니다.
  const mergedLots = {};

 // 1. 현재 완제품 창고 및 포장완료 상태인 데이터 수집
const wipFinished = (wipList || []).filter(
  (w) => w.currentStep === "done"
);

  wipFinished.forEach((w) => {
    mergedLots[w.mixLot] = {
      mixLot: w.mixLot,
      type: w.type,
      height: w.height,
      qty: Number(w.qty),
      details: w.details || "",
      shrinkageRate: w.shrinkageRate || "-",
    };
  });

  // 2. 이미 출고된 데이터(shippingHistory)를 뒤져서 원래 생산 수량 복원
  (shippingHistory || []).forEach((h) => {
    if (!mergedLots[h.lot]) {
      mergedLots[h.lot] = {
        mixLot: h.lot,
        type: h.type,
        height: h.height,
        qty: 0,
        details: h.details || "",
        shrinkageRate: "-",
      };
    }
    // 출고된 수량만큼 정상 수량에 다시 더해줍니다.
    mergedLots[h.lot].qty += Number(h.qty);

    if (mergedLots[h.lot].shrinkageRate === "-") {
      const shrinkMatch = (h.details || "").match(/\[수축률:\s*([0-9.]+)/);
      if (shrinkMatch) mergedLots[h.lot].shrinkageRate = shrinkMatch[1];
    }
  });

  const finishedLots = Object.values(mergedLots);

  if (finishedLots.length === 0) {
    if (ctx)
      ctx.showToast("동기화할 생산 완료/출고 데이터가 없습니다.", "error");
    return;
  }

  // 3. 구글 시트로 보낼 로트별 상세 레코드 포맷팅
  const lotRecords = finishedLots.map((w) => {
    const details = w.details || "";
    const defectMatch = details.match(/불량\s*(\d+)개:\s*([^\]]+)/);
    const defectQty = defectMatch ? parseInt(defectMatch[1]) : 0;
    const defectReason = defectMatch ? defectMatch[2] : "-";
    const dateMatch = details.match(/\[(\d{4}-\d{2}-\d{2})\s/);
    const finishDate = dateMatch ? dateMatch[1] : getKST().split(" ")[0];

    return [
      finishDate,
      w.mixLot,
      w.type,
      `${w.height}T`,
      Number(w.qty), // 복원된 총 정상 생산량
      defectQty, // 총 불량 수량
      defectReason,
      w.shrinkageRate || "-",
      details,
    ];
  });

  // 4. 월별 요약 지표(KPI) 계산
  const monthlyData = {};
  lotRecords.forEach((record) => {
    const month = record[0].substring(0, 7);
    const goodQty = record[4];
    const defQty = record[5];

    if (!monthlyData[month]) monthlyData[month] = { total: 0, defect: 0 };
    monthlyData[month].total += goodQty + defQty;
    monthlyData[month].defect += defQty;
  });

  const monthlySummary = Object.keys(monthlyData)
    .sort((a, b) => b.localeCompare(a))
    .map((month) => {
      const data = monthlyData[month];
      const defectRate = data.total > 0 ? data.defect / data.total : 0;
      return [month, data.total, data.defect, defectRate];
    });

  const payload = { lotRecords, monthlySummary };

  try {
    await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
    });
// 사용자가 직접 버튼을 눌렀을 때(ctx가 있을 때)만 알림을 띄웁니다.
    if (ctx) ctx.showToast("주주 보고용 구글 시트 동기화 완료", "success");
  } catch (e) {
    if (ctx) ctx.showToast("시트 동기화 실패", "error");
  }
};

// 🌟 [신규 추가] 개별 공정 기록을 구글 시트로 전송하는 스텔스 엔진 (상세 기록 버전)
const logProcessToGoogleSheet = async (stepId, wipItem, operator, extraData = {}) => {
  const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxFqyQaps_suzkAmQnOgDDOU_A1p--lmvAIOLZEo8LSPIAQ5mVLofzfFZo0Rmvq7LI7DA/exec";
  try {
    const payload = {
      type: "PROCESS_LOG",
      data: {
        stepId: stepId,
        timestamp: getKST(),
        lot: wipItem.mixLot || wipItem.lot || wipItem.orderNo || "N/A",
        product: wipItem.type ? `${wipItem.type} ${wipItem.height}T` : (wipItem.productCode || "N/A"),
        qty: Number(wipItem.qty) || 0,
        // 아래 항목들이 구글 시트의 새 열(Column)로 들어갑니다.
        defects: extraData.defects || 0,
        defectReason: extraData.defectReason || "-",
        worker: operator || "현장작업자",
        equipment: extraData.equipment || "-",
        conditions: extraData.conditions || "-",
        measurements: extraData.measurements || "-",
        details: extraData.details || "-"
      }
    };
    await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error(`[${stepId}] 기록 전송 실패:`, error);
  }
};

// --- [Firebase Initialization] ---
let app, auth, db;
const firebaseConfig = {
  apiKey:
    process.env.REACT_APP_FIREBASE_API_KEY ||
    "AIzaSyDxHU5KH8Wdq6Ct73S-gUOvK2YqD7J23kI",
  authDomain:
    process.env.REACT_APP_FIREBASE_AUTH_DOMAIN ||
    "dasanind-mes.firebaseapp.com",
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID || "dasanind-mes",
  storageBucket:
    process.env.REACT_APP_FIREBASE_STORAGE_BUCKET ||
    "dasanind-mes.firebasestorage.app",
  messagingSenderId: "782401133060",
  appId: "1:782401133060:web:e6997bdb37fad09dd1f351",
};
app = initializeApp(firebaseConfig);
auth = getAuth(app);
db = getFirestore(app);

const appId = typeof __app_id !== "undefined" ? __app_id : "dasan-mes-app";
const getColRef = (colName) =>
  collection(db, "artifacts", appId, "public", "data", colName);
const getDocRef = (colName, docId) =>
  doc(db, "artifacts", appId, "public", "data", colName, docId.toString());

const MATERIAL_TYPES = ["4Y-W", "4Y-Y", "5E-P", "4Y-G"];
const PRODUCT_COLORS = ["BL0", "BL1", "BL2", "BL3", "A1", "A2", "B1"];
const PRODUCT_HEIGHTS = ["20", "22", "25", "30", "35"];
const WEIGHT_BY_HEIGHT = { 20: 502, 22: 553, 25: 628, 30: 754, 35: 879 };

const RATIO_BY_COLOR = {
  BL0: { "4Y-W": 1.0, "4Y-Y": 0.0, "5E-P": 0.0, "4Y-G": 0.0 },
  BL1: { "4Y-W": 0.961, "4Y-Y": 0.03, "5E-P": 0.004, "4Y-G": 0.005 },
  BL2: { "4Y-W": 0.931, "4Y-Y": 0.055, "5E-P": 0.006, "4Y-G": 0.008 },
  BL3: { "4Y-W": 0.915, "4Y-Y": 0.079, "5E-P": 0.006, "4Y-G": 0.0 },
  A1: { "4Y-W": 0.83, "4Y-Y": 0.15, "5E-P": 0.02, "4Y-G": 0.0 },
  A2: { "4Y-W": 0.786, "4Y-Y": 0.174, "5E-P": 0.02, "4Y-G": 0.02 },
  B1: { "4Y-W": 0.869, "4Y-Y": 0.12, "5E-P": 0.011, "4Y-G": 0.0 },
};

const PROCESS_STEPS = [
  { id: "dashboard", name: "대시보드", icon: LayoutDashboard },
  { id: "step0", name: "발주 관리", icon: ShoppingCart },
  { id: "step1", name: "원재료 창고", icon: Package },
  { id: "step2", name: "혼합", icon: Beaker },
  { id: "step3", name: "1차 성형", icon: Boxes },
  { id: "step4", name: "2차 성형", icon: Cylinder },
  { id: "step5", name: "열처리", icon: Flame },
  { id: "step6", name: "검수/가공", icon: Microscope },
  { id: "step7", name: "건조", icon: Wind },
  { id: "step8", name: "포장 (라벨링)", icon: Printer },
  { id: "step9", name: "완제품 창고", icon: Archive },
  { id: "tracking", name: "로트 이력 추적", icon: Search },
];

const DEFAULT_FURNACES = {
  1: {
    cartItems: [],
    temp: "1060",
    isHeating: false,
    operator: "",
    completionData: {},
    heatingWipIds: [],
  },
  2: {
    cartItems: [],
    temp: "1060",
    isHeating: false,
    operator: "",
    completionData: {},
    heatingWipIds: [],
  },
  3: { isHeating: false },
  4: { isHeating: false },
};

const DEFAULT_DRYING_ROOM = {
  cartItems: [],
  temp: "60",
  humidity: "20",
  isDrying: false,
  operator: "",
  completionData: {},
  dryingWipIds: [],
};

const SyncInput = ({ value, onChange, ...props }) => {
  const [localVal, setLocalVal] = useState(value || "");
  useEffect(() => {
    setLocalVal(value || "");
  }, [value]);
  return (
    <input
      {...props}
      value={localVal}
      onChange={(e) => setLocalVal(e.target.value)}
      onBlur={() => onChange(localVal)}
    />
  );
};

export default function DasanMES() {
  const MASTER_PIN = "7777";
  const PROCESS_PIN = "15938"; // 🌟 현장 공정용 PIN 추가
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false); // 🌟 마스터 권한 여부 상태 저장
  const [pinInput, setPinInput] = useState("");

  // 🌟 주소창의 꼬리표(?step=이름)를 읽어와서 해당 화면을 바로 띄우는 마법의 코드
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

  // ==============================================================
  // 🌟 [추가됨] 스텔스 자동 동기화 센서 (버튼 안 눌러도 됨)
  // ==============================================================
  const prevSyncCount = useRef({ finished: 0, shipped: 0 });

  useEffect(() => {
    if (!isUnlocked) return; // 로그인 전에는 작동하지 않음

    // 현재 완제품 수량과 출고된 수량을 계산합니다.
const currentFinished = wipList.filter(
  (w) => w.currentStep === "done"
).length;
    const currentShipped = shippingHistory.length;

    // 만약 이전보다 '포장 완료된 제품'이나 '출고된 제품'이 늘어났다면? -> 자동 동기화 발동!
    if (
      currentFinished > prevSyncCount.current.finished ||
      currentShipped > prevSyncCount.current.shipped
    ) {
      // ctx 자리에 null을 넣어 알림창(Toast) 없이 배경에서 조용히 전송되게 합니다.
      syncToGoogleSheets(
        orderList,
        wipList,
        inventoryHistory,
        shippingHistory,
        null
      );
      console.log("구글 시트 백그라운드 자동 동기화 완료");
    }

    // 현재 상태를 다음 비교를 위해 저장해 둡니다.
    prevSyncCount.current = {
      finished: currentFinished,
      shipped: currentShipped,
    };
  }, [wipList, shippingHistory, orderList, inventoryHistory, isUnlocked]);
  // ==============================================================

  const showToast = (msg, type = "error") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };
  const showConfirm = (msg, onConfirm) => {
    setConfirmDialog({ msg, onConfirm });
  };
  const ctx = { showToast, showConfirm };

  useEffect(() => {
    let meta = document.querySelector('meta[name="robots"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "robots";
      document.head.appendChild(meta);
    }
    meta.content = "noindex, nofollow";
  }, []);

  useEffect(() => {
    signInAnonymously(auth);
    onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    if (!user || !isUnlocked) return;
    const setupListener = (col, setter) =>
      onSnapshot(getColRef(col), (snap) =>
        setter(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      );
    setupListener("inventory", setInventory);
    setupListener("inventoryHistory", (d) =>
      setInventoryHistory(d.sort((a, b) => b.id - a.id))
    );
    setupListener("wipList", setWipList);
    setupListener("orderList", (d) =>
      setOrderList(
        d.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate))
      )
    );
    setupListener("shippingHistory", (d) =>
      setShippingHistory(d.sort((a, b) => b.id - a.id))
    );
    onSnapshot(getColRef("equipment"), (snap) => {
      snap.docs.forEach((d) => {
        if (d.id === "furnaces") setFurnaces(d.data());
        if (d.id === "dryingRoom") setDryingRoom(d.data());
      });
    });
  }, [user, isUnlocked]);

  if (!isUnlocked) {
    return (
      <div className="flex h-screen bg-slate-900 text-white items-center justify-center flex-col relative overflow-hidden">
        {toast && (
          <div className="absolute top-10 px-6 py-3 bg-red-500 text-white rounded-xl shadow-2xl font-bold animate-in fade-in slide-in-from-top-4">
            {toast.msg}
          </div>
        )}
        <div className="bg-slate-800 p-10 rounded-3xl shadow-2xl flex flex-col items-center border border-slate-700 w-full max-w-sm">
          <div className="bg-indigo-500/20 p-4 rounded-full mb-6">
            <Lock className="w-10 h-10 text-indigo-400" />
          </div>
          <h1 className="text-2xl font-black mb-2 tracking-tight text-center">
            다산산업 MES
            <br />
            보안 시스템
          </h1>
          <p className="text-slate-400 text-sm mb-8 text-center">
            허가된 관계자 외의 접근을 엄격히 금지합니다.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              // 🌟 마스터와 현장 핀 번호 분리 로직 적용
              if (pinInput === MASTER_PIN) {
                setIsUnlocked(true);
                setIsAdmin(true); // 마스터 권한 부여
              } else if (pinInput === PROCESS_PIN) {
                // 🌟 대시보드나 이력 추적으로 접근 시도 시 차단
                if (activeStep === "dashboard" || activeStep === "tracking") {
                  showToast(
                    "해당 화면은 마스터 핀 번호가 필요합니다.",
                    "error"
                  );
                } else {
                  setIsUnlocked(true);
                  setIsAdmin(false); // 일반 공정 권한 부여
                }
              } else {
                showToast("접근 권한이 없습니다 (PIN 불일치)", "error");
              }
            }}
            className="flex flex-col gap-4 w-full"
          >
            <input
              type="password"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              className="text-slate-900 px-5 py-3.5 rounded-xl font-black outline-none text-center text-xl tracking-widest focus:ring-2 focus:ring-indigo-500"
              placeholder="PIN 번호"
              autoFocus
            />
            <button
              type="submit"
              className="bg-indigo-600 px-5 py-3.5 rounded-xl font-bold hover:bg-indigo-500 transition-colors shadow-lg shadow-indigo-900/50"
            >
              MES 시스템 접속
            </button>
          </form>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    const props = {
      inventory,
      wipList,
      orderList,
      inventoryHistory,
      shippingHistory,
      furnaces,
      dryingRoom,
      setActiveStep,
      ctx,
    };
    switch (activeStep) {
      case "dashboard":
        return <DashboardView {...props} />;
      case "step0":
        return <Step0OrderManagement {...props} />;
      case "step1":
        return <Step1MaterialWarehouse {...props} />;
      case "step2":
        return <Step2Mixing {...props} />;
      case "step3":
        return <Step3FirstMolding {...props} />;
      case "step4":
        return <Step4SecondMolding {...props} />;
      case "step5":
        return <Step5HeatTreatment {...props} />;
      case "step6":
        return <Step6Inspection {...props} />;
      case "step7":
        return <Step7Drying {...props} />;
      case "step8":
        return <Step8Packaging {...props} />;
      case "step9":
        return <Step9FinishedGoods {...props} />;
      case "tracking":
        return <StepTracking {...props} />;
      default:
        return <DashboardView {...props} />;
    }
  };

  return (
    <div className="flex h-screen bg-slate-50 text-slate-800">
      {toast && (
        <div
          className={`fixed top-6 right-6 px-6 py-4 rounded-xl shadow-2xl text-white font-black z-50 ${
            toast.type === "error" ? "bg-red-600" : "bg-green-600"
          }`}
        >
          {toast.msg}
        </div>
      )}
      {confirmDialog && (
        <div className="fixed inset-0 bg-slate-900/60 z-50 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-white p-8 rounded-2xl shadow-2xl w-96">
            <h3 className="text-xl font-black mb-4 flex items-center">
              <AlertCircle className="w-6 h-6 mr-2 text-indigo-500" /> 확인 필요
            </h3>
            <p className="text-slate-600 mb-8 font-medium">
              {confirmDialog.msg}
            </p>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setConfirmDialog(null)}
                className="px-5 py-2 bg-slate-100 rounded-xl font-bold"
              >
                취소
              </button>
              <button
                onClick={() => {
                  confirmDialog.onConfirm();
                  setConfirmDialog(null);
                }}
                className="px-5 py-2 bg-indigo-600 text-white rounded-xl font-bold"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🌟 마스터 권한(isAdmin)일 때만 왼쪽 사이드바 메뉴를 보여줍니다 */}
      {isAdmin && (
        <div className="w-64 bg-slate-900 text-slate-300 flex flex-col shadow-xl z-20">
          <div className="p-5 bg-slate-950 border-b border-slate-800 text-center">
            <div className="text-xl font-bold text-white tracking-wide">
              다산산업 MES
            </div>
            <div className="text-xs text-blue-400 mt-1">
              첨단소재 디스크 공정관리
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-4">
            <ul className="space-y-1">
              {PROCESS_STEPS.map((step) => (
                <li key={step.id}>
                  <button
                    onClick={() => setActiveStep(step.id)}
                    className={`w-full flex items-center px-6 py-3 text-sm font-medium transition-colors ${
                      activeStep === step.id
                        ? "bg-blue-600 text-white shadow-md"
                        : "hover:bg-slate-800"
                    }`}
                  >
                    <step.icon
                      className={`w-5 h-5 mr-3 ${
                        activeStep === step.id
                          ? "text-blue-200"
                          : "text-slate-500"
                      }`}
                    />{" "}
                    {step.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="bg-white border-b border-slate-200 px-8 py-5 flex justify-between items-center shadow-sm z-10">
          <div className="flex items-center">
            <h1 className="text-2xl font-bold text-slate-800">
              {PROCESS_STEPS.find((s) => s.id === activeStep)?.name}
            </h1>
            {/* 🌟 현장 태블릿인 경우 제목 옆에 라벨을 달아줍니다 */}
            {!isAdmin && (
              <span className="ml-4 bg-orange-100 text-orange-700 px-3 py-1 rounded-full text-xs font-black border border-orange-200">
                현장 전용 모드
              </span>
            )}
          </div>
          <div className="text-sm text-slate-600 bg-slate-100 px-3 py-1.5 rounded-full flex items-center font-bold">
            <span className="w-2 h-2 rounded-full bg-green-500 mr-2 animate-pulse"></span>{" "}
            클라우드 실시간 동기화
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
// Dashboard View (재고 예측 + 원재료 현황 통합 버전)
// ==========================================
function DashboardView({
  inventory,
  wipList,
  orderList = [],
  inventoryHistory,
  shippingHistory,
  setActiveStep,
  ctx,
}) {
  // 1. 재고 예측 시뮬레이션 계산 로직 (가장 상단 유지)
  const stockForecast = React.useMemo(() => {
    const getBOM = (color, singleWeight, qty) => {
      const baseKg = (Number(singleWeight) * Number(qty)) / 1000;
      const totalKg = baseKg * 1.01 + 0.2;
      const ratios = RATIO_BY_COLOR[color] || { "4Y-W": 1.0 };
      const req = {};
      for (const [mat, ratio] of Object.entries(ratios)) {
        if (ratio > 0) req[mat] = totalKg * ratio;
      }
      return req;
    };

    return MATERIAL_TYPES.map((type) => {
      const currentStock = inventory
        .filter((i) => i.type === type)
        .reduce((sum, i) => sum + i.weight, 0);

      const reqFromOrders = orderList
        .filter((o) => o.status === "대기중" || o.status === "부분투입")
        .reduce((sum, o) => {
          const remainQty = o.qty - (o.releasedQty || 0);
          if (remainQty <= 0) return sum;
          const bom = getBOM(o.color, o.singleWeight, remainQty);
          return sum + (bom[type] || 0);
        }, 0);

      const reqFromPendingLots = (wipList || [])
        .filter((w) => w.currentStep === "step1")
        .reduce((sum, w) => {
          const bom = getBOM(w.type, w.singleWeight || 628, w.qty);
          return sum + (bom[type] || 0);
        }, 0);

      const totalRequired = reqFromOrders + reqFromPendingLots;
      const expectedStock = currentStock - totalRequired;

      return {
        type,
        current: currentStock,
        required: totalRequired,
        expected: expectedStock,
        isShort: expectedStock < 0,
      };
    });
  }, [inventory, orderList, wipList]);

  // 기존 요약 데이터 계산
  const pendingOrdersQty = orderList
    .filter((o) => o.status === "대기중")
    .reduce((sum, o) => sum + (Number(o.qty) || 0), 0);
  const wipQty = (wipList || [])
    .filter((w) => w.currentStep !== "done")
    .reduce((sum, w) => sum + (Number(w.qty) || 0), 0);
  const readyToShipQty = (wipList || [])
    .filter((w) => w.currentStep === "done")
    .reduce((sum, w) => sum + (Number(w.qty) || 0), 0);

  const pipelineSteps = PROCESS_STEPS.filter(
    (s) =>
      s.id.startsWith("step") && !["step0", "step1", "step9"].includes(s.id)
  );
  const activeWipList = (wipList || []).filter((w) => w.currentStep !== "done");
  const finishedWipList = (wipList || []).filter(
    (w) => w.currentStep === "done"
  );

  const fgSummary = finishedWipList.reduce((acc, curr) => {
    const k = `${curr.type}_${curr.height}`;
    if (!acc[k]) acc[k] = { type: curr.type, height: curr.height, qty: 0 };
    acc[k].qty += curr.qty;
    return acc;
  }, {});

  const sortedOrderList = [...orderList].sort((a, b) => {
    const rank = { 생산중: 1, 대기중: 2, 완료: 3, 취소: 4 };
    const rankA = rank[a.status] || 5;
    const rankB = rank[b.status] || 5;
    if (rankA !== rankB) return rankA - rankB;
    return new Date(b.orderDate) - new Date(a.orderDate);
  });

  // 상태값 정의
  const [editingId, setEditingId] = React.useState(null);
  const [editData, setEditData] = React.useState({});
  const [editingInvId, setEditingInvId] = React.useState(null);
  const [editInvData, setEditInvData] = React.useState({});
  const [editingOrderId, setEditingOrderId] = React.useState(null);
  const [editOrderData, setEditOrderData] = React.useState({});
  const [editingFgId, setEditingFgId] = React.useState(null);
  const [editFgData, setEditFgData] = React.useState({});
  const [showInvHistory, setShowInvHistory] = React.useState(false);
  const [showFgHistory, setShowFgHistory] = React.useState(false);
  const [selectedMaterial, setSelectedMaterial] = React.useState(null);

  const WIP_STEPS = [
    { value: "step2", label: "혼합 대기" },
    { value: "step3", label: "1차 성형 대기" },
    { value: "step4", label: "2차 성형 대기" },
    { value: "step5", label: "열처리 대기" },
    { value: "step5_heating", label: "열처리 진행중" },
    { value: "step6", label: "검수 대기" },
    { value: "step7", label: "건조 대기" },
    { value: "step7_drying", label: "건조 진행중" },
    { value: "step8", label: "포장 대기" },
  ];

  // 🌟 이 함수가 실제로 시트에 데이터를 쏴주는 '진짜' 엔진입니다.
  const handleSyncGoogleSheet = async () => {
    await syncToGoogleSheets(
      orderList,
      wipList,
      inventoryHistory,
      shippingHistory,
      ctx
    );
  };

  // 아래 handleSaveWip과 handleDeleteWip은 기존 그대로 유지합니다.
  const handleSaveWip = async (wip) => {
    const safeQty = Number(editData.qty);
    if (isNaN(safeQty) || safeQty < 0)
      return ctx.showToast("올바른 숫자를 입력해주세요.", "error");
    try {
      await setDoc(getDocRef("wipList", wip.id), {
        ...wip,
        qty: safeQty,
        currentStep: editData.currentStep,
      });
      setEditingId(null);
      ctx.showToast("수정 완료", "success");
    } catch (e) {
      ctx.showToast("실패", "error");
    }
  };

  const handleDeleteWip = (id) => {
    ctx.showConfirm("삭제하시겠습니까?", async () => {
      try {
        await deleteDoc(getDocRef("wipList", id));
        ctx.showToast("삭제 완료", "success");
      } catch (e) {
        ctx.showToast("실패", "error");
      }
    });
  };
  const handleSaveInv = async (item) => {
    const safeWeight = Number(editInvData.weight);
    if (isNaN(safeWeight) || safeWeight < 0)
      return ctx.showToast("올바른 중량을 입력해주세요.", "error");
    try {
      await setDoc(getDocRef("inventory", item.id), {
        ...item,
        weight: safeWeight,
        lot: editInvData.lot || item.lot,
      });
      setEditingInvId(null);
      ctx.showToast("수정 완료", "success");
    } catch (e) {
      ctx.showToast("실패", "error");
    }
  };
  const handleDeleteInv = (id) => {
    ctx.showConfirm("삭제하시겠습니까?", async () => {
      try {
        await deleteDoc(getDocRef("inventory", id));
        ctx.showToast("삭제 완료", "success");
      } catch (e) {
        ctx.showToast("실패", "error");
      }
    });
  };
  const handleSaveOrder = async (order) => {
    const safeQty = Number(editOrderData.qty);
    if (isNaN(safeQty) || safeQty < 0)
      return ctx.showToast("올바른 수량을 입력해주세요.", "error");
    try {
      await setDoc(getDocRef("orderList", order.id), {
        ...order,
        qty: safeQty,
        status: editOrderData.status,
      });
      setEditingOrderId(null);
      ctx.showToast("수정 완료", "success");
    } catch (e) {
      ctx.showToast("실패", "error");
    }
  };
  const handleDeleteOrder = (id) => {
    ctx.showConfirm("삭제하시겠습니까?", async () => {
      try {
        await deleteDoc(getDocRef("orderList", id));
        ctx.showToast("삭제 완료", "success");
      } catch (e) {
        ctx.showToast("실패", "error");
      }
    });
  };
  const handleSaveFg = async (fg) => {
    const safeQty = Number(editFgData.qty);
    if (isNaN(safeQty) || safeQty < 0)
      return ctx.showToast("올바른 수량을 입력해주세요.", "error");
    try {
      await setDoc(getDocRef("wipList", fg.id), {
        ...fg,
        qty: safeQty,
        mixLot: editFgData.mixLot || fg.mixLot,
        details: editFgData.details || fg.details,
      });
      setEditingFgId(null);
      ctx.showToast("수정 완료", "success");
    } catch (e) {
      ctx.showToast("실패", "error");
    }
  };
  const handleDeleteFg = (id) => {
    ctx.showConfirm("삭제하시겠습니까?", async () => {
      try {
        await deleteDoc(getDocRef("wipList", id));
        ctx.showToast("삭제 완료", "success");
      } catch (e) {
        ctx.showToast("실패", "error");
      }
    });
  };
  const handleDeleteShippingHistory = (id) => {
    ctx.showConfirm("삭제하시겠습니까?", async () => {
      try {
        await deleteDoc(getDocRef("shippingHistory", id));
        ctx.showToast("삭제 완료", "success");
      } catch (e) {
        ctx.showToast("실패", "error");
      }
    });
  };

  return (
    <div className="space-y-6">
      {/* 1. 헤더 */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-6 rounded-xl shadow-sm border border-slate-100">
        <div>
          <h2 className="text-2xl font-black text-slate-800 tracking-tight">
            통합 관리자 대시보드
          </h2>
          <p className="text-slate-500 text-sm mt-1">
            공정, 발주, 원재료 정보를 마스터 권한으로 통합 관리합니다.
          </p>
        </div>
        <button
          onClick={handleSyncGoogleSheet}
          className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-5 py-2.5 rounded-lg shadow-sm font-bold transition-all"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          구글 시트 동기화
        </button>
      </div>

      {/* 2. 상단 핵심 요약 지표 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-100 flex flex-col items-center">
          <div className="text-slate-500 text-xs font-bold mb-1">
            대기중 발주 수량
          </div>
          <div className="text-3xl font-black text-indigo-600">
            {pendingOrdersQty.toLocaleString()} EA
          </div>
        </div>
        <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-100 flex flex-col items-center">
          <div className="text-slate-500 text-xs font-bold mb-1">
            진행 중 공정 수량
          </div>
          <div className="text-3xl font-black text-blue-600">
            {wipQty.toLocaleString()} EA
          </div>
        </div>
        <div
          onClick={() =>
            document
              .getElementById("master-finished-goods")
              ?.scrollIntoView({ behavior: "smooth" })
          }
          className="bg-white rounded-xl p-6 shadow-sm border border-slate-100 flex flex-col items-center cursor-pointer hover:border-green-400 transition-all group relative overflow-hidden"
        >
          <div className="absolute top-0 right-0 p-3 opacity-0 group-hover:opacity-100 transition-opacity">
            <svg
              className="w-5 h-5 text-green-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
              />
            </svg>
          </div>
          <div className="text-slate-500 text-xs font-bold mb-1">
            출고대기 수량
          </div>
          <div className="text-3xl font-black text-green-600">
            {readyToShipQty.toLocaleString()} EA
          </div>
        </div>
      </div>

      {/* 🚀 4번이 위로 올라왔습니다! 공정별 네비게이션 아이콘 */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
        <h3 className="text-lg font-bold mb-6 text-slate-800 flex items-center">
          <ArrowRight className="w-5 h-5 mr-2 text-blue-600" /> 공정 상황 상세
          이동
        </h3>
        <div className="flex justify-between items-start w-full">
          {pipelineSteps.map((step, idx) => {
            const count = wipList
              .filter((w) => w.currentStep.startsWith(step.id))
              .reduce((sum, w) => sum + (Number(w.qty) || 0), 0);
            const Icon = step.icon;
            return (
              <div
                key={step.id}
                onClick={() => setActiveStep(step.id)}
                className="flex-1 flex flex-col items-center relative group cursor-pointer hover:bg-slate-50 rounded-xl py-2"
              >
                {idx < pipelineSteps.length - 1 && (
                  <div className="absolute top-6 left-1/2 w-full h-0.5 bg-slate-100 -z-10"></div>
                )}
                <div
                  className={`w-10 h-10 rounded-2xl flex items-center justify-center mb-2 shadow-sm ${
                    count > 0
                      ? "bg-blue-600 text-white"
                      : "bg-slate-100 text-slate-400"
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </div>
                <div className="text-center w-full">
                  <div className="text-[10px] font-bold text-slate-500 mb-0.5">
                    {step.name}
                  </div>
                  <div
                    className={`text-sm font-black ${
                      count > 0 ? "text-blue-700" : "text-slate-300"
                    }`}
                  >
                    {count}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 🌟 3번이 아래로 내려갔습니다! 원재료 현황 및 생산 재고 예측 섹션 */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 space-y-6">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <svg
              className="w-5 h-5 text-indigo-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 002-2h-2a2 2 0 00-2 2"
              />
            </svg>
            <h3 className="text-lg font-bold text-slate-800">
              원재료 현황 및 재고 시뮬레이션
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowInvHistory(!showInvHistory)}
              className={`text-xs font-bold px-3 py-1.5 rounded border transition-colors shadow-sm ${
                showInvHistory
                  ? "bg-slate-700 text-white border-slate-700"
                  : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"
              }`}
            >
              입출고(소진) 내역 {showInvHistory ? "숨기기" : "보기"}
            </button>
            <span className="text-xs font-bold text-red-500 bg-red-50 px-2 py-1 rounded border border-red-100 uppercase">
              마스터 권한
            </span>
          </div>
        </div>

        {/* 🌟 종류별 통합 시뮬레이션 카드 그리드 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {stockForecast.map((item) => (
            <div
              key={item.type}
              onClick={() =>
                setSelectedMaterial(
                  selectedMaterial === item.type ? null : item.type
                )
              }
              className={`p-4 rounded-2xl border transition-all cursor-pointer ${
                selectedMaterial === item.type
                  ? "ring-2 ring-indigo-500 shadow-md"
                  : ""
              } ${
                item.isShort
                  ? "bg-red-50 border-red-200"
                  : "bg-slate-50 border-slate-100 hover:bg-slate-100"
              }`}
            >
              <div className="flex justify-between items-center mb-3">
                <span className="font-black text-slate-700 text-base">
                  {item.type}
                </span>
                {item.isShort ? (
                  <span className="bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full font-black animate-pulse">
                    부족
                  </span>
                ) : (
                  <span className="bg-emerald-500 text-white text-[10px] px-2 py-0.5 rounded-full font-black">
                    안전
                  </span>
                )}
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between items-baseline mb-1">
                  <span className="text-slate-400 font-bold text-[10px]">
                    현 창고 실재고
                  </span>
                  <span className="text-slate-900 font-black text-xl tracking-tighter">
                    {item.current.toFixed(2)}{" "}
                    <span className="text-[10px] font-bold text-slate-500 uppercase ml-0.5">
                      kg
                    </span>
                  </span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400 font-bold">
                    발주 소요 예정
                  </span>
                  <span className="text-orange-500 font-black">
                    - {item.required.toFixed(2)} kg
                  </span>
                </div>
                <div className="pt-2 mt-1 border-t border-slate-200 flex justify-between items-end">
                  <span className="text-[10px] font-bold text-slate-400">
                    생산 후 잔량
                  </span>
                  <span
                    className={`text-lg font-black tracking-tighter ${
                      item.isShort ? "text-red-600" : "text-indigo-700"
                    }`}
                  >
                    {item.expected.toFixed(2)}{" "}
                    <span className="text-[10px]">kg</span>
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* 하단 상세 로트 테이블 (선택한 카드의 내용 표시) */}
        <div className="overflow-x-auto max-h-[400px] border rounded-lg">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0 shadow-sm border-b">
              <tr>
                <th className="px-4 py-3 text-center">입고일자</th>
                <th className="px-4 py-3">원재료 종류</th>
                <th className="px-4 py-3">로트 번호</th>
                <th className="px-4 py-3 text-right">잔여 중량 (kg)</th>
                <th className="px-4 py-3 text-center text-red-600">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {selectedMaterial
                ? // 🌟 1. 특정 원재료 카드를 클릭했을 때: 입출고 전체 히스토리(inventoryHistory) 표시
                  (inventoryHistory || [])
                    .filter((h) => h.materialType === selectedMaterial)
                    .sort((a, b) => new Date(b.date) - new Date(a.date)) // 최신순 정렬
                    .map((item) => (
                      <tr
                        key={item.id}
                        className="bg-slate-50/50 hover:bg-slate-100 transition-colors"
                      >
                        <td className="px-4 py-3 text-slate-500 font-medium text-center">
                          {item.date}
                          <span
                            className={`text-[10px] font-bold ml-1 ${
                              item.type === "IN"
                                ? "text-blue-500"
                                : "text-red-400"
                            }`}
                          >
                            ({item.type === "IN" ? "입고" : "출고"})
                          </span>
                        </td>
                        <td className="px-4 py-3 font-black text-slate-800">
                          {item.materialType}
                        </td>
                        <td className="px-4 py-3 font-mono text-indigo-600">
                          {item.lot}
                        </td>
                        <td className="px-4 py-3 text-right font-black">
                          {item.qty.toLocaleString()}{" "}
                          <span className="text-[10px] font-normal text-slate-400">
                            kg
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => handleDeleteInvHistory(item.id)}
                            className="text-red-400 hover:bg-red-500 hover:text-white p-1 bg-white border rounded shadow-sm transition-colors"
                            title="내역 삭제"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))
                : // 🌟 2. 카드를 선택하지 않은 기본 상태: 현재고(Inventory) 로트별 현황 표시
                  inventory
                    .filter((i) => (showInvHistory ? true : i.weight > 0))
                    .map((item) => {
                      const isEditing = editingInvId === item.id;
                      const isDrained = item.weight <= 0;
                      return (
                        <tr
                          key={item.id}
                          className={`transition-colors ${
                            isDrained
                              ? "bg-slate-50 opacity-60"
                              : "hover:bg-slate-50"
                          }`}
                        >
                          <td className="px-4 py-3 text-slate-500 font-medium text-center">
                            {item.date}{" "}
                            {isDrained && (
                              <span className="text-[10px] text-red-400 ml-1">
                                (소진)
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-black text-slate-800">
                            {item.type}
                          </td>
                          <td className="px-4 py-3 font-mono text-indigo-600">
                            {isEditing ? (
                              <input
                                type="text"
                                value={editInvData.lot}
                                onChange={(e) =>
                                  setEditInvData({
                                    ...editInvData,
                                    lot: e.target.value,
                                  })
                                }
                                className="border p-1 w-full rounded bg-orange-50 font-bold"
                              />
                            ) : (
                              item.lot
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-black">
                            {isEditing ? (
                              <input
                                type="number"
                                step="0.001"
                                value={editInvData.weight}
                                onChange={(e) =>
                                  setEditInvData({
                                    ...editInvData,
                                    weight: e.target.value,
                                  })
                                }
                                className="border p-1 w-24 text-right rounded bg-orange-50"
                              />
                            ) : (
                              item.weight.toLocaleString()
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="flex justify-center gap-1.5">
                              {isEditing ? (
                                <>
                                  <button
                                    onClick={() => handleSaveInv(item)}
                                    className="bg-orange-500 text-white p-1.5 rounded shadow-sm"
                                  >
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M5 13l4 4L19 7"
                                      />
                                    </svg>
                                  </button>
                                  <button
                                    onClick={() => setEditingInvId(null)}
                                    className="bg-slate-200 text-slate-700 p-1.5 rounded shadow-sm"
                                  >
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M6 18L18 6M6 6l12 12"
                                      />
                                    </svg>
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => {
                                      setEditingInvId(item.id);
                                      setEditInvData(item);
                                    }}
                                    className="text-slate-500 hover:text-indigo-600 p-1 bg-white border rounded shadow-sm"
                                  >
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                                      />
                                    </svg>
                                  </button>
                                  <button
                                    onClick={() => handleDeleteInv(item.id)}
                                    className="text-red-400 hover:bg-red-500 hover:text-white p-1 bg-white border rounded shadow-sm transition-colors"
                                  >
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                      />
                                    </svg>
                                  </button>
                                </>
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

      {/* 5. 공정 진행 현황 테이블 (기존 유지) */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold flex items-center text-slate-800">
            <Layers className="w-5 h-5 mr-2 text-slate-400" /> 공정 진행 현황
            상세 (마스터)
          </h3>
          <span className="text-xs font-bold text-red-500 bg-red-50 px-2 py-1 rounded border border-red-100 uppercase">
            마스터 권한
          </span>
        </div>
        <div className="overflow-x-auto max-h-[500px] border rounded-lg">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0 shadow-sm border-b">
              <tr>
                <th className="px-4 py-3">MIX LOT</th>
                <th className="px-4 py-3">제품</th>
                <th className="px-4 py-3 text-center">수량</th>
                <th className="px-4 py-3">진행 상태</th>
                <th className="px-4 py-3 w-1/3 text-center">메모</th>
                <th className="px-4 py-3 text-center text-red-600">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activeWipList.map((wip) => {
                const isEditing = editingId === wip.id;
                return (
                  <tr
                    key={wip.id}
                    className="hover:bg-slate-50 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-blue-600">
                      {wip.mixLot}
                    </td>
                    <td className="px-4 py-3 font-bold text-slate-800">
                      {wip.type} {wip.height}T
                    </td>
                    <td className="px-4 py-3 text-center font-bold">
                      {isEditing ? (
                        <input
                          type="number"
                          value={editData.qty}
                          onChange={(e) =>
                            setEditData({ ...editData, qty: e.target.value })
                          }
                          className="border p-1 w-16 text-center rounded bg-orange-50"
                        />
                      ) : (
                        wip.qty
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-1 border rounded text-[10px] font-bold ${
                          wip.currentStep.includes("heating")
                            ? "bg-orange-50 text-orange-700"
                            : "bg-white text-slate-600"
                        }`}
                      >
                        {WIP_STEPS.find((s) => s.value === wip.currentStep)
                          ?.label || "대기중"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 truncate max-w-[150px] text-center">
                      {wip.details}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex justify-center gap-1.5">
                        {isEditing ? (
                          <button
                            onClick={() => handleSaveWip(wip)}
                            className="bg-orange-500 text-white p-1 rounded"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M5 13l4 4L19 7"
                              />
                            </svg>
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              setEditingId(wip.id);
                              setEditData(wip);
                            }}
                            className="text-slate-400 hover:text-indigo-600"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                              />
                            </svg>
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteWip(wip.id)}
                          className="text-red-300 hover:text-red-600"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 6. 발주 현황 테이블 (기존 유지) */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold flex items-center text-slate-800">
            <ShoppingCart className="w-5 h-5 mr-2 text-slate-400" /> 발주 현황
            및 마스터 제어
          </h3>
          <span className="text-xs font-bold text-red-500 bg-red-50 px-2 py-1 rounded border border-red-100 uppercase">
            마스터 권한
          </span>
        </div>
        <div className="overflow-x-auto max-h-[400px] border rounded-lg">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0 shadow-sm border-b">
              <tr>
                <th className="px-4 py-3">발주일자</th>
                <th className="px-4 py-3">제품정보</th>
                <th className="px-4 py-3 text-center">수량</th>
                <th className="px-4 py-3 text-center">상태</th>
                <th className="px-4 py-3 text-center text-red-600">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedOrderList.map((order) => {
                const isEditing = editingOrderId === order.id;
                return (
                  <tr key={order.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-500">
                      <div className="font-bold">{order.orderDate}</div>
                      <div className="text-xs font-mono text-slate-400">
                        {order.orderNo}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-bold text-slate-800">
                      {order.color} {order.height}T
                    </td>
                    <td className="px-4 py-3 text-center font-black text-indigo-600">
                      {isEditing ? (
                        <input
                          type="number"
                          value={editOrderData.qty}
                          onChange={(e) =>
                            setEditOrderData({
                              ...editOrderData,
                              qty: e.target.value,
                            })
                          }
                          className="border p-1 w-20 text-center rounded bg-orange-50"
                        />
                      ) : (
                        order.qty
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`px-3 py-1.5 rounded text-xs font-bold ${
                          order.status === "대기중"
                            ? "bg-yellow-100 text-yellow-800"
                            : "bg-blue-100 text-blue-800"
                        }`}
                      >
                        {order.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex justify-center gap-1.5">
                        {isEditing ? (
                          <button
                            onClick={() => handleSaveOrder(order)}
                            className="bg-orange-500 text-white p-1.5 rounded shadow-sm"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M5 13l4 4L19 7"
                              />
                            </svg>
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              setEditingOrderId(order.id);
                              setEditOrderData(order);
                            }}
                            className="text-slate-500 hover:text-indigo-600 p-1 bg-white border rounded shadow-sm"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                              />
                            </svg>
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteOrder(order.id)}
                          className="text-red-400 hover:bg-red-500 hover:text-white p-1 bg-white border rounded shadow-sm transition-colors"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 7. 완제품 현황 및 마스터 제어 (기존 유지) */}
      <div
        id="master-finished-goods"
        className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 scroll-mt-24"
      >
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-lg font-bold flex items-center text-slate-800">
            <Archive className="w-5 h-5 mr-2 text-slate-400" /> 완제품(출고대기)
            현황 및 마스터
          </h3>
          <button
            onClick={() => setShowFgHistory(!showFgHistory)}
            className={`text-xs font-bold px-3 py-1.5 rounded border ${
              showFgHistory
                ? "bg-slate-700 text-white"
                : "bg-white text-slate-600"
            }`}
          >
            출고 내역 {showFgHistory ? "숨기기" : "보기"}
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
          {Object.values(fgSummary).map((i) => (
            <div
              key={`${i.type}_${i.height}`}
              onClick={() =>
                setSelectedMaterial(
                  selectedMaterial === `${i.type}_${i.height}`
                    ? null
                    : `${i.type}_${i.height}`
                )
              }
              className={`p-4 rounded-xl border text-center transition-all ${
                selectedMaterial === `${i.type}_${i.height}`
                  ? "bg-green-50 border-green-400 shadow-md"
                  : "bg-slate-50 border-slate-100"
              }`}
            >
              <div className="text-sm font-bold text-slate-500 mb-1">
                {i.type} {i.height}T
              </div>
              <div className="text-2xl font-black text-green-600">
                {i.qty} EA
              </div>
            </div>
          ))}
        </div>
        <div className="overflow-x-auto max-h-[400px] border rounded-lg">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0 shadow-sm border-b">
              <tr>
                <th className="px-4 py-3 w-1/4">포장 LOT</th>
                <th className="px-4 py-3">제품정보</th>
                <th className="px-4 py-3 text-center">수량</th>
                <th className="px-4 py-3 w-1/3">상세/메모</th>
                <th className="px-4 py-3 text-center text-red-600">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {showFgHistory || selectedMaterial
                ? (shippingHistory || [])
                    .filter((h) =>
                      selectedMaterial
                        ? String(h.type) + "_" + String(h.height) ===
                          String(selectedMaterial)
                        : true
                    )
                    .map((item) => (
                      <tr
                        key={item.id}
                        className="bg-slate-50 opacity-70 hover:opacity-100 transition-colors"
                      >
                        <td className="px-4 py-3 font-mono font-bold text-slate-700">
                          {item.lot}{" "}
                          <span className="text-[10px] text-red-400">
                            ({item.date.split(" ")[0]} 출고)
                          </span>
                        </td>
                        <td className="px-4 py-3 font-bold text-slate-800">
                          {item.type} {item.height}T
                        </td>
                        <td className="px-4 py-3 text-center font-black text-green-600">
                          {item.qty}
                        </td>
                        <td className="px-4 py-3 text-slate-500 text-xs text-center">
                          출고처: {item.destination}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => handleDeleteShippingHistory(item.id)}
                            className="text-red-400 hover:text-white p-1.5 bg-white border rounded"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))
                : wipList
                    .filter((w) => w.currentStep === "done" && w.qty > 0)
                    .map((fg) => {
                      const isEditing = editingFgId === fg.id;
                      return (
                        <tr
                          key={fg.id}
                          className="hover:bg-slate-50 transition-colors"
                        >
                          <td className="px-4 py-3 font-mono font-bold text-slate-700">
                            {isEditing ? (
                              <input
                                type="text"
                                value={editFgData.mixLot}
                                onChange={(e) =>
                                  setEditFgData({
                                    ...editFgData,
                                    mixLot: e.target.value,
                                  })
                                }
                                className="border p-1 w-full rounded bg-orange-50 font-bold"
                              />
                            ) : (
                              fg.mixLot
                            )}
                          </td>
                          <td className="px-4 py-3 font-bold text-slate-800">
                            {fg.type} {fg.height}T
                          </td>
                          <td className="px-4 py-3 text-center font-black text-green-600">
                            {isEditing ? (
                              <input
                                type="number"
                                value={editFgData.qty}
                                onChange={(e) =>
                                  setEditFgData({
                                    ...editFgData,
                                    qty: e.target.value,
                                  })
                                }
                                className="border p-1 w-16 text-center rounded bg-orange-50"
                              />
                            ) : (
                              fg.qty
                            )}
                          </td>
                          <td className="px-4 py-3 text-slate-500 text-xs truncate max-w-[200px] text-center">
                            {isEditing ? (
                              <input
                                type="text"
                                value={editFgData.details}
                                onChange={(e) =>
                                  setEditFgData({
                                    ...editFgData,
                                    details: e.target.value,
                                  })
                                }
                                className="border p-1 w-full rounded bg-orange-50"
                              />
                            ) : (
                              fg.details
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="flex justify-center gap-1.5">
                              {isEditing ? (
                                <>
                                  <button
                                    onClick={() => handleSaveFg(fg)}
                                    className="bg-orange-500 text-white p-1 rounded shadow-sm"
                                  >
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M5 13l4 4L19 7"
                                      />
                                    </svg>
                                  </button>
                                  <button
                                    onClick={() => setEditingFgId(null)}
                                    className="bg-slate-200 text-slate-700 p-1 rounded shadow-sm"
                                  >
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M6 18L18 6M6 6l12 12"
                                      />
                                    </svg>
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => {
                                      setEditingFgId(fg.id);
                                      setEditFgData(fg);
                                    }}
                                    className="text-slate-500 hover:text-indigo-600 p-1 bg-white border rounded shadow-sm"
                                  >
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                                      />
                                    </svg>
                                  </button>
                                  <button
                                    onClick={() => handleDeleteFg(fg.id)}
                                    className="text-red-400 hover:bg-red-500 hover:text-white p-1 bg-white border rounded shadow-sm transition-colors"
                                  >
                                    <svg
                                      className="w-4 h-4"
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                      />
                                    </svg>
                                  </button>
                                </>
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
// Step 0: Order Management (분할 투입 기능 추가 버전)
// ==========================================
function Step0OrderManagement({ orderList, ctx }) {
  const [newOrder, setNewOrder] = useState({
    date: getKST().split(" ")[0],
    color: "BL3",
    height: "25",
    singleWeight: 628,
    qty: 100,
  });
  const [editingId, setEditingId] = useState(null);
  const [editData, setEditData] = useState({});

  // 분할 투입용 입력 상태 관리
  const [releaseQtyMap, setReleaseQtyMap] = useState({});

  const calcBOM = (color, singleWeight, qty) => {
    const baseKg = (singleWeight * parseInt(qty)) / 1000;
    const totalKg = baseKg * 1.01 + 0.2;
    const ratios = RATIO_BY_COLOR[color] || { "4Y-W": 1.0 };
    const reqBOM = {};
    for (const [mat, ratio] of Object.entries(ratios)) {
      if (ratio > 0) reqBOM[mat] = totalKg * ratio;
    }
    return reqBOM;
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newOrder.qty || newOrder.qty <= 0) return;
    const sWeight =
      Number(newOrder.singleWeight) || WEIGHT_BY_HEIGHT[newOrder.height];
    const reqBOM = calcBOM(newOrder.color, sWeight, newOrder.qty);
    const newItem = {
      id: Date.now().toString(),
      orderNo: `ORD-${newOrder.date.replace(/-/g, "").slice(2)}-${Math.floor(
        Math.random() * 1000
      )}`,
      orderDate: newOrder.date,
      productCode: `AM1100VT${newOrder.color}${newOrder.height}`,
      color: newOrder.color,
      height: newOrder.height,
      singleWeight: sWeight,
      qty: parseInt(newOrder.qty),
      releasedQty: 0, // 🌟 초기 투입량 0
      reqBOM,
      status: "대기중",
      createdAt: serverTimestamp(), // 🌟 추가됨: 조작 불가능한 서버 시간 강제 기록
    };
    try {
      await setDoc(getDocRef("orderList", newItem.id), newItem);
      ctx.showToast("발주가 등록되었습니다.", "success");
    } catch (err) {
      ctx.showToast("발주 등록 실패", "error");
    }
  };

  // 🌟 [수정본] 분할 공정 투입 핸들러 (시간 기록 추가)
  const handleReleaseToWIP = async (order) => {
    const inputQty = parseInt(releaseQtyMap[order.id]);
    const alreadyReleased = order.releasedQty || 0;
    const remaining = order.qty - alreadyReleased;

    if (!inputQty || inputQty <= 0)
      return ctx.showToast("투입할 수량을 입력해주세요.");
    if (inputQty > remaining)
      return ctx.showToast(`잔량보다 많이 투입할 수 없습니다.`, "error");

    ctx.showConfirm(
      `${order.color} ${order.height}T 제품 ${inputQty}개를 원재료 창고로 보내시겠습니까?`,
      async () => {
        try {
          const newWipId = Date.now().toString();
          const totalReleased = alreadyReleased + inputQty;

          // 1. 발주 상태 업데이트
          await setDoc(getDocRef("orderList", order.id), {
            ...order,
            releasedQty: totalReleased,
            status: totalReleased >= order.qty ? "생산중" : "부분투입",
          });

          // 2. 신규 WIP 로트 생성
          await setDoc(getDocRef("wipList", newWipId), {
            id: newWipId,
            orderId: order.id,
            mixLot: `MIX-${getKSTDateOnly()}-${
              Math.floor(Math.random() * 900) + 100
            }`,
            type: order.color,
            height: order.height,
            singleWeight: order.singleWeight,
            qty: inputQty,
            currentStep: "step1",
            // 🌟 시간 기록 추가
            details: `[${getKST()}] 발주분할투입 (원본:${order.orderNo})`,
          });

          setReleaseQtyMap({ ...releaseQtyMap, [order.id]: "" });
      ctx.showToast(`${inputQty}개 원재료 창고로 전송 완료`, "success");

     // 🌟 시트 기록 추가
logProcessToGoogleSheet("step0", { ...order, qty: inputQty, mixLot: order.orderNo }, "마스터", { 
  details: "발주 분할 투입" 
});
    } catch (e) {
          ctx.showToast("투입 처리 중 오류 발생", "error");
        }
      }
    );
  };

  const handleDel = async (id) => {
    ctx.showConfirm("삭제하시겠습니까?", async () => {
      try {
        await deleteDoc(getDocRef("orderList", id));
        ctx.showToast("삭제됨", "success");
      } catch (e) {
        ctx.showToast("삭제 실패", "error");
      }
    });
  };

  const handleSave = async (order) => {
    const safeQty = parseInt(editData.qty);
    if (isNaN(safeQty) || safeQty <= 0)
      return ctx.showToast("수량을 올바른 숫자로 입력해주세요.", "error");

    const sWeight =
      Number(editData.singleWeight) || WEIGHT_BY_HEIGHT[editData.height];
    if (isNaN(sWeight) || sWeight <= 0)
      return ctx.showToast("단중을 올바른 숫자로 입력해주세요.", "error");

    const reqBOM = calcBOM(editData.color, sWeight, safeQty);
    const updated = {
      ...order,
      color: editData.color,
      height: editData.height,
      singleWeight: sWeight,
      qty: safeQty,
      reqBOM,
      productCode: `AM1100VT${editData.color}${editData.height}`,
    };
    try {
      await setDoc(getDocRef("orderList", order.id), updated);
      setEditingId(null);
      ctx.showToast("수정되었습니다.", "success");
    } catch (e) {
      ctx.showToast("수정 실패", "error");
    }
  };

  const pbBOM = calcBOM(
    newOrder.color,
    newOrder.singleWeight || WEIGHT_BY_HEIGHT[newOrder.height],
    newOrder.qty || 0
  );

  // 🌟 완료/취소 뿐만 아니라 전량 투입된 발주도 숨기려면 필터링 수정 가능 (현재는 유지)
  const activeOrders = orderList.filter(
    (o) => o.status !== "완료" && o.status !== "취소" && o.status !== "생산중"
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="bg-white rounded-xl shadow-sm border p-6 lg:col-span-1 h-fit">
        <h3 className="text-lg font-bold mb-4 text-slate-800">
          신규 발주 등록
        </h3>
        <form onSubmit={handleAdd} className="space-y-5">
          <div>
            <label className="block text-sm font-medium mb-1">발주 일자</label>
            <input
              type="date"
              required
              className="w-full border rounded-md p-2"
              value={newOrder.date}
              onChange={(e) =>
                setNewOrder({ ...newOrder, date: e.target.value })
              }
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">제품 색상</label>
            <div className="flex flex-wrap gap-2">
              {PRODUCT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setNewOrder({ ...newOrder, color: c })}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium border ${
                    newOrder.color === c
                      ? "bg-indigo-600 text-white"
                      : "bg-white"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">
              제품 높이 (T)
            </label>
            <div className="flex flex-wrap gap-2">
              {PRODUCT_HEIGHTS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() =>
                    setNewOrder({
                      ...newOrder,
                      height: h,
                      singleWeight: WEIGHT_BY_HEIGHT[h],
                    })
                  }
                  className={`px-3 py-1.5 rounded-md text-sm font-medium border ${
                    newOrder.height === h
                      ? "bg-indigo-600 text-white"
                      : "bg-white"
                  }`}
                >
                  {h}T
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">단중 (g)</label>
              <div className="relative">
                <input
                  type="number"
                  required
                  min="1"
                  className="w-full border rounded-md p-2 font-bold text-indigo-700 bg-indigo-50"
                  value={newOrder.singleWeight || ""}
                  onChange={(e) =>
                    setNewOrder({ ...newOrder, singleWeight: e.target.value })
                  }
                />
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                  <span className="text-slate-400 text-xs font-bold">g</span>
                </div>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                수량 (EA)
              </label>
              <input
                type="number"
                required
                min="1"
                className="w-full border rounded-md p-2"
                value={newOrder.qty}
                onChange={(e) =>
                  setNewOrder({ ...newOrder, qty: e.target.value })
                }
              />
            </div>
          </div>
          <div className="p-4 bg-indigo-50 rounded-lg border mt-4">
            <div className="text-xs font-semibold mb-2">
              예상 총 소요량 (BOM)
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(pbBOM).map(([mat, kg]) => (
                <div
                  key={mat}
                  className="flex justify-between px-3 py-2 bg-white rounded border flex-1"
                >
                  <span className="font-bold text-xs">{mat}</span>
                  <span className="font-black text-indigo-700">
                    {kg.toFixed(3)}kg
                  </span>
                </div>
              ))}
            </div>
          </div>
          <button
            type="submit"
            className="w-full bg-indigo-600 text-white py-2.5 rounded-md font-bold"
          >
            발주 등록
          </button>
        </form>
      </div>

      <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border p-6">
        <h3 className="text-lg font-bold mb-4">발주 현황 및 분할 투입 관리</h3>
        <div className="overflow-x-auto max-h-[650px]">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="bg-slate-50 sticky top-0 text-xs text-slate-500 uppercase border-b">
              <tr>
                <th className="px-4 py-3">발주정보</th>
                <th className="px-4 py-3">전체/남은수량</th>
                <th className="px-4 py-3">투입 진행률</th>
                <th className="px-4 py-3 text-center">분할 공정 투입</th>
                <th className="px-4 py-3 text-center">관리</th>
              </tr>
            </thead>
            <tbody>
              {activeOrders.map((order) => {
                const isEditing = editingId === order.id;
                const released = order.releasedQty || 0;
                const remaining = order.qty - released;
                const percent = Math.floor((released / order.qty) * 100);

                return (
                  <tr
                    key={order.id}
                    className="border-b hover:bg-slate-50 transition-colors"
                  >
                    <td className="px-4 py-4">
                      <div className="text-[10px] text-slate-400 font-mono mb-1">
                        {order.orderNo}
                      </div>
                      <div className="font-black text-slate-800 text-base">
                        {order.color} {order.height}T
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-bold text-slate-700">
                        {order.qty} EA
                      </div>
                      <div className="text-xs font-black text-orange-600">
                        잔량: {remaining} EA
                      </div>
                    </td>
                    <td className="px-4 py-4 min-w-[120px]">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-indigo-500 transition-all"
                            style={{ width: `${percent}%` }}
                          ></div>
                        </div>
                        <span className="text-[10px] font-black text-slate-500">
                          {percent}%
                        </span>
                      </div>
                      <div className="text-[10px] font-bold text-slate-400 mt-1">
                        {order.status}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center justify-center gap-2">
                        <input
                          type="number"
                          placeholder="수량"
                          value={releaseQtyMap[order.id] || ""}
                          onChange={(e) =>
                            setReleaseQtyMap({
                              ...releaseQtyMap,
                              [order.id]: e.target.value,
                            })
                          }
                          className="w-20 border rounded p-1.5 text-center font-bold text-indigo-600 outline-none focus:border-indigo-400"
                        />
                        <button
                          onClick={() => handleReleaseToWIP(order)}
                          className="bg-indigo-600 text-white px-3 py-1.5 rounded font-bold text-xs hover:bg-indigo-700 whitespace-nowrap"
                        >
                          공정 투입
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-center">
                      <div className="flex justify-center gap-2">
                        <button
                          onClick={() => {
                            setEditingId(order.id);
                            setEditData(order);
                          }}
                          className="text-slate-400 hover:text-indigo-600"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDel(order.id)}
                          className="text-red-300 hover:text-red-600"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {activeOrders.length === 0 && (
                <tr>
                  <td
                    colSpan="5"
                    className="text-center py-20 text-slate-400 font-bold"
                  >
                    진행 중인 발주가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// Step 1: Material Warehouse (WIP 로트 기반 출고 + 하단 입고내역 및 모달 복구)
// ==========================================
function Step1MaterialWarehouse({
  inventory,
  inventoryHistory,
  wipList, // 🌟 이제 공정 리스트(wipList)를 받습니다.
  ctx,
}) {
  const [inboundItems, setInboundItems] = useState(
    MATERIAL_TYPES.map((t) => ({ type: t, lot: "", weight: "" }))
  );
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [operators, setOperators] = useState({});
  const [detailModalType, setDetailModalType] = useState(null);
  const [detailModalTab, setDetailModalTab] = useState("lots");

  // 🌟 Step 0에서 [공정 투입] 버튼을 눌러 넘어온 로트들만 필터링 (step1 상태인 것들)
  const pendingLots = (wipList || []).filter((w) => w.currentStep === "step1");

  // 🌟 투입량에 맞게 BOM(소요량)을 계산하는 함수
  const calcPartialBOM = (color, singleWeight, qty) => {
    const baseKg = (Number(singleWeight) * Number(qty)) / 1000;
    const totalKg = baseKg * 1.01 + 0.2;
    const ratios = RATIO_BY_COLOR[color] || { "4Y-W": 1.0 };
    const reqBOM = {};
    for (const [mat, ratio] of Object.entries(ratios)) {
      if (ratio > 0) reqBOM[mat] = totalKg * ratio;
    }
    return reqBOM;
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    const validItems = inboundItems.filter((item) => item.lot && item.weight);
    if (validItems.length === 0)
      return ctx.showToast("입고 데이터를 입력해주세요.", "error");

    // 🌟 NaN 검증: 입력된 항목 중 중량이 숫자가 아니거나 0 이하인 것이 있는지 먼저 검사
    for (let item of validItems) {
      const checkVal = parseFloat(item.weight);
      if (isNaN(checkVal) || checkVal <= 0) {
        return ctx.showToast(
          `[${item.type}] 올바른 중량(숫자)을 입력해주세요.`,
          "error"
        );
      }
    }

    const dStr = getKST().split(" ")[0];
    const timeStr = getKST().slice(0, 16);
    try {
      for (let item of validItems) {
        const wVal = parseFloat(item.weight);
        const newId =
          Date.now().toString() + Math.random().toString().slice(2, 7);
        const histId =
          Date.now().toString() + Math.random().toString().slice(2, 7);
        await setDoc(getDocRef("inventory", newId), {
          id: newId,
          lot: item.lot,
          type: item.type,
          weight: wVal,
          date: dStr,
          status: "입고완료",
          createdAt: serverTimestamp(), // 🌟 1~4단계 적용 유지
        });
        await setDoc(getDocRef("inventoryHistory", histId), {
          id: histId,
          date: timeStr,
          type: "IN",
          materialType: item.type,
          lot: item.lot,
          qty: wVal,
          note: "일괄입고",
          createdAt: serverTimestamp(), // 🌟 1~4단계 적용 유지
        });
      }
      setInboundItems(
        MATERIAL_TYPES.map((t) => ({ type: t, lot: "", weight: "" }))
      );
      setIsModalOpen(false);
      ctx.showToast("입고 완료", "success");
    } catch (err) {
      ctx.showToast("입고 실패", "error");
    }
  };

  // 🌟 [수정본] 원클릭 출고 처리 (시간 기록 추가)
  const handleOutboundLot = async (lot) => {
    const op = operators[lot.id];
    if (!op) return ctx.showToast("작업자 성명을 입력해주세요.", "error");

    const neededBOM = calcPartialBOM(lot.type, lot.singleWeight, lot.qty);
    let currentInv = [...inventory].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );
    let invUpdates = [];
    let invDeletes = [];
    let historyToStore = [];

    for (const [mat, needed] of Object.entries(neededBOM)) {
      const avail = currentInv
        .filter((i) => i.type === mat)
        .reduce((s, i) => s + i.weight, 0);
      if (avail < needed) return ctx.showToast(`[${mat}] 재고 부족!`, "error");
    }

    for (const [mat, needed] of Object.entries(neededBOM)) {
      let remain = needed;
      for (let i = 0; i < currentInv.length; i++) {
        if (currentInv[i].type === mat && currentInv[i].weight > 0) {
          const deduct = Math.min(currentInv[i].weight, remain);
          currentInv[i].weight -= deduct;
          remain -= deduct;
          historyToStore.push({
            id: Date.now() + Math.random().toString(),
            date: getKST().slice(0, 16),
            type: "OUT",
            materialType: mat,
            lot: currentInv[i].lot,
            qty: Number(deduct.toFixed(3)),
            note: `분할출고(${lot.mixLot})`,
          });
          if (currentInv[i].weight <= 0) invDeletes.push(currentInv[i].id);
          else invUpdates.push(currentInv[i]);
          if (remain <= 0) break;
        }
      }
    }

    try {
      for (let u of invUpdates) await setDoc(getDocRef("inventory", u.id), u);
      for (let d of invDeletes) await deleteDoc(getDocRef("inventory", d));
      for (let h of historyToStore)
        await setDoc(getDocRef("inventoryHistory", h.id), h);

      const totalW = Object.values(neededBOM).reduce((a, b) => a + b, 0);
      await setDoc(getDocRef("wipList", lot.id), {
        ...lot,
        weight: totalW.toFixed(3),
        currentStep: "step2",
        // 🌟 시간 기록 추가
        details: `${
          lot.details
        }\n[${getKST()}] [원재료창고] 출고완료 (담당:${op})`,
     });
    ctx.showToast(`로트 ${lot.mixLot} 출고 및 혼합 이관 완료`, "success");

// 🌟 시트 기록 추가 (수량 대신 총 중량(kg)과 투입 원료명 기록)
    const materialsStr = Object.keys(neededBOM).join(", ");
    logProcessToGoogleSheet("step1", { ...lot, qty: totalW.toFixed(3) }, op, { 
      measurements: `투입원료: ${materialsStr}`,
      details: "원재료 혼합 공정으로 출고 (단위: kg)" 
    });
  } catch (e) {
      ctx.showToast("오류 발생", "error");
    }
  };

  const inboundHistory = (inventoryHistory || []).filter(
    (h) => h.type === "IN"
  );
  const groupedInbound = inboundHistory.reduce((acc, curr) => {
    const dateDate = curr.date.split(" ")[0];
    if (!acc[dateDate]) acc[dateDate] = [];
    acc[dateDate].push(curr);
    return acc;
  }, {});
  const sortedInboundDates = Object.keys(groupedInbound).sort(
    (a, b) => new Date(b) - new Date(a)
  );

  return (
    <div className="space-y-8 relative">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-bold text-slate-800 flex items-center">
          <Package className="w-5 h-5 mr-2 text-indigo-600" /> 분말 재고 요약
        </h3>
        {!isModalOpen && (
          <button
            onClick={() => setIsModalOpen(true)}
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center hover:bg-indigo-700 transition-colors"
          >
            <Plus className="w-4 h-4 mr-1" /> 일괄 입고 등록
          </button>
        )}
      </div>

      {isModalOpen && (
        <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 mb-6 relative">
          <div className="flex justify-between items-center mb-6">
            <h4 className="font-black text-lg text-slate-800 flex items-center">
              <Plus className="w-5 h-5 mr-2 text-indigo-500" /> 원재료 일괄 입고
              등록
            </h4>
            <button
              onClick={() => setIsModalOpen(false)}
              className="text-slate-400 hover:text-slate-600 bg-slate-100 p-1.5 rounded-full"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {inboundItems.map((item, idx) => (
              <div
                key={item.type}
                className="flex gap-3 items-center bg-slate-50 p-3 rounded-xl border border-slate-200 shadow-sm"
              >
                <span className="w-16 font-black text-indigo-700 text-center">
                  {item.type}
                </span>
                <input
                  type="text"
                  placeholder="로트번호"
                  className="flex-1 border border-slate-300 p-2.5 rounded-lg text-sm font-mono focus:border-indigo-400"
                  value={item.lot}
                  onChange={(e) => {
                    const newItems = [...inboundItems];
                    newItems[idx].lot = e.target.value;
                    setInboundItems(newItems);
                  }}
                />
                <div className="relative w-28">
                  <input
                    type="number"
                    step="0.001"
                    placeholder="중량"
                    className="w-full border border-slate-300 p-2.5 rounded-lg text-sm text-right font-bold pr-7 focus:border-indigo-400"
                    value={item.weight}
                    onChange={(e) => {
                      const newItems = [...inboundItems];
                      newItems[idx].weight = e.target.value;
                      setInboundItems(newItems);
                    }}
                  />
                  <span className="absolute right-2 top-2.5 text-xs font-bold text-slate-400">
                    kg
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex justify-end">
            <button
              onClick={handleAdd}
              className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-black shadow-md hover:bg-indigo-700 transition-transform flex items-center"
            >
              <CheckCircle2 className="w-5 h-5 mr-2" /> 일괄 입고 처리
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
        {MATERIAL_TYPES.map((type) => {
          const totalW = inventory
            .filter((i) => i.type === type)
            .reduce((s, i) => s + i.weight, 0);
          let safetyThreshold =
            type === "4Y-W"
              ? 500
              : type === "4Y-Y"
              ? 50
              : type === "5E-P"
              ? 20
              : 10;
          let maxCapacity =
            type === "4Y-W"
              ? 2000
              : type === "4Y-Y"
              ? 200
              : type === "5E-P"
              ? 100
              : 50;
          const isWarning = totalW <= safetyThreshold;
          return (
            <div
              key={type}
              onClick={() => {
                setDetailModalType(type);
                setDetailModalTab("lots");
              }}
              className={`rounded-2xl shadow-sm border bg-white p-6 cursor-pointer transition-all ${
                isWarning
                  ? "border-red-300 bg-red-50/50"
                  : "hover:border-indigo-400 hover:shadow-md"
              }`}
            >
              <div className="text-sm font-bold text-slate-500 mb-3 flex justify-between items-center">
                <span>{type}</span>
                {isWarning && (
                  <span className="text-[10px] text-red-500 bg-red-100 border border-red-200 px-1.5 py-0.5 rounded font-black animate-pulse">
                    재고부족
                  </span>
                )}
              </div>
              <div
                className={`text-3xl font-black mb-4 ${
                  isWarning ? "text-red-600" : "text-slate-800"
                }`}
              >
                {totalW.toLocaleString()}{" "}
                <span className="text-base font-bold text-slate-500">kg</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-2">
                <div
                  className={`h-2 rounded-full ${
                    isWarning ? "bg-red-500" : "bg-green-500"
                  }`}
                  style={{
                    width: `${Math.min((totalW / maxCapacity) * 100, 100)}%`,
                  }}
                ></div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
        <div className="px-6 py-5 bg-slate-50 border-b">
          <h3 className="font-bold text-lg text-slate-800">
            생산 투입 로트 (출고 대기)
          </h3>
        </div>
        <table className="w-full text-sm text-left">
          <thead className="bg-white border-b text-xs text-slate-500 uppercase tracking-wider">
            <tr>
              <th className="px-6 py-4">로트 번호</th>
              <th className="px-6 py-4">제품 정보</th>
              <th className="px-4 py-4 text-center">투입 수량</th>
              <th className="px-6 py-4">소요 원재료 (BOM)</th>
              <th className="px-6 py-4 text-center">작업</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pendingLots.length === 0 && (
              <tr>
                <td
                  colSpan="5"
                  className="text-center py-20 text-slate-400 font-medium italic"
                >
                  Step 0에서 투입된 로트가 없습니다.
                </td>
              </tr>
            )}
            {pendingLots.map((lot) => {
              const neededBOM = calcPartialBOM(
                lot.type,
                lot.singleWeight,
                lot.qty
              );
              // 🌟 1. 총 합산 무게 계산 로직 추가
              const totalBOMWeight = Object.values(neededBOM).reduce(
                (a, b) => a + b,
                0
              );

              return (
                <tr
                  key={lot.id}
                  className="hover:bg-slate-50 transition-colors"
                >
                  <td className="px-6 py-4 font-mono font-bold text-indigo-600">
                    {lot.mixLot}
                  </td>
                  <td className="px-6 py-4 font-black">
                    {lot.type} {lot.height}T
                  </td>
                  <td className="px-4 py-4 font-black text-blue-600 text-center text-lg">
                    {lot.qty} EA
                  </td>
                  <td className="px-6 py-4">
                    {/* 🌟 2. items-center 클래스 추가 및 녹색 합계 뱃지 추가 */}
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {Object.entries(neededBOM).map(([m, k]) => (
                        <div
                          key={m}
                          className="px-2 py-1 bg-indigo-50 border border-indigo-100 rounded text-[10px] font-bold text-indigo-700"
                        >
                          {m}: {k.toFixed(3)}kg
                        </div>
                      ))}
                      {/* 🌟 추가된 합계 뱃지 UI */}
                      <div className="px-2.5 py-1 bg-emerald-100 border border-emerald-300 rounded text-[10px] font-black text-emerald-800 shadow-sm">
                        합계: {totalBOMWeight.toFixed(3)} kg
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-2 items-center">
                      <input
                        type="text"
                        placeholder="작업자"
                        value={operators[lot.id] || ""}
                        onChange={(e) =>
                          setOperators({
                            ...operators,
                            [lot.id]: e.target.value,
                          })
                        }
                        className="border p-2 text-xs text-center font-bold rounded-lg w-24 outline-none focus:border-indigo-500"
                      />
                      <button
                        onClick={() => handleOutboundLot(lot)}
                        className="bg-blue-600 text-white px-4 py-2 rounded-xl text-xs font-black hover:bg-blue-700 shadow-md"
                      >
                        출고 실행
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 🌟 여기서부터 사라졌던 입고 내역 테이블 및 상세 모달 창 완벽 복구 🌟 */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mt-8">
        <div className="px-6 py-5 bg-slate-50 border-b border-slate-100 flex items-center">
          <History className="w-5 h-5 mr-2 text-slate-500" />
          <h3 className="font-bold text-lg">최근 분말 입고 내역</h3>
        </div>
        <div className="p-6 overflow-x-auto max-h-[400px]">
          {sortedInboundDates.length === 0 ? (
            <div className="text-center py-8 text-slate-400">
              최근 입고 내역이 없습니다.
            </div>
          ) : (
            <div className="space-y-8">
              {sortedInboundDates.map((date) => (
                <div key={date}>
                  <h4 className="font-black text-slate-700 mb-3 flex items-center">
                    <span className="w-2 h-2 rounded-full bg-indigo-500 mr-2"></span>{" "}
                    {date}
                  </h4>
                  <table className="w-full text-sm text-left border rounded-lg overflow-hidden">
                    <thead className="bg-slate-50 border-b text-xs text-slate-500">
                      <tr>
                        <th className="px-4 py-3">시간</th>
                        <th className="px-4 py-3">원재료 종류</th>
                        <th className="px-4 py-3">로트 번호</th>
                        <th className="px-4 py-3 text-right">입고 중량</th>
                        <th className="px-4 py-3">비고</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {groupedInbound[date].map((h) => (
                        <tr key={h.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 text-xs text-slate-500 font-mono">
                            {h.date.split(" ")[1] || h.date}
                          </td>
                          <td className="px-4 py-3 font-black text-slate-800">
                            {h.materialType}
                          </td>
                          <td className="px-4 py-3 font-mono font-bold text-indigo-600">
                            {h.lot}
                          </td>
                          <td className="px-4 py-3 text-right font-black">
                            {h.qty.toLocaleString()}{" "}
                            <span className="text-xs font-bold text-slate-400">
                              kg
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-500">
                            {h.note}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {detailModalType && (
        <div className="fixed inset-0 bg-slate-900/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col overflow-hidden">
            <div className="flex justify-between items-center p-6 border-b border-slate-200 bg-slate-50">
              <h3 className="text-xl font-black text-slate-800">
                {detailModalType} 상세 정보
              </h3>
              <button
                onClick={() => setDetailModalType(null)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="flex border-b px-6 bg-white">
              <button
                onClick={() => setDetailModalTab("lots")}
                className={`py-3 px-4 font-bold text-sm border-b-2 transition-colors ${
                  detailModalTab === "lots"
                    ? "border-indigo-600 text-indigo-700"
                    : "border-transparent text-slate-500 hover:text-slate-700"
                }`}
              >
                로트별 잔여량
              </button>
              <button
                onClick={() => setDetailModalTab("history")}
                className={`py-3 px-4 font-bold text-sm border-b-2 transition-colors ${
                  detailModalTab === "history"
                    ? "border-indigo-600 text-indigo-700"
                    : "border-transparent text-slate-500 hover:text-slate-700"
                }`}
              >
                입출고 내역
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1 bg-slate-50">
              {detailModalTab === "lots" && (
                <table className="w-full text-sm text-left bg-white border rounded-lg overflow-hidden shadow-sm">
                  <thead className="bg-slate-100 text-slate-500 text-xs uppercase">
                    <tr>
                      <th className="p-3">입고일자</th>
                      <th className="p-3">로트 번호</th>
                      <th className="p-3 text-right">잔여 중량</th>
                      <th className="p-3 text-center">상태</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {inventory
                      .filter((i) => i.type === detailModalType && i.weight > 0)
                      .map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="p-3">{item.date}</td>
                          <td className="p-3 font-mono font-bold text-indigo-600">
                            {item.lot}
                          </td>
                          <td className="p-3 text-right font-black">
                            {item.weight.toLocaleString()} kg
                          </td>
                          <td className="p-3 text-center">
                            <span className="bg-green-100 text-green-700 px-2 py-1 rounded text-[10px] font-bold">
                              {item.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    {inventory.filter(
                      (i) => i.type === detailModalType && i.weight > 0
                    ).length === 0 && (
                      <tr>
                        <td
                          colSpan="4"
                          className="text-center p-6 text-slate-400"
                        >
                          잔여 로트가 없습니다.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}

              {detailModalTab === "history" && (
                <table className="w-full text-sm text-left bg-white border rounded-lg overflow-hidden shadow-sm">
                  <thead className="bg-slate-100 text-slate-500 text-xs uppercase">
                    <tr>
                      <th className="p-3">일시</th>
                      <th className="p-3 text-center">구분</th>
                      <th className="p-3">로트 번호</th>
                      <th className="p-3 text-right">수량</th>
                      <th className="p-3">비고</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(inventoryHistory || [])
                      .filter((h) => h.materialType === detailModalType)
                      .map((h) => (
                        <tr key={h.id} className="hover:bg-slate-50">
                          <td className="p-3 text-xs text-slate-500">
                            {h.date}
                          </td>
                          <td className="p-3 text-center">
                            <span
                              className={`px-2 py-1 rounded text-[10px] font-bold ${
                                h.type === "IN"
                                  ? "bg-blue-100 text-blue-700"
                                  : "bg-red-100 text-red-700"
                              }`}
                            >
                              {h.type === "IN" ? "입고" : "출고"}
                            </span>
                          </td>
                          <td className="p-3 font-mono font-bold text-slate-700">
                            {h.lot}
                          </td>
                          <td className="p-3 text-right font-black">
                            {h.qty.toLocaleString()} kg
                          </td>
                          <td className="p-3 text-xs text-slate-600">
                            {h.note}
                          </td>
                        </tr>
                      ))}
                    {(inventoryHistory || []).filter(
                      (h) => h.materialType === detailModalType
                    ).length === 0 && (
                      <tr>
                        <td
                          colSpan="5"
                          className="text-center p-6 text-slate-400"
                        >
                          입출고 내역이 없습니다.
                        </td>
                      </tr>
                    )}
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
// Step 2: Mixing
// ==========================================
function Step2Mixing({ wipList, ctx }) {
  const pendingWip = wipList.filter((w) => w.currentStep === "step2");
  const [activeMixId, setActiveMixId] = useState(null);
  const [isSplitMode, setIsSplitMode] = useState(false);
  const [splitMaterial, setSplitMaterial] = useState("");
  const [splitWeightStr, setSplitWeightStr] = useState("");
  const [operator, setOperator] = useState("");
  const [specialNote, setSpecialNote] = useState("");

  useEffect(() => {
    if (!activeMixId && pendingWip.length > 0) {
      setActiveMixId(pendingWip[0].id);
      setIsSplitMode(false);
    } else if (activeMixId && !pendingWip.find((w) => w.id === activeMixId)) {
      setActiveMixId(pendingWip.length > 0 ? pendingWip[0].id : null);
      setIsSplitMode(false);
    }
  }, [pendingWip, activeMixId]);

  const activeJob = pendingWip.find((w) => w.id === activeMixId);
  const ratios = activeJob
    ? RATIO_BY_COLOR[activeJob.type] || { "4Y-W": 1.0 }
    : {};
  const activeMaterials = Object.keys(ratios).filter((m) => ratios[m] > 0);

  useEffect(() => {
    if (
      activeMaterials.length > 0 &&
      !activeMaterials.includes(splitMaterial)
    ) {
      setSplitMaterial(activeMaterials[0]);
      setSplitWeightStr("");
    }
  }, [activeJob, activeMaterials, splitMaterial]);

  const splitWeight = parseFloat(splitWeightStr) || 0;
  const matRatio = ratios[splitMaterial] || 1;
  const subTotal = matRatio > 0 ? splitWeight / matRatio : 0;
  const origTotal = activeJob ? parseFloat(activeJob.weight) : 0;
  const isValidSplit = subTotal > 0 && subTotal < origTotal;
  const remainTotal = origTotal - subTotal;
  const subQty = activeJob
    ? Math.round((subTotal / origTotal) * activeJob.qty)
    : 0;
  const remainQty = activeJob ? activeJob.qty - subQty : 0;

  // 🌟 [수정본] 일반 혼합 및 분할 혼합 (시간 기록 추가)
  const handleMix = async () => {
    if (!operator) return ctx.showToast("작업자 필수");
    try {
      await setDoc(getDocRef("wipList", activeJob.id), {
        ...activeJob,
        currentStep: "step3",
        // 🌟 시간 기록 추가
        details: `${
          activeJob.details
        }\n[${getKST()}] [혼합] 담당: ${operator} ${
          specialNote ? `[메모:${specialNote}]` : ""
        }`,
      });
      setOperator("");
    setSpecialNote("");
    ctx.showToast("혼합 완료", "success");

// 🌟 시트 기록 추가 (수량 대신 총 혼합 중량 기록)
    logProcessToGoogleSheet("step2", { ...activeJob, qty: activeJob.weight }, operator, { 
      measurements: `혼합중량: ${activeJob.weight}kg`,
      details: specialNote ? `일반 혼합 [메모:${specialNote}] (단위: kg)` : "일반 혼합 (단위: kg)"
    });
  } catch (err) {
      ctx.showToast("오류 발생", "error");
    }
  };

  const handleSplitMix = async () => {
    if (!operator) return ctx.showToast("작업자 필수");
    if (!isValidSplit) return ctx.showToast("잔여 중량 오류", "error");

    const id1 = Date.now().toString();
    const id2 = (Date.now() + 1).toString();

    try {
      await deleteDoc(getDocRef("wipList", activeJob.id));
      await setDoc(getDocRef("wipList", id1), {
        ...activeJob,
        id: id1,
        mixLot: `${activeJob.mixLot}-R`,
        weight: subTotal.toFixed(3),
        qty: subQty,
        currentStep: "step3",
        // 🌟 시간 기록 추가
        details: `${
          activeJob.details
        }\n[${getKST()}] [혼합] 잔량 분할 혼합 (담당:${operator})`,
      });
      await setDoc(getDocRef("wipList", id2), {
        ...activeJob,
        id: id2,
        mixLot: `MIX-${getKSTDateOnly()}-${Math.floor(Math.random() * 100)}`,
        weight: remainTotal.toFixed(3),
        qty: remainQty,
        currentStep: "step2",
        // 🌟 시간 기록 추가
        details: `${
          activeJob.details
        }\n[${getKST()}] [혼합] 이전 로트 잔량 분리 생성`,
      });

      setIsSplitMode(false);
      setSplitWeightStr("");
      setOperator("");
    setSpecialNote("");
    ctx.showToast("잔량 분할 완료", "success");

// 🌟 시트 기록 추가 (수량 대신 분할된 중량 기록)
    logProcessToGoogleSheet("step2", { ...activeJob, qty: subTotal.toFixed(3) }, operator, { 
      measurements: `분할중량: ${subTotal.toFixed(3)}kg`,
      details: "잔량 분할 소진 (단위: kg)" 
    });
  } catch (err) {
      ctx.showToast("오류 발생", "error");
    }
  };

  return (
    <div className="space-y-8">
      {activeJob ? (
        (() => {
          const fullBatches = Math.floor(parseFloat(activeJob.weight) / 15);
          const remainder = Number(
            (parseFloat(activeJob.weight) % 15).toFixed(3)
          );

          return (
            <div className="bg-white rounded-2xl shadow-md border overflow-hidden">
              <div className="bg-indigo-600 px-6 py-4 flex justify-between items-center text-white">
                <h3 className="text-xl font-black flex items-center">
                  <Beaker className="w-6 h-6 mr-2 opacity-80" /> 혼합 작업
                  지시서
                </h3>
                <span className="bg-indigo-800 text-sm px-4 py-1.5 rounded-full font-mono font-bold shadow-inner">
                  {activeJob.mixLot}
                </span>
              </div>

              <div className="flex border-b bg-slate-50">
                <button
                  onClick={() => setIsSplitMode(false)}
                  className={`flex-1 py-4 text-sm font-bold flex items-center justify-center ${
                    !isSplitMode
                      ? "bg-white text-indigo-700 border-b-2 border-indigo-600"
                      : "text-slate-500"
                  }`}
                >
                  <Cylinder className="w-4 h-4 mr-2" /> 일반 혼합 (15kg 기준)
                </button>
                <button
                  onClick={() => setIsSplitMode(true)}
                  className={`flex-1 py-4 text-sm font-bold flex items-center justify-center ${
                    isSplitMode
                      ? "bg-orange-50 text-orange-700 border-b-2 border-orange-600"
                      : "text-slate-500"
                  }`}
                >
                  <Split className="w-4 h-4 mr-2" /> 로트 잔량 분할 (잔량 소진)
                </button>
              </div>

              <div className="p-8">
                <div className="flex justify-between mb-8 pb-6 border-b gap-6">
                  <div>
                    <div className="text-sm font-bold text-slate-500 mb-1">
                      작업 제품
                    </div>
                    <div className="text-3xl font-black flex items-center">
                      {activeJob.type}{" "}
                      <span className="text-indigo-600 ml-2">
                        {activeJob.height}T
                      </span>{" "}
                      <span className="text-xl font-bold text-indigo-600 ml-3 bg-indigo-50 px-3 py-1 rounded-lg">
                        {activeJob.qty} EA
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-slate-500 mb-1">
                      총 혼합 중량
                    </div>
                    <div className="text-4xl font-black">
                      {parseFloat(activeJob.weight).toFixed(3)}{" "}
                      <span className="text-xl font-medium text-slate-400">
                        kg
                      </span>
                    </div>
                  </div>
                </div>

                {!isSplitMode ? (
                  <>
                    <div className="bg-slate-50 rounded-2xl p-6 border mb-8 flex justify-center gap-12">
                      <div className="text-center">
                        <Cylinder className="w-12 h-12 text-indigo-500 mb-3 mx-auto" />
                        <div className="font-bold text-slate-600">
                          15kg 꽉 찬 통
                        </div>
                        <div className="text-3xl font-black text-indigo-700 mt-1">
                          {fullBatches} 통
                        </div>
                      </div>
                      <div className="text-4xl font-black text-slate-300 mt-6">
                        +
                      </div>
                      <div
                        className={`text-center ${
                          remainder > 0 ? "" : "opacity-30 grayscale"
                        }`}
                      >
                        <Cylinder className="w-12 h-12 text-orange-400 mb-3 mx-auto" />
                        <div className="font-bold text-slate-600">
                          나머지 미달 통
                        </div>
                        <div className="text-3xl font-black text-orange-600 mt-1">
                          {remainder > 0 ? 1 : 0} 통
                        </div>
                        {remainder > 0 && (
                          <div className="text-sm font-black text-orange-700 mt-2">
                            {remainder.toFixed(3)} kg
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                      <div className="border-2 border-indigo-100 bg-indigo-50/40 rounded-2xl p-6 relative overflow-hidden shadow-sm">
                        <div className="absolute top-0 left-0 w-2 h-full bg-indigo-500"></div>
                        <h4 className="text-xl font-black text-indigo-900 mb-5 flex items-center">
                          <span className="bg-indigo-600 text-white w-8 h-8 rounded-full inline-flex items-center justify-center text-base mr-3 shadow-md">
                            {fullBatches}
                          </span>
                          15kg 통 1개당 투입량
                        </h4>
                        <div className="space-y-3">
                          {Object.entries(ratios).map(([mat, ratio]) => {
                            if (ratio > 0) {
                              return (
                                <div
                                  key={mat}
                                  className="flex justify-between items-center bg-white p-4 rounded-xl shadow-sm border border-indigo-100"
                                >
                                  <span className="font-black text-slate-700 text-lg">
                                    {mat}
                                  </span>
                                  <span className="font-black text-indigo-700 text-2xl">
                                    {(15 * ratio).toFixed(3)}{" "}
                                    <span className="text-sm text-slate-400">
                                      kg
                                    </span>
                                  </span>
                                </div>
                              );
                            }
                            return null;
                          })}
                        </div>
                      </div>

                      {remainder > 0 ? (
                        <div className="border-2 border-orange-100 bg-orange-50/40 rounded-2xl p-6 relative overflow-hidden shadow-sm">
                          <div className="absolute top-0 left-0 w-2 h-full bg-orange-400"></div>
                          <h4 className="text-xl font-black text-orange-900 mb-5 flex items-center">
                            <span className="bg-orange-500 text-white w-8 h-8 rounded-full inline-flex items-center justify-center text-base mr-3 shadow-md">
                              1
                            </span>
                            최종 미달 통 ({remainder.toFixed(3)}kg) 투입량
                          </h4>
                          <div className="space-y-3">
                            {Object.entries(ratios).map(([mat, ratio]) => {
                              if (ratio > 0) {
                                return (
                                  <div
                                    key={mat}
                                    className="flex justify-between items-center bg-white p-4 rounded-xl shadow-sm border border-orange-100"
                                  >
                                    <span className="font-black text-slate-700 text-lg">
                                      {mat}
                                    </span>
                                    <span className="font-black text-orange-600 text-2xl">
                                      {(remainder * ratio).toFixed(3)}{" "}
                                      <span className="text-sm text-slate-400">
                                        kg
                                      </span>
                                    </span>
                                  </div>
                                );
                              }
                              return null;
                            })}
                          </div>
                        </div>
                      ) : (
                        <div className="border-2 border-dashed border-slate-200 bg-slate-50/80 rounded-2xl p-6 flex flex-col items-center justify-center text-slate-400 min-h-[250px]">
                          <CheckCircle2 className="w-16 h-16 mb-3 opacity-30 text-indigo-500" />
                          <div className="font-black text-lg text-slate-500">
                            나머지 미달 통 없음
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="mt-8 flex justify-end gap-4 border-t pt-6">
                      <input
                        type="text"
                        placeholder="메모"
                        className="border rounded-lg p-3 text-sm w-64"
                        value={specialNote}
                        onChange={(e) => setSpecialNote(e.target.value)}
                      />
                      <input
                        type="text"
                        placeholder="작업자"
                        className="border rounded-lg p-3 text-sm w-40 text-center font-bold"
                        value={operator}
                        onChange={(e) => setOperator(e.target.value)}
                      />
                      <button
                        onClick={handleMix}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-xl font-black shadow flex items-center"
                      >
                        <CheckCircle2 className="w-5 h-5 mr-2" /> 혼합 완료
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="bg-orange-50 border border-orange-200 rounded-2xl p-6">
                    <div className="mb-6">
                      <h4 className="text-lg font-black text-orange-800 flex items-center mb-2">
                        <AlertCircle className="w-5 h-5 mr-2 text-orange-500" />{" "}
                        잔량 소진 부분 혼합
                      </h4>
                    </div>
                    <div className="grid grid-cols-2 gap-6 bg-white p-6 rounded border border-orange-200 mb-6">
                      <div>
                        <label className="block text-sm font-bold text-slate-700 mb-2">
                          잔량을 소진할 원재료
                        </label>
                        <select
                          className="w-full border rounded p-3 font-bold text-indigo-700 bg-slate-50"
                          value={splitMaterial}
                          onChange={(e) => setSplitMaterial(e.target.value)}
                        >
                          {activeMaterials.map((m) => (
                            <option key={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-bold text-slate-700 mb-2">
                          남은 중량 (kg)
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          className="w-full border rounded p-3 font-black text-orange-600"
                          value={splitWeightStr}
                          onChange={(e) => setSplitWeightStr(e.target.value)}
                        />
                      </div>
                    </div>
                    {isValidSplit && (
                      <div className="grid grid-cols-2 gap-6 mb-6">
                        <div className="bg-white border-2 border-orange-300 rounded-xl p-5">
                          <div className="text-sm font-black text-orange-600 bg-orange-100 px-2 py-1 rounded inline-block mb-3">
                            부분 혼합 지시
                          </div>
                          <div className="text-2xl font-black">
                            {subTotal.toFixed(3)} kg ({subQty} EA)
                          </div>
                        </div>
                        <div className="bg-white border-2 border-slate-200 rounded-xl p-5">
                          <div className="text-sm font-black text-slate-500 bg-slate-100 px-2 py-1 rounded inline-block mb-3">
                            잔여 혼합 대기 (새 로트)
                          </div>
                          <div className="text-2xl font-black">
                            {remainTotal.toFixed(3)} kg ({remainQty} EA)
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="flex justify-end gap-4 border-t border-orange-200 pt-6">
                      <input
                        type="text"
                        placeholder="작업자"
                        className="border rounded-lg p-3 text-sm w-40 text-center font-bold"
                        value={operator}
                        onChange={(e) => setOperator(e.target.value)}
                      />
                      <button
                        onClick={handleSplitMix}
                        disabled={!isValidSplit}
                        className={`px-8 py-3 rounded-xl font-black flex items-center ${
                          isValidSplit
                            ? "bg-orange-500 text-white"
                            : "bg-slate-200 text-slate-400"
                        }`}
                      >
                        <Split className="w-5 h-5 mr-2" /> 분할 생성
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border p-12 text-center text-slate-400">
          <Beaker className="w-16 h-16 mx-auto mb-4" />
          <h3 className="text-xl font-bold">진행할 작업이 없습니다.</h3>
        </div>
      )}

      {pendingWip.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="text-lg font-bold mb-4 flex items-center">
            <Layers className="w-5 h-5 mr-2 text-indigo-500" /> 대기 중인 작업
          </h3>
          <div className="overflow-x-auto max-h-64 border rounded">
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-50 sticky top-0 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="px-5 py-4">MIX LOT</th>
                  <th className="px-5 py-4">제품</th>
                  <th className="px-5 py-4">수량</th>
                  <th className="px-5 py-4">총중량</th>
                  <th className="px-5 py-4">선택</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pendingWip.map((w) => (
                  <tr
                    key={w.id}
                    className={`cursor-pointer ${
                      activeMixId === w.id
                        ? "bg-indigo-50/60"
                        : "hover:bg-slate-50"
                    }`}
                    onClick={() => setActiveMixId(w.id)}
                  >
                    <td
                      className={`px-5 py-3 font-mono font-bold ${
                        activeMixId === w.id ? "text-indigo-700" : ""
                      }`}
                    >
                      {w.mixLot}
                    </td>
                    <td className="px-5 py-3 font-bold">
                      {w.type}{" "}
                      <span className="text-indigo-600">{w.height}T</span>
                    </td>
                    <td className="px-5 py-3 font-bold text-slate-600">
                      {w.qty}
                    </td>
                    <td className="px-5 py-3 font-black text-slate-700">
                      {w.weight} kg
                    </td>
                    <td className="px-5 py-3">
                      <button
                        className={`px-3 py-1.5 rounded text-xs font-black ${
                          activeMixId === w.id
                            ? "bg-indigo-600 text-white"
                            : "bg-white border text-slate-500"
                        }`}
                      >
                        {activeMixId === w.id ? "확인중" : "보기"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// Step 3: First Molding (원본 UI + 이력 누적 로직)
// ==========================================
function Step3FirstMolding({ wipList, ctx }) {
  const pendingWip = wipList.filter((w) => w.currentStep === "step3");
  const [formData, setFormData] = useState({});
  const handleDataChange = (id, f, v) =>
    setFormData((p) => ({ ...p, [id]: { ...(p[id] || {}), [f]: v } }));

  // 🌟 [개선] 중복되는 평균 계산 로직을 함수로 분리하여 코드를 경량화했습니다.
  const calcAvg = (v1, v2, v3, dec = 2) =>
    v1 && v2 && v3
      ? ((Number(v1) + Number(v2) + Number(v3)) / 3).toFixed(dec)
      : (0).toFixed(dec);

  // 🌟 [수정본] 1차 성형 완료 (시간 기록 추가)
  const moveNext = async (id) => {
    const d = formData[id] || {};
    if (!d.operator)
      return ctx.showToast("작업자 성명을 입력해주세요.", "error");

    const wItem = wipList.find((w) => w.id === id);
    const aQty =
      parseInt(d.actualQty !== undefined ? d.actualQty : wItem.qty) || 0;
    const defQty = parseInt(d.defects) || 0;

    const dAvg = calcAvg(d.d1, d.d2, d.d3, 2);
    const hAvg = calcAvg(d.h1, d.h2, d.h3, 2);
    const wAvg = calcAvg(d.w1, d.w2, d.w3, 1);

    const defectStr =
      defQty > 0 ? ` [불량 ${defQty}개: ${d.defectReason || "사유미상"}]` : "";
    const noteStr = d.specialNote ? ` [메모: ${d.specialNote}]` : "";

    // 🌟 시간 기록 추가
    const recordDetails = `[${getKST()}] [1차성형] 압력:${
      d.pressure || 0
    } | 직경:${dAvg}mm | 높이:${hAvg}mm | 무게:${wAvg}g | 담당:${
      d.operator
    }${defectStr}${noteStr}`;

    try {
      await runTransaction(db, async (transaction) => {
        const docRef = getDocRef("wipList", id);
        const docSnap = await transaction.get(docRef);

        if (!docSnap.exists()) {
          throw "이미 삭제된 로트입니다.";
        }
        if (docSnap.data().currentStep !== "step3") {
          throw "이미 다른 작업자가 처리한 로트입니다.";
        }

        transaction.update(docRef, {
          qty: Math.max(0, aQty - defQty),
          currentStep: "step4",
          details: `${docSnap.data().details || ""}\n${recordDetails}`, // 🌟 여기에 적용
 });
  });
ctx.showToast("1차 성형 완료", "success");

// 🌟 시트 기록 추가 (정상수량=전체-불량 적용 및 단위 추가)
logProcessToGoogleSheet("step3", { ...wItem, qty: aQty - defQty }, d.operator, {
  defects: defQty,
  defectReason: d.defectReason || "-",
  conditions: `압력:${d.pressure || 0}ton`,
  measurements: `직경:${dAvg}mm, 높이:${hAvg}mm, 무게:${wAvg}g`,
  details: d.specialNote || "-"
});
} catch (err) {
      ctx.showToast(typeof err === "string" ? err : "오류 발생", "error");
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
      <h3 className="text-lg font-bold mb-2">1차 성형 (프레스 건식성형)</h3>
      <p className="text-sm text-slate-500 mb-6">
        성형 압력 및 특이사항 입력 필수. 수축률 측정용 시편 (7T) 포함 성형.
      </p>

      <div className="space-y-6">
        {pendingWip.length === 0 && (
          <div className="text-center py-12 text-slate-400 border-2 border-dashed border-slate-100 rounded-xl">
            대기 중인 반제품이 없습니다.
          </div>
        )}

        {pendingWip.map((wip) => {
          const d = formData[wip.id] || {};

          // 🌟 화면에 보여줄 때도 함수를 이용해 렌더링 로직 최소화
          const dAvg = calcAvg(d.d1, d.d2, d.d3, 2);
          const hAvg = calcAvg(d.h1, d.h2, d.h3, 2);
          const wAvg = calcAvg(d.w1, d.w2, d.w3, 1);
          const actualQtyValue =
            d.actualQty !== undefined ? d.actualQty : wip.qty;

          return (
            <div
              key={wip.id}
              className="border border-slate-200 rounded-xl p-5 bg-slate-50"
            >
              <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center mb-5 border-b border-slate-200 pb-4 gap-4">
                <div className="flex items-center space-x-4">
                  <span className="font-mono font-bold text-indigo-700 bg-indigo-100 px-3 py-1.5 rounded-lg border border-indigo-200">
                    {wip.mixLot}
                  </span>
                  <span className="font-black text-slate-800 text-xl tracking-wide">
                    {wip.type}
                    <span className="text-indigo-600 ml-1">{wip.height}T</span>
                  </span>
                  <div className="flex items-center bg-white border border-slate-300 rounded-lg shadow-sm px-3 py-1.5">
                    <span className="text-xs font-bold text-slate-500 mr-2 whitespace-nowrap">
                      실 성형수량
                    </span>
                    <input
                      type="number"
                      min="1"
                      value={actualQtyValue}
                      onChange={(e) =>
                        handleDataChange(wip.id, "actualQty", e.target.value)
                      }
                      className="w-16 text-center font-black text-indigo-700 outline-none bg-transparent"
                    />
                    <span className="text-xs font-bold text-slate-500 ml-1">
                      EA
                    </span>
                  </div>
                </div>

                <div className="flex items-center space-x-3 w-full xl:w-auto">
                  <label className="flex items-center space-x-2 text-sm font-bold text-slate-700 bg-white px-3 py-2 rounded-lg border border-slate-200 shadow-sm cursor-pointer whitespace-nowrap">
                    <input
                      type="checkbox"
                      className="rounded text-blue-600 focus:ring-blue-500 w-4 h-4"
                      defaultChecked
                    />
                    <span>수축률 시편 포함</span>
                  </label>
                  <div className="relative flex-1 xl:flex-none">
                    <input
                      type="text"
                      placeholder="작업자 성명"
                      value={d.operator || ""}
                      onChange={(e) =>
                        handleDataChange(wip.id, "operator", e.target.value)
                      }
                      className={`border rounded-lg p-2 text-sm w-full xl:w-32 text-center font-bold shadow-sm focus:ring-2 outline-none ${
                        d.error
                          ? "border-red-400 bg-red-50 focus:ring-red-200"
                          : "border-slate-300 focus:border-indigo-500 focus:ring-indigo-200"
                      }`}
                    />
                    {d.error && (
                      <span className="absolute -bottom-5 left-0 text-red-500 text-[10px] font-bold whitespace-nowrap">
                        {d.error}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
                <div className="xl:col-span-2 bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-center space-y-4">
                  <div>
                    <label className="text-xs font-bold text-slate-500 mb-2 flex items-center">
                      <Cylinder className="w-3.5 h-3.5 mr-1" /> 성형 압력
                    </label>
                    <input
                      type="text"
                      placeholder="예: 70ton"
                      value={d.pressure || ""}
                      onChange={(e) =>
                        handleDataChange(wip.id, "pressure", e.target.value)
                      }
                      className="border border-slate-300 rounded-lg p-2.5 text-sm font-black text-indigo-600 w-full text-center"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-500 mb-2 block">
                      특이사항 (메모)
                    </label>
                    <input
                      type="text"
                      placeholder="특이사항 기입"
                      value={d.specialNote || ""}
                      onChange={(e) =>
                        handleDataChange(wip.id, "specialNote", e.target.value)
                      }
                      className="border border-slate-300 rounded-lg p-2 text-xs w-full"
                    />
                  </div>
                </div>

                <div className="xl:col-span-7 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                    <div>
                      <label className="text-[11px] font-bold text-slate-500 mb-2 flex justify-between items-center">
                        <span>직경 (3회)</span>
                        <span className="text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded font-bold border border-indigo-100">
                          Avg: {dAvg} mm
                        </span>
                      </label>
                      <div className="flex space-x-1.5">
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="#1"
                          value={d.d1 || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "d1", e.target.value)
                          }
                          className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold"
                        />
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="#2"
                          value={d.d2 || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "d2", e.target.value)
                          }
                          className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold"
                        />
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="#3"
                          value={d.d3 || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "d3", e.target.value)
                          }
                          className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-[11px] font-bold text-slate-500 mb-2 flex justify-between items-center">
                        <span>높이 (3회)</span>
                        <span className="text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded font-bold border border-indigo-100">
                          Avg: {hAvg} mm
                        </span>
                      </label>
                      <div className="flex space-x-1.5">
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="#1"
                          value={d.h1 || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "h1", e.target.value)
                          }
                          className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold"
                        />
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="#2"
                          value={d.h2 || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "h2", e.target.value)
                          }
                          className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold"
                        />
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="#3"
                          value={d.h3 || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "h3", e.target.value)
                          }
                          className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-[11px] font-bold text-slate-500 mb-2 flex justify-between items-center">
                        <span>무게 (3회)</span>
                        <span className="text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded font-bold border border-indigo-100">
                          Avg: {wAvg} g
                        </span>
                      </label>
                      <div className="flex space-x-1.5">
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="#1"
                          value={d.w1 || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "w1", e.target.value)
                          }
                          className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold"
                        />
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="#2"
                          value={d.w2 || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "w2", e.target.value)
                          }
                          className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold"
                        />
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="#3"
                          value={d.w3 || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "w3", e.target.value)
                          }
                          className="border border-slate-300 rounded py-1.5 px-1 text-xs w-full text-center bg-slate-50 font-bold"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="xl:col-span-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between space-y-3">
                  <div className="flex flex-col space-y-1.5">
                    <label className="text-[11px] font-bold text-red-500 mb-0.5 block">
                      불량 (수량/사유)
                    </label>
                    <div className="flex space-x-1.5">
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="0"
                        value={d.defects || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "defects", e.target.value)
                        }
                        className="border border-red-300 rounded p-1.5 text-sm font-bold text-red-600 w-1/3 text-center bg-red-50 focus:ring-red-200 outline-none"
                      />
                      <input
                        type="text"
                        placeholder="사유기입"
                        value={d.defectReason || ""}
                        onChange={(e) =>
                          handleDataChange(
                            wip.id,
                            "defectReason",
                            e.target.value
                          )
                        }
                        className="border border-slate-300 rounded p-1.5 text-xs w-2/3 focus:ring-indigo-200 outline-none"
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => moveNext(wip.id)}
                    className="w-full text-sm bg-blue-600 text-white py-2.5 rounded-lg font-bold hover:bg-blue-700 transition-colors shadow-sm flex items-center justify-center"
                  >
                    <CheckCircle2 className="w-4 h-4 mr-1.5" /> 1차 성형 완료
                  </button>
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
// Step 4: Second Molding (제공 원본 UI + 이력 누적 로직)
// ==========================================
function Step4SecondMolding({ wipList, ctx }) {
  const pendingWip = wipList.filter((w) => w.currentStep === "step4");
  const [formData, setFormData] = useState({});
  const handleDataChange = (id, f, v) =>
    setFormData((p) => ({ ...p, [id]: { ...(p[id] || {}), [f]: v } }));

  // 🌟 [개선] A/B 호기 양쪽에 중복되던 평균 계산을 깔끔하게 묶어주는 함수
  const calcAvg = (v1, v2, v3, dec = 2) =>
    v1 && v2 && v3
      ? ((Number(v1) + Number(v2) + Number(v3)) / 3).toFixed(dec)
      : (0).toFixed(dec);

  // 🌟 [수정본] 2차 성형 완료 (시간 기록 추가)
  const moveNext = async (id) => {
    const d = formData[id] || {};
    if (!d.operator)
      return ctx.showToast("작업자 성명을 필수로 입력해주세요.", "error");

    const qtyA = parseInt(d.qtyA) || 0;
    const defA = parseInt(d.defectA) || 0;
    const qtyB = parseInt(d.qtyB) || 0;
    const defB = parseInt(d.defectB) || 0;
    const wipItem = wipList.find((w) => w.id === id);

    if (qtyA === 0 && qtyB === 0)
      return ctx.showToast(
        "A호기 또는 B호기 중 정상 생산 수량을 배정해주세요!",
        "error"
      );
    if (qtyA + defA + qtyB + defB !== wipItem.qty)
      return ctx.showToast(
        "입력한 수량 합계(정상+불량)가 대기 수량과 불일치합니다.",
        "error"
      );

    const dAvgA = calcAvg(d.d1A, d.d2A, d.d3A, 2);
    const hAvgA = calcAvg(d.h1A, d.h2A, d.h3A, 2);
    const pressA = d.pressureA || 0;

    const dAvgB = calcAvg(d.d1B, d.d2B, d.d3B, 2);
    const hAvgB = calcAvg(d.h1B, d.h2B, d.h3B, 2);
    const pressB = d.pressureB || 0;

    const noteStr = d.specialNote ? ` [메모:${d.specialNote}]` : "";
    const curTime = getKST(); // 🌟 현재 시간 미리 생성

    try {
      await runTransaction(db, async (transaction) => {
        const docRef = getDocRef("wipList", id);
        const docSnap = await transaction.get(docRef);

        if (!docSnap.exists()) {
          throw "이미 삭제된 로트입니다.";
        }
        if (docSnap.data().currentStep !== "step4") {
          throw "이미 다른 작업자가 처리한 로트입니다.";
        }

        const currentData = docSnap.data();

        if (qtyA > 0) {
          const defStrA =
            defA > 0
              ? ` [불량 ${defA}개: ${d.defectReasonA || "사유미상"}]`
              : "";
          const idA = Date.now().toString() + "A";
          const refA = getDocRef("wipList", idA);
          transaction.set(refA, {
            ...currentData,
            id: idA,
            mixLot: `${currentData.mixLot}-A`,
            qty: qtyA,
            currentStep: "step5",
            // 🌟 시간 기록 추가
            details: `${
              currentData.details || ""
            }\n[${curTime}] [2차성형 A호기] 압력:${pressA} | 직경:${dAvgA}mm | 높이:${hAvgA}mm | 담당:${
              d.operator
            }${defStrA}${noteStr}`,
          });
        }

        if (qtyB > 0) {
          const defStrB =
            defB > 0
              ? ` [불량 ${defB}개: ${d.defectReasonB || "사유미상"}]`
              : "";
          const idB = Date.now().toString() + "B";
          const refB = getDocRef("wipList", idB);
          transaction.set(refB, {
            ...currentData,
            id: idB,
            mixLot: `${currentData.mixLot}-B`,
            qty: qtyB,
            currentStep: "step5",
            // 🌟 시간 기록 추가
            details: `${
              currentData.details || ""
            }\n[${curTime}] [2차성형 B호기] 압력:${pressB} | 직경:${dAvgB}mm | 높이:${hAvgB}mm | 담당:${
              d.operator
            }${defStrB}${noteStr}`,
          });
        }

        transaction.delete(docRef);
  });

ctx.showToast("2차 성형 완료 및 열처리 이관", "success");

// 🌟 시트 기록 추가 (A/B 호기 상세 데이터 전용 칸 배정)
if (qtyA > 0) {
  logProcessToGoogleSheet("step4", { ...wipItem, qty: qtyA }, d.operator, {
    defects: defA,
    defectReason: d.defectReasonA || "-",
    equipment: "A호기",
    conditions: `압력:${d.pressureA || 0}bar`,
    measurements: `직경:${dAvgA}mm, 높이:${hAvgA}mm`,
    details: d.specialNote || "-"
  });
}
if (qtyB > 0) {
  logProcessToGoogleSheet("step4", { ...wipItem, qty: qtyB }, d.operator, {
    defects: defB,
    defectReason: d.defectReasonB || "-",
    equipment: "B호기",
    conditions: `압력:${d.pressureB || 0}bar`,
    measurements: `직경:${dAvgB}mm, 높이:${hAvgB}mm`,
    details: d.specialNote || "-"
  });
}
} catch (err) {
      ctx.showToast(typeof err === "string" ? err : "오류 발생", "error");
    }
  };

  // 🚀 [글로벌 엔진] 구글 시트 데이터 전송 함수

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
      <h3 className="text-lg font-bold mb-2">2차 성형 (A/B 호기)</h3>
      <p className="text-sm text-slate-500 mb-6">
        A/B 호기별로 수량(정상/불량)을 배정하고 압력 및 측정값을 기록하세요.
        수량 분배가 완료되어야 다음 공정으로 넘어갑니다.
      </p>

      <div className="space-y-6">
        {pendingWip.length === 0 && (
          <div className="text-center py-12 text-slate-400 border-2 border-dashed rounded-xl">
            대기 중인 반제품이 없습니다.
          </div>
        )}

        {pendingWip.map((wip) => {
          const d = formData[wip.id] || {};
          const qtyA = parseInt(d.qtyA) || 0;
          const defA = parseInt(d.defectA) || 0;
          const qtyB = parseInt(d.qtyB) || 0;
          const defB = parseInt(d.defectB) || 0;

          // 🌟 화면용 데이터도 함수 적용으로 경량화
          const dAvgA = calcAvg(d.d1A, d.d2A, d.d3A, 2);
          const hAvgA = calcAvg(d.h1A, d.h2A, d.h3A, 2);
          const dAvgB = calcAvg(d.d1B, d.d2B, d.d3B, 2);
          const hAvgB = calcAvg(d.h1B, d.h2B, d.h3B, 2);

          return (
            <div
              key={wip.id}
              className="border border-slate-200 rounded-xl p-5 bg-slate-50 relative"
            >
              <div className="flex justify-between items-center mb-4 border-b pb-4">
                <div className="flex items-center space-x-3">
                  <span className="font-mono font-bold text-indigo-700 bg-indigo-100 px-3 py-1 rounded-lg">
                    {wip.mixLot}
                  </span>
                  <span className="font-black text-xl">
                    {wip.type} {wip.height}T
                  </span>
                  <span className="font-bold text-slate-600 bg-white border px-3 py-1 rounded-lg shadow-sm">
                    대상: {wip.qty} EA
                  </span>
                </div>

                <div className="flex items-center space-x-2">
                  <input
                    type="text"
                    placeholder="공통 메모/특이사항"
                    value={d.specialNote || ""}
                    onChange={(e) =>
                      handleDataChange(wip.id, "specialNote", e.target.value)
                    }
                    className="border rounded-lg p-2 text-xs w-40"
                  />
                  <input
                    type="text"
                    placeholder="작업자 성명"
                    value={d.operator || ""}
                    onChange={(e) =>
                      handleDataChange(wip.id, "operator", e.target.value)
                    }
                    className={`border rounded-lg p-2 text-sm w-32 text-center font-bold ${
                      d.error && !d.operator ? "border-red-400 bg-red-50" : ""
                    }`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* A호기 */}
                <div
                  className={`border-2 rounded-xl p-4 transition-all ${
                    qtyA > 0 || defA > 0
                      ? "border-indigo-300 bg-white shadow-sm"
                      : "border-slate-200 bg-slate-100/50"
                  }`}
                >
                  <div className="flex justify-between items-center mb-4">
                    <h4 className="font-black text-indigo-800 bg-indigo-100 px-3 py-1 rounded-md">
                      A호기 라인
                    </h4>
                    <div className="flex space-x-2">
                      <div className="flex items-center border border-indigo-200 rounded p-1 bg-white">
                        <span className="text-xs font-bold text-indigo-600 w-10 text-center">
                          정상
                        </span>
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="0"
                          value={d.qtyA || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "qtyA", e.target.value)
                          }
                          className="w-12 text-center text-sm font-black outline-none"
                        />
                      </div>
                      <div className="flex items-center border border-red-200 rounded p-1 bg-white">
                        <span className="text-xs font-bold text-red-600 w-10 text-center">
                          불량
                        </span>
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="0"
                          value={d.defectA || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "defectA", e.target.value)
                          }
                          className="w-12 text-center text-sm font-black text-red-600 outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* 입력창 활성화 조건: qtyA > 0 인 경우에만 보임 */}
                  <div
                    className={`space-y-3 ${
                      qtyA > 0
                        ? "opacity-100"
                        : "opacity-40 grayscale pointer-events-none"
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-bold text-slate-500 w-12">
                        압력
                      </span>
                      <input
                        type="text"
                        placeholder="예: 2360 bar"
                        value={d.pressureA || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "pressureA", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-full"
                      />
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-bold text-slate-500 w-12">
                        직경(3)
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="#1"
                        value={d.d1A || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "d1A", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-1/3 text-center"
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="#2"
                        value={d.d2A || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "d2A", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-1/3 text-center"
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="#3"
                        value={d.d3A || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "d3A", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-1/3 text-center"
                      />
                      <span className="text-xs font-bold text-indigo-600 w-12 text-right">
                        {dAvgA}
                      </span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-bold text-slate-500 w-12">
                        높이(3)
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="#1"
                        value={d.h1A || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "h1A", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-1/3 text-center"
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="#2"
                        value={d.h2A || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "h2A", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-1/3 text-center"
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="#3"
                        value={d.h3A || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "h3A", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-1/3 text-center"
                      />
                      <span className="text-xs font-bold text-indigo-600 w-12 text-right">
                        {hAvgA}
                      </span>
                    </div>

                    {defA > 0 && (
                      <input
                        type="text"
                        placeholder="A호기 불량 사유 기입"
                        value={d.defectReasonA || ""}
                        onChange={(e) =>
                          handleDataChange(
                            wip.id,
                            "defectReasonA",
                            e.target.value
                          )
                        }
                        className="border border-red-300 bg-red-50 rounded p-1.5 text-xs w-full outline-none focus:ring-red-200"
                      />
                    )}
                  </div>
                </div>

                {/* B호기 */}
                <div
                  className={`border-2 rounded-xl p-4 transition-all ${
                    qtyB > 0 || defB > 0
                      ? "border-blue-300 bg-white shadow-sm"
                      : "border-slate-200 bg-slate-100/50"
                  }`}
                >
                  <div className="flex justify-between items-center mb-4">
                    <h4 className="font-black text-blue-800 bg-blue-100 px-3 py-1 rounded-md">
                      B호기 라인
                    </h4>
                    <div className="flex space-x-2">
                      <div className="flex items-center border border-blue-200 rounded p-1 bg-white">
                        <span className="text-xs font-bold text-blue-600 w-10 text-center">
                          정상
                        </span>
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="0"
                          value={d.qtyB || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "qtyB", e.target.value)
                          }
                          className="w-12 text-center text-sm font-black outline-none"
                        />
                      </div>
                      <div className="flex items-center border border-red-200 rounded p-1 bg-white">
                        <span className="text-xs font-bold text-red-600 w-10 text-center">
                          불량
                        </span>
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="0"
                          value={d.defectB || ""}
                          onChange={(e) =>
                            handleDataChange(wip.id, "defectB", e.target.value)
                          }
                          className="w-12 text-center text-sm font-black text-red-600 outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* 입력창 활성화 조건: qtyB > 0 인 경우에만 보임 */}
                  <div
                    className={`space-y-3 ${
                      qtyB > 0
                        ? "opacity-100"
                        : "opacity-40 grayscale pointer-events-none"
                    }`}
                  >
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-bold text-slate-500 w-12">
                        압력
                      </span>
                      <input
                        type="text"
                        placeholder="예: 2360 bar"
                        value={d.pressureB || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "pressureB", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-full"
                      />
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-bold text-slate-500 w-12">
                        직경(3)
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="#1"
                        value={d.d1B || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "d1B", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-1/3 text-center"
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="#2"
                        value={d.d2B || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "d2B", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-1/3 text-center"
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="#3"
                        value={d.d3B || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "d3B", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-1/3 text-center"
                      />
                      <span className="text-xs font-bold text-blue-600 w-12 text-right">
                        {dAvgB}
                      </span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-bold text-slate-500 w-12">
                        높이(3)
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="#1"
                        value={d.h1B || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "h1B", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-1/3 text-center"
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="#2"
                        value={d.h2B || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "h2B", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-1/3 text-center"
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="#3"
                        value={d.h3B || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "h3B", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs w-1/3 text-center"
                      />
                      <span className="text-xs font-bold text-blue-600 w-12 text-right">
                        {hAvgB}
                      </span>
                    </div>

                    {defB > 0 && (
                      <input
                        type="text"
                        placeholder="B호기 불량 사유 기입"
                        value={d.defectReasonB || ""}
                        onChange={(e) =>
                          handleDataChange(
                            wip.id,
                            "defectReasonB",
                            e.target.value
                          )
                        }
                        className="border border-red-300 bg-red-50 rounded p-1.5 text-xs w-full outline-none focus:ring-red-200"
                      />
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-6 flex flex-col items-center border-t pt-4">
                {(() => {
                  const remaining = wip.qty - qtyA - defA - qtyB - defB;
                  if (remaining !== 0)
                    return (
                      <div
                        className={`text-xs font-bold mb-2 ${
                          remaining < 0 ? "text-red-500" : "text-orange-500"
                        }`}
                      >
                        수량 합계 불일치 (
                        {remaining > 0
                          ? `${remaining}개 미배정`
                          : `${Math.abs(remaining)}개 초과`}
                        )
                      </div>
                    );
                  return null;
                })()}

                <button
                  onClick={() => moveNext(wip.id)}
                  className="w-full md:w-1/2 bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 shadow-md flex items-center justify-center transition-transform hover:scale-105"
                >
                  <CheckCircle2 className="w-5 h-5 mr-2" /> 2차 성형 데이터 저장
                  및 열처리 이관
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ==========================================
// Step 5: Heat Treatment (수축률 3회 기본+추가 복구 및 레이아웃 최적화)
// ==========================================
function Step5HeatTreatment({ wipList, furnaces, ctx }) {
  const pendingWip = wipList.filter((w) => w.currentStep === "step5");
  const [tempSelection, setTempSelection] = useState({});
  const [tempQty, setTempQty] = useState({});

  const getRemainingQty = (wipId) => {
    const w = wipList.find((i) => i.id === wipId);
    if (!w) return 0;
    let used = 0;
    [1, 2, 3, 4].forEach((fid) => {
      const f = furnaces[fid];
      if (f && !f.isHeating && f.cartItems)
        f.cartItems.forEach((c) => {
          if (c.originalWipId === wipId) used += c.qty;
        });
    });
    return w.qty - used;
  };

  const handleAddCart = async (fid) => {
    const wipId = tempSelection[fid];
    const addQty = Number(tempQty[fid]);
    if (!wipId || !addQty || addQty <= 0)
      return ctx.showToast("제품과 수량을 확인하세요.");
    if (addQty > getRemainingQty(wipId))
      return ctx.showToast("잔여 수량을 초과했습니다.", "error");

    const w = wipList.find((i) => i.id === wipId);
    const newItem = {
      cartId: Date.now().toString(),
      originalWipId: wipId,
      mixLot: w.mixLot,
      type: w.type,
      height: w.height,
      qty: addQty,
    };

    const newFurnaces = {
      ...furnaces,
      [fid]: {
        ...furnaces[fid],
        cartItems: [...(furnaces[fid].cartItems || []), newItem],
      },
    };
    try {
      await setDoc(getDocRef("equipment", "furnaces"), newFurnaces);
      setTempSelection({ ...tempSelection, [fid]: "" });
      setTempQty({ ...tempQty, [fid]: "" });
    } catch (e) {}
  };

  const handleRemoveCart = async (fid, cartId) => {
    const newFurnaces = {
      ...furnaces,
      [fid]: {
        ...furnaces[fid],
        cartItems: furnaces[fid].cartItems.filter((c) => c.cartId !== cartId),
      },
    };
    await setDoc(getDocRef("equipment", "furnaces"), newFurnaces);
  };

  const handleInputChange = async (fid, field, val) => {
    const newFurnaces = {
      ...furnaces,
      [fid]: { ...furnaces[fid], [field]: val },
    };
    await setDoc(getDocRef("equipment", "furnaces"), newFurnaces);
  };

  const handleCompletionData = async (fid, targetId, field, val) => {
    const newFurnaces = {
      ...furnaces,
      [fid]: {
        ...furnaces[fid],
        completionData: {
          ...furnaces[fid].completionData,
          [targetId]: {
            ...(furnaces[fid].completionData[targetId] || {}),
            [field]: val,
          },
        },
      },
    };
    await setDoc(getDocRef("equipment", "furnaces"), newFurnaces);
  };

  // 🌟 수축률 3개 기본 배열로 수정
  const updateShrinkage = (fid, targetId, index, value) => {
    const current = furnaces[fid].completionData[targetId]?.shrinkages || [
      "",
      "",
      "",
    ];
    const newArr = [...current];
    newArr[index] = value;
    handleCompletionData(fid, targetId, "shrinkages", newArr);
  };
  const addShrinkage = (fid, targetId) => {
    const current = furnaces[fid].completionData[targetId]?.shrinkages || [
      "",
      "",
      "",
    ];
    if (current.length < 8)
      handleCompletionData(fid, targetId, "shrinkages", [...current, ""]);
  };

  const updateSplit = (fid, targetId, index, field, value) => {
    const current = furnaces[fid].completionData[targetId]?.splits || [
      { qty: "", shrink: "" },
      { qty: "", shrink: "" },
    ];
    const newArr = [...current];
    newArr[index] = { ...newArr[index], [field]: value };
    handleCompletionData(fid, targetId, "splits", newArr);
  };
  const addSplit = (fid, targetId) => {
    const current = furnaces[fid].completionData[targetId]?.splits || [
      { qty: "", shrink: "" },
      { qty: "", shrink: "" },
    ];
    handleCompletionData(fid, targetId, "splits", [
      ...current,
      { qty: "", shrink: "" },
    ]);
  };

  // 🌟 [수정] 작업자 검증 로직 강화
  const startHeating = async (fid) => {
    const f = furnaces[fid];
    if (!f.cartItems || f.cartItems.length === 0)
      return ctx.showToast("열처리할 로트를 먼저 추가해주세요.", "error");

    // 이 부분이 핵심입니다: operator가 없거나 공백만 있으면 튕겨냅니다.
    if (!f.operator || f.operator.trim() === "")
      return ctx.showToast(
        "가동 전 담당 작업자 성명을 반드시 입력해주세요.",
        "error"
      );

    const heatingWipIds = [];
    const wipsToUpdate = [];
    const wipsToAdd = [];
    f.cartItems.forEach((c) => {
      const orig = wipList.find((w) => w.id === c.originalWipId);
      if (orig) {
        if (orig.qty === c.qty) {
          wipsToUpdate.push({ ...orig, currentStep: "step5_heating" });
          heatingWipIds.push(orig.id);
        } else {
          wipsToUpdate.push({ ...orig, qty: orig.qty - c.qty });
          const newId =
            Date.now().toString() + Math.floor(Math.random() * 1000);
          wipsToAdd.push({
            ...orig,
            id: newId,
            mixLot: `${orig.mixLot}-F${fid}`,
            qty: c.qty,
            currentStep: "step5_heating",
          });
          heatingWipIds.push(newId);
        }
      }
    });

    try {
      for (let w of wipsToUpdate) await setDoc(getDocRef("wipList", w.id), w);
      for (let w of wipsToAdd) await setDoc(getDocRef("wipList", w.id), w);
      await setDoc(getDocRef("equipment", "furnaces"), {
        ...furnaces,
        [fid]: { ...f, isHeating: true, heatingWipIds },
      });
      ctx.showToast(`${fid}호기 가동 시작`, "success");
    } catch (err) {
      ctx.showToast("오류 발생", "error");
    }
  };

  // 🌟 [수정본] 열처리 완료 (시간 기록 추가)
  const completeHeating = async (fid) => {
    const f = furnaces[fid];
    const newWips = [];
    const wipsToDelete = [...(f.heatingWipIds || [])];
    const curTime = getKST(); // 🌟 현재 시간 생성

    for (let targetId of f.heatingWipIds || []) {
      const w = wipList.find((i) => i.id === targetId);
      if (!w) continue;
      const cData = f.completionData[targetId] || {};
      const def = parseInt(cData.defects) || 0;
      const remainQty = w.qty - def;

      const shrinkages = cData.shrinkages || [];
      const validShrinks = shrinkages
        .map(Number)
        .filter((n) => !isNaN(n) && n > 0);
      const diff =
        validShrinks.length > 0
          ? Math.max(...validShrinks) - Math.min(...validShrinks)
          : 0;

      const dAvg =
        cData.d1 && cData.d2 && cData.d3
          ? (
              (Number(cData.d1) + Number(cData.d2) + Number(cData.d3)) /
              3
            ).toFixed(2)
          : "0.00";
      const hAvg =
        cData.h1 && cData.h2 && cData.h3
          ? (
              (Number(cData.h1) + Number(cData.h2) + Number(cData.h3)) /
              3
            ).toFixed(2)
          : "0.00";

      if (diff > 0.3) {
        const splits = cData.splits || [];
        const splitSum = splits.reduce(
          (sum, sp) => sum + (parseInt(sp.qty) || 0),
          0
        );
        if (splitSum !== remainQty)
          return ctx.showToast(
            `[${w.mixLot}] 분할 수량 합(${splitSum}) 오류.`,
            "error"
          );

        splits.forEach((sp, idx) => {
          if (parseInt(sp.qty) > 0)
            newWips.push({
              ...w,
              id: Date.now().toString() + Math.random(),
              mixLot: `${w.mixLot}-H${idx + 1}`,
              qty: parseInt(sp.qty),
              currentStep: "step6",
              shrinkageRate: sp.shrink,
              // 🌟 시간 기록 추가
              details: `${
                w.details || ""
              }\n[${curTime}] [열처리] 직경:${dAvg} | 높이:${hAvg} | 수축률:${
                sp.shrink
              }% 분할 (담당:${f.operator})`,
            });
        });
      } else {
        const avgS =
          validShrinks.length > 0
            ? (
                validShrinks.reduce((a, b) => a + b, 0) / validShrinks.length
              ).toFixed(4)
            : "0.0000";
        newWips.push({
          ...w,
          id: Date.now().toString() + Math.random(),
          qty: remainQty,
          currentStep: "step6",
          shrinkageRate: avgS,
          // 🌟 시간 기록 추가
          details: `${
            w.details || ""
          }\n[${curTime}] [열처리] 직경:${dAvg} | 높이:${hAvg} | 평균수축률:${avgS} | 담당:${
            f.operator
          }`,
       });
  }

// 🌟 시트 기록 추가 (열처리 온도 및 수축률 전용 칸 기록 - 수축률 계산 보강)
          const displayShrink = diff > 0.3 ? "편차분할" : (validShrinks.length > 0 ? (validShrinks.reduce((a, b) => a + b, 0) / validShrinks.length).toFixed(4) : "-");
          
          logProcessToGoogleSheet("step5", { ...w, qty: remainQty }, f.operator, {
            defects: def,
            defectReason: cData.reason || "-",
            equipment: `${fid}호기`,
            conditions: `온도:${f.temp}°C`,
            measurements: `평균수축률:${displayShrink}%`,
            details: cData.specialNote || "-"
          });
        } // for문 종료 괄호 

try {
  for (let id of wipsToDelete) await deleteDoc(getDocRef("wipList", id));
      for (let w of newWips) await setDoc(getDocRef("wipList", w.id), w);
      await setDoc(getDocRef("equipment", "furnaces"), {
        ...furnaces,
        [fid]: {
          cartItems: [],
          temp: "1060",
          isHeating: false,
          operator: "",
          completionData: {},
          heatingWipIds: [],
        },
      });
      ctx.showToast("열처리 완료", "success");
    } catch (err) {
      ctx.showToast("오류 발생", "error");
    }
  };

  return (
    <div className="bg-slate-50 border rounded-xl p-4 shadow-sm min-h-screen">
      <h3 className="text-xl font-black mb-4">
        <Thermometer className="w-6 h-6 mr-2 inline text-orange-500" /> 열처리
        공정
      </h3>
      <div className="flex flex-col xl:flex-row gap-4">
        {/* 왼쪽: 대기열 */}
        <div className="xl:w-1/5 bg-white rounded-xl shadow border overflow-hidden">
          <div className="bg-slate-800 text-white px-4 py-2 text-sm font-bold">
            열처리 대기열
          </div>
          <div className="p-3 space-y-2 overflow-y-auto max-h-[600px]">
            {pendingWip.length === 0 && (
              <div className="text-center text-slate-400 py-10 text-xs">
                대기 물량 없음
              </div>
            )}
            {pendingWip.map((wip) => {
              const r = getRemainingQty(wip.id);
              if (r <= 0) return null;
              return (
                <div key={wip.id} className="p-2 border-b last:border-0">
                  <div className="text-[10px] text-slate-400 font-mono">
                    {wip.mixLot}
                  </div>
                  <div className="text-xs font-black">
                    {wip.type} {wip.height}T{" "}
                    <span className="text-blue-600">({r}개)</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 오른쪽: 전기로 리스트 (2x2 배치) */}
        <div className="xl:w-4/5 grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((id) => {
            const isAvailable = id === 1 || id === 2;
            const fData = furnaces[id] || { cartItems: [], isHeating: false };
            const isH = fData.isHeating;
            const items = isH
              ? fData.heatingWipIds
                  ?.map((wid) => wipList.find((w) => w.id === wid))
                  .filter(Boolean) || []
              : fData.cartItems || [];

            return (
              <div
                key={id}
                className={`flex flex-col border-2 rounded-2xl overflow-hidden shadow-sm transition-all ${
                  !isAvailable
                    ? "bg-slate-100 opacity-50"
                    : isH
                    ? "border-orange-400 bg-orange-50/30"
                    : "border-slate-200 bg-white"
                }`}
              >
                <div
                  className={`py-2 text-center text-white font-black text-sm ${
                    !isAvailable
                      ? "bg-slate-400"
                      : isH
                      ? "bg-orange-600"
                      : "bg-slate-700"
                  }`}
                >
                  {id}호기 {isH && "(가동중)"}
                </div>

                <div className="p-3 flex-1 flex flex-col">
                  {/* 중앙 아이콘 영역 높이 축소 */}
                  <div className="flex flex-col items-center mb-3">
                    <div
                      className={`w-12 h-16 rounded-t-full border-2 flex items-center justify-center ${
                        isH
                          ? "bg-orange-500 animate-pulse border-orange-700"
                          : "bg-slate-100 border-slate-300"
                      }`}
                    >
                      <Flame
                        className={`w-6 h-6 ${
                          isH ? "text-yellow-200" : "text-slate-300"
                        }`}
                      />
                    </div>
                    {isAvailable && (
                      <div className="font-black text-sm mt-1">
                        {fData.temp}°C
                      </div>
                    )}
                  </div>

                  {isAvailable ? (
                    isH ? (
                      <div className="flex flex-col flex-1">
                        <div className="flex-1 overflow-y-auto max-h-[400px] space-y-2 mb-3 pr-1">
                          {items.map((w) => {
                            const cData = fData.completionData?.[w.id] || {};
                            const shrinks = cData.shrinkages || ["", "", ""]; // 🌟 기본 3개
                            const vShrinks = shrinks
                              .map(Number)
                              .filter((n) => !isNaN(n) && n > 0);
                            const needsSplit =
                              vShrinks.length > 0 &&
                              Math.max(...vShrinks) - Math.min(...vShrinks) >
                                0.3;
                            const splits = cData.splits || [
                              { qty: "", shrink: "" },
                              { qty: "", shrink: "" },
                            ];

                            return (
                              <div
                                key={w.id}
                                className={`p-2 bg-white border-2 rounded-lg text-xs shadow-sm ${
                                  needsSplit
                                    ? "border-red-300"
                                    : "border-slate-200"
                                }`}
                              >
                                {/* 🌟 제품 색상과 높이가 보이도록 UI 개선 */}
                                <div className="font-bold border-b pb-1 mb-1 flex justify-between items-start text-slate-700">
                                  <div className="flex flex-col">
                                    <span>{w.mixLot}</span>
                                    <span className="text-[10px] font-black text-indigo-500 mt-0.5">
                                      {w.type} {w.height}T
                                    </span>
                                  </div>
                                  <span className="text-blue-600 mt-0.5">
                                    {w.qty}개
                                  </span>
                                </div>

                                {/* 3회 치수 측정 (직경/높이) */}
                                <div className="grid grid-cols-2 gap-2 mb-2">
                                  <div>
                                    <div className="text-[9px] font-bold text-slate-500 mb-0.5">
                                      직경(3회)
                                    </div>
                                    <div className="flex gap-1">
                                      <SyncInput
                                        type="text"
                                        placeholder="1"
                                        value={cData.d1 || ""}
                                        onChange={(v) =>
                                          handleCompletionData(
                                            id,
                                            w.id,
                                            "d1",
                                            v
                                          )
                                        }
                                        className="w-full border rounded text-[10px] p-1 text-center"
                                      />
                                      <SyncInput
                                        type="text"
                                        placeholder="2"
                                        value={cData.d2 || ""}
                                        onChange={(v) =>
                                          handleCompletionData(
                                            id,
                                            w.id,
                                            "d2",
                                            v
                                          )
                                        }
                                        className="w-full border rounded text-[10px] p-1 text-center"
                                      />
                                      <SyncInput
                                        type="text"
                                        placeholder="3"
                                        value={cData.d3 || ""}
                                        onChange={(v) =>
                                          handleCompletionData(
                                            id,
                                            w.id,
                                            "d3",
                                            v
                                          )
                                        }
                                        className="w-full border rounded text-[10px] p-1 text-center"
                                      />
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-[9px] font-bold text-slate-500 mb-0.5">
                                      높이(3회)
                                    </div>
                                    <div className="flex gap-1">
                                      <SyncInput
                                        type="text"
                                        placeholder="1"
                                        value={cData.h1 || ""}
                                        onChange={(v) =>
                                          handleCompletionData(
                                            id,
                                            w.id,
                                            "h1",
                                            v
                                          )
                                        }
                                        className="w-full border rounded text-[10px] p-1 text-center"
                                      />
                                      <SyncInput
                                        type="text"
                                        placeholder="2"
                                        value={cData.h2 || ""}
                                        onChange={(v) =>
                                          handleCompletionData(
                                            id,
                                            w.id,
                                            "h2",
                                            v
                                          )
                                        }
                                        className="w-full border rounded text-[10px] p-1 text-center"
                                      />
                                      <SyncInput
                                        type="text"
                                        placeholder="3"
                                        value={cData.h3 || ""}
                                        onChange={(v) =>
                                          handleCompletionData(
                                            id,
                                            w.id,
                                            "h3",
                                            v
                                          )
                                        }
                                        className="w-full border rounded text-[10px] p-1 text-center"
                                      />
                                    </div>
                                  </div>
                                </div>

                                {/* 🌟 수축률 3~8개 개별 측정 영역 복구 🌟 */}
                                <div className="bg-slate-50 p-2 rounded border border-slate-100 mb-2">
                                  <div className="flex justify-between items-center text-[9px] font-bold text-slate-500 mb-1.5">
                                    <span>수축률(S.F) 3~8개 측정</span>
                                    {needsSplit && (
                                      <span className="text-red-500">
                                        최대편차:{" "}
                                        {(
                                          Math.max(...vShrinks) -
                                          Math.min(...vShrinks)
                                        ).toFixed(2)}
                                        % (분할요망)
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {shrinks.map((s, i) => (
                                      <SyncInput
                                        key={i}
                                        type="text"
                                        inputMode="decimal"
                                        value={s}
                                        onChange={(val) =>
                                          updateShrinkage(id, w.id, i, val)
                                        }
                                        className="w-10 border border-blue-200 rounded p-1 text-[10px] text-center font-bold outline-none focus:border-blue-500 text-blue-700"
                                      />
                                    ))}
                                    {shrinks.length < 8 && (
                                      <button
                                        onClick={() => addShrinkage(id, w.id)}
                                        className="w-8 border border-dashed border-slate-300 rounded bg-white text-slate-400 font-black shadow-sm text-[10px] hover:bg-slate-100 flex items-center justify-center"
                                      >
                                        +
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {/* 🌟 불량 및 메모 입력 (틀어짐 방지 2줄 레이아웃) */}
                                <div className="flex flex-col gap-1.5 mb-2">
                                  <div className="flex gap-1 w-full">
                                    <SyncInput
                                      type="number"
                                      placeholder="불량수량"
                                      value={cData.defects || ""}
                                      onChange={(v) =>
                                        handleCompletionData(
                                          id,
                                          w.id,
                                          "defects",
                                          v
                                        )
                                      }
                                      className="w-16 border border-red-200 bg-red-50 rounded text-[10px] p-1.5 text-center text-red-600 font-bold outline-none focus:border-red-400"
                                    />
                                    <SyncInput
                                      type="text"
                                      placeholder="불량 사유"
                                      value={cData.reason || ""}
                                      onChange={(v) =>
                                        handleCompletionData(
                                          id,
                                          w.id,
                                          "reason",
                                          v
                                        )
                                      }
                                      className="flex-1 border border-slate-300 rounded text-[10px] p-1.5 outline-none focus:border-indigo-400"
                                    />
                                  </div>
                                  <SyncInput
                                    type="text"
                                    placeholder="메모(특이사항)"
                                    value={cData.specialNote || ""}
                                    onChange={(v) =>
                                      handleCompletionData(
                                        id,
                                        w.id,
                                        "specialNote",
                                        v
                                      )
                                    }
                                    className="w-full border border-slate-300 rounded text-[10px] p-1.5 outline-none focus:border-indigo-400"
                                  />
                                </div>

                                {/* 🌟 편차 초과 시 로트 분할 영역 복구 🌟 */}
                                {needsSplit && (
                                  <div className="bg-red-50 p-2 rounded mt-1 border border-red-200 space-y-1">
                                    <div className="text-red-600 text-[9px] font-black flex items-center">
                                      <AlertCircle className="w-3 h-3 mr-1" />{" "}
                                      로트분할 (총{" "}
                                      {w.qty - (parseInt(cData.defects) || 0)}개
                                      배분)
                                    </div>
                                    {splits.map((sp, i) => (
                                      <div
                                        key={i}
                                        className="flex gap-1 items-center"
                                      >
                                        <span className="w-5 font-black text-[9px] text-red-500 text-center bg-white border border-red-200 rounded py-1">
                                          H{i + 1}
                                        </span>
                                        <SyncInput
                                          placeholder="수량"
                                          value={sp.qty}
                                          onChange={(val) =>
                                            updateSplit(id, w.id, i, "qty", val)
                                          }
                                          className="w-12 border border-slate-300 rounded p-1 text-[10px] text-center font-bold outline-none"
                                        />
                                        <SyncInput
                                          placeholder="수축률"
                                          value={sp.shrink}
                                          onChange={(val) =>
                                            updateSplit(
                                              id,
                                              w.id,
                                              i,
                                              "shrink",
                                              val
                                            )
                                          }
                                          className="flex-1 border border-slate-300 rounded p-1 text-[10px] text-center font-bold outline-none"
                                        />
                                      </div>
                                    ))}
                                    {splits.length < 4 && (
                                      <button
                                        onClick={() => addSplit(id, w.id)}
                                        className="w-full bg-white text-red-500 border border-red-200 py-1 rounded text-[9px] font-black shadow-sm mt-1 hover:bg-red-100"
                                      >
                                        + 분할 추가
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <button
                          onClick={() => completeHeating(id)}
                          className="w-full bg-slate-800 text-white font-bold py-3 rounded-xl text-xs mt-2 transition-transform active:scale-95"
                        >
                          <CheckCircle2 className="w-4 h-4 inline mr-1" /> 완료
                          및 검수 이관
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col flex-1 space-y-3">
                        <div className="flex gap-1 items-center">
                          <select
                            className="flex-1 border p-2 rounded-lg text-[10px] font-bold outline-none min-w-0 bg-indigo-50/30 text-indigo-700"
                            value={tempSelection[id] || ""}
                            onChange={(e) => {
                              setTempSelection({
                                ...tempSelection,
                                [id]: e.target.value,
                              });
                              setTempQty({
                                ...tempQty,
                                [id]: e.target.value
                                  ? getRemainingQty(e.target.value)
                                  : "",
                              });
                            }}
                          >
                            <option value="">+ 대기열 제품선택</option>
                            {pendingWip.map(
                              (w) =>
                                getRemainingQty(w.id) > 0 && (
                                  <option key={w.id} value={w.id}>
                                    {w.mixLot} [{w.type} {w.height}T] (
                                    {getRemainingQty(w.id)}개)
                                  </option>
                                )
                            )}
                          </select>
                          <input
                            type="number"
                            className="w-12 border p-2 rounded-lg text-[10px] text-center font-bold"
                            value={tempQty[id] || ""}
                            onChange={(e) =>
                              setTempQty({ ...tempQty, [id]: e.target.value })
                            }
                            placeholder="수량"
                          />
                          <button
                            onClick={() => handleAddCart(id)}
                            className="bg-indigo-600 text-white px-3 py-2 rounded-lg font-bold text-[10px] whitespace-nowrap active:scale-95"
                          >
                            추가
                          </button>
                        </div>

                        <div className="border rounded-lg h-24 overflow-y-auto p-1 bg-slate-50 space-y-1">
                          {items.length === 0 && (
                            <div className="text-center text-[10px] text-slate-400 py-6">
                              로트를 추가하세요.
                            </div>
                          )}
                          {items.map((c) => (
                            <div
                              key={c.cartId}
                              className="flex justify-between items-center bg-white border p-1.5 rounded shadow-sm text-[10px]"
                            >
                              <span className="font-bold truncate w-2/3 text-slate-700">
                                {c.mixLot}
                              </span>
                              <span className="font-black text-indigo-600">
                                {c.qty}개{" "}
                                <button
                                  onClick={() => handleRemoveCart(id, c.cartId)}
                                  className="text-slate-300 hover:text-red-500 ml-1"
                                >
                                  ×
                                </button>
                              </span>
                            </div>
                          ))}
                        </div>

                        <div className="grid grid-cols-2 gap-2 mt-auto">
                          <div>
                            <label className="text-[9px] font-bold text-slate-400 block ml-1">
                              가동 온도(°C)
                            </label>
                            <SyncInput
                              type="text"
                              value={fData.temp}
                              onChange={(val) =>
                                handleInputChange(id, "temp", val)
                              }
                              className="w-full border p-1.5 rounded-lg text-center font-black text-orange-600 bg-orange-50 text-xs outline-none"
                            />
                          </div>
                          <div>
                            <label className="text-[9px] font-bold text-slate-400 block ml-1">
                              담당 작업자
                            </label>
                            <SyncInput
                              type="text"
                              placeholder="성명"
                              value={fData.operator || ""}
                              onChange={(val) =>
                                handleInputChange(id, "operator", val)
                              }
                              className="w-full border p-1.5 rounded-lg text-center font-bold text-xs outline-none"
                            />
                          </div>
                        </div>

                        <button
                          onClick={() => startHeating(id)}
                          className="w-full bg-orange-500 text-white py-3 rounded-xl font-black text-xs shadow-md mt-1 transition-transform active:scale-95 flex items-center justify-center"
                        >
                          <Play className="w-4 h-4 mr-1 fill-current" /> 가동
                          시작
                        </button>
                      </div>
                    )
                  ) : (
                    <div className="flex flex-col items-center justify-center h-48 text-slate-300">
                      <Flame className="w-8 h-8 mb-1 opacity-30" />
                      <span className="font-bold text-xs">도입 예정</span>
                    </div>
                  )}
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
// Step 6: Inspection & Machining (UI 개선 및 오류 수정 완료)
// ==========================================
function Step6Inspection({ wipList, ctx }) {
  const pendingWip = wipList.filter((w) => w.currentStep === "step6");
  const [formData, setFormData] = useState({});

  const handleDataChange = (id, field, val) =>
    setFormData((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [field]: val },
    }));

  const moveNext = async (id) => {
    const data = formData[id] || {};
    if (!data.operator)
      return ctx.showToast("작업자 성명을 입력해주세요.", "error");

    const defectQty = parseInt(data.defects) || 0;
    const defectStr =
      defectQty > 0
        ? ` [불량 ${defectQty}개: ${data.defectReason || "사유미상"}]`
        : "";

    try {
      const w = wipList.find((i) => i.id === id);
      await setDoc(getDocRef("wipList", id), {
        ...w,
        qty: Math.max(0, w.qty - defectQty),
        currentStep: "step7",
        details: `${w.details || ""}\n[${getKST()}] [검수] 내경:${
          data.innerDia || 0
        } | 외경:${data.outerDia || 0} | 턱:${data.stepH || 0} | 제품:${
          data.prodH || 0
       } | 담당:${data.operator}${defectStr}`,
  });
  ctx.showToast("검수 완료", "success");

// 🌟 시트 기록 추가 (모든 치수 및 현장 메모 분리 기록)
logProcessToGoogleSheet("step6", { ...w, qty: w.qty - defectQty }, data.operator, {
  defects: defectQty,
  defectReason: data.defectReason || "-",
  measurements: `내경:${data.innerDia}, 외경:${data.outerDia}, 턱:${data.stepH}, 제품:${data.prodH}`,
  details: data.memo || "검수완료"
});
} catch (err) {
      ctx.showToast("오류 발생", "error");
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex justify-between items-center">
        <h3 className="text-lg font-black text-slate-800 flex items-center">
          <Microscope className="w-5 h-5 mr-2 text-indigo-600" /> 검수 및 가공
          현황
        </h3>
        <span className="text-xs font-bold text-slate-500 bg-white px-3 py-1 rounded-full border">
          대기: {pendingWip.length}건
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left border-collapse">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-slate-500 bg-slate-50/50">
              <th className="p-4 font-bold border-b">로트 / 제품명</th>
              <th className="p-4 font-bold border-b">현재수량</th>
              <th className="p-4 font-bold border-b text-center">
                치수 측정 (내/외/턱/높)
              </th>
              <th className="p-4 font-bold border-b">불량 관리</th>
              <th className="p-4 font-bold border-b">담당자</th>
              <th className="p-4 font-bold border-b">메모</th>
              <th className="p-4 font-bold border-b text-center">작업</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pendingWip.length === 0 ? (
              <tr>
                <td
                  colSpan="6"
                  className="text-center py-20 text-slate-400 font-medium"
                >
                  현재 검수 대기 중인 물량이 없습니다.
                </td>
              </tr>
            ) : (
              pendingWip.map((wip) => {
                const data = formData[wip.id] || {};
                return (
                  <tr
                    key={wip.id}
                    className="hover:bg-slate-50/50 transition-colors"
                  >
                    <td className="p-4">
                      <div className="text-[10px] font-mono font-bold text-indigo-600 mb-1">
                        {wip.mixLot}
                      </div>
                      <div className="font-black text-slate-800">
                        {wip.type} {wip.height}T
                      </div>
                    </td>
                    <td className="p-4 font-black text-blue-600 text-lg">
                      {wip.qty}
                    </td>

                    <td className="p-4">
                      <div className="grid grid-cols-2 gap-1.5 w-40 mx-auto">
                        <div className="relative">
                          <span className="absolute left-1 top-0.5 text-[8px] text-slate-400 font-bold">
                            내
                          </span>
                          <input
                            type="text"
                            value={data.innerDia || ""}
                            onChange={(e) =>
                              handleDataChange(
                                wip.id,
                                "innerDia",
                                e.target.value
                              )
                            }
                            className="w-full pl-4 pr-1 py-1 text-[11px] font-bold border rounded bg-white"
                            placeholder="0.0"
                          />
                        </div>
                        <div className="relative">
                          <span className="absolute left-1 top-0.5 text-[8px] text-slate-400 font-bold">
                            외
                          </span>
                          <input
                            type="text"
                            value={data.outerDia || ""}
                            onChange={(e) =>
                              handleDataChange(
                                wip.id,
                                "outerDia",
                                e.target.value
                              )
                            }
                            className="w-full pl-4 pr-1 py-1 text-[11px] font-bold border rounded bg-white"
                            placeholder="0.0"
                          />
                        </div>
                        <div className="relative">
                          <span className="absolute left-1 top-0.5 text-[8px] text-slate-400 font-bold">
                            턱
                          </span>
                          <input
                            type="text"
                            value={data.stepH || ""}
                            onChange={(e) =>
                              handleDataChange(wip.id, "stepH", e.target.value)
                            }
                            className="w-full pl-4 pr-1 py-1 text-[11px] font-bold border rounded bg-white"
                            placeholder="0.0"
                          />
                        </div>
                        <div className="relative">
                          <span className="absolute left-1 top-0.5 text-[8px] text-slate-400 font-bold">
                            높
                          </span>
                          <input
                            type="text"
                            value={data.prodH || ""}
                            onChange={(e) =>
                              handleDataChange(wip.id, "prodH", e.target.value)
                            }
                            className="w-full pl-4 pr-1 py-1 text-[11px] font-bold border rounded bg-white"
                            placeholder="0.0"
                          />
                        </div>
                      </div>
                    </td>

                    <td className="p-4">
                      <div className="flex flex-col gap-1 w-28">
                        <input
                          type="number"
                          onChange={(e) =>
                            handleDataChange(wip.id, "defects", e.target.value)
                          }
                          className="w-full border p-1.5 text-xs rounded text-red-600 font-bold border-red-100"
                          placeholder="불량수"
                        />
                        <input
                          type="text"
                          onChange={(e) =>
                            handleDataChange(
                              wip.id,
                              "defectReason",
                              e.target.value
                            )
                          }
                          className="w-full border p-1.5 text-[10px] rounded"
                          placeholder="사유"
                        />
                      </div>
                    </td>

<td className="p-4">
                      <input
                        type="text"
                        onChange={(e) =>
                          handleDataChange(wip.id, "operator", e.target.value)
                        }
                        className="w-20 border p-1.5 text-xs rounded font-bold focus:border-indigo-400 outline-none"
                        placeholder="성명"
                      />
                    </td>
                    {/* 🌟 여기에 메모 입력칸을 새로 추가합니다! 🌟 */}
                    <td className="p-4">
                      <input
                        type="text"
                        onChange={(e) =>
                          handleDataChange(wip.id, "memo", e.target.value)
                        }
                        className="w-full border p-1.5 text-xs rounded focus:border-indigo-400 outline-none"
                        placeholder="특이사항 입력"
                      />
                    </td>
                    {/* ------------------------------------------- */}
                    <td className="p-4 text-center">
                      <button
                        onClick={() => moveNext(wip.id)}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-xs font-black shadow-sm transition-transform active:scale-95"
                      >
                        완료
                      </button>
                    </td>
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
// Step 7: Drying Room (에러 수정 + 원본 UI + 이력 누적 + 한글 입력 깨짐 방지)
// ==========================================
// 🌟 수정 사항: 파라미터에서 dryingRoom을 받아 room으로 매핑하도록 변경했습니다.
function Step7Drying({ wipList, dryingRoom: room, ctx }) {
  const pendingWip = wipList.filter((w) => w.currentStep === "step7");
  const dryingWip = wipList.filter((w) => w.currentStep === "step7_drying");

  const handleRoomConfig = async (field, val) => {
    try {
      await setDoc(getDocRef("equipment", "dryingRoom"), {
        ...room,
        [field]: val,
      });
    } catch (e) {
      console.error("저장 오류:", e);
    }
  };

  const handleStartDrying = async (wipId) => {
    if (!room?.operator)
      return ctx.showToast("건조실 담당자를 입력하세요.", "error");
    try {
      const w = wipList.find((i) => i.id === wipId);
      await setDoc(getDocRef("wipList", wipId), {
        ...w,
        currentStep: "step7_drying",
      });
      ctx.showToast("건조 시작", "success");
    } catch (e) {
      ctx.showToast("오류 발생", "error");
    }
  };

  const handleCompData = async (id, field, val) => {
    const cData = room?.completionData || {};
    const tData = cData[id] || {};
    try {
      await setDoc(getDocRef("equipment", "dryingRoom"), {
        ...room,
        completionData: { ...cData, [id]: { ...tData, [field]: val } },
      });
    } catch (e) {}
  };

  // 🌟 [수정본] 건조 완료 (시간 기록 추가)
  const handleCompleteItem = async (targetId) => {
    const w = wipList.find((i) => i.id === targetId);
    if (!w) return;

    const cData = room?.completionData?.[targetId] || {};
    const def = parseInt(cData.defects) || 0;
    const remainQty = w.qty - def;

    if (remainQty < 0) return ctx.showToast("불량 오류", "error");

    const defStr =
      def > 0 ? ` [불량 ${def}개: ${cData.reason || "사유미상"}]` : "";
    const memoStr = cData.specialNote ? ` [메모: ${cData.specialNote}]` : "";

    // 🌟 시간 기록 추가
    const recordDetails = `[${getKST()}] [건조] 온도:${
      room?.temp || 60
    }°C | 습도:${room?.humidity || 20}% | 담당:${
      room?.operator || "미상"
    }${defStr}${memoStr}`;

    try {
      await setDoc(getDocRef("wipList", targetId), {
        ...w,
        qty: remainQty,
        currentStep: "step8",
        details: `${w.details || ""}\n${recordDetails}`,
      });

      const newCompData = { ...(room?.completionData || {}) };
      delete newCompData[targetId];
      await setDoc(getDocRef("equipment", "dryingRoom"), {
        ...room,
    completionData: newCompData,
  });

  ctx.showToast("건조 완료 및 포장 이관", "success");

// 🌟 시트 기록 추가 (온도, 습도, 불량 분리 기록)
logProcessToGoogleSheet("step7", { ...w, qty: remainQty }, room?.operator, {
  defects: def,
  defectReason: cData.reason || "-",
  conditions: `온도:${room?.temp || 60}°C, 습도:${room?.humidity || 20}%`,
  details: cData.specialNote || "-"
});
} catch (err) {
      ctx.showToast("오류 발생", "error");
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* 좌측: 건조실 설정 및 대기열 */}
      <div className="bg-white border p-6 rounded-xl shadow-sm">
        <h3 className="font-bold text-lg mb-4 flex items-center">
          <Wind className="w-5 h-5 mr-2 text-cyan-500" /> 건조실 설정 및 대기열
        </h3>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-400 ml-1">
              온도 (°C)
            </label>
            {/* 🌟 기존 input을 SyncInput으로 교체 */}
            <SyncInput
              type="text"
              value={room?.temp || ""}
              onChange={(val) => handleRoomConfig("temp", val)}
              className="border p-2 w-full rounded text-sm font-bold text-red-500 outline-none"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-400 ml-1">
              습도 (%)
            </label>
            {/* 🌟 기존 input을 SyncInput으로 교체 */}
            <SyncInput
              type="text"
              value={room?.humidity || ""}
              onChange={(val) => handleRoomConfig("humidity", val)}
              className="border p-2 w-full rounded text-sm font-bold text-blue-500 outline-none"
            />
          </div>
        </div>

        <div className="space-y-1 mb-6">
          <label className="text-[10px] font-bold text-slate-400 ml-1">
            담당 작업자
          </label>
          {/* 🌟 기존 input을 SyncInput으로 교체 */}
          <SyncInput
            type="text"
            placeholder="성명 입력"
            value={room?.operator || ""}
            onChange={(val) => handleRoomConfig("operator", val)}
            className="border p-2 w-full rounded text-sm font-bold outline-none"
          />
        </div>

        <div className="space-y-2">
          {pendingWip.length === 0 && (
            <div className="text-slate-400 text-sm text-center py-8 border border-dashed rounded-lg">
              대기 중인 물량이 없습니다.
            </div>
          )}
          {pendingWip.map((w) => (
            <div
              key={w.id}
              className="border p-3 rounded-lg flex justify-between items-center bg-slate-50 border-slate-200"
            >
              <div>
                <div className="text-[10px] font-mono font-bold text-indigo-600">
                  {w.mixLot}
                </div>
                <div className="text-sm font-black">
                  {w.type} {w.height}T
                  <span className="text-slate-400 ml-1">({w.qty}개)</span>
                </div>
              </div>
              <button
                onClick={() => handleStartDrying(w.id)}
                className="bg-slate-800 text-white px-4 py-2 text-xs rounded-lg font-bold"
              >
                건조 시작
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 우측: 건조실 내부 */}
      <div className="bg-white border p-6 rounded-xl shadow-sm">
        <h3 className="font-bold text-lg mb-4 flex items-center">
          <Droplets className="w-5 h-5 mr-2 text-blue-500" /> 건조실 내부 (진행
          중)
        </h3>

        <div className="space-y-4">
          {dryingWip.length === 0 && (
            <div className="text-slate-400 text-sm text-center py-16 border border-dashed rounded-lg bg-slate-50">
              현재 건조 중인 물량이 없습니다.
            </div>
          )}
          {dryingWip.map((w) => {
            const cData = room?.completionData?.[w.id] || {};
            return (
              <div
                key={w.id}
                className="border-2 border-cyan-100 p-4 rounded-xl bg-cyan-50/30"
              >
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <div className="text-[10px] font-mono font-bold text-cyan-700">
                      {w.mixLot}
                    </div>
                    <div className="font-black text-slate-800">
                      {w.type} {w.height}T
                      <span className="text-cyan-600 ml-1">({w.qty}개)</span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-2">
                  {/* 🌟 기존 input을 SyncInput으로 교체 */}
                  <SyncInput
                    type="number"
                    placeholder="불량 수량"
                    value={cData.defects || ""}
                    onChange={(val) => handleCompData(w.id, "defects", val)}
                    className="border border-red-200 p-2 text-xs rounded bg-white text-red-600 font-bold"
                  />
                  {/* 🌟 기존 input을 SyncInput으로 교체 */}
                  <SyncInput
                    type="text"
                    placeholder="불량 사유"
                    value={cData.reason || ""}
                    onChange={(val) => handleCompData(w.id, "reason", val)}
                    className="border border-slate-200 p-2 text-xs rounded bg-white"
                  />
                </div>

                <div className="flex gap-2">
                  {/* 🌟 기존 input을 SyncInput으로 교체 */}
                  <SyncInput
                    type="text"
                    placeholder="메모"
                    value={cData.specialNote || ""}
                    onChange={(val) => handleCompData(w.id, "specialNote", val)}
                    className="border border-slate-200 p-2 text-xs flex-1 rounded bg-white"
                  />
                  <button
                    onClick={() => handleCompleteItem(w.id)}
                    className="bg-cyan-600 text-white px-4 py-2 rounded-lg text-xs font-black shadow-md"
                  >
                    건조 완료
                  </button>
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
// Step 8: Packaging (수축률 UI 완벽 반영 버전)
// ==========================================
function Step8Packaging({ wipList, orderList, ctx }) {
  const pendingWip = wipList.filter((w) => w.currentStep === "step8");
  const [formData, setFormData] = useState({});

  const handleDataChange = (id, field, val) =>
    setFormData((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [field]: val },
    }));

  const moveNext = async (wipId) => {
    const data = formData[wipId] || {};
    const wip = wipList.find((w) => w.id === wipId);

    // ✅ 열처리에서 넘어온 수축률 데이터가 있는지 체크
    if (!data.operator || !wip?.shrinkageRate) {
      return ctx.showToast(
        "작업자 성명 입력 혹은 열처리 단계 수축률 데이터가 필요합니다.",
        "error"
      );
    }

    const defectQty = parseInt(data.defects) || 0;
    // 🌟 불량 기록 문자열 생성
    const defectStr =
      defectQty > 0
        ? ` [불량 ${defectQty}개: ${data.defectReason || "사유미상"}]`
        : "";

    try {
      const newLot = `F${getKSTDateOnly().slice(-5)}${wip.id.slice(-2)}`;

      await setDoc(getDocRef("wipList", wip.id), {
        ...wip,
        mixLot: newLot,
        shrinkageRate: wip.shrinkageRate,
        qty: Math.max(0, wip.qty - defectQty),
        currentStep: "done",
        // 🌟 끝에 defectStr 추가
        details: `${wip.details || ""}\n[${getKST()}] [포장완료] 담당: ${
          data.operator
        } [수축률: ${wip.shrinkageRate}]${defectStr}`,
      });

      // 2. 발주 상태 업데이트 (생산완료)
          if (wip.orderId) {
            const targetOrder = (orderList || []).find((o) => o.id === wip.orderId);
            if (targetOrder) {
              await setDoc(getDocRef("orderList", wip.orderId), {
                ...targetOrder,
                status: "생산완료",
              });
            }
          }
          ctx.showToast("포장 및 수축률 기록 완료", "success");

 // 🌟 시트 기록 추가 (수축률 및 불량 분리 기록)
logProcessToGoogleSheet("step8", { ...wip, qty: wip.qty - defectQty }, data.operator, {
  defects: defectQty,
  defectReason: data.defectReason || "-",
  measurements: `S.F:${wip.shrinkageRate}`,
  details: data.specialNote || "-"
});
        } catch (err) {
      console.error(err);
      ctx.showToast("오류 발생", "error");
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
      <h3 className="text-lg font-bold mb-2">포장 및 라벨링</h3>
      <p className="text-sm text-slate-500 mb-6">
        최종 수축률(Scaling Factor)을 입력하고 라벨을 발행합니다.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-y border-slate-200">
            <tr>
              <th className="px-4 py-3">현재 로트</th>
              <th className="px-4 py-3">제품/색상</th>
              <th className="px-4 py-3 text-center">최종수량</th>
              <th className="px-4 py-3 text-blue-600">수축률 (S.F)</th>{" "}
              {/* 🌟 추가된 제목 */}
              <th className="px-4 py-3 text-red-600">불량(수량/사유)</th>
              <th className="px-4 py-3">메모/작업자</th>
              <th className="px-4 py-3 text-center">작업</th>
            </tr>
          </thead>
          <tbody>
            {pendingWip.length === 0 && (
              <tr>
                <td
                  colSpan="7"
                  className="text-center py-10 text-slate-400 font-bold"
                >
                  포장 대기 중인 제품이 없습니다.
                </td>
              </tr>
            )}
            {pendingWip.map((wip) => {
              const data = formData[wip.id] || {};
              return (
                <tr
                  key={wip.id}
                  className="border-b border-slate-100 hover:bg-slate-50 transition-colors"
                >
                  <td className="px-4 py-4">
                    <div className="flex flex-col">
                      {/* 1. 현재 로트 (원로트) - 상단에 작게 표시 */}
                      <span className="text-[10px] text-slate-400 font-bold mb-1 uppercase">
                        원로트: {wip.mixLot}
                      </span>
                      {/* 2. 최종 포장 로트 - 하단에 확대율처럼 크고 명확하게 표시 */}
                      <div className="text-lg font-black text-indigo-700 bg-indigo-50 px-4 py-1.5 rounded-lg border border-indigo-200 shadow-sm w-max tracking-widest">
                        F{getKSTDateOnly().slice(-5)}
                        {wip.id.slice(-2)}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4 font-bold text-slate-800">
                    {wip.type}{" "}
                    <span className="text-indigo-600">{wip.height}T</span>
                  </td>
                  <td className="px-4 py-4 font-black text-indigo-700 text-xl text-center">
                    {wip.qty}
                  </td>

                  {/* 🌟 수축률 입력 칸 추가 */}
                  <td className="px-4 py-4">
                    <div className="flex flex-col items-center">
                      <span className="text-[10px] text-slate-400 font-bold mb-1 uppercase">
                        S.F & Scale Factor
                      </span>
                      <div className="flex flex-col items-center bg-blue-50 px-4 py-1.5 rounded-lg border border-blue-100 shadow-sm min-w-[100px]">
                        {/* 1. 수축률 (%) 표시 */}
                        <div className="text-[10px] font-bold text-slate-500 mb-0.5">
                          수축률:{" "}
                          {wip.shrinkageRate ? `${wip.shrinkageRate}%` : "-"}
                        </div>
                        {/* 2. 확대율(Scale Factor) 자동 계산 표시 */}
                        <div className="text-lg font-black text-blue-700">
                          {(() => {
                            const s = Number(wip.shrinkageRate);
                            if (!isNaN(s) && s > 0 && s < 100) {
                              // 공식: 1 / (1 - (수축률 / 100))
                              return (1 / (1 - s / 100)).toFixed(4);
                            }
                            return "계산 불가";
                          })()}
                        </div>
                      </div>
                    </div>
                  </td>

                  <td className="px-4 py-4 w-40">
                    <div className="flex flex-col space-y-1">
                      <input
                        type="number"
                        placeholder="불량"
                        value={data.defects || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "defects", e.target.value)
                        }
                        className="border border-red-200 rounded p-1.5 text-xs text-center text-red-600 bg-red-50"
                      />
                      <input
                        type="text"
                        placeholder="사유"
                        value={data.defectReason || ""}
                        onChange={(e) =>
                          handleDataChange(
                            wip.id,
                            "defectReason",
                            e.target.value
                          )
                        }
                        className="border rounded p-1.5 text-[10px]"
                      />
                    </div>
                  </td>

                  <td className="px-4 py-4 w-40">
                    <div className="flex flex-col space-y-1">
                      <input
                        type="text"
                        placeholder="메모"
                        value={data.specialNote || ""}
                        onChange={(e) =>
                          handleDataChange(
                            wip.id,
                            "specialNote",
                            e.target.value
                          )
                        }
                        className="border rounded p-1.5 text-[10px]"
                      />
                      <input
                        type="text"
                        placeholder="작업자"
                        value={data.operator || ""}
                        onChange={(e) =>
                          handleDataChange(wip.id, "operator", e.target.value)
                        }
                        className="border rounded p-1.5 text-xs text-center font-bold focus:border-indigo-400"
                      />
                    </div>
                  </td>

                  <td className="px-4 py-4">
                    <div className="flex flex-col space-y-2">
                      <button className="text-[10px] bg-slate-100 text-slate-600 px-2 py-1.5 rounded font-bold hover:bg-slate-200 flex items-center justify-center">
                        <Printer className="w-3 h-3 mr-1" /> 라벨출력
                      </button>
                      <button
                        onClick={() => moveNext(wip.id)}
                        className="text-[10px] bg-indigo-600 text-white px-2 py-1.5 rounded font-bold hover:bg-indigo-700 flex items-center justify-center shadow-sm"
                      >
                        <CheckCircle2 className="w-3 h-3 mr-1" /> 포장완료
                      </button>
                    </div>
                  </td>
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
// Step 9: Finished Goods (출고처 드롭다운 및 직접입력 추가 + 이력 보존 수정)
// ==========================================
function Step9FinishedGoods({ wipList, shippingHistory, orderList, ctx }) {
  const finishedWip = wipList.filter((w) => w.currentStep === "done");
  const [shipData, setShipData] = useState({});

  const handleShip = async (wip) => {
    const d = shipData[wip.id] || {};
    const safeQty = parseInt(d.qty);

    if (isNaN(safeQty) || safeQty <= 0)
      return ctx.showToast("출고 수량을 올바른 숫자로 입력해주세요.", "error");
    if (!d.destination || !d.operator)
      return ctx.showToast("출고처와 담당자를 모두 입력해주세요.", "error");

    ctx.showConfirm("출고 처리하시겠습니까?", async () => {
      try {
        const hid = Date.now().toString();

        // 1. 출고 이력 저장
        await setDoc(getDocRef("shippingHistory", hid), {
          id: hid,
          orderId: wip.orderId || "", // 이력에도 발주 ID 남기기
          lot: wip.mixLot,
          type: wip.type,
          height: wip.height,
          weight: wip.weight || "", // 🌟 추가: 원료 투입량(혼합량) 데이터 출고 이력으로 복사 보존
          qty: safeQty,
          destination: d.destination,
          operator: d.operator,
          date: getKST().slice(0, 16),
          details: wip.details || "", // 🌟 핵심 수정: 그동안 쌓인 공정 이력(details)을 출고 데이터에도 복사해서 보존합니다!
          createdAt: serverTimestamp(), // 🌟 추가됨: 조작 불가능한 서버 시간 강제 기록
        });

        // 2. 발주 상태를 '출고완료'로 최종 변경
        if (wip.orderId) {
          const targetOrder = (orderList || []).find(
            (o) => o.id === wip.orderId
          );
          if (targetOrder) {
            await setDoc(getDocRef("orderList", wip.orderId), {
              ...targetOrder,
              status: "출고완료",
            });
          }
        }

        // 3. 재고 수량 차감 (전량 출고 시 데이터 삭제)
        if (Number(wip.qty) - safeQty <= 0) {
          await deleteDoc(getDocRef("wipList", wip.id));
        } else {
          await setDoc(getDocRef("wipList", wip.id), {
            ...wip,
            qty: wip.qty - safeQty,
          });
       }

    ctx.showToast("출고 및 출고완료 처리됨", "success");

// 🌟 시트 기록 추가 (출고처 정보를 [장비] 칸에 기록)
logProcessToGoogleSheet("step9", { ...wip, qty: safeQty }, d.operator, {
  equipment: d.destination,
  details: wip.details ? "이력포함출고" : "일반출고"
});
  } catch (e) {
        ctx.showToast("출고 중 오류가 발생했습니다.", "error");
      }
    });
  };

  const inventorySummary = finishedWip.reduce((acc, curr) => {
    const k = `${curr.type}_${curr.height}`;
    if (!acc[k]) acc[k] = { type: curr.type, height: curr.height, qty: 0 };
    acc[k].qty += curr.qty;
    return acc;
  }, {});

  return (
    <div className="bg-white rounded-xl border p-6 space-y-6">
      <h3 className="text-lg font-bold flex items-center">
        <Archive className="w-5 h-5 mr-2 text-indigo-500" /> 완제품 현재고 요약
      </h3>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        {Object.values(inventorySummary).map((i) => (
          <div
            key={`${i.type}_${i.height}`}
            className="bg-white p-4 rounded-xl shadow border text-center"
          >
            <div className="text-sm font-bold text-slate-500 mb-1">
              {i.type} <span className="text-indigo-600">{i.height}T</span>
            </div>
            <div className="text-2xl font-black">{i.qty} EA</div>
          </div>
        ))}
        {Object.keys(inventorySummary).length === 0 && (
          <div className="col-span-full text-center text-slate-400 py-6 bg-white rounded border border-dashed">
            재고 없음
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border p-6">
        <h3 className="text-lg font-bold mb-4">로트별 출고 처리</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="bg-slate-50 border-b text-xs text-slate-500">
              <tr>
                <th className="p-3">포장 LOT</th>
                <th className="p-3">제품/색상</th>
                <th className="p-3">현재고</th>
                <th className="p-3 w-28">출고 수량</th>
                <th className="p-3 w-48">출고처</th>
                <th className="p-3 w-32">담당자</th>
                <th className="p-3 text-center">작업</th>
              </tr>
            </thead>
            <tbody>
              {finishedWip.length === 0 && (
                <tr>
                  <td colSpan="7" className="text-center py-6 text-slate-400">
                    대기 물량 없음
                  </td>
                </tr>
              )}
              {finishedWip.map((w) => {
                const d = shipData[w.id] || {};
                return (
                  <tr key={w.id} className="border-b hover:bg-slate-50">
                    <td className="p-3 font-bold text-slate-700">{w.mixLot}</td>
                    <td className="p-3 font-bold">
                      {w.type} {w.height}T
                    </td>
                    <td className="p-3 font-black text-indigo-600 text-lg">
                      {w.qty}
                    </td>
                    <td className="p-3">
                      <input
                        type="number"
                        max={w.qty}
                        min="1"
                        placeholder="수량"
                        value={d.qty || ""}
                        onChange={(e) =>
                          setShipData({
                            ...shipData,
                            [w.id]: { ...d, qty: e.target.value },
                          })
                        }
                        className="w-full border p-2 rounded text-center font-bold focus:border-indigo-400 outline-none"
                      />
                    </td>
                    <td className="p-3">
                      <div className="flex flex-col gap-2">
                        <select
                          value={d.destSelect || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setShipData({
                              ...shipData,
                              [w.id]: {
                                ...d,
                                destSelect: val,
                                destination: val === "직접입력" ? "" : val,
                              },
                            });
                          }}
                          className="w-full border p-2 rounded text-sm font-bold text-slate-700 focus:border-indigo-400 outline-none"
                        >
                          <option value="">출고처 선택</option>
                          <option value="이엔씨">이엔씨</option>
                          <option value="직접입력">직접입력...</option>
                        </select>
                        {d.destSelect === "직접입력" && (
                          <input
                            type="text"
                            placeholder="거래처 직접 입력"
                            value={d.destination || ""}
                            onChange={(e) =>
                              setShipData({
                                ...shipData,
                                [w.id]: { ...d, destination: e.target.value },
                              })
                            }
                            className="w-full border border-indigo-300 bg-indigo-50 p-2 rounded text-sm focus:border-indigo-500 outline-none"
                          />
                        )}
                      </div>
                    </td>
                    <td className="p-3">
                      <input
                        type="text"
                        placeholder="담당자"
                        value={d.operator || ""}
                        onChange={(e) =>
                          setShipData({
                            ...shipData,
                            [w.id]: { ...d, operator: e.target.value },
                          })
                        }
                        className="w-full border p-2 rounded text-center font-bold focus:border-indigo-400 outline-none"
                      />
                    </td>
                    <td className="p-3 text-center">
                      <button
                        onClick={() => handleShip(w)}
                        className="bg-indigo-600 text-white px-4 py-2.5 rounded-lg font-bold shadow-md hover:bg-indigo-700 flex items-center justify-center transition-transform hover:scale-105 w-full"
                      >
                        <Truck className="w-4 h-4 mr-1.5" /> 출고
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border p-6">
        <h3 className="text-lg font-bold mb-4 flex items-center">
          <History className="w-5 h-5 mr-2 text-slate-500" /> 완제품 출고 이력
        </h3>
        <div className="overflow-x-auto max-h-60 border rounded-lg">
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 sticky top-0 text-xs text-slate-500">
              <tr>
                <th className="p-3">출고일시</th>
                <th className="p-3">포장 LOT</th>
                <th className="p-3">제품</th>
                <th className="p-3 text-right pr-6">출고수량</th>
                <th className="p-3">출고처</th>
                <th className="p-3">담당자</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shippingHistory.map((h) => (
                <tr key={h.id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-3 text-xs text-slate-500">{h.date}</td>
                  <td className="p-3 font-mono font-bold text-slate-700">
                    {h.lot}
                  </td>
                  <td className="p-3 font-bold text-slate-800">
                    {h.type}{" "}
                    <span className="text-indigo-600">{h.height}T</span>
                  </td>
                  <td className="p-3 font-black text-indigo-600 text-right pr-6">
                    {h.qty} EA
                  </td>
                  <td className="p-3 font-bold text-slate-700">
                    {h.destination}
                  </td>
                  <td className="p-3 font-bold text-slate-600">{h.operator}</td>
                </tr>
              ))}
              {shippingHistory.length === 0 && (
                <tr>
                  <td colSpan="6" className="text-center py-6 text-slate-400">
                    출고 이력이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// 추적 화면: Lot Genealogy Tracking (Master Mode & 타임라인 & 초강력 검색)
// ==========================================
function StepTracking({
  wipList,
  shippingHistory,
  inventoryHistory,
  orderList,
  ctx,
}) {
  const [searchLot, setSearchLot] = useState("");
  const [results, setResults] = useState([]);
  const [hasSearched, setHasSearched] = useState(false);

  const [editingId, setEditingId] = useState(null);
  const [editData, setEditData] = useState({});

  const handleSearch = () => {
    if (!searchLot) return;
    setHasSearched(true);

    // 1. 검색어를 띄어쓰기 기준으로 나눕니다
    const searchTerms = searchLot.trim().toUpperCase().split(/\s+/);

    // 2. 해당 데이터가 모든 검색어를 포함하는지 확인하는 마법의 함수
    const isMatch = (item, isShipped) => {
      // 🌟 오류 수정: 출고된 제품(isShipped)도 details(공정 이력)를 검색할 수 있도록 추가
      const searchableText = isShipped
        ? `${item.lot || ""} ${item.originalLot || ""} ${item.type || ""} ${
            item.height || ""
          }T ${item.destination || ""} ${item.operator || ""} ${
            item.details || ""
          }`.toUpperCase()
        : `${item.mixLot || ""} ${item.originalLot || ""} ${item.type || ""} ${
            item.height || ""
          }T ${item.details || ""}`.toUpperCase();

      return searchTerms.every((term) => searchableText.includes(term));
    };

    // 3. 출고 내역과 진행 중인 내역에서 각각 뒤져서 가져옵니다.
    const shippedMatches = shippingHistory.filter((h) => isMatch(h, true));
    const wipMatches = wipList.filter((w) => isMatch(w, false));

    const combined = [
      ...shippedMatches.map((data) => ({
        type: "shipped",
        data,
        collection: "shippingHistory",
      })),
      ...wipMatches.map((data) => ({
        type: "wip",
        data,
        collection: "wipList",
      })),
    ];

    setResults(combined);
    setEditingId(null);

    // 🌟 사용자 피드백 추가 (오류 아님, 편의성)
    if (combined.length === 0 && ctx) {
      ctx.showToast("검색 결과가 없습니다.", "error");
    } else if (ctx) {
      ctx.showToast(`${combined.length}건의 이력을 찾았습니다.`, "success");
    }
  };

  const startEdit = (res) => {
    setEditData({ ...res.data });
    setEditingId(res.data.id);
  };

  const handleSaveEdit = async (res) => {
    try {
      await setDoc(getDocRef(res.collection, res.data.id), editData);
      if (ctx) ctx.showToast("마스터 권한으로 수정되었습니다.", "success");

      setResults(
        results.map((r) =>
          r.data.id === res.data.id ? { ...r, data: editData } : r
        )
      );
      setEditingId(null);
    } catch (error) {
      if (ctx) ctx.showToast("수정 실패", "error");
    }
  };

  const handleDelete = (res) => {
    const targetLot = res.data.mixLot || res.data.lot;
    if (ctx && ctx.showConfirm) {
      ctx.showConfirm(
        `[마스터 권한] 정말로 로트(${targetLot}) 데이터를 영구 삭제하시겠습니까?`,
        async () => {
          try {
            await deleteDoc(getDocRef(res.collection, res.data.id));
            ctx.showToast(`로트(${targetLot}) 영구 삭제 완료`, "success");
            setResults(results.filter((r) => r.data.id !== res.data.id));
          } catch (error) {
            ctx.showToast("삭제 실패", "error");
          }
        }
      );
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-100">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-2xl font-black flex items-center text-slate-800">
            <Search className="w-6 h-6 mr-2 text-indigo-600" /> 로트 공정 이력
            통합 검색
          </h3>
          <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full text-xs font-black border border-red-200 animate-pulse">
            Master Mode
          </span>
        </div>

        <div className="flex gap-3 mb-8">
          <input
            type="text"
            placeholder="검색어 입력 (예: BL3 30T, 이엔씨, 담당자명, 또는 로트번호 일부)"
            className="flex-1 border-2 border-slate-300 rounded-xl p-4 font-bold text-lg focus:border-indigo-500 outline-none placeholder:text-sm"
            value={searchLot}
            onChange={(e) => {
              setSearchLot(e.target.value);
              setHasSearched(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
          <button
            onClick={handleSearch}
            className="bg-indigo-600 text-white px-8 py-4 rounded-xl font-black text-lg shadow-md hover:bg-indigo-700 flex items-center transition-transform hover:scale-105"
          >
            <Search className="w-5 h-5 mr-2" /> 통합 검색
          </button>
        </div>

        {hasSearched && results.length === 0 && (
          <div className="text-center py-16 bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200 text-slate-500 font-bold text-lg">
            일치하는 기록이 없습니다. 검색어를 바꿔보세요.
          </div>
        )}

        {/* 검색 결과가 여러 개일 경우 스크롤이 가능하도록 감싸줍니다. */}
        <div className="space-y-6 max-h-[800px] overflow-y-auto pr-2">
          {results.map((result, idx) => {
            const isEditing = editingId === result.data.id;

            // 🌟 오류 수정: details가 없을 경우 빈 문자열로 안전하게 처리하여 프로그램 멈춤 방지
            let historyLogs = (result.data.details || "")
              .split("\n")
              .filter((line) => line.trim() !== "");

            if (result.type === "shipped") {
              historyLogs.push(
                `[출고 완료] 출고일시:${result.data.date} | 출고처:${result.data.destination} | 담당:${result.data.operator}`
              );
            }

            return (
              <div
                key={idx}
                className={`border-2 rounded-2xl p-6 transition-all ${
                  isEditing
                    ? "border-orange-400 bg-orange-50/30"
                    : "border-indigo-100 bg-indigo-50/30"
                }`}
              >
                <div
                  className={`flex flex-col md:flex-row justify-between items-start md:items-center border-b pb-4 mb-4 gap-4 ${
                    isEditing ? "border-orange-200" : "border-indigo-100"
                  }`}
                >
                  <div>
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-black mr-3 ${
                        result.type === "shipped"
                          ? "bg-green-100 text-green-700"
                          : "bg-blue-100 text-blue-700"
                      }`}
                    >
                      {result.type === "shipped"
                        ? "출고 완료 제품"
                        : "생산 진행 중"}
                    </span>
                    <span className="font-black text-2xl text-slate-800">
                      {result.data.lot || result.data.mixLot}
                    </span>
                    {result.data.originalLot && (
                      <div className="text-sm font-bold text-slate-400 mt-1">
                        원로트: {result.data.originalLot}
                      </div>
                    )}
                  </div>
                  <div className="text-left md:text-right flex flex-col items-start md:items-end">
                    <div className="font-black text-xl text-indigo-700">
                      {result.data.type} {result.data.height}T
                    </div>
                    <div className="text-sm font-bold text-slate-500 mt-1">
                      현재 수량: {result.data.qty} EA
                    </div>
                    {/* 🌟 원료 투입량(혼합량) 표시 (데이터가 존재할 때만 뱃지 노출) */}
                    {result.data.weight && (
                      <div className="mt-1.5 text-xs font-black text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded shadow-sm">
                        원료 투입량: {result.data.weight} kg
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <h4 className="font-black text-slate-700 mb-2 flex items-center">
                    공정 진행 타임라인{" "}
                    {isEditing && (
                      <span className="text-orange-600 ml-2 text-sm">
                        (수정 모드)
                      </span>
                    )}
                  </h4>

                  <div className="bg-white p-5 rounded-xl border shadow-sm text-sm text-slate-600 leading-relaxed grid grid-cols-1 gap-4">
                    {isEditing ? (
                      <>
                        <div className="flex items-center">
                          <strong className="w-24 text-slate-800">
                            현재 수량:
                          </strong>{" "}
                          <input
                            type="number"
                            value={editData.qty || ""}
                            onChange={(e) =>
                              setEditData({
                                ...editData,
                                qty: Number(e.target.value),
                              })
                            }
                            className="border border-orange-300 rounded p-1.5 w-32 font-bold focus:outline-none"
                          />
                        </div>
                        <div className="flex items-center">
                          <strong className="w-24 text-slate-800">
                            진행 상태:
                          </strong>{" "}
                          <input
                            type="text"
                            value={editData.currentStep || ""}
                            onChange={(e) =>
                              setEditData({
                                ...editData,
                                currentStep: e.target.value,
                              })
                            }
                            className="border border-orange-300 rounded p-1.5 flex-1 font-bold text-orange-700 focus:outline-none"
                          />
                        </div>
                        <div className="flex items-start">
                          <strong className="w-24 text-slate-800 mt-1">
                            누적 기록:
                          </strong>{" "}
                          <textarea
                            value={editData.details || ""}
                            onChange={(e) =>
                              setEditData({
                                ...editData,
                                details: e.target.value,
                              })
                            }
                            className="border border-orange-300 rounded p-2 flex-1 h-32 text-xs focus:outline-none whitespace-pre-wrap"
                          />
                        </div>
                      </>
                    ) : (
                      <div className="relative pl-4 border-l-2 border-indigo-200 space-y-4 py-2">
                        {historyLogs.map((log, logIdx) => {
                          const isDefect = log.includes("불량");
                          return (
                            <div key={logIdx} className="relative">
                              <div
                                className={`absolute -left-[23px] top-1 w-3 h-3 rounded-full ring-4 ring-white ${
                                  isDefect ? "bg-red-500" : "bg-indigo-500"
                                }`}
                              ></div>
                              <div
                                className={`font-bold leading-tight ${
                                  isDefect
                                    ? "text-red-600 bg-red-50 inline-block px-2 py-0.5 rounded shadow-sm"
                                    : "text-slate-800"
                                }`}
                              >
                                {log}
                              </div>
                            </div>
                          );
                        })}
                        {historyLogs.length === 0 && (
                          <div className="text-slate-400">기록이 없습니다.</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="mt-6 pt-4 flex justify-between items-center border-t border-slate-200">
                    <button
                      onClick={() => handleDelete(result)}
                      className="flex items-center text-red-500 bg-red-50 hover:bg-red-100 px-4 py-2.5 rounded-xl font-black text-sm transition-colors border border-red-200"
                    >
                      <Trash2 className="w-4 h-4 mr-1.5" /> 데이터 영구 삭제
                    </button>

                    <div className="flex space-x-3">
                      {isEditing ? (
                        <>
                          <button
                            onClick={() => setEditingId(null)}
                            className="px-6 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl font-bold transition-colors"
                          >
                            취소
                          </button>
                          <button
                            onClick={() => handleSaveEdit(result)}
                            className="flex items-center px-6 py-2.5 bg-orange-500 hover:bg-orange-600 text-white rounded-xl font-black shadow-md transition-colors"
                          >
                            <Save className="w-4 h-4 mr-1.5" /> 강제 수정 저장
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => startEdit(result)}
                          className="flex items-center px-6 py-2.5 bg-slate-800 hover:bg-slate-900 text-white rounded-xl font-black shadow-md transition-colors"
                        >
                          <Edit2 className="w-4 h-4 mr-1.5" /> 데이터 강제 수정
                        </button>
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
