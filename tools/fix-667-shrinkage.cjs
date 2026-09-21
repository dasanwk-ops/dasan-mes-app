const fs = require("fs");

const APP_PATH = "src/App.js";
const PROJECT_ID = "dasanind-mes";
const APP_ID = "dasan-mes-app";
const DOC_ID = "stocktake-recovery-260724-667";
const TARGET_RATE = "19.7665";
const DOC_PATH = `artifacts/${APP_ID}/public/data/wipList/${DOC_ID}`;

function getApiKey() {
  const src = fs.readFileSync(APP_PATH, "utf8");
  const m = src.match(/apiKey:\s*process\.env\.REACT_APP_FIREBASE_API_KEY\s*\|\|\s*"([^"]+)"/);
  if (!m) throw new Error("Firebase API key fallback not found in src/App.js");
  return m[1];
}

function field(doc, name) {
  return doc?.fields?.[name];
}
function stringField(doc, name) {
  return field(doc, name)?.stringValue ?? "";
}
function intField(doc, name) {
  const v = field(doc, name);
  if (!v) return NaN;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  return NaN;
}
function mapField(doc, name) {
  return field(doc, name)?.mapValue?.fields || {};
}
function mapString(map, name) {
  return map?.[name]?.stringValue ?? "";
}
function mapBool(map, name) {
  return map?.[name]?.booleanValue;
}

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${url} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function main() {
  const apiKey = getApiKey();

  const auth = await jsonFetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }),
    }
  );
  if (!auth.idToken) throw new Error("Anonymous Firebase auth did not return idToken");
  const headers = {
    authorization: `Bearer ${auth.idToken}`,
    "content-type": "application/json",
  };

  const docUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${DOC_PATH}`;
  const before = await jsonFetch(docUrl, { headers });

  const recovery = mapField(before, "stocktakeRecovery");
  const qty = intField(before, "qty");
  const mixLot = stringField(before, "mixLot");
  const step = stringField(before, "currentStep");
  const currentRate = stringField(before, "shrinkageRate");
  const sourceLot = mapString(recovery, "sourceLot");
  const needsShrink = mapBool(recovery, "needsShrinkageData");
  const needsHeat = mapBool(recovery, "needsHeatHistory");
  const priorMeasured = mapString(recovery, "shrinkageRemeasuredRate");

  if (qty !== 94) throw new Error(`Guard failed: qty=${qty}, expected 94`);
  if (mixLot !== "MIX-260724-667") throw new Error(`Guard failed: mixLot=${mixLot}`);
  if (step !== "step8") throw new Error(`Guard failed: currentStep=${step}`);
  if (sourceLot !== "MIX-260724-667") throw new Error(`Guard failed: sourceLot=${sourceLot}`);
  if (needsHeat !== true) throw new Error(`Guard failed: needsHeatHistory=${needsHeat}, expected true`);

  if (currentRate === TARGET_RATE && needsShrink === false && priorMeasured === TARGET_RATE) {
    console.log("Already corrected. No write needed.");
    return;
  }

  if (!(currentRate === "" || currentRate === "0" || currentRate === TARGET_RATE)) {
    throw new Error(`Guard failed: unexpected existing shrinkageRate=${currentRate}`);
  }
  if (!(needsShrink === true || needsShrink === false)) {
    throw new Error(`Guard failed: needsShrinkageData=${needsShrink}`);
  }

  const nowKst = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(new Date());

  const oldDetails = stringField(before, "details");
  const auditLine = `[${nowKst}] [수축률 재측정] 실측 수축률 ${TARGET_RATE}% 반영 | 기존 열처리 원기록 미확인 상태 유지`;
  const newDetails = oldDetails.includes("[수축률 재측정] 실측 수축률 19.7665%")
    ? oldDetails
    : `${oldDetails}\n${auditLine}`;

  const name = before.name;
  if (!name || !before.updateTime) throw new Error("Missing Firestore document name/updateTime");

  const commitUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`;
  await jsonFetch(commitUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      writes: [
        {
          update: {
            name,
            fields: {
              shrinkageRate: { stringValue: TARGET_RATE },
              details: { stringValue: newDetails },
              stocktakeRecovery: {
                mapValue: {
                  fields: {
                    needsShrinkageData: { booleanValue: false },
                    shrinkageRemeasuredRate: { stringValue: TARGET_RATE },
                    shrinkageRemeasuredAt: { stringValue: nowKst },
                    shrinkageRemeasureSource: { stringValue: "사용자 제공 실측값" },
                  },
                },
              },
            },
          },
          updateMask: {
            fieldPaths: [
              "shrinkageRate",
              "details",
              "stocktakeRecovery.needsShrinkageData",
              "stocktakeRecovery.shrinkageRemeasuredRate",
              "stocktakeRecovery.shrinkageRemeasuredAt",
              "stocktakeRecovery.shrinkageRemeasureSource",
            ],
          },
          currentDocument: { updateTime: before.updateTime },
        },
      ],
    }),
  });

  const after = await jsonFetch(docUrl, { headers });
  const afterRecovery = mapField(after, "stocktakeRecovery");
  const checks = {
    shrinkageRate: stringField(after, "shrinkageRate"),
    needsShrinkageData: mapBool(afterRecovery, "needsShrinkageData"),
    needsHeatHistory: mapBool(afterRecovery, "needsHeatHistory"),
    shrinkageRemeasuredRate: mapString(afterRecovery, "shrinkageRemeasuredRate"),
    shrinkageRemeasuredAt: mapString(afterRecovery, "shrinkageRemeasuredAt"),
    shrinkageRemeasureSource: mapString(afterRecovery, "shrinkageRemeasureSource"),
  };

  if (
    checks.shrinkageRate !== TARGET_RATE ||
    checks.needsShrinkageData !== false ||
    checks.needsHeatHistory !== true ||
    checks.shrinkageRemeasuredRate !== TARGET_RATE
  ) {
    throw new Error(`Post-write verification failed: ${JSON.stringify(checks)}`);
  }

  console.log("667 shrinkage correction applied and verified:", JSON.stringify(checks));
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
