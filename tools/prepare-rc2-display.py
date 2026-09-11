import hashlib
from pathlib import Path
p=Path("src/App.js")
b=p.read_bytes()
actual=hashlib.sha1(b"blob "+str(len(b)).encode()+b"\0"+b).hexdigest()
if actual!="a35b4dd8204a214047de6f8f22b90cb210e2ac67":
    raise SystemExit("Refusing to patch an unexpected App.js baseline: "+actual)
s=b.decode("utf-8")
changes = [('import { createOperations } from "./mesOperations.mjs";', 'import { createOperations } from "./mesOperations.mjs";\nimport { getWipProcessStatus } from "./mesProcessStatus.mjs";'), ('                const rollbackSteps = currentStepIndex >= 0 ? WIP_STEPS.slice(0, currentStepIndex + 1) : WIP_STEPS;', '                const rollbackSteps = currentStepIndex >= 0 ? WIP_STEPS.slice(0, currentStepIndex + 1) : WIP_STEPS;\n                const processStatus = getWipProcessStatus(wip, furnaces, WIP_STEPS.find((s) => s.value === wip.currentStep)?.label || "\uacf5\uc815 \ud655\uc778 \ud544\uc694");'), ('`\ud604\uc7ac: ${step.label}`', '`\ud604\uc7ac: ${processStatus.label}`'), ('wip.currentStep.includes("heating") ? "bg-orange-50 text-orange-700" : "bg-white text-slate-600"', 'processStatus.tone === "heating" ? "bg-orange-50 text-orange-700" : processStatus.tone === "warning" ? "bg-red-50 text-red-700" : processStatus.tone === "assigned" ? "bg-blue-50 text-blue-700" : "bg-white text-slate-600"'), ('{WIP_STEPS.find((s) => s.value === wip.currentStep)?.label || "\ub300\uae30\uc911"}', '{processStatus.label}')]
for old,new in changes:
    if s.count(old)!=1: raise SystemExit("Source anchor is not unique")
    s=s.replace(old,new)
p.write_text(s,encoding="utf-8")

p=Path("tools/render-smoke.mjs")
b=p.read_bytes()
actual=hashlib.sha1(b"blob "+str(len(b)).encode()+b"\0"+b).hexdigest()
if actual!="55b24b707d90582a13391f9f7bf9d378d824d890":
    raise SystemExit("Unexpected render smoke baseline")
s=b.decode("utf-8")
changes=[("import * as store from '../src/mesDatabase.mjs';", "import * as status from '../src/mesProcessStatus.mjs';\nimport * as store from '../src/mesDatabase.mjs';"), ("'./mesDatabase.mjs':store,", "'./mesProcessStatus.mjs':status,'./mesDatabase.mjs':store,")]
for old,new in changes:
    if s.count(old)!=1: raise SystemExit("Smoke source anchor is not unique")
    s=s.replace(old,new)
s+="\n// RC2 checks both the badge and the current option while a row is being edited.\nconst w005=props.wipList.find(w=>w.mixLot==='MIX-DEMO-005');\nconst assignedFurnaces=heating=>({'1':{isHeating:heating,slotData:{L1:{wipId:w005.id,qty:10}}}});\nconst textOf=t=>t===null||t===undefined?'':Array.isArray(t)?t.map(textOf).join(''):typeof t==='object'?textOf(t.children||[]):String(t);\nfor(const [heating,label] of [[false,'\\uc804\\uae30\\ub85c \\ubc30\\uc815 (1\\ud638\\uae30)'],[true,'\\uc5f4\\ucc98\\ub9ac \\uc911 (1\\ud638\\uae30)']]){\n  current={n:0,state:[]};\n  const dashboard=exports.__components.DashboardView({...props,furnaces:assignedFurnaces(heating)});\n  assert.ok(walk(dashboard).some(n=>n.type==='span'&&textOf(n)===label));\n  current={n:0,state:[w005.id,{...w005}]};\n  const editTree=exports.__components.DashboardView({...props,furnaces:assignedFurnaces(heating)});\n  const selected=walk(editTree).find(n=>n.type==='option'&&n.props.value==='step5');\n  assert.equal(textOf(selected),'\\ud604\\uc7ac: '+label);\n  console.log(`PASS RC2 dashboard display and edit option: ${label}`);\n}\n"
p.write_text(s,encoding="utf-8")
