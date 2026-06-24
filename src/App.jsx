import React, { useState, useMemo, useEffect, useRef, createContext, useContext } from "react";
import * as RC from "recharts";

/* =========================================================================
   DATA LAYER  — all figures anchored to BRD V0.5.1 and internally consistent.
   See README.md for the rigor notes / sources.
   ========================================================================= */
const BRD = {
  eligibleFamilies: 1400000,          // >1.4M families passed eligibility
  baseline: { contracts:127952, spendSAR:18098000000, avgPerContract:141444 }, // 2024–2025/07
  phase3BudgetSAR: 7900000000,        // ~7.9B over 5y
  phase3Years: 5,
  targetContractsTotal: 510000,       // 2026–2030
  targetBreakdown: { redf:310000, zatca:150000, devHousing:50000 },
  hbrBaseline: 0.405,                 // 40–41%
  hbrTarget2030: 0.325,               // 30–35%
  ownershipNow: 0.6624, ownershipTarget: 0.70,
  fairnessThreshold: 1.0,
};
const ANNUAL_CONTRACTS = Math.round(BRD.targetContractsTotal / BRD.phase3Years); // 102000

// Income bands. NOTE: this engine works in the PHASE-3 FLEXIBLE-BUDGET frame
// (7.9B / 510k contracts ⇒ avg support ≈ 15.5k/contract). The historical 141,444/contract
// (18.098B / 127,952) is a *different basis* (total support incl. package/loan) and is shown
// only as a historical context card — never mixed into the optimization math.
// Calibration targets: ~64% of contracts to >10k · weighted avg support ≈ 17.4k · FG_base ≈ 0.70 · HBR_base ≈ 0.405.
// Above-10k bands are deliberately OVER-subsidised (BRD pain point: budget diverted to the less needy),
// so rationalising/reallocating them yields genuine savings.
// Two support instruments per BRD (kept as separate, documented sub-models):
//   subsidyBase – the FLEXIBLE-budget line (drives spend / savings / fairness), avg ≈ 17.4k
//   pkgBase     – the PACKAGE / effective buy-down support (drives HBR), avg ≈ 130k
// >10k bands are over-served on both instruments (BRD pain point).
const BANDS = [
  { id:"b1", key:"lt5",    below:true,  incomeAvg:4200,  popShare:0.15, cShareBase:0.08, subsidyBase:15000, pkgBase:95000,  homePrice:470000 },
  { id:"b2", key:"5to8",   below:true,  incomeAvg:6600,  popShare:0.20, cShareBase:0.14, subsidyBase:15800, pkgBase:105000, homePrice:560000 },
  { id:"b3", key:"8to10",  below:true,  incomeAvg:9000,  popShare:0.18, cShareBase:0.14, subsidyBase:16500, pkgBase:115000, homePrice:650000 },
  { id:"b4", key:"10to13", below:false, incomeAvg:11500, popShare:0.20, cShareBase:0.26, subsidyBase:18800, pkgBase:150000, homePrice:790000 },
  { id:"b5", key:"13to16", below:false, incomeAvg:14500, popShare:0.15, cShareBase:0.22, subsidyBase:20500, pkgBase:160000, homePrice:930000 },
  { id:"b6", key:"gt16",   below:false, incomeAvg:18500, popShare:0.12, cShareBase:0.16, subsidyBase:22500, pkgBase:170000, homePrice:1180000 },
];
// HBR (mortgage-burden) model: monthly payment on (price − downpayment − package buy-down) / income.
const MORT = { rate:0.073/12, n:300, down:0.10 };   // 7.3% APR, 25y, 10% down (calibrated to HBR_base≈40.5%)
const HBR_LEV = { boost:2.5, cap:0.6 };             // leverage of boost/cap on package support
function monthlyPayment(P){ const r=MORT.rate,n=MORT.n; return P<=0?0:P*r/(1-Math.pow(1+r,-n)); }

// 13 administrative regions of Saudi Arabia (eligible-base weights sum to 1; FG varies by region).
const REGIONS = [
  { key:"riyadh",   w:0.255, priceIdx:1.18, fg:0.74 },
  { key:"makkah",   w:0.210, priceIdx:1.22, fg:0.69 },
  { key:"eastern",  w:0.155, priceIdx:1.10, fg:0.81 },
  { key:"madinah",  w:0.075, priceIdx:1.02, fg:0.88 },
  { key:"asir",     w:0.058, priceIdx:0.90, fg:1.04 },
  { key:"qassim",   w:0.045, priceIdx:0.94, fg:0.97 },
  { key:"tabuk",    w:0.030, priceIdx:0.88, fg:1.08 },
  { key:"hail",     w:0.026, priceIdx:0.86, fg:1.11 },
  { key:"jazan",    w:0.043, priceIdx:0.84, fg:1.06 },
  { key:"najran",   w:0.020, priceIdx:0.85, fg:1.09 },
  { key:"bahah",    w:0.016, priceIdx:0.83, fg:1.12 },
  { key:"jawf",     w:0.017, priceIdx:0.84, fg:1.10 },
  { key:"northern", w:0.050, priceIdx:0.87, fg:1.05 },
];

const DATA_SOURCES = [
  { key:"sakani",  status:"ok",      freq:"daily",     records:1402360, exc:2.1, completeness:98, updated:"Today 06:00" },
  { key:"redf",    status:"ok",      freq:"daily",     records:318540,  exc:3.4, completeness:95, updated:"Today 05:30" },
  { key:"nhc",     status:"ok",      freq:"weekly",    records:84210,   exc:6.2, completeness:91, updated:"2 days ago" },
  { key:"rega",    status:"ok",      freq:"monthly",   records:51300,   exc:8.5, completeness:88, updated:"Last month" },
  { key:"ncsi",    status:"delayed", freq:"quarterly", records:540000,  exc:9.3, completeness:86, updated:"1 quarter ago" },
  { key:"sama",    status:"ok",      freq:"daily",     records:1250,    exc:0.4, completeness:99, updated:"Today 06:00" },
];

/* =========================================================================
   WHAT-IF / FORMULA ENGINE
   params:
     reallocatePct  – fraction of >10k contract share shifted to <10k bands (0..0.30)
     capHighPct     – reduction applied to subsidy of top two bands (0..0.20)
     boostLowPct    – uplift applied to subsidy of <10k bands (0..0.20)
   ========================================================================= */
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}

function computeAllocation(params){
  const p = Object.assign({ reallocatePct:0, capHighPct:0, boostLowPct:0, offPlanPct:0 }, params||{});
  const belowIdx = BANDS.map((b,i)=>b.below?i:-1).filter(i=>i>=0);
  const aboveIdx = BANDS.map((b,i)=>!b.below?i:-1).filter(i=>i>=0);

  // Total annual contracts kept constant (the 510k/5y target is non-negotiable).
  // reallocatePct shifts that fraction of the >10k contract share down to <10k bands, pro-rata.
  const baseAboveTotal = aboveIdx.reduce((s,i)=>s+BANDS[i].cShareBase,0);
  const moved = baseAboveTotal * p.reallocatePct;
  const belowBaseTotal = belowIdx.reduce((s,i)=>s+BANDS[i].cShareBase,0);

  const rows = BANDS.map((b)=>{
    let cShare = b.cShareBase;
    if(b.below)  cShare = b.cShareBase + moved*(b.cShareBase/belowBaseTotal);
    else         cShare = b.cShareBase*(1 - p.reallocatePct);
    let subsidy = b.subsidyBase;
    if(b.below) subsidy = b.subsidyBase*(1+p.boostLowPct);
    else        subsidy = subsidy*(1-p.capHighPct);          // cap applies to all >10k bands
    subsidy = subsidy*(1 - p.offPlanPct);                    // off-plan / in-kind restriction (flat — savings lever, FG/HBR neutral)
    return Object.assign({}, b, { cShare, subsidy });
  });

  const contractsTotal = ANNUAL_CONTRACTS;
  let spend=0, subsidyBelow=0, subsidyTotal=0;
  let hbrNum=0, hbrDen=0;
  rows.forEach(r=>{
    const contracts = contractsTotal*r.cShare;
    const bandSpend = contracts*r.subsidy;
    spend += bandSpend; subsidyTotal += bandSpend;
    if(r.below) subsidyBelow += bandSpend;
    r.contracts = contracts; r.bandSpend = bandSpend;
    // HBR: package buy-down reduces mortgage principal → lowers monthly payment → lowers burden.
    let pkg = r.pkgBase;
    if(r.below) pkg = r.pkgBase*(1 + p.boostLowPct*HBR_LEV.boost);
    else        pkg = r.pkgBase*(1 - p.capHighPct*HBR_LEV.cap);
    const principal = r.homePrice*(1-MORT.down) - pkg;
    const hbr = clamp(monthlyPayment(principal)/r.incomeAvg, 0.08, 0.70);
    r.hbr = hbr; r.pkg = pkg;
    hbrNum += hbr*r.popShare; hbrDen += r.popShare;
  });
  const avgPerContract = spend/contractsTotal;
  const popBelow = belowIdx.reduce((s,i)=>s+BANDS[i].popShare,0);
  const popTotal = BANDS.reduce((s,b)=>s+b.popShare,0);
  const FG = (subsidyBelow/subsidyTotal) / (popBelow/popTotal);
  const HBR = hbrNum/hbrDen;

  return { rows, spend, avgPerContract, FG, HBR, subsidyBelow, subsidyTotal, contractsTotal,
           fgShareBelow:subsidyBelow/subsidyTotal, popShareBelow:popBelow/popTotal };
}

const BASELINE = computeAllocation({}); // current matrix (all sliders = 0)

// Savings are measured against the current matrix (BASELINE). BRD frames savings as
// 1.37–3.4B over the 5-year phase (≈17–43% of the 7.9B budget).
function scenarioSavings(scn){
  const annual = BASELINE.spend - scn.spend;
  return { annual, phase: annual*BRD.phase3Years,
           pctOfBudget: (annual*BRD.phase3Years)/BRD.phase3BudgetSAR };
}

function fgByRegion(globalFG){
  // scale each region's baseline FG by the same ratio the global FG moved
  const ratio = globalFG / BASELINE.FG;
  return REGIONS.map(r=>({ key:r.key, fg:+(r.fg*ratio).toFixed(3), w:r.w, priceIdx:r.priceIdx }));
}

/* =========================================================================
   FORECAST (12-month spend projection with budget ceiling + alert)
   ========================================================================= */
// Seasonal weights (Jan contract surge, mid-year / post-Ramadan dip, year-end push).
const FC_SEASON=[1.18,1.06,0.99,0.96,0.92,0.86,0.80,0.78,0.95,1.06,1.12,1.20];
function buildForecast(scn){
  const annualCeiling = BRD.phase3BudgetSAR / BRD.phase3Years; // 1.58B
  const monthlyCeiling = annualCeiling/12;
  const monthlyAvg = scn.spend/12;
  const months=[]; let cum=0;
  for(let m=1;m<=12;m++){
    const projected = monthlyAvg*FC_SEASON[m-1];
    cum += projected;
    months.push({ m, projected:Math.round(projected), cumulative:Math.round(cum), ceiling:Math.round(monthlyCeiling*m) });
  }
  // 3-month OLS-style continuation from the last quarter slope, with ±12% CI.
  const slope=(months[11].projected-months[8].projected)/3;
  const fc=[]; let last=months[11].projected, fcum=cum;
  for(let k=1;k<=3;k++){ const proj=Math.round(last+slope*k); fcum+=proj;
    fc.push({ m:12+k, proj, lo:Math.round(proj*0.88), hi:Math.round(proj*1.12), cumulative:Math.round(fcum), ceiling:Math.round(monthlyCeiling*(12+k)) }); }
  const alertMonth = months.find(x=>x.cumulative > monthlyCeiling*x.m*0.70);
  return { months, fc, annualCeiling, monthlyCeiling, alertMonth: alertMonth? alertMonth.m : null };
}

/* =========================================================================
   i18n  (English + Arabic).  Switching AR flips the whole app to RTL.
   ========================================================================= */
const I18N = {
  en:{
    appName:"Dynamic Subsidy Allocation & Optimization",
    sso_title:"MoMAH Single Sign-On", sso_sub:"Unified national access to the Ministry of Municipalities & Housing digital services.", identity:"Identity",
    signInTitle:"Sign In", forgotPwd:"Forgot password?", securityCode:"Security code", or_:"or",
    nafath:"Nafath national access", noAccount:"Don't have an account?", createAccount:"Create New Account",
    nic1:"NIC", nic2:"National Identity Card", identityPh:"Select identity",
    copyright:"© 2026 — Ministry of Municipalities & Housing · Housing Support Agency", brandLine:"Dynamic Subsidy Allocation", login_btn:"Login",
    ministry:"Ministry of Municipalities & Housing", agency:"Housing Support Agency",
    syntheticData:"Synthetic demo data — not real beneficiaries",
    login:"Sign in", username:"Username", password:"Password", chooseRole:"Select a demo identity",
    loginHint:"Password is pre-filled for the demo (no real authentication).", enter:"Enter",
    logout:"Sign out", language:"Language", currency:"Currency", resetDemo:"Reset demo",
    // roles
    analyst:"Analyst", owner:"Business Owner", minister:"Minister",
    analyst_full:"Analyst", owner_full:"Business Owner", minister_full:"Minister",
    analyst_desc:"Runs analyses, What-if, assembles & submits decision packages.",
    owner_desc:"Reviews and approves tactical recommendations.",
    minister_desc:"Adjudicates strategic items (caps / internal regulations).",
    // nav
    nav_home:"Dashboard", nav_data:"Data Readiness", nav_alloc:"Allocation Plan", nav_forecast:"Forecast & Fairness",
    nav_whatif:"What-if Simulation", nav_packages:"Decision Packages", nav_approvals:"Approvals",
    nav_audit:"Audit Trail", nav_copilot:"Housing Copilot", nav_cockpit:"Strategic Cockpit", nav_decisions:"Strategic Decisions",
    // KPIs
    kpi_savings:"Projected savings (5-yr)", kpi_fairness:"Fairness Gap", kpi_hbr:"Housing Burden (HBR)",
    kpi_budget:"Budget utilisation", kpi_contracts:"Contracts to target", kpi_pending:"Pending decisions",
    kpi_forecastErr:"Forecast error", kpi_dataReady:"Data readiness", kpi_adoption:"Adoption rate",
    of_budget:"of 7.9B budget", target:"target", baseline:"baseline", current:"current",
    fair_if:"Fair when ≥ 1.0", toTarget:"to 2030 target 30–35%",
    // common
    explain:"View rationale", impact:"Projected impact", submit:"Assemble & submit package", approve:"Approve",
    reject:"Reject & feedback", escalate:"Escalate to Minister", adjudicate:"Adjudicate", view:"View",
    run:"Run", running:"Running…", done:"Done", apply:"Apply", todo:"To-do", status:"Status",
    region:"Region", incomeBand:"Income band", contracts:"Contracts", subsidy:"Avg support", share:"Share",
    before:"Before", after:"After", delta:"Change", scenario:"Scenario", recommended:"Recommended",
    notifTitle:"Decision package submitted", noItems:"Nothing here yet.",
    // data sources
    src_sakani:"Sakani Platform", src_redf:"Real Estate Dev. Fund (REDF)", src_nhc:"National Housing Co. (NHC)",
    src_rega:"Real Estate Authority (Rega)", src_ncsi:"Statistics Authority (NCSI)", src_sama:"Central Bank (SAMA)",
    st_ok:"Updated", st_pending:"Pending approval", st_delayed:"Delayed 3–6 mo", quality:"Quality", freq:"Frequency",
    // bands
    bl_lt5:"< 5,000", bl_5to8:"5,000–8,000", bl_8to10:"8,000–10,000",
    bl_10to13:"10,000–13,000", bl_13to16:"13,000–16,000", bl_gt16:"> 16,000",
    below10k:"Below 10,000", above10k:"Above 10,000",
    // regions
    rg_riyadh:"Riyadh", rg_makkah:"Makkah", rg_eastern:"Eastern Province", rg_madinah:"Madinah", rg_asir:"Asir",
    rg_qassim:"Qassim", rg_tabuk:"Tabuk", rg_hail:"Hail", rg_jazan:"Jazan", rg_najran:"Najran",
    rg_bahah:"Al-Bahah", rg_jawf:"Al-Jawf", rg_northern:"Northern Borders",
    // pages text
    home_hello:"Welcome", monthlyCycle:"Monthly allocation review",
    data_sub:"Daily automated cycle cleans data and writes prices & budget to BIDSC.",
    runCycle:"Run daily data cycle", writingBidsc:"Writing to BIDSC", bidscDone:"BIDSC updated",
    alloc_sub:"Explainable proposed distribution within the approved policy matrix.",
    forecast_sub:"12-month spend projection with budget ceiling, plus multi-dimensional Fairness Gap & leakage.",
    spendForecast:"Spend forecast (12 months)", budgetCeiling:"Budget ceiling", alert:"Alert",
    alertMsg:"Cumulative spend exceeds 70% of the monthly ceiling — early warning raised.",
    fairnessByRegion:"Fairness Gap by region", leakage:"Leakage & undue-benefit signals",
    whatif_sub:"Ask in plain language or move the levers — the orchestration layer calls the agents and the KPIs update live.",
    nlPlaceholder:"e.g. Boost support to families under 10,000 by 10% and assess the impact",
    orchestration:"Agent orchestration", levers:"Policy levers",
    lv_realloc:"Reallocate >10k → <10k", lv_cap:"Cap >10k support", lv_boost:"Boost <10k support", lv_offplan:"Restrict off-plan",
    runWhatif:"Run simulation", compare:"Baseline vs scenario", assembleFromHere:"Assemble decision package from this scenario",
    pkg_sub:"Assemble the explained package and submit it up the decision chain.",
    approvals_sub:"Review tactical recommendations submitted by analysts.",
    cockpit_sub:"Strategic KPIs and items requiring ministerial adjudication.",
    decisions_sub:"Items escalated for strategic adjudication (caps / internal regulations).",
    audit_sub:"Every submission, approval, rejection and adjudication is recorded.", auditDetail:"Audit trail detail", openHint:"Click a work order # to view details",
    copilot_sub:"Approved outputs are delivered to Housing Copilot via the API Contract.",
    deliver:"Deliver to Housing Copilot", opening:"Opening Housing Copilot…",
    redline:"The system only recommends. It never auto-approves, never auto-suspends support, never edits regulations.",
    pkgStatus_draft:"Draft", pkgStatus_submitted:"Awaiting Business Owner", pkgStatus_approved:"Approved (tactical)",
    pkgStatus_escalated:"Awaiting Minister", pkgStatus_adjudicated:"Adjudicated", pkgStatus_rejected:"Rejected",
    needsMinister:"Exceeds tactical authority — affects support cap. Escalate to Minister.",
    by:"by", at:"at", level:"Level", agentChain:"Orchestration chain",
    ag_uc01:"Subsidy Formula", ag_uc03:"Optimization", ag_uc04:"Forecast", ag_uc08:"Fairness",
    deliveredItems:"Recommendation · HBR · Fairness Gap · What-if result",
    annualSavings:"Annual savings", phaseSavings:"5-year savings", reviewRun:"Review & run What-if",
    contractsTarget:"Contract target 2026–2030", ownership:"Ownership rate",
    more:"More", workOrder:"Work order", colStatus:"Status", records:"Records", vsPrev:"vs last cycle",
    completeness:"Completeness", lastUpdate:"Last update", leversUsed:"Levers used", expectedImpact:"Expected impact",
    alertTitle:"Budget alert", quickActions:"Quick actions", action:"Action", time:"Time", note:"Note", noLevers:"No change (baseline)",
    td_alloc:"Review this month's allocation plan", td_forecast:"Resolve spending alerts",
    td_whatif:"Run What-if for the interest-rate scenario", td_packages:"Submit assembled decision packages",
    td_copilot:"Deliver approved outputs to Housing Copilot",
    due_today:"Due today", due_3:"3 open", due_2:"2 ready", due_soon:"This week", due_1:"1 pending",
    svc_section:"Key Services", btn_details:"Details", btn_open:"Open", aiWorking:"Agents orchestrating…", cycleDone:"Cycle complete — sources refreshed",
    tag_auto:"Automated daily", tag_monthly:"Monthly cycle", tag_ai:"AI · live", tag_explain:"Explainable", tag_audit:"Audit-logged", tag_api:"API contract",
  },
  ar:{
    appName:"التخصيص الديناميكي للدعم وتحسينه",
    sso_title:"النفاذ الموحد", sso_sub:"النفاذ الوطني الموحد إلى الخدمات الرقمية لوزارة البلديات والإسكان.", identity:"الهوية",
    signInTitle:"تسجيل الدخول", forgotPwd:"نسيت كلمة المرور؟", securityCode:"الرمز المرئي", or_:"أو",
    nafath:"الدخول عبر نفاذ", noAccount:"ليس لديك حساب؟", createAccount:"إنشاء حساب جديد",
    nic1:"الهوية", nic2:"بطاقة الهوية الوطنية", identityPh:"اختر الهوية",
    copyright:"© ٢٠٢٦ — وزارة البلديات والإسكان · هيئة الدعم السكني", brandLine:"التخصيص الديناميكي للدعم", login_btn:"دخول",
    ministry:"وزارة البلديات والإسكان", agency:"هيئة الدعم السكني",
    syntheticData:"بيانات تجريبية اصطناعية — ليست مستفيدين حقيقيين",
    login:"تسجيل الدخول", username:"اسم المستخدم", password:"كلمة المرور", chooseRole:"اختر هوية تجريبية",
    loginHint:"كلمة المرور مُعبّأة للعرض (بدون مصادقة فعلية).", enter:"دخول",
    logout:"تسجيل الخروج", language:"اللغة", currency:"العملة", resetDemo:"إعادة ضبط العرض",
    analyst:"محلل", owner:"مالك الأعمال", minister:"الوزير",
    analyst_full:"محلل", owner_full:"مالك الأعمال", minister_full:"الوزير",
    analyst_desc:"يشغّل التحليلات والمحاكاة ويُجمّع حزم القرار ويرفعها.",
    owner_desc:"يراجع ويعتمد التوصيات التكتيكية.",
    minister_desc:"يبتّ في البنود الاستراتيجية (السقوف / اللوائح الداخلية).",
    nav_home:"لوحة المعلومات", nav_data:"جاهزية البيانات", nav_alloc:"خطة التخصيص", nav_forecast:"التنبؤ والعدالة",
    nav_whatif:"محاكاة الافتراضات", nav_packages:"حزم القرار", nav_approvals:"الاعتمادات",
    nav_audit:"سجل التدقيق", nav_copilot:"مساعد الإسكان", nav_cockpit:"لوحة القيادة", nav_decisions:"القرارات الاستراتيجية",
    kpi_savings:"الوفورات المتوقعة (٥ سنوات)", kpi_fairness:"فجوة العدالة", kpi_hbr:"عبء السكن (HBR)",
    kpi_budget:"استخدام الميزانية", kpi_contracts:"العقود مقابل المستهدف", kpi_pending:"قرارات معلّقة",
    kpi_forecastErr:"خطأ التنبؤ", kpi_dataReady:"جاهزية البيانات", kpi_adoption:"معدل التبني",
    of_budget:"من ميزانية ٧٫٩ مليار", target:"المستهدف", baseline:"الأساس", current:"الحالي",
    fair_if:"عادلة عند ≥ ١٫٠", toTarget:"نحو مستهدف ٢٠٣٠: ٣٠–٣٥٪",
    explain:"عرض المبرر", impact:"الأثر المتوقع", submit:"تجميع ورفع الحزمة", approve:"اعتماد",
    reject:"رفض مع ملاحظات", escalate:"رفع للوزير", adjudicate:"البتّ", view:"عرض",
    run:"تشغيل", running:"جارٍ…", done:"تم", apply:"تطبيق", todo:"المهام", status:"الحالة",
    region:"المنطقة", incomeBand:"شريحة الدخل", contracts:"العقود", subsidy:"متوسط الدعم", share:"الحصة",
    before:"قبل", after:"بعد", delta:"التغير", scenario:"السيناريو", recommended:"موصى به",
    notifTitle:"تم رفع حزمة القرار", noItems:"لا يوجد بعد.",
    src_sakani:"منصة سكني", src_redf:"صندوق التنمية العقارية", src_nhc:"الشركة الوطنية للإسكان",
    src_rega:"الهيئة العامة للعقار", src_ncsi:"الهيئة العامة للإحصاء", src_sama:"البنك المركزي",
    st_ok:"محدّث", st_pending:"بانتظار الاعتماد", st_delayed:"متأخر ٣–٦ أشهر", quality:"الجودة", freq:"التحديث",
    bl_lt5:"أقل من ٥٬٠٠٠", bl_5to8:"٥٬٠٠٠–٨٬٠٠٠", bl_8to10:"٨٬٠٠٠–١٠٬٠٠٠",
    bl_10to13:"١٠٬٠٠٠–١٣٬٠٠٠", bl_13to16:"١٣٬٠٠٠–١٦٬٠٠٠", bl_gt16:"أكثر من ١٦٬٠٠٠",
    below10k:"أقل من ١٠٬٠٠٠", above10k:"أكثر من ١٠٬٠٠٠",
    rg_riyadh:"الرياض", rg_makkah:"مكة المكرمة", rg_eastern:"المنطقة الشرقية", rg_madinah:"المدينة المنورة", rg_asir:"عسير",
    rg_qassim:"القصيم", rg_tabuk:"تبوك", rg_hail:"حائل", rg_jazan:"جازان", rg_najran:"نجران",
    rg_bahah:"الباحة", rg_jawf:"الجوف", rg_northern:"الحدود الشمالية",
    home_hello:"مرحباً", monthlyCycle:"مراجعة التخصيص الشهرية",
    data_sub:"دورة يومية آلية تنظّف البيانات وتكتب الأسعار والميزانية إلى BIDSC.",
    runCycle:"تشغيل الدورة اليومية", writingBidsc:"الكتابة إلى BIDSC", bidscDone:"تم تحديث BIDSC",
    alloc_sub:"خطة توزيع مقترحة قابلة للتفسير ضمن مصفوفة السياسة المعتمدة.",
    forecast_sub:"تنبؤ إنفاق ١٢ شهراً مع سقف الميزانية، وفجوة عدالة متعددة الأبعاد ورصد التسرب.",
    spendForecast:"تنبؤ الإنفاق (١٢ شهراً)", budgetCeiling:"سقف الميزانية", alert:"تنبيه",
    alertMsg:"تجاوز الإنفاق التراكمي ٧٠٪ من السقف الشهري — تم رفع إنذار مبكر.",
    fairnessByRegion:"فجوة العدالة حسب المنطقة", leakage:"إشارات التسرب والاستفادة غير المستحقة",
    whatif_sub:"اسأل بلغة طبيعية أو حرّك المؤشرات — تستدعي طبقة التنسيق الوكلاء وتتحدث المؤشرات فوراً.",
    nlPlaceholder:"مثال: ارفع الدعم للأسر أقل من ١٠٬٠٠٠ بنسبة ١٠٪ وقيّم الأثر",
    orchestration:"تنسيق الوكلاء", levers:"روافع السياسة",
    lv_realloc:"إعادة التوزيع >١٠ك ← <١٠ك", lv_cap:"تقييد دعم >١٠ك", lv_boost:"رفع دعم <١٠ك", lv_offplan:"تقييد البيع على الخارطة",
    runWhatif:"تشغيل المحاكاة", compare:"الأساس مقابل السيناريو", assembleFromHere:"تجميع حزمة قرار من هذا السيناريو",
    pkg_sub:"جمّع الحزمة المفسّرة وارفعها في سلسلة القرار.",
    approvals_sub:"راجع التوصيات التكتيكية المرفوعة من المحللين.",
    cockpit_sub:"مؤشرات استراتيجية وبنود تتطلب بتّ الوزير.",
    decisions_sub:"بنود مرفوعة للبتّ الاستراتيجي (السقوف / اللوائح الداخلية).",
    audit_sub:"يُسجّل كل رفع واعتماد ورفض وبتّ.", auditDetail:"تفاصيل سجل التدقيق", openHint:"اضغط رقم أمر العمل لعرض التفاصيل",
    copilot_sub:"تُسلَّم المخرجات المعتمدة إلى مساعد الإسكان عبر عقد الـ API.",
    deliver:"التسليم إلى مساعد الإسكان", opening:"جارٍ فتح مساعد الإسكان…",
    redline:"النظام يوصي فقط: لا يعتمد آلياً، ولا يوقف الدعم آلياً، ولا يعدّل اللوائح.",
    pkgStatus_draft:"مسودة", pkgStatus_submitted:"بانتظار مالك الأعمال", pkgStatus_approved:"معتمد (تكتيكي)",
    pkgStatus_escalated:"بانتظار الوزير", pkgStatus_adjudicated:"تم البتّ", pkgStatus_rejected:"مرفوض",
    needsMinister:"يتجاوز الصلاحية التكتيكية — يمسّ سقف الدعم. يُرفع للوزير.",
    by:"بواسطة", at:"في", level:"المستوى", agentChain:"سلسلة التنسيق",
    ag_uc01:"صيغة الدعم", ag_uc03:"التحسين", ag_uc04:"التنبؤ", ag_uc08:"العدالة",
    deliveredItems:"توصية · HBR · فجوة العدالة · نتيجة المحاكاة",
    annualSavings:"الوفورات السنوية", phaseSavings:"وفورات ٥ سنوات", reviewRun:"المراجعة وتشغيل المحاكاة",
    contractsTarget:"مستهدف العقود ٢٠٢٦–٢٠٣٠", ownership:"معدل التملك",
    more:"المزيد", workOrder:"أمر العمل", colStatus:"الحالة", records:"السجلات", vsPrev:"مقابل الدورة السابقة",
    completeness:"اكتمال الحقول", lastUpdate:"آخر تحديث", leversUsed:"الروافع المستخدمة", expectedImpact:"الأثر المتوقع",
    alertTitle:"تنبيه الميزانية", quickActions:"إجراءات سريعة", action:"الإجراء", time:"الوقت", note:"ملاحظة", noLevers:"دون تغيير (الأساس)",
    td_alloc:"مراجعة خطة التخصيص لهذا الشهر", td_forecast:"معالجة تنبيهات الإنفاق",
    td_whatif:"تشغيل محاكاة لسيناريو سعر الفائدة", td_packages:"رفع حزم القرار المُجمّعة",
    td_copilot:"تسليم المخرجات المعتمدة إلى مساعد الإسكان",
    due_today:"مستحق اليوم", due_3:"٣ مفتوحة", due_2:"٢ جاهزة", due_soon:"هذا الأسبوع", due_1:"١ معلّق",
    svc_section:"الخدمات الرئيسية", btn_details:"تفاصيل", btn_open:"فتح", aiWorking:"الوكلاء يعملون…", cycleDone:"اكتملت الدورة — تم تحديث المصادر",
    tag_auto:"آلي يومي", tag_monthly:"دورة شهرية", tag_ai:"ذكاء · مباشر", tag_explain:"قابل للتفسير", tag_audit:"مُسجّل", tag_api:"عقد API",
  }
};

/* =========================================================================
   Store / context
   ========================================================================= */
const Ctx = createContext(null);
const useStore = () => useContext(Ctx);

function statusToText(t,s){ return s==="ok"?t("st_ok"):s==="pending"?t("st_pending"):t("st_delayed"); }
const n0 = v => Math.round(v).toLocaleString("en-US");
const pct1 = v => (v*100).toFixed(1)+"%";
function abbr(v){ const a=Math.abs(v);
  if(a>=1e9) return (v/1e9).toFixed(2)+"B";
  if(a>=1e6) return (v/1e6).toFixed(0)+"M";
  if(a>=1e3) return (v/1e3).toFixed(0)+"K";
  return n0(v); }
function useMoney(){ const {currency}=useStore(); const pre = currency==="symbol" ? "⃁ " : "SAR ";
  return { money:(v)=>pre+abbr(v), moneyFull:(v)=>pre+n0(v) }; }

/* =========================================================================
   UI atoms
   ========================================================================= */
const GlobeIcon = (<svg className="ic-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z"/></svg>);
const ArrowIcon = (<svg className="ic-svg ic-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>);
const UserIcon = (<svg className="ic-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.2 3.6-7 8-7s8 2.8 8 7"/></svg>);
const BellIcon = (<svg className="ic-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>);
const GearIcon = (<img className="ic-gear" src="/assets/gear2.svg" alt="" onError={e=>{const im=e.currentTarget,f=im.dataset.f||"0"; if(f==="0"){im.dataset.f="1";im.src="public/assets/gear2.svg";} else if(f==="1"){im.dataset.f="2";im.src="assets/gear2.svg";} else im.style.display="none";}}/>);
function AgentBadge({name,lvl}){ const {t}=useStore(); return (<span className="agent-badge">{GearIcon}<span>{name}{lvl?(" · "+lvl):""} · {t("agent_auto")}</span></span>); }
function InfoTip({text}){ return (<span className="tip" tabIndex={0} aria-label="formula">?<span className="tip-pop">{text}</span></span>); }
const SEED_NOTIFS = [{id:1,k:"ntf_sla",tone:"amber",ts:"2h ago"},{id:2,k:"ntf_leak",tone:"danger",ts:"5h ago"},{id:3,k:"ntf_budget",tone:"amber",ts:"1d ago"},{id:4,k:"ntf_sync",tone:"info",ts:"Today 06:00"}];
function NotifBell(){
  const {t}=useStore(); const [open,setOpen]=useState(false);
  const list=SEED_NOTIFS;
  return (<div className="usermenu">
    <button className="tbtn" onClick={()=>setOpen(o=>!o)} style={{position:"relative"}} aria-label={t("notifications")}>
      {BellIcon}{list.length>0&&<span className="notif-badge">{list.length}</span>}
    </button>
    {open&&<div className="panel" onMouseLeave={()=>setOpen(false)} style={{minWidth:312}}>
      <div style={{fontWeight:700,padding:"4px 8px 8px"}}>{t("notifications")}</div>
      {list.length===0? <div className="muted" style={{padding:8}}>{t("noNotifs")}</div>
        : list.map(n=>(<div key={n.id} className="notif-row">
            <span className="dot" style={{background:n.tone==="danger"?"var(--danger)":n.tone==="amber"?"var(--amber)":"var(--info)",marginTop:5}}/>
            <div style={{flex:1}}><div style={{fontSize:12.5,lineHeight:1.4}}>{t(n.k)}</div><div className="muted" style={{fontSize:11,marginTop:2}}>{n.ts}</div></div>
          </div>))}
    </div>}
  </div>);
}
function KPI({label,value,sub,tone,onClick}){
  const {t}=useStore();
  const color = tone==="good"?"var(--green)":tone==="bad"?"var(--danger)":tone==="warn"?"var(--amber)":"var(--ink)";
  return (<div className={"kpi"+(tone?" kpi-"+tone:"")+(onClick?" kpi-click":"")} onClick={onClick}>
    <div className="label">{label}</div>
    <div className="value" style={{color}}>{value}</div>{sub&&<div className="sub">{sub}</div>}
    {onClick&&<div className="kpi-more">{t("viewTrend")} ↗</div>}</div>);
}
function Section({title,sub,right,children,className}){
  return (<div className={"card pad acc"+(className?" "+className:"")} style={{marginBottom:16}}>
    <div className="page-h" style={{marginBottom:sub?12:8}}>
      <div><h2 style={{fontSize:16}}>{title}</h2>{sub&&<div className="sub muted">{sub}</div>}</div>{right}</div>
    {children}</div>);
}
function Progress({v,color}){ return (<div className="progress"><span style={{width:Math.min(100,v*100)+"%",background:color||"var(--green)"}}/></div>); }
function Bar({label,v,max,color}){ return (<div style={{marginBottom:8}}>
  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}><span>{label}</span><span className="mono">{(v).toFixed(2)}</span></div>
  <div className="progress"><span style={{width:Math.min(100,(v/max)*100)+"%",background:color}}/></div></div>); }

/* =========================================================================
   Login
   ========================================================================= */
const ROLE_KEYS = ["analyst","owner","minister"];
const Skyline = (
  <svg viewBox="0 0 1440 700" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="bldsky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#13796a"/><stop offset="0.55" stopColor="#0d5a4f"/><stop offset="1" stopColor="#093b35"/>
      </linearGradient>
    </defs>
    <rect width="1440" height="700" fill="url(#bldsky)"/>
    <circle cx="1180" cy="150" r="60" fill="#1aa07f" opacity="0.25"/>
    <g fill="#0c4a40">
      <rect x="40" y="420" width="120" height="280"/><rect x="200" y="360" width="90" height="340"/>
      <rect x="330" y="300" width="70" height="400"/><rect x="430" y="440" width="110" height="260"/>
      <rect x="580" y="250" width="60" height="450"/><rect x="660" y="330" width="100" height="370"/>
      <rect x="800" y="280" width="80" height="420"/><rect x="900" y="420" width="120" height="280"/>
      <rect x="1060" y="320" width="80" height="380"/><rect x="1170" y="380" width="100" height="320"/>
      <rect x="1300" y="300" width="90" height="400"/>
    </g>
    <g fill="#0f5a4c">
      <rect x="150" y="470" width="70" height="230"/><rect x="290" y="410" width="50" height="290"/>
      <rect x="520" y="380" width="70" height="320"/><rect x="760" y="440" width="60" height="260"/>
      <rect x="1010" y="470" width="60" height="230"/><rect x="1250" y="440" width="60" height="260"/>
    </g>
    <g fill="#f8c630" opacity="0.16">
      <rect x="350" y="330" width="8" height="12"/><rect x="368" y="330" width="8" height="12"/><rect x="350" y="360" width="8" height="12"/>
      <rect x="598" y="290" width="8" height="12"/><rect x="598" y="320" width="8" height="12"/><rect x="616" y="290" width="8" height="12"/>
      <rect x="820" y="320" width="8" height="12"/><rect x="838" y="320" width="8" height="12"/><rect x="820" y="350" width="8" height="12"/>
      <rect x="1078" y="360" width="8" height="12"/><rect x="1078" y="390" width="8" height="12"/><rect x="1318" y="340" width="8" height="12"/>
    </g>
  </svg>
);
function genCode(){ const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s=""; for(let i=0;i<6;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; }
function Login(){
  const {t,setUser,lang,setLang}=useStore();
  const [role,setRole]=useState("analyst");
  const [code,setCode]=useState(genCode);
  const [showPwd,setShowPwd]=useState(false);
  return (<div className="bld-login">
    <div className="bld-bg">{Skyline}</div>
    <img className="bld-photo" src="/MOMAH-housingsub/assets/HeroSection.png" alt="" data-i="0"
      onError={e=>{const im=e.currentTarget; const c=["/MOMAH-housingsub/assets/building.jpg","public/assets/HeroSection.png","public/assets/building.jpg","assets/HeroSection.png","assets/building.jpg"]; const i=+(im.dataset.i||0); if(i<c.length){im.dataset.i=i+1; im.src=c[i];} else im.style.display="none";}}/>
    <div className="bld-overlay"/>
    <div className="bld-center">
      <div className="bld-wrap">
        <div className="bld-row2">
          <div className="bld-brand-area">
            <div className="bld-logo">
              <img className="bld-logo-img" src="/assets/logo.png" alt="MoMaH"
                   onError={e=>{const im=e.currentTarget,f=im.dataset.f||"0"; if(f==="0"){im.dataset.f="1";im.src="public/assets/logo.png";} else if(f==="1"){im.dataset.f="2";im.src="assets/logo.png";} else im.style.display="none";}}/>
              <span className="bld-logo-cap">{t("brandLine")}</span>
            </div>
            <h3 style={{color:"#fff"}}>{t("sso_title")}</h3>
            <p>{t("sso_sub")}</p>
          </div>
          <div className="bld-card-col">
            <div className="bld-card fade">
              <h2>{t("signInTitle")}</h2>
              <div className="bld-fg">
                <label>{t("identity")}</label>
                <div className="bld-inp">
                  <span className="ic">👤</span>
                  <select value={role} onChange={e=>setRole(e.target.value)}>
                    {ROLE_KEYS.map(rk=><option key={rk} value={rk}>{t(rk+"_full")}</option>)}
                  </select>
                  <span className="caret">▾</span>
                </div>
              </div>
              <div className="bld-fg">
                <label>{t("password")}</label>
                <div className="bld-inp has-eye">
                  <span className="ic">🔒</span>
                  <input type={showPwd?"text":"password"} value="********" readOnly/>
                  <span className="eye" onClick={()=>setShowPwd(s=>!s)} title="Show/Hide">👁</span>
                </div>
              </div>
              <div className="bld-hint">{t("loginHint")}</div>
              <div className="bld-captcha">
                <div className="bld-code"><span>{code}</span></div>
                <button className="bld-refresh" onClick={()=>setCode(genCode())} title="Refresh">⟳</button>
                <input placeholder={t("securityCode")} maxLength={6}/>
              </div>
              <button className="bld-btn" onClick={()=>setUser(role)}>{t("login_btn")}</button>
              <div className="bld-or">{t("or_")}</div>
              <button className="bld-nic" onClick={()=>setUser(role)}>
                <div className="bld-nic-grid">
                  <i className="g"/><i className="k"/><i className="o"/>
                  <i className="k"/><i className="g"/><i className="k"/>
                  <i className="o"/><i className="k"/><i className="g"/>
                </div>
                <div><div className="l1">{t("nic1")}</div><div className="l2">{t("nic2")}</div></div>
              </button>
              <div className="bld-create">{t("noAccount")} <button>{t("createAccount")}</button></div>
              <div className="bld-langrow">
                <button className="bld-lang2" onClick={()=>setLang(lang==="en"?"ar":"en")}>{GlobeIcon} {lang==="en"?"EN / العربية":"العربية / EN"}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div className="bld-copy">{t("copyright")} · {t("syntheticData")}</div>
  </div>);
}

/* =========================================================================
   Shell: top bar + sidebar
   ========================================================================= */
function TopBar(){
  const {t,lang,setLang,currency,setCurrency,user,setUser,reset}=useStore();
  const [open,setOpen]=useState(false);
  return (<div className="topbar">
    <div className="brand">
      <img className="topbar-logo" src="/assets/logo.png" alt="MoMaH" onError={e=>{const im=e.currentTarget,f=im.dataset.f||"0"; if(f==="0"){im.dataset.f="1";im.src="public/assets/logo.png";} else if(f==="1"){im.dataset.f="2";im.src="assets/logo.png";} else im.style.display="none";}}/>
      <span className="topbar-sep"/>
      <span className="topbar-app">{t("appName")}</span>
    </div>
    <div className="right">
      <button className="tbtn" onClick={()=>setLang(lang==="en"?"ar":"en")}><img className="ic-lang" src="/assets/icon-language.svg" alt="" onError={e=>{const im=e.currentTarget,f=im.dataset.f||"0"; if(f==="0"){im.dataset.f="1";im.src="public/assets/icon-language.svg";} else if(f==="1"){im.dataset.f="2";im.src="assets/icon-language.svg";} else im.style.display="none";}}/> {lang==="en"?"العربية":"English"}</button>
      <button className="tbtn" onClick={()=>setCurrency(currency==="SAR"?"symbol":"SAR")}>{currency==="SAR"?"SAR":"⃁"}</button>
      <NotifBell/>
      <div className="usermenu">
        <button className="tbtn" onClick={()=>setOpen(o=>!o)}>{UserIcon} {t(user)} ▾</button>
        {open&&<div className="panel" onMouseLeave={()=>setOpen(false)}>
          <div style={{padding:"6px 8px",fontWeight:700}}>{t(user+"_full")}</div>
          <div style={{padding:"2px 8px 10px",fontSize:12}} className="muted">{t(user+"_desc")}</div>
          <div className="divider" style={{margin:"6px 0"}}/>
          <button className="btn ghost sm" style={{width:"100%",marginBottom:6}} onClick={()=>{reset();setOpen(false);}}>↺ {t("resetDemo")}</button>
          <button className="btn danger sm" style={{width:"100%"}} onClick={()=>setUser(null)}>⎋ {t("logout")}</button>
        </div>}
      </div>
    </div>
  </div>);
}

const NAV = {
  analyst:[["nav_home","◧"],["nav_data","⛁"],["nav_formula","∑"],["nav_alloc","▦"],["nav_mortgage","🏦"],["nav_forecast","📈"],["nav_referrals","👥"],["nav_impact","🔎"],["nav_whatif","✦"],["nav_packages","📦"],["nav_inventory","🏘"],["nav_benchmark","🌐"],["nav_audit","🕓"],["nav_copilot","🤝"],["nav_agents","🤖"],["nav_settings","⚙"]],
  owner:[["nav_home","◧"],["nav_data","⛁"],["nav_alloc","▦"],["nav_approvals","✔"],["nav_referrals","👥"],["nav_forecast","📈"],["nav_inventory","🏘"],["nav_impact","🔎"],["nav_benchmark","🌐"],["nav_audit","🕓"],["nav_agents","🤖"],["nav_settings","⚙"]],
  minister:[["nav_cockpit","◧"],["nav_decisions","⚖"],["nav_forecast","📈"],["nav_impact","🔎"],["nav_benchmark","🌐"],["nav_audit","🕓"],["nav_agents","🤖"],["nav_settings","⚙"]],
};
// Release timestamps are in Saudi Arabia Standard Time (AST, UTC+3).
const RELEASES=[
  {ver:"v1.9", date:"2026-06-24 13:20",
    en:["Subsidy Formula: live parameter controls (sliders/dropdown) + preview table + Activate/Rollback","Forecast: seasonal curve + 3-month OLS forecast with ±12% CI, 70/90 alert lines, Monthly/Cumulative toggle","Allocation: structured detail (How / Why / Impact), clearer vs-last-month, annotation"],
    zh:["补贴公式:实时参数控件(滑块/下拉)+ 预览表 + 激活/回滚","预测:季节性曲线 + 3 月 OLS 预测(±12% 置信)、70/90 警戒线、月/累计切换","配分:结构化展开(如何算/为何/影响)、环比说清、加注释"]},
  {ver:"v1.8", date:"2026-06-24 11:58",
    en:["Dashboard KPIs as visuals: radial gauge, mini-area, multi-bar, stacked bar","Data Readiness: data-lineage strip with completeness gate (GO/HOLD)"],
    zh:["仪表盘 KPI 可视化:环形仪表、面积图、多档柱、堆叠条","数据就绪:数据血缘条 + 完整度门控(GO/HOLD)"]},
  {ver:"v1.7", date:"2026-06-24 11:34",
    en:["Benchmarking: KSA/OECD/best bars + colour-coded reference programs","Fairness: region heatmap view (bar / heatmap toggle)","Formula: version timeline + Test-in-What-if","Allocation: submit checklist gate"],
    zh:["国际对标:沙特/OECD/最佳 对比条 + 参照项目颜色编码卡","公平:区域热力图视图(柱状 / 热力 切换)","公式:版本时间线 + 在 What-if 中测试","配分:提交前 Checklist 门控"]},
  {ver:"v1.6", date:"2026-06-24 11:10",
    en:["Dashboard: KPIs are clickable → 12-month trend + income-bracket drill-down","\"Home\" renamed to \"Dashboard\"","Allocation: vs-last-month column, Run What-if per row, agent trace (Show trace)"],
    zh:["仪表盘:KPI 可点击 → 12 个月趋势 + 收入档下钻","\"首页\"改名为\"仪表盘\"","配分:环比上月列、每行跑 What-if、agent 链路(Show trace)"]},
  {ver:"v1.5", date:"2026-06-24 10:46",
    en:["Settings center and Subsidy Formula pages added","Agent Architecture overview (L1/L2/L3 + scope)","AI insight cards on the dashboard; What-if sandbox notice + scenario type","Fairness drill-down by region / income / loan term / age"],
    zh:["新增设置中心与补贴公式页","智能体架构总览(L1/L2/L3 + 职责)","首页 AI 洞察卡片;What-if 沙箱声明 + 情景类型","公平性多维下钻:地区 / 收入 / 贷款期限 / 年龄"]},
  {ver:"v1.4", date:"2026-06-21 10:08",
    en:["Beneficiary tracking, support-type optimizer, benchmarking, inventory & policy-impact pages — full BRD coverage","Data-flow funnel on Data Readiness (6 sources → BIDSC)","Internal use-case codes removed from the UI","Login title fixed to MoMAH"],
    zh:["新增受益人追踪、补贴类型优选、国际对标、库存去化、政策影响等页 —— BRD 全覆盖","Data Readiness 数据流向漏斗(6 源 → BIDSC)","移除界面中的用例编号","登录标题修正为 MoMAH"]},
  {ver:"v1.3", date:"2026-06-20 18:30",
    en:["What-if AI assessment bubble + Apply AI suggestion","Orchestration nodes: progress-fill, agent-purple","Startup crash fixed (classic JSX runtime)"],
    zh:["What-if AI 评估气泡 + 应用 AI 建议","编排节点:进度条填充、agent 紫色","启动崩溃修复(经典 JSX runtime)"]},
  {ver:"v1.2", date:"2026-06-18 14:15",
    en:["Decision packages with SLA + clickable audit trail","Leakage escalation: analyst → BO → minister","Housing Copilot delivery briefs"],
    zh:["决策包 SLA + 可点工单审计","漏损升级:分析师 → 业务负责人 → 部长","Housing Copilot 交付简报"]},
  {ver:"v1.1", date:"2026-06-15 09:40",
    en:["Single sign-on + 3 roles","Data Readiness, Allocation approval flow","Forecast & Fairness, What-if engine"],
    zh:["单点登录 + 三角色","Data Readiness、配分审批流","Forecast & Fairness、What-if 引擎"]},
];
const APP_VER=RELEASES[0].ver;
function ReleaseNotes({onClose}){
  const {t,lang}=useStore(); const pick=(r)=> r[lang]||r.en;
  return (<Modal title={<span className="rel-mtitle">📦 {t("rel_title")}</span>} onClose={onClose}>
    <div className="muted" style={{fontSize:12,marginBottom:14}}>🕓 {t("rel_tz")}</div>
    <div className="rel-time">
      {RELEASES.map((r,i)=>(<div key={r.ver} className={"rel-item"+(i===0?" cur":"")}>
        <span className="rel-dot"/>
        <div className="rel-head"><b>{r.ver}</b> <span className="muted" style={{fontSize:12}}>· {r.date} AST</span>{i===0?<span className="chip" style={{marginInlineStart:8}}>{t("rel_current")}</span>:null}</div>
        <ul className="rel-list">{pick(r).map((x,j)=>(<li key={j}>{x}</li>))}</ul>
      </div>))}
    </div>
    <div style={{display:"flex",justifyContent:"flex-end",marginTop:6}}>
      <button className="btn secondary" onClick={onClose}>{t("rel_close")}</button>
    </div>
  </Modal>);
}
function Sidebar(){
  const {t,user,route,setRoute,packages}=useStore();
  const [rel,setRel]=useState(false);
  const pendingForOwner = packages.filter(p=>p.status==="submitted").length;
  const pendingForMin = packages.filter(p=>p.status==="escalated").length;
  return (<div className="sidebar">
    <div className="role"><div className="nm">{t(user+"_full")}</div></div>
    {NAV[user].map(([k,ic])=>{
      const key=k.replace("nav_","");
      const badge = (user==="owner"&&k==="nav_approvals"&&pendingForOwner)||(user==="minister"&&k==="nav_decisions"&&pendingForMin);
      return (<div key={k} className={"navitem"+(route===key?" active":"")} onClick={()=>setRoute(key)}>
        <span className="ico">{ic}</span><span style={{flex:1}}>{t(k)}</span>
        {badge?<span className="badge-count">{badge}</span>:null}</div>);
    })}
    <div className="side-foot">
      <button className="ver-chip" onClick={()=>setRel(true)} title={t("rel_title")}>
        <span className="ver-dot"/> {APP_VER} <span className="muted" style={{fontSize:10.5,fontWeight:400}}>· {RELEASES[0].date} AST</span>
      </button>
    </div>
    {rel&&<ReleaseNotes onClose={()=>setRel(false)}/>}
  </div>);
}

const RECO_PARAMS = { reallocatePct:0.20, capHighPct:0.25, boostLowPct:0.08, offPlanPct:0.10 };
// BRD 3.5: 5-yr savings expected range 1.37B–3.4B of the 7.9B Phase-3 budget; 3.4B is the upper bound.
const SAVINGS_CEIL = 3.4e9;

function PageHeader({title,sub,right}){
  return (<div className="page-h"><div><h1>{title}</h1>{sub&&<div className="sub">{sub}</div>}</div>{right}</div>);
}
function bandLabel(t,key){ return t("bl_"+key); }

/* ---- Analyst home ---- */
function AnalystHome(){
  const {t,setRoute,packages}=useStore(); const {money}=useMoney();
  const [kd,setKd]=useState(null);
  const reco=useMemo(()=>computeAllocation(RECO_PARAMS),[]);
  const sv=scenarioSavings(reco);
  const myPending=packages.filter(p=>p.status==="submitted").length;
  const items=[
    {ic:"▦", k:"td_alloc",    due:"due_today", chip:"info",  route:"alloc"},
    {ic:"📈", k:"td_forecast", due:"due_3",     chip:"amber", route:"forecast"},
    {ic:"✦", k:"td_whatif",   due:"due_soon",  chip:"gray",  route:"whatif"},
    {ic:"📦", k:"td_packages", due:"due_2",     chip:"info",  route:"packages"},
    {ic:"🤝", k:"td_copilot",  due:"due_1",     chip:"gray",  route:"copilot"},
  ];
  const quick=[["nav_alloc","▦","alloc"],["nav_forecast","📈","forecast"],["nav_whatif","✦","whatif"],["nav_packages","📦","packages"]];
  return (<div className="fade">
    <PageHeader title={t("home_hello")+" · "+t("analyst_full")} sub={t("monthlyCycle")}/>
    <div className="cols-4" style={{marginBottom:16}}>
      <MegaKpi title={t("kpi_ownership")} delta="▲ +0.8pp" onClick={()=>setKd("ownership")}>
        <RadialGauge value={66.24} target={70} max={100} unit="%"/></MegaKpi>
      <MegaKpi title={t("kpi_hbr")} value={pct1(BASELINE.HBR)} delta="▼ −0.6pp" onClick={()=>setKd("hbr")}>
        <MiniArea series={KPI_DETAIL.hbr.series} thr={38} min={34} max={42}/></MegaKpi>
      <MegaKpi title={t("kpi_fairness")} value={BASELINE.FG.toFixed(2)} delta="▲ +0.04" onClick={()=>setKd("fairness")}>
        <MiniBars data={KPI_DETAIL.fairness.drill} thr={1.0}/></MegaKpi>
      <MegaKpi title={t("kpi_budget")} value={(BASELINE.spend/(BRD.phase3BudgetSAR/BRD.phase3Years)*100).toFixed(0)+"%"} delta="▼ −2.1pp" onClick={()=>setKd("budget")}>
        <StackedBar segments={[{v:54,c:"var(--green)"},{v:22,c:"#5aa6e0"},{v:13,c:"#f0a91e"}]} marks={[70,90]} total={100}/></MegaKpi>
    </div>
    {kd&&<KpiDetailModal kpi={kd} onClose={()=>setKd(null)}/>}
    <AIInsights/>
    <Section title={t("quickActions")}>
      <div className="cols-4">
        {quick.map(([k,ic,r])=>(<button key={k} className="role-opt" onClick={()=>setRoute(r)}>
          <span className="av">{ic}</span><span style={{fontWeight:600}}>{t(k)}</span></button>))}
      </div>
    </Section>
    <Section title={t("todo")}>
      {items.map((it,i)=>(<div key={i} className="todo-row">
        <span className="av sm">{it.ic}</span>
        <div style={{flex:1}}><div style={{fontWeight:600}}>{t(it.k)}</div></div>
        <span className={"chip "+it.chip}>{t(it.due)}</span>
        <button className="btn secondary sm" onClick={()=>setRoute(it.route)}>{t("more")} {ArrowIcon}</button>
      </div>))}
    </Section>
  </div>);
}

/* ---- Data readiness ---- */
// Particle burst fired from the "Run" button centre — palm-green dots floating up & fading.
function ParticleBurst(){
  const parts=Array.from({length:16},()=>({dx:(Math.random()-.5)*140, dy:-30-Math.random()*90, d:(Math.random()*0.25).toFixed(2)}));
  return <span className="burst" aria-hidden="true">{parts.map((p,i)=><i key={i} style={{"--dx":p.dx+"px","--dy":p.dy+"px","--d":p.d+"s"}}/>)}</span>;
}
function DataReadiness(){
  const {t,user,budget,saveBudget,lang,currency}=useStore();
  const cur=currency==="symbol"?"⃁":"SAR";
  const [sources,setSources]=useState(DATA_SOURCES);
  const [running,setRunning]=useState(false); const [prog,setProg]=useState(100); const [done,setDone]=useState(true);
  const [flash,setFlash]=useState(false); const [ranOnce,setRanOnce]=useState(false);
  const [burst,setBurst]=useState(0); const [shake,setShake]=useState(false);
  const [exc,setExc]=useState(4.2); const [uploaded,setUploaded]=useState(null);
  const [bform,setBform]=useState({cash:budget.cash, inkind:budget.inkind, ceiling:budget.ceiling}); const [saved,setSaved]=useState(false);
  const [syncTime,setSyncTime]=useState("2026-06-15 06:00"); const [syncOk]=useState(true);
  const [showUp,setShowUp]=useState(false); const [file,setFile]=useState(null); const [checking,setChecking]=useState(false); const [chk,setChk]=useState(null); const [over,setOver]=useState(false);
  const fileRef=useRef(null);
  function run(){
    setRunning(true); setDone(false); setProg(0); setFlash(false);
    setBurst(Date.now()); setShake(true); setTimeout(()=>setShake(false),450);
    let p=0; const id=setInterval(()=>{ p+=10; setProg(p);
      if(p>=100){ clearInterval(id); setRunning(false); setDone(true); setRanOnce(true);
        setSources(prev=>prev.map(s=>({
          ...s,
          records: s.records + Math.max(1, Math.round(s.records*(0.001+Math.random()*0.004))),
          completeness: Math.min(99, s.completeness + 1 + Math.floor(Math.random()*2)),
          exc: +(1+Math.random()*8).toFixed(1),
          updated: s.status==="ok" ? "Just now" : s.updated,
        })));
        setExc(+(3+Math.random()*3).toFixed(1)); setSyncTime(nowStr(lang));
        setFlash(true); setTimeout(()=>setFlash(false), 1300);
      }
    },110);
  }
  function pickFile(name){ setFile(name); setChk(null); setChecking(true);
    setTimeout(()=>{ const comp=86+Math.floor(Math.random()*12); const ex=+(2+Math.random()*9).toFixed(1); const recs=8000+Math.floor(Math.random()*4000); setChk({comp,ex,recs,valid:comp>=90&&ex<=10}); setChecking(false); },1100);
  }
  function doImport(){ setUploaded(file+" · "+nowStr("en")); setShowUp(false); setFile(null); setChk(null); }
  const totalRecords=sources.reduce((s,x)=>s+x.records,0);
  const avgComp=Math.round(sources.reduce((s,x)=>s+x.completeness,0)/sources.length);
  const qkey=exc>10?"qExc":avgComp<90?"qBelow":"qOk";
  const qtone=qkey==="qOk"?"good":qkey==="qBelow"?"warn":"bad";
  return (<div className={"fade"+(shake?" page-shake":"")}>
    <PageHeader title={t("nav_data")} sub={<span style={{color:syncOk?"var(--green)":"var(--danger)",fontWeight:700}}>{(syncOk?"✓ ":"✕ ")+t(syncOk?"syncOk":"syncFail")+" · "+t("lastSyncAt")+": "+syncTime}</span>}
      right={<div style={{display:"flex",gap:8,alignItems:"center"}}>
        {user==="analyst"&&<button className="btn secondary sm" onClick={()=>setShowUp(true)}><svg className="ic-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/></svg> {t("uploadBidsc")}</button>}
        <span className="btn-burst-wrap">
          <button className="btn" onClick={run} disabled={running}>{running?t("running"):t("runCycle")}</button>
          {burst?<ParticleBurst key={burst}/>:null}
        </span>
      </div>}/>
    {user==="analyst"&&uploaded&&<div className="banner" style={{marginBottom:14}}>✓ {uploaded} — {t("uploadedOk")} · <span className="muted">{t("uploadHint")}</span></div>}
    <Section title={t("qreport")+" · "+t("budgetBalance")} right={<span className={"chip "+(qtone==="good"?"":qtone==="warn"?"amber":"danger")}>{t(qkey)}</span>}>
      <div className="dr-strip">
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("totalRecords")}</div><div className="v">{n0(totalRecords)}</div></div>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("avgCompleteness")}</div><div className="v" style={{color:avgComp>=90?"var(--green)":"var(--amber)"}}>{avgComp}%</div></div>
        <div className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t("exceptions")}</div><div className="v" style={{color:exc>10?"var(--danger)":"var(--green)"}}>{exc}%</div></div>
        {[["cash","bud_cash"],["inkind","bud_inkind"],["ceiling","bud_ceiling"]].map(([f,lk])=>(
          <div key={f} className="mini-kpi">
            <div className="muted" style={{fontSize:11.5}}>{t(lk)} <span style={{opacity:.7}}>({cur} · M)</span></div>
            {user==="owner"
              ? <input className="input mono" style={{height:30,padding:"0 8px",marginTop:4,fontSize:14,width:"100%"}} type="number" value={bform[f]} onChange={e=>{setBform({...bform,[f]:e.target.value});setSaved(false);}}/>
              : <div className="v">{cur} {n0(budget[f])}<span className="muted" style={{fontSize:11,fontWeight:400}}> M</span></div>}
          </div>))}
      </div>
      {user==="owner"&&<div style={{display:"flex",alignItems:"center",gap:12,marginTop:12,flexWrap:"wrap"}}>
        <button className="btn sm" onClick={()=>{saveBudget({cash:+bform.cash,inkind:+bform.inkind,ceiling:+bform.ceiling});setSaved(true);}}>💾 {t("saveBalance")}</button>
        {saved&&<span className="chip">✓ {t("done")}</span>}
        <span className="muted" style={{fontSize:12}}>{t("enteredBy")}: {t(budget.enteredBy)} · {budget.enteredAt}</span>
      </div>}
      {budget.daysSince>30&&<div className="banner" style={{marginTop:12,background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("budStale")}</div>}
    </Section>
    <Section title="BIDSC" right={<AgentBadge name={t("agent_data")} lvl="L1"/>}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:6}}>
        <div style={{flex:1}}><Progress v={prog/100}/></div>
        <span className="chip">{running?(t("writingBidsc")+" "+prog+"%"):("✓ "+t("bidscDone"))}</span>
      </div>
      {ranOnce&&done&&<div className="muted" style={{fontSize:12,marginTop:8}}>✓ {t("cycleDone")}</div>}
    </Section>
    {running&&<div className="skel-area">
      <div className="cols-3">
        {[0,1,2].map(i=>(<div key={i} className="skel-card">
          <div className="skel-bar w50"/><div className="skel-bar w85"/><div className="skel-bar w65"/><div className="skel-bar w40"/>
        </div>))}
      </div>
    </div>}
    <div className="dr-funnel" aria-hidden="true">
      <svg className="dr-funnel-svg" viewBox="0 0 200 56" width="160" height="44">
        <defs><linearGradient id="fnlG" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="var(--green)" stopOpacity="0.10"/><stop offset="100%" stopColor="var(--green)" stopOpacity="0.34"/>
        </linearGradient></defs>
        <path d="M20 54 L180 54 L116 26 L84 26 Z" fill="url(#fnlG)" stroke="var(--green)" strokeOpacity="0.22"/>
        <path className="fnl-arrow" d="M72 28 L100 4 L128 28 Z" fill="var(--green)"/>
      </svg>
      <span className="dr-funnel-cap">{t("srcFlowCap")}</span>
    </div>
    <div className="src-group">
      <div className="src-group-head"><strong>{t("srcGroup")}</strong><span className="chip">● {sources.length} {t("connected")}</span></div>
      <div className={"cols-3"+(flash?" flash-sources":"")}>
      {sources.map(s=>{
        const tone=s.status==="ok"?"var(--green)":"var(--amber)";
        const excHigh=s.exc>10; const excCol=excHigh?"var(--danger)":"var(--green)";
        return (<div key={s.key} className="card pad">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <strong>{t("src_"+s.key)}</strong>
            <span className="chip" style={{background:tone+"22",color:tone}}>● {statusToText(t,s.status)}</span></div>
          <div className="kv">
            <div className="kv-row"><span className="muted">{t("records")}</span><span className="mono">{n0(s.records)}</span></div>
            <div className="kv-row"><span className="muted">{t("freq")}</span><span>{s.freq}</span></div>
            <div className="kv-row"><span className="muted">{t("lastUpdate")}</span><span>{s.updated}</span></div>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,margin:"10px 0 4px"}}>
            <span className="muted">{t("completeness")}</span><span className="mono">{s.completeness}%</span></div>
          <Progress v={s.completeness/100} color="var(--info)"/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,margin:"8px 0 4px"}}>
            <span className="muted">{t("exceptions")} <span style={{opacity:.7}}>(≤ 10%)</span></span><span className="mono" style={{color:excCol,fontWeight:700}}>{s.exc}%</span></div>
          <Progress v={Math.min(1,s.exc/15)} color={excCol}/>
          {excHigh&&<div className="muted" style={{fontSize:11,marginTop:6,color:"var(--danger)"}}>⚠ {t("qExc")}</div>}
        </div>);
      })}
      </div>
    </div>
    <Section title={t("dl_title")}>
      <div className="lineage">
        <div className="ln-node">BIDSC</div>
        <span className="ln-arrow">→</span>
        <span className={"chip "+(avgComp>=90?"":"amber")} style={{flex:"0 0 auto"}}>{avgComp>=90?("● "+t("dl_go")):("● "+t("dl_hold"))}</span>
        <span className="ln-arrow">→</span>
        <div className="ln-node">{t("dl_opt")}</div>
        <div className="ln-node">{t("dl_fc")}</div>
        <div className="ln-node">{t("dl_track")}</div>
      </div>
    </Section>
    {showUp&&<Modal title={t("importTitle")} onClose={()=>{setShowUp(false);setFile(null);setChk(null);}}>
      <div className={"dropzone"+(over?" over":"")}
        onDragOver={e=>{e.preventDefault();setOver(true);}}
        onDragLeave={()=>setOver(false)}
        onDrop={e=>{e.preventDefault();setOver(false);const f=e.dataTransfer.files&&e.dataTransfer.files[0];if(f)pickFile(f.name);}}
        onClick={()=>fileRef.current&&fileRef.current.click()}>
        <div className="di">⬆</div>
        <div style={{fontWeight:700}}>{t("dropHint")}</div>
        <input ref={fileRef} type="file" style={{display:"none"}} onChange={e=>{const f=e.target.files&&e.target.files[0];if(f)pickFile(f.name);}}/>
      </div>
      {file&&<div style={{marginTop:16}}>
        <div style={{fontSize:13,marginBottom:10}}><b>{t("fileLabel")}:</b> {file}</div>
        {checking ? <div className="ai-working">⟳ {t("validating")}</div>
          : chk && <div>
            <div className="cols-3" style={{marginBottom:12}}>
              <div className="mini-kpi"><div className="muted">{t("records")}</div><div className="v">{n0(chk.recs)}</div></div>
              <div className="mini-kpi"><div className="muted">{t("completeness")}</div><div className="v" style={{color:chk.comp>=90?"var(--green)":"var(--danger)"}}>{chk.comp}%</div></div>
              <div className="mini-kpi"><div className="muted">{t("exceptions")}</div><div className="v" style={{color:chk.ex<=10?"var(--green)":"var(--danger)"}}>{chk.ex}%</div></div>
            </div>
            <div className="banner" style={chk.valid?{}:{background:"var(--danger-50)",borderColor:"#f0b4ad",color:"#7a241d"}}>{chk.valid?("✓ "+t("checkPass")):("✕ "+t("checkFail"))}</div>
            {chk.valid && <button className="btn" style={{marginTop:12,width:"100%",justifyContent:"center"}} onClick={doImport}>⬆ {t("importBtn")}</button>}
          </div>}
      </div>}
    </Modal>}
  </div>);
}

/* ---- Allocation ---- */
const ALLOC_VSPREV=[82,58,-21,-34,12,-8,15];
function Allocation(){
  const {t,user,allocation,recalcAlloc,submitAlloc,actAlloc,setRoute}=useStore(); const {moneyFull}=useMoney();
  const [open,setOpen]=useState(null);
  const [busy,setBusy]=useState(false); const [note,setNote]=useState(""); const [err,setErr]=useState(false);
  const [gates,setGates]=useState({a:false,b:false,c:false}); const allGates=gates.a&&gates.b&&gates.c;
  const [annoOpen,setAnnoOpen]=useState(null);
  const a=allocation||{lastSync:"—",recalcAt:null,status:"draft",rejectNote:""};
  const data=BASELINE;
  function doRecalc(){ setBusy(true); setTimeout(()=>{ recalcAlloc&&recalcAlloc(); setBusy(false); },900); }
  function doReject(){ if(!note.trim()){ setErr(true); return; } actAlloc&&actAlloc("reject",note.trim()); setNote(""); setErr(false); }
  const cmap={draft:"gray",submitted:"info",approved:"",rejected:"danger"};
  const statusChip=<span className={"chip "+(cmap[a.status]||"")}>{t("allocStatus_"+a.status)}</span>;
  return (<div className="fade">
    <PageHeader title={t("nav_alloc")} sub={t("alloc_sub")} right={statusChip}/>
    <Section title={t("alloc_autosync")}>
      <div className="cols-3" style={{marginBottom:14}}>
        <div><div className="muted" style={{fontSize:12}}>{t("lastSyncAt")}</div><div style={{fontWeight:700,marginTop:3}}>{a.lastSync}</div></div>
        <div><div className="muted" style={{fontSize:12}}>{t("lastRecalc")}</div><div style={{fontWeight:700,marginTop:3}}>{a.recalcAt||"—"}</div></div>
        <div><div className="muted" style={{fontSize:12}}>{t("status")}</div><div style={{marginTop:5}}><span className={"chip "+(cmap[a.status]||"")}>{t("allocStatus_"+a.status)}</span></div></div>
      </div>
      {a.status==="rejected"&&a.rejectNote&&<div className="banner" style={{marginBottom:12,background:"var(--danger-50)",borderColor:"#f0b4ad",color:"#7a241d"}}>✕ {t("rejectReason")}: {a.rejectNote}</div>}
      {user==="analyst"&&(a.status==="draft"||a.status==="rejected")&&<div className="gate-box">
        {[["a","al_gate1"],["b","al_gate2"],["c","al_gate3"]].map(([g,lk])=>(
          <label key={g} className="gate-row"><input type="checkbox" checked={gates[g]} onChange={e=>setGates({...gates,[g]:e.target.checked})}/> {t(lk)}</label>))}
        {!allGates&&<div className="muted" style={{fontSize:11.5,marginTop:4}}>{t("al_gateHint")}</div>}
      </div>}
      {user==="analyst"&&<div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <button className="btn secondary sm" onClick={doRecalc} disabled={busy}>{busy?t("recalculating"):("↻ "+t("recalc"))}</button>
        {(a.status==="draft"||a.status==="rejected")&&<button className="btn sm" onClick={()=>submitAlloc&&submitAlloc()} disabled={!allGates}>✔ {t("approveSubmit")}</button>}
        {a.status==="submitted"&&<span className="chip info">⏳ {t("allocStatus_submitted")}</span>}
        {a.status==="approved"&&<span className="chip">✓ {t("allocStatus_approved")}</span>}
      </div>}
      {user==="owner"&&(a.status==="submitted"?<div>
        <input className="input" placeholder={t("rejectReasonPh")} value={note} onChange={e=>{setNote(e.target.value);setErr(false);}} style={{marginBottom:err?4:10}}/>
        {err&&<div style={{color:"var(--danger)",fontSize:12,marginBottom:8}}>{t("needReason")}</div>}
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button className="btn sm" onClick={()=>actAlloc&&actAlloc("approve")}>✔ {t("approve")}</button>
          <button className="btn danger sm" onClick={doReject}>✕ {t("reject")}</button>
        </div>
      </div> : a.status==="approved"?<span className="chip">✓ {t("allocStatus_approved")}</span>
        : a.status==="rejected"?<span className="chip danger">✕ {t("allocStatus_rejected")}</span>
        : <div className="muted" style={{fontSize:13}}>{t("notSubmittedYet")}</div>)}
    </Section>
    <Section title={<span className="sect-right">{t("monthlyCycle")}<InfoTip text={t("fml_alloc")}/></span>} right={<span className="sect-right"><span className="chip">{t("kpi_budget")}: {(data.spend/(BRD.phase3BudgetSAR/BRD.phase3Years)*100).toFixed(0)}%</span><AgentBadge name={t("agent_alloc")} lvl="L2"/></span>}>
      <div className="scrollx"><table className="tbl">
        <thead><tr><th>{t("incomeBand")}</th><th className="right-num">{t("contracts")}</th><th className="right-num">{t("subsidy")}</th><th className="right-num">{t("share")}</th><th className="right-num">{t("al_vsPrev")}</th><th></th></tr></thead>
        <tbody>{data.rows.map((r,i)=>{ const dv=r.subsidy>0?ALLOC_VSPREV[i%ALLOC_VSPREV.length]:null; return (<React.Fragment key={r.key}>
          <tr>
            <td>{bandLabel(t,r.key)} {r.below?<span className="chip gray" style={{marginInlineStart:6}}>{t("below10k")}</span>:null}</td>
            <td className="right-num mono">{n0(r.contracts)}</td>
            <td className="right-num mono">{moneyFull(r.subsidy)}</td>
            <td className="right-num mono">{(r.cShare*100).toFixed(1)}%</td>
            <td className="right-num mono" style={{color:dv==null?"var(--muted)":dv>0?"var(--amber)":"var(--green)",fontSize:12}}>{dv==null?"—":(dv>0?"▲ +":"▼ ")+"⃁ "+Math.abs(dv)}</td>
            <td className="right-num"><button className="btn sm" onClick={()=>setOpen(open===i?null:i)}>{t("explain")}</button></td>
          </tr>
          {open===i&&<tr className="expand-row"><td colSpan={6}>
            <div style={{fontSize:12.5}}>
              <div className="alx-grid">
                <div><div className="alx-h">{t("alx_how")}</div><div className="muted">{t("alx_howT")}</div></div>
                <div><div className="alx-h">{t("alx_why")}</div><div className="muted">{bandLabel(t,r.key)} — {r.below?t("below10k"):t("above10k")} · {t("subsidy")} {moneyFull(r.subsidy)}</div></div>
                <div><div className="alx-h">{t("alx_impact")}</div><div className="muted">HBR {pct1(r.hbr)} · {t("kpi_fairness")} {BASELINE.FG.toFixed(2)} · {t("share")} {(r.cShare*100).toFixed(1)}%</div></div>
              </div>
              {dv!=null&&<div style={{marginTop:8}}><b>{t("al_vsPrev")}:</b> <span className="mono" style={{color:dv>0?"var(--amber)":"var(--green)"}}>{(dv>0?"+":"")}⃁ {dv}</span> <span className="muted">— {t("alx_reason")}</span></div>}
              <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
                <button className="btn secondary sm" onClick={()=>setRoute&&setRoute("whatif")}>✦ {t("wf_runHint")}</button>
                <button className="btn ghost sm" onClick={()=>setAnnoOpen(annoOpen===i?null:i)}>🏷️ {t("alx_annotate")}</button>
              </div>
              {annoOpen===i&&<textarea className="input" placeholder={t("alx_annoPh")} style={{marginTop:8,minHeight:54,width:"100%"}}/>}
              <div className="trace">
                <div style={{fontWeight:700,fontSize:12,marginBottom:6}}>▶ {t("al_showTrace")}</div>
                <div className="trace-step"><span className="ts-dot"/><div><b>{t("agent_data")}</b> · L1<br/><span className="muted">{t("tr_data")}</span></div></div>
                <div className="trace-step"><span className="ts-dot"/><div><b>{t("agent_alloc")}</b> · L2<br/><span className="muted">{t("tr_opt")}</span></div></div>
                <div className="trace-step"><span className="ts-dot"/><div><b>{t("agent_alloc")}</b> · L2<br/><span className="muted">{t("tr_type")}</span></div></div>
              </div>
            </div></td></tr>}
        </React.Fragment>);})}</tbody>
      </table></div>
    </Section>
  </div>);
}

/* ---- Forecast & Fairness ---- */
function ForecastFairness(){
  const {t,user,leaks,leakAct}=useStore(); const {money}=useMoney();
  const scn=BASELINE; const fc=useMemo(()=>buildForecast(scn),[]);
  const regions=useMemo(()=>fgByRegion(scn.FG),[]);
  const [dim,setDim]=useState("region");
  const [view,setView]=useState("bar");
  const dimData={
    region: regions.map(r=>({name:t("rg_"+r.key),fg:r.fg})),
    income: [["<5k",0.51],["5–10k",0.72],["10–15k",1.02],["15–20k",1.18],[">20k",1.25]].map(([n,f])=>({name:n,fg:f})),
    loan: [["<15y",0.83],["15–20y",0.96],["20–25y",1.08],[">25y",1.14]].map(([n,f])=>({name:n,fg:f})),
    age: [["<30",0.74],["30–40",0.91],["40–50",1.05],[">50",1.16]].map(([n,f])=>({name:n,fg:f})),
  };
  const fgData=dimData[dim];
  const [fcView,setFcView]=useState("monthly");
  const mdata=[...fc.months.map(x=>({label:"M"+x.m, mProj:x.projected})), ...fc.fc.map(x=>({label:"M"+x.m, fProj:x.proj, lo:x.lo, hi:x.hi}))];
  mdata[11].fProj=fc.months[11].projected;
  const cdata=[...fc.months.map(x=>({label:"M"+x.m, cum:x.cumulative, ceiling:x.ceiling})), ...fc.fc.map(x=>({label:"M"+x.m, cum:x.cumulative, ceiling:x.ceiling}))];
  const C=RC; const ok=!!RC.ResponsiveContainer;
  const noChart=<div className="muted" style={{padding:20}}>Chart library unavailable (offline). Data is still computed correctly.</div>;
  return (<div className="fade">
    <PageHeader title={t("nav_forecast")} sub={t("forecast_sub")}/>
    {fc.alertMonth&&<div className="alert-strong fade">
      <span className="alert-ico">⚠</span>
      <div style={{flex:1}}>
        <div className="alert-title">{t("alertTitle")} · M{fc.alertMonth}</div>
        <div className="alert-body">{t("alertMsg")}</div>
      </div>
      <span className="alert-pill">{t("alert")}</span>
    </div>}
    <Section title={<span className="sect-right">{t("spendForecast")}<InfoTip text={t("fml_forecast")}/></span>} right={<span className="sect-right">
      <button className={"btn sm "+(fcView==="monthly"?"":"secondary")} onClick={()=>setFcView("monthly")}>{t("fc_monthly")}</button>
      <button className={"btn sm "+(fcView==="cum"?"":"secondary")} onClick={()=>setFcView("cum")}>{t("fc_cumulative")}</button>
      <AgentBadge name={t("agent_forecast")} lvl="L2"/></span>}>
      <div style={{width:"100%",height:280}}>
        {!ok? noChart : fcView==="monthly"?
        <C.ResponsiveContainer>
          <C.LineChart data={mdata} margin={{top:8,right:16,left:8,bottom:4}}>
            <C.CartesianGrid strokeDasharray="3 3" stroke="#eef2ef"/>
            <C.XAxis dataKey="label" tick={{fontSize:10}}/>
            <C.YAxis tickFormatter={abbr} tick={{fontSize:10}} width={48}/>
            <C.Tooltip formatter={(v)=>money(v)}/>
            <C.ReferenceLine y={fc.monthlyCeiling*0.9} stroke="#b3261e" strokeDasharray="5 4" label={{value:"90%",fontSize:10,fill:"#b3261e"}}/>
            <C.ReferenceLine y={fc.monthlyCeiling*0.7} stroke="#9a6b00" strokeDasharray="5 4" label={{value:"70%",fontSize:10,fill:"#9a6b00"}}/>
            <C.Line type="monotone" dataKey="hi" stroke="#b9c4bd" strokeDasharray="2 3" strokeWidth={1} dot={false} name={t("fc_ci")} connectNulls/>
            <C.Line type="monotone" dataKey="lo" stroke="#b9c4bd" strokeDasharray="2 3" strokeWidth={1} dot={false} connectNulls/>
            <C.Line type="monotone" dataKey="mProj" stroke="#006C35" strokeWidth={2.4} dot={false} name={t("fc_actual")} connectNulls/>
            <C.Line type="monotone" dataKey="fProj" stroke="#006C35" strokeDasharray="5 4" strokeWidth={2} dot={false} name={t("fc_forecast")} connectNulls/>
          </C.LineChart>
        </C.ResponsiveContainer> :
        <C.ResponsiveContainer>
          <C.LineChart data={cdata} margin={{top:8,right:16,left:8,bottom:4}}>
            <C.CartesianGrid strokeDasharray="3 3" stroke="#eef2ef"/>
            <C.XAxis dataKey="label" tick={{fontSize:10}}/>
            <C.YAxis tickFormatter={abbr} tick={{fontSize:10}} width={48}/>
            <C.Tooltip formatter={(v)=>money(v)}/>
            <C.ReferenceLine y={fc.annualCeiling*0.9} stroke="#b3261e" strokeDasharray="5 4" label={{value:"90%",fontSize:10,fill:"#b3261e"}}/>
            <C.ReferenceLine y={fc.annualCeiling*0.7} stroke="#9a6b00" strokeDasharray="5 4" label={{value:"70%",fontSize:10,fill:"#9a6b00"}}/>
            <C.Line type="monotone" dataKey="cum" stroke="#006C35" strokeWidth={2.4} dot={false} name={t("kpi_budget")} connectNulls/>
            <C.Line type="monotone" dataKey="ceiling" stroke="#b3261e" strokeDasharray="5 4" strokeWidth={2} dot={false} name={t("budgetCeiling")} connectNulls/>
          </C.LineChart>
        </C.ResponsiveContainer>}
      </div>
    </Section>
    <Section title={<span className="sect-right">{t("fairnessByRegion")}<InfoTip text={t("fml_fg")}/></span>} right={<AgentBadge name={t("agent_fair")} lvl="L3"/>}>
      <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
        {[["region","fgdim_region"],["income","fgdim_income"],["loan","fgdim_loan"],["age","fgdim_age"]].map(([k,lk])=>(
          <button key={k} className={"btn sm "+(dim===k?"":"secondary")} onClick={()=>setDim(k)}>{t(lk)}</button>))}
        <span style={{flex:1}}/>
        <button className={"btn sm "+(view==="bar"?"":"secondary")} onClick={()=>setView("bar")}>▦ {t("fg_bar")}</button>
        <button className={"btn sm "+(view==="heat"?"":"secondary")} onClick={()=>setView("heat")}>▥ {t("fg_heat")}</button>
      </div>
      {view==="heat"
        ? <div className="fg-heat">{fgData.map((r,i)=>{ const c=r.fg>=1?"var(--green)":r.fg>=0.9?"var(--amber)":"var(--danger)"; return (
            <div key={i} className="fg-tile" style={{borderColor:c}}><div className="fgt-n">{r.name}</div><div className="fgt-v" style={{color:c}}>{r.fg.toFixed(2)}</div></div>);})}</div>
        : <div style={{width:"100%",height:300}}>
        {!ok? noChart :
        <C.ResponsiveContainer>
          <C.BarChart data={fgData} margin={{top:4,right:8,left:0,bottom:4}}>
            <C.CartesianGrid strokeDasharray="3 3" stroke="#eef2ef"/>
            <C.XAxis dataKey="name" tick={{fontSize:10}} interval={0} angle={-30} textAnchor="end" height={64}/>
            <C.YAxis tick={{fontSize:11}} domain={[0,1.4]}/>
            <C.Tooltip/>
            <C.ReferenceLine y={1.0} stroke="#006C35" strokeDasharray="4 4"/>
            <C.Bar dataKey="fg" radius={[3,3,0,0]}>
              {fgData.map((r,i)=><C.Cell key={i} fill={r.fg>=1?"#006C35":r.fg>=0.9?"#9a6b00":"#b3261e"}/>)}
            </C.Bar>
          </C.BarChart>
        </C.ResponsiveContainer>}
      </div>}
    </Section>
    <Section title={t("leakage")} sub={t("leak_routeHint")} right={<AgentBadge name={t("agent_fair")} lvl="L3"/>}>
      {leaks.map(l=>{
        const big=l.cases>100;
        const canA=user==="analyst"&&l.status==="detected";
        const canO=user==="owner"&&l.status==="submitted";
        const canM=user==="minister"&&l.status==="escalated";
        const sChip={detected:"gray",submitted:"info",adopted:"",escalated:"amber",adjudicated:"",rejected:"danger"};
        return (<div key={l.id} className="leak-card">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <span className="wo">#{l.id}</span>
              <span className={"chip "+l.sev}>{t("leakSev_"+l.sev)}</span>
              <strong style={{fontSize:13}}>{l.k}</strong>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span className="chip gray">{n0(l.cases)} {t("leak_cases")}</span>
              <span className={"chip "+(sChip[l.status]||"")}>{t("leakStatus_"+l.status)}</span>
            </div>
          </div>
          {big&&(l.status==="detected"||l.status==="submitted")&&<div className="banner" style={{marginTop:8}}>⚖ {t("leak_big")}</div>}
          {(canA||canO||canM)&&<div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10}}>
            {canA&&<button className="btn sm" onClick={()=>leakAct(l.id,"report")}>↑ {t("leak_report")}</button>}
            {canO&&big&&<button className="btn sm" onClick={()=>leakAct(l.id,"escalate")}>⚖ {t("escalate")}</button>}
            {canO&&!big&&<button className="btn sm" onClick={()=>leakAct(l.id,"adopt")}>✔ {t("approve")}</button>}
            {canO&&<button className="btn danger sm" onClick={()=>leakAct(l.id,"reject")}>✕ {t("reject")}</button>}
            {canM&&<button className="btn sm" onClick={()=>leakAct(l.id,"adjudicate")}>⚖ {t("adjudicate")}</button>}
            {canM&&<button className="btn danger sm" onClick={()=>leakAct(l.id,"reject")}>✕ {t("reject")}</button>}
          </div>}
          {l.history.length>0&&<div className="timeline" style={{marginTop:12}}>
            {l.history.map((h,i)=>(<div key={i} className="ev"><div style={{fontSize:12.5}}>
              <span className="tag">{t(h.role)}</span> <b>{t(LEAK_KIND_KEY[h.kind])}</b> {h.note?("· "+h.note):""}</div>
              <div className="muted" style={{fontSize:11}}>{h.ts}</div></div>))}
          </div>}
        </div>);
      })}
      <div className="muted" style={{fontSize:12,marginTop:10}}>{t("redline")}</div>
    </Section>
  </div>);
}

/* ---- Orchestration chain ---- */
// Smoothly rolling governmental metric (population / land / budget …). Rolls while active, locks to target otherwise.
function RollingMetric({active,target,format}){
  const [v,setV]=useState(target);
  useEffect(()=>{
    if(!active){ setV(target); return; }
    const id=setInterval(()=>setV(target*(0.35+Math.random()*1.3)),85);
    return ()=>clearInterval(id);
  },[active,target]);
  return <span className="chain-metric mono">{format(v)}</span>;
}
// Canvas particle field: glowing core particles + gravity links; on "converge" they collapse to the centre.
function ParticleField({mode}){
  const ref=useRef(null); const modeRef=useRef(mode);
  useEffect(()=>{ modeRef.current=mode; },[mode]);
  useEffect(()=>{
    const cv=ref.current; if(!cv) return; const ctx=cv.getContext("2d"); if(!ctx) return;
    const dpr=window.devicePixelRatio||1;
    const cw=cv.clientWidth||600, ch=170;
    cv.width=cw*dpr; cv.height=ch*dpr; ctx.scale(dpr,dpr);
    const KPIS=[{l:"Eligible",v:"1.4M"},{l:"Contracts",v:"510K"},{l:"Budget",v:"7.9B"},{l:"Savings",v:"3.4B"},{l:"Fairness",v:"1.05"},{l:"HBR",v:"33%"},{l:"Ownership",v:"70%"}];
    const N=KPIS.length, cx=cw/2, cy=ch/2;
    const P=Array.from({length:N},(_,i)=>({x:Math.random()*cw,y:Math.random()*ch,vx:(Math.random()-.5)*.6,vy:(Math.random()-.5)*.6,r:9+Math.random()*3,glow:.5,bright:0,kpi:KPIS[i]}));
    let raf, lastGrow=0;
    function frame(now){
      const conv=modeRef.current==="converge";
      ctx.clearRect(0,0,cw,ch);
      for(let i=0;i<N;i++)for(let j=i+1;j<N;j++){ const a=P[i],b=P[j]; const d=Math.hypot(a.x-b.x,a.y-b.y);
        if(d<165){ ctx.strokeStyle="rgba(27,131,84,"+(0.20*(1-d/165))+")"; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); } }
      if(!conv && now-lastGrow>650){ lastGrow=now; const p=P[(Math.random()*N)|0]; p.bright=1; p.r=Math.min(13,p.r+1.3); }
      P.forEach((p,i)=>{
        if(conv){ p.x+=(cx-p.x)*0.08; p.y+=(cy-p.y)*0.08; p.glow=Math.min(1,p.glow+0.03); p.r+=(2.5-p.r)*0.05; }
        else{ p.vx+=(cx-p.x)*0.00018+(Math.random()-.5)*0.07; p.vy+=(cy-p.y)*0.00018+(Math.random()-.5)*0.07; p.vx*=0.95; p.vy*=0.95; p.x+=p.vx; p.y+=p.vy;
          if(p.x<10){p.x=10;p.vx*=-1;} if(p.x>cw-10){p.x=cw-10;p.vx*=-1;} if(p.y<10){p.y=10;p.vy*=-1;} if(p.y>ch-10){p.y=ch-10;p.vy*=-1;}
          p.glow=0.5+0.3*Math.sin(now/380+i)+0.4*p.bright; p.bright*=0.96; }
        const r=p.r;
        const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,r*4.5);
        g.addColorStop(0,"rgba(27,131,84,"+Math.min(0.6,0.5*p.glow)+")"); g.addColorStop(1,"rgba(27,131,84,0)");
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(p.x,p.y,r*4.5,0,7); ctx.fill();
        ctx.fillStyle="rgba(8,93,58,0.95)"; ctx.beginPath(); ctx.arc(p.x,p.y,r,0,7); ctx.fill();
        if(!conv){ ctx.textAlign="center";
          ctx.fillStyle="#fff"; ctx.font="700 10px Arial"; ctx.fillText(p.kpi.v, p.x, p.y+3);
          ctx.fillStyle="rgba(8,59,52,0.92)"; ctx.font="600 9px Arial"; ctx.fillText(p.kpi.l, p.x, p.y+r+11);
        }
      });
      if(conv){ const g=ctx.createRadialGradient(cx,cy,0,cx,cy,46); g.addColorStop(0,"rgba(248,198,48,0.55)"); g.addColorStop(1,"rgba(248,198,48,0)"); ctx.fillStyle=g; ctx.beginPath(); ctx.arc(cx,cy,46,0,7); ctx.fill(); }
      raf=requestAnimationFrame(frame);
    }
    raf=requestAnimationFrame(frame);
    return ()=>cancelAnimationFrame(raf);
  },[]);
  return <canvas ref={ref} className="pfield"/>;
}
function OrchestrationChain({states}){
  const {t}=useStore(); const {money}=useMoney();
  const nodes=[
    { k:"ag_uc01", labelKey:"budgetCeiling", target:BRD.phase3BudgetSAR/BRD.phase3Years, fmt:money },
    { k:"ag_uc03", labelKey:"contracts",     target:ANNUAL_CONTRACTS,                     fmt:n0 },
    { k:"ag_uc04", labelKey:"kpi_savings",   target:scenarioSavings(computeAllocation(RECO_PARAMS)).phase, fmt:money },
    { k:"ag_uc08", labelKey:"kpi_fairness",  target:1.05,                                 fmt:(v)=>Number(v).toFixed(2) },
  ];
  return (<div className="chain">
    {nodes.map((nd,i)=>{ const s=states[i]||"idle";
      const col=s==="done"?"var(--green)":s==="run"?"#6d5ae6":null;
      return (<div key={nd.k} className={"node "+(s==="run"?"run":s==="done"?"done":"")}>
        <span className="node-dot" style={{background:col||"#cbd5d0"}}/>
        <span style={{flex:1,fontSize:13,fontWeight:600,color:col||"inherit",transition:"color .3s ease"}}>{t(nd.k)}</span>
        <span className="node-metric"><span className="ml">{t(nd.labelKey)}</span> <RollingMetric active={s==="run"} target={nd.target} format={nd.fmt}/></span>
        <span className="st" style={{color:col||"var(--muted)"}}>
          {s==="run"?t("running"):s==="done"?("✓ "+t("done")):"—"}</span>
      </div>); })}
  </div>);
}

/* ---- What-if — centerpiece ---- */
function WhatIf(){
  const {t,setRoute,addPackage,user}=useStore(); const {money}=useMoney();
  const [p,setP]=useState({reallocatePct:0,capHighPct:0,boostLowPct:0,offPlanPct:0});
  const [nl,setNl]=useState("");
  const [scenType,setScenType]=useState("tactical");
  const [chain,setChain]=useState(["idle","idle","idle","idle"]);
  const [busy,setBusy]=useState(false);
  const [flash,setFlash]=useState(false);
  const [phase,setPhase]=useState(null);
  const [evP,setEvP]=useState(null);      // params of the LAST run — drives the AI assessment
  const [leverFlash,setLeverFlash]=useState(false);
  const scn=useMemo(()=>computeAllocation(p),[p]);
  const sv=scenarioSavings(scn);
  const C=RC;
  const ev=useMemo(()=>{
    if(!evP) return {tone:"info", text:t("ai_start")};
    const a=computeAllocation(evP), s=scenarioSavings(a);
    const fg=a.FG, hbr=a.HBR, save=money(s.phase), pct=Math.round(s.pctOfBudget*100);
    const fmt=(k,v)=>t(k).replace(/\{(\w+)\}/g,(_,x)=>v[x]!==undefined?v[x]:"{"+x+"}");
    if(evP.boostLowPct>0.15 && s.pctOfBudget<0.10) return {tone:"warn", text:fmt("ai_tradeoff",{hbr:pct1(hbr),save})};
    if(fg>=0.95 && s.pctOfBudget>=0.15) return {tone:"good", text:fmt("ai_win",{save,pct,fg:fg.toFixed(2)})};
    if(fg<0.90) return {tone:"warn", text:fmt("ai_fairlow",{fg:fg.toFixed(2)})};
    let txt=fmt("ai_neutral",{save,fg:fg.toFixed(2),hbr:pct1(hbr)});
    if(evP.reallocatePct>0.2) txt+=" "+t("ai_minister");
    return {tone:"info", text:txt};
  },[evP,t,money]);
  function animateChain(then,finalP){
    setBusy(true); setPhase("run");
    [0,1,2,3].forEach((i)=>{
      setTimeout(()=>{ setChain(c=>{const n=[...c];n[i]="run";return n;}); },i*450);
      setTimeout(()=>{ setChain(c=>{const n=[...c];n[i]="done";return n;}); if(i===3){setBusy(false); then&&then(); setEvP(finalP||p); setFlash(true); setPhase("converge"); setTimeout(()=>{setFlash(false); setPhase(null);},1300);} },i*450+380);
    });
  }
  function runSim(){ animateChain(null,p); }
  function applyReco(){ const next={...RECO_PARAMS}; setLeverFlash(false); animateChain(()=>{setP(next); setLeverFlash(true); setTimeout(()=>setLeverFlash(false),1100);}, next); }
  function runNL(){
    // light NL parse: first number → boost <10k; mention of cap/reduce → cap; else recommended preset
    const m=nl.match(/(\d+)\s*%?/); const num=m?clamp(parseInt(m[1])/100,0,0.45):0.10;
    const next={...RECO_PARAMS, boostLowPct:num};
    if(/cap|reduce|تقييد|خفض/i.test(nl)) next.capHighPct=0.20;
    animateChain(()=>{setP(next); setLeverFlash(true); setTimeout(()=>setLeverFlash(false),1100);}, next);
  }
  function assemble(){
    const affectsCap = p.capHighPct>0 || p.reallocatePct>0.20;
    addPackage({
      title: t("scenario")+" · "+new Date().toLocaleDateString(),
      params:{...p}, affectsCap,
      kpis:{ savingsPhase:sv.phase, pctBudget:sv.pctOfBudget, fg:scn.FG, hbr:scn.HBR },
    });
    setRoute("packages");
  }
  const blowBase=BASELINE.rows.filter(r=>r.below).reduce((s,r)=>s+r.contracts,0);
  const blowScn=scn.rows.filter(r=>r.below).reduce((s,r)=>s+r.contracts,0);
  const reclassified=Math.round(Math.abs(p.reallocatePct)*8500);
  const cmp=[
    {k:t("kpi_savings"),b:money(0),a:money(sv.phase),tone:"good"},
    {k:t("cmp_contractsLow"),b:n0(blowBase),a:n0(blowScn),tone:"good"},
    {k:t("kpi_fairness"),b:BASELINE.FG.toFixed(2),a:scn.FG.toFixed(2),tone:scn.FG>=1?"good":"warn"},
    {k:t("kpi_hbr"),b:pct1(BASELINE.HBR),a:pct1(scn.HBR),tone:"good"},
    {k:t("cmp_commit"),b:money(BASELINE.spend*15),a:money(scn.spend*15),tone:"good"},
  ];
  const leverDefs=[{lk:"lv_realloc",field:"reallocatePct",max:30},{lk:"lv_cap",field:"capHighPct",max:35},{lk:"lv_boost",field:"boostLowPct",max:45},{lk:"lv_offplan",field:"offPlanPct",max:20}];
  const saveOver=sv.phase>SAVINGS_CEIL;
  return (<div className="fade">
    <PageHeader title={t("nav_whatif")} sub={t("whatif_sub")}/>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,flexWrap:"wrap"}}>
      <span className="banner" style={{flex:1,margin:0,minWidth:240}}>🧪 {t("whatif_sandbox")}</span>
      <select className="input" style={{width:"auto"}} value={scenType} onChange={e=>setScenType(e.target.value)}>
        <option value="tactical">{t("st_tactical")}</option>
        <option value="strategic">{t("st_strategic")}</option>
        <option value="macro">{t("st_macro")}</option>
      </select>
    </div>
    <Section title={t("orchestration")} right={<AgentBadge name={t("agent_orch")}/>}>
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <input className="input" style={{flex:1}} placeholder={t("nlPlaceholder")} value={nl} onChange={e=>setNl(e.target.value)}/>
        <button className="btn btn-ai" style={{flexShrink:0,minWidth:170,justifyContent:"center",textAlign:"center",fontWeight:700}} onClick={runNL} disabled={busy}>✦ {t("askAI")}</button>
      </div>
      {busy&&<div className="ai-working">✦ {t("aiWorking")}</div>}
      <OrchestrationChain states={chain}/>
    </Section>
    <div className="cols-2">
      <Section className="lever-card" title={t("levers")} right={<button className="btn secondary sm" onClick={runSim} disabled={busy}>{busy?t("running"):t("runLevers")}</button>}>
        {leverDefs.map(d=>(<div key={d.field} className={"field"+(leverFlash?" lever-flash":"")}>
          <label style={{display:"flex",justifyContent:"space-between"}}><span>{t(d.lk)}</span><span className="mono">{Math.round(p[d.field]*100)}%</span></label>
          <input className="range" type="range" min="0" max={d.max} step="1" value={Math.round(p[d.field]*100)}
            onChange={e=>setP({...p,[d.field]:parseInt(e.target.value)/100})}/></div>))}
        <div className={"ai-eval "+ev.tone}>
          <div className="ai-eval-top"><span className="ai-eval-ic">✦</span><span className="ai-eval-h">{t("ai_title")}</span></div>
          <div className="ai-eval-t" style={busy?{color:"#6d5ae6"}:undefined}>{busy?t("aiWorking"):ev.text}</div>
          {evP&&!busy&&<button className="ai-eval-btn" onClick={applyReco}>✦ {t("applyReco")}</button>}
        </div>
      </Section>
      <div>
        <div className={"cols-3"+(flash?" flash-kpis":"")} style={{marginBottom:16}}>
          <KPI label={t("kpi_savings")} value={money(sv.phase)} sub={saveOver?t("save_over"):(sv.pctOfBudget*100).toFixed(0)+"% "+t("of_budget")} tone={saveOver?"warn":"good"}/>
          <KPI label={t("kpi_fairness")} value={scn.FG.toFixed(2)} sub={t("fair_if")} tone={scn.FG>=1?"good":"warn"}/>
          <KPI label={t("kpi_hbr")} value={pct1(scn.HBR)} sub={t("toTarget")} tone="good"/>
        </div>
        <Section title={<span className="sect-right">{t("compare")}<InfoTip text={t("fml_savings")}/></span>} sub={t("compareNote")}>
          <table className="tbl"><thead><tr><th></th><th className="right-num">{t("current")}</th><th className="right-num">{t("scenario")}</th></tr></thead>
            <tbody>{cmp.map((r,i)=>(<tr key={i}><td>{r.k}</td><td className="right-num mono muted">{r.b}</td>
              <td className="right-num mono" style={{fontWeight:700,color:r.tone==="good"?"var(--green)":"var(--amber)"}}>{r.a}</td></tr>))}</tbody></table>
          <div className="muted" style={{fontSize:12.5,marginTop:10}}>{t("cmp_recls")}: <b style={{color:"var(--green)"}}>{n0(reclassified)}</b></div>
        </Section>
      </div>
    </div>
    {user==="analyst"&&<button className="btn" style={{marginTop:4}} onClick={assemble}>📦 {t("assembleFromHere")}</button>}
  </div>);
}

/* ---- Decision packages (role-aware) ---- */
function statusChip(t,s){
  const map={draft:"gray",submitted:"info",approved:"",escalated:"amber",adjudicated:"",rejected:"danger"};
  return <span className={"chip "+(map[s]||"")}>{t("pkgStatus_"+s)}</span>;
}
function leverSummary(t,p){
  const o=[];
  if(p.reallocatePct) o.push([t("lv_realloc"), Math.round(p.reallocatePct*100)+"%"]);
  if(p.capHighPct)    o.push([t("lv_cap"),     Math.round(p.capHighPct*100)+"%"]);
  if(p.boostLowPct)   o.push([t("lv_boost"),   Math.round(p.boostLowPct*100)+"%"]);
  if(p.offPlanPct)    o.push([t("lv_offplan"), Math.round(p.offPlanPct*100)+"%"]);
  return o;
}
function PackageCard({pkg}){
  const {t,user,actOnPackage}=useStore(); const {money}=useMoney();
  const [note,setNote]=useState("");
  const canOwner = user==="owner" && pkg.status==="submitted";
  const canMin = user==="minister" && pkg.status==="escalated";
  const levers=leverSummary(t,pkg.params||{});
  return (<div className="card pad acc" style={{marginBottom:14}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
      <div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
          <span className="wo">#{pkg.id}</span>{statusChip(t,pkg.status)}
        </div>
        <strong>{pkg.title}</strong>
      </div>
      <div className="muted" style={{fontSize:11,textAlign:"end",whiteSpace:"nowrap"}}>{pkg.history[0]&&pkg.history[0].ts}</div>
    </div>
    <div className="pkg-detail">
      <div className="muted" style={{fontSize:12,marginBottom:6}}>{t("leversUsed")}</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
        {levers.length? levers.map((l,i)=><span key={i} className="chip gray">{l[0]} <b style={{marginInlineStart:4}}>{l[1]}</b></span>)
          : <span className="muted" style={{fontSize:12}}>{t("noLevers")}</span>}
      </div>
      <div className="cols-3">
        <div className="mini-kpi"><div className="muted">{t("kpi_savings")}</div><div className="v" style={{color:"var(--green)"}}>{money(pkg.kpis.savingsPhase)}</div></div>
        <div className="mini-kpi"><div className="muted">{t("kpi_fairness")}</div><div className="v">{pkg.kpis.fg.toFixed(2)}</div></div>
        <div className="mini-kpi"><div className="muted">{t("kpi_hbr")}</div><div className="v">{pct1(pkg.kpis.hbr)}</div></div>
      </div>
    </div>
    {(pkg.status==="submitted"||pkg.status==="escalated")&&typeof pkg.sla==="number"&&(()=>{
      const win=pkg.status==="submitted"?48:72; const left=Math.max(0,pkg.sla); const used=Math.min(1,(win-left)/win);
      const col=left<=0?"var(--danger)":left<12?"var(--danger)":left<24?"var(--amber)":"var(--green)";
      return (<div style={{marginTop:12}}>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}>
          <span className="muted">⏱ {t("sla_window")} ({win}h)</span>
          <span className="mono" style={{color:col,fontWeight:700}}>{left<=0?t("sla_overdue"):(left+"h "+t("sla_left"))}</span>
        </div>
        <div className="progress"><span style={{width:(used*100)+"%",background:col}}/></div>
      </div>);
    })()}
    {pkg.affectsCap&&pkg.status!=="adjudicated"&&pkg.status!=="rejected"&&
      <div className="banner" style={{marginTop:10}}>⚖ {t("needsMinister")}</div>}
    {(canOwner||canMin)&&<div style={{marginTop:12}}>
      <input className="input" placeholder={t("reject")} value={note} onChange={e=>setNote(e.target.value)} style={{marginBottom:10}}/>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {canOwner&&!pkg.affectsCap&&<button className="btn" onClick={()=>actOnPackage(pkg.id,"approve",note)}>✔ {t("approve")}</button>}
        {canOwner&&pkg.affectsCap&&<button className="btn" onClick={()=>actOnPackage(pkg.id,"escalate",note)}>⚖ {t("escalate")}</button>}
        {canOwner&&<button className="btn danger" onClick={()=>actOnPackage(pkg.id,"reject",note)}>✕ {t("reject")}</button>}
        {canMin&&<button className="btn" onClick={()=>actOnPackage(pkg.id,"adjudicate",note)}>⚖ {t("adjudicate")}</button>}
        {canMin&&<button className="btn danger" onClick={()=>actOnPackage(pkg.id,"reject",note)}>✕ {t("reject")}</button>}
      </div>
    </div>}
    <div className="timeline" style={{marginTop:14}}>
      {pkg.history.map((h,i)=>(<div key={i} className="ev"><div style={{fontSize:12.5}}>
        <span className="tag">{t(h.role)}</span> <b>{t(h.action)}</b> {h.note?("· "+h.note):""}</div>
        <div className="muted" style={{fontSize:11}}>{h.ts}</div></div>))}
    </div>
  </div>);
}
function DecisionPackages({filter}){
  const {t,packages}=useStore();
  const list=packages.filter(filter||(()=>true));
  return (<div className="fade">
    <PageHeader title={t("nav_packages")} sub={t("pkg_sub")} right={<AgentBadge name={t("agent_route")} lvl="L3"/>}/>
    {list.length===0? <div className="card pad muted">{t("noItems")}</div>
      : list.map(p=><PackageCard key={p.id} pkg={p}/>)}
  </div>);
}

/* ---- Owner home ---- */
function OwnerHome(){
  const {t,packages,setRoute}=useStore();
  const pending=packages.filter(p=>p.status==="submitted").length;
  return (<div className="fade">
    <PageHeader title={t("home_hello")+" · "+t("owner_full")} sub={t("approvals_sub")}/>
    <div className="cols-4" style={{marginBottom:16}}>
      <KPI label={t("kpi_pending")} value={pending} tone={pending?"warn":"good"}/>
      <KPI label={t("kpi_fairness")} value={BASELINE.FG.toFixed(2)} sub={t("fair_if")} tone="bad"/>
      <KPI label={t("kpi_hbr")} value={pct1(BASELINE.HBR)} tone="warn"/>
      <KPI label={t("kpi_adoption")} value="65%" sub={t("target")+" 75%"}/>
    </div>
    <Section title={t("nav_approvals")} right={<button className="btn sm" onClick={()=>setRoute("approvals")}>{t("view")} {ArrowIcon}</button>}>
      <div className="muted">{pending? (pending+" · "+t("pkgStatus_submitted")) : t("noItems")}</div>
    </Section>
  </div>);
}

/* ---- Minister cockpit ---- */
function MinisterHome(){
  const {t,packages,setRoute}=useStore(); const {money}=useMoney();
  const approved=packages.filter(p=>p.status==="approved"||p.status==="adjudicated");
  const totalSavings=approved.reduce((s,p)=>s+p.kpis.savingsPhase,0);
  const pending=packages.filter(p=>p.status==="escalated").length;
  return (<div className="fade">
    <PageHeader title={t("nav_cockpit")+" · "+t("minister_full")} sub={t("cockpit_sub")}/>
    <div className="cols-4" style={{marginBottom:16}}>
      <KPI label={t("phaseSavings")} value={money(totalSavings)} sub={(totalSavings/BRD.phase3BudgetSAR*100).toFixed(0)+"% "+t("of_budget")} tone="good"/>
      <KPI label={t("kpi_fairness")} value={BASELINE.FG.toFixed(2)} sub={t("fair_if")} tone="bad"/>
      <KPI label={t("ownership")} value={pct1(BRD.ownershipNow)} sub={t("target")+" "+pct1(BRD.ownershipTarget)}/>
      <KPI label={t("kpi_pending")} value={pending} tone={pending?"warn":"good"}/>
    </div>
    <Section title={t("contractsTarget")}>
      <div className="muted" style={{marginBottom:8}}>{n0(BRD.targetContractsTotal)} ({t("target")})</div>
      <Progress v={0.0}/>
      <div style={{display:"flex",gap:16,marginTop:10,flexWrap:"wrap"}}>
        <span className="chip">REDF {n0(BRD.targetBreakdown.redf)}</span>
        <span className="chip">ZATCA {n0(BRD.targetBreakdown.zatca)}</span>
        <span className="chip">Dev. {n0(BRD.targetBreakdown.devHousing)}</span>
      </div>
    </Section>
    <Section title={t("nav_decisions")} right={<button className="btn sm" onClick={()=>setRoute("decisions")}>{t("view")} {ArrowIcon}</button>}>
      <div className="muted">{pending? (pending+" · "+t("pkgStatus_escalated")) : t("noItems")}</div>
    </Section>
  </div>);
}

/* ---- Audit trail ---- */
function Modal({title,onClose,children}){
  return (<div className="modal-ov" onClick={onClose}>
    <div className="modal-box fade" onClick={e=>e.stopPropagation()}>
      <div className="modal-head"><h3>{title}</h3><button className="modal-x" onClick={onClose} aria-label="close">✕</button></div>
      <div className="modal-body">{children}</div>
    </div>
  </div>);
}
function AuditTrailPage(){
  const {t,audit,packages}=useStore(); const {money}=useMoney();
  const [sel,setSel]=useState(null);
  const pkg = sel ? packages.find(p=>p.id===sel) : null;
  const levers = pkg ? leverSummary(t,pkg.params||{}) : [];
  return (<div className="fade">
    <PageHeader title={t("nav_audit")} sub={t("audit_sub")}/>
    <div className="card pad">
      {audit.length===0? <div className="muted">{t("noItems")}</div> :
      <div className="scrollx"><table className="tbl">
        <thead><tr>
          <th>{t("workOrder")}</th><th>{t("level")}</th><th>{t("action")}</th>
          <th>{t("colStatus")}</th><th>{t("time")}</th><th>{t("note")}</th>
        </tr></thead>
        <tbody>{audit.map((a,i)=>(<tr key={i}>
          <td className="mono"><button className="wo wo-btn" onClick={()=>setSel(a.target)} title={t("auditDetail")}>#{a.target}<svg className="wo-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg></button></td>
          <td><span className="tag">{t(a.role)}</span></td>
          <td>{t(a.action)}</td>
          <td>{a.status? statusChip(t,a.status) : "—"}</td>
          <td className="muted" style={{whiteSpace:"nowrap"}}>{a.ts}</td>
          <td className="muted">{a.note||"—"}</td>
        </tr>))}</tbody>
      </table></div>}
      {audit.length>0&&<div className="muted" style={{fontSize:12,marginTop:10}}>{t("openHint")}</div>}
    </div>
    {pkg && <Modal title={t("auditDetail")} onClose={()=>setSel(null)}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:10}}>
        <span className="wo">#{pkg.id}</span>{statusChip(t,pkg.status)}
      </div>
      <h4 style={{margin:"0 0 14px",fontSize:16}}>{pkg.title}</h4>
      <div className="muted" style={{fontSize:12,marginBottom:6}}>{t("leversUsed")}</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:14}}>
        {levers.length? levers.map((l,i)=><span key={i} className="chip gray">{l[0]} <b style={{marginInlineStart:4}}>{l[1]}</b></span>)
          : <span className="muted" style={{fontSize:12}}>{t("noLevers")}</span>}
      </div>
      <div className="cols-3" style={{marginBottom:16}}>
        <div className="mini-kpi"><div className="muted">{t("kpi_savings")}</div><div className="v" style={{color:"var(--green)"}}>{money(pkg.kpis.savingsPhase)}</div></div>
        <div className="mini-kpi"><div className="muted">{t("kpi_fairness")}</div><div className="v">{pkg.kpis.fg.toFixed(2)}</div></div>
        <div className="mini-kpi"><div className="muted">{t("kpi_hbr")}</div><div className="v">{pct1(pkg.kpis.hbr)}</div></div>
      </div>
      <div className="divider"/>
      <div className="muted" style={{fontSize:12,marginBottom:10}}>{t("nav_audit")}</div>
      <div className="timeline">
        {pkg.history.map((h,i)=>(<div key={i} className="ev"><div style={{fontSize:12.5}}>
          <span className="tag">{t(h.role)}</span> <b>{t(h.action)}</b> {h.note?("· "+h.note):""}</div>
          <div className="muted" style={{fontSize:11}}>{h.ts}</div></div>))}
      </div>
    </Modal>}
  </div>);
}

/* ---- Copilot handoff ---- */
function CopilotHandoff(){
  const {t,audit}=useStore(); const {money}=useMoney();
  const [sent,setSent]=useState(false);
  function deliver(){ setSent(true); setTimeout(()=>{ window.open("http://momah.test.hyrhui.com","_blank"); },700); }
  const recoSave=scenarioSavings(computeAllocation(RECO_PARAMS)).phase;
  return (<div className="fade">
    <PageHeader title={t("nav_copilot")} sub={t("copilot_sub")}/>
    <Section title={t("cop_sumTitle")} right={<AgentBadge name={t("agent_route")} lvl="L3"/>}>
      <div className="cols-2">
        <div className="brief-card"><div className="bh">📄 {t("cop_i1")}</div>
          <div className="bv">Package + Monthly</div>
          <div className="bs muted">5 support types · with rationale</div></div>
        <div className="brief-card"><div className="bh">📉 {t("cop_i2")}</div>
          <div className="bv">{pct1(BASELINE.HBR)} <span style={{color:"var(--muted)"}}>→</span> 33%</div>
          <div className="bs muted">{t("toTarget")}</div></div>
        <div className="brief-card"><div className="bh">⚖ {t("cop_i3")}</div>
          <div className="bv">{BASELINE.FG.toFixed(2)} <span style={{color:"var(--muted)"}}>→</span> ≥ 1.0</div>
          <div className="bs muted">multi-dimensional</div></div>
        <div className="brief-card"><div className="bh">✦ {t("cop_i4")}</div>
          <div className="bv">{money(recoSave)}</div>
          <div className="bs muted">latest scenario savings (5-yr)</div></div>
      </div>
      <div className="muted" style={{fontSize:12.5,marginTop:14}}><b>{t("cop_for")}:</b> {t("cop_aud")}</div>
      <div className="banner" style={{marginTop:10}}>● {t("cop_note")}</div>
    </Section>
    <Section title="API Contract → Housing Copilot" right={<span className="chip">🤝 {t("manualPush")}</span>}>
      <div className="muted" style={{marginBottom:12}}>{t("deliveredItems")} · response &lt; 30s</div>
      <button className="btn" onClick={deliver}>{sent?("… "+t("opening")):("🤝 "+t("deliver"))}</button>
      <div className="banner" style={{marginTop:14}}>● {t("redline")}</div>
    </Section>
  </div>);
}

/* ---- action labels (merged into i18n) ---- */
// Chinese dictionary — reachable only via URL ?ln=zh (no language button is exposed for it).
I18N.zh = {
  appName:"住房补贴动态分配与优化",
  sso_title:"统一身份登录", sso_sub:"统一访问市政与住房部数字服务。", identity:"身份",
  signInTitle:"登录", forgotPwd:"忘记密码？", securityCode:"验证码", or_:"或",
  nafath:"Nafath 国民统一登录", noAccount:"还没有账号？", createAccount:"创建新账号",
  nic1:"NIC", nic2:"国民身份证", identityPh:"选择身份",
  copyright:"© 2026 — 市政与住房部 · 住房支援署", brandLine:"住房补贴动态分配", login_btn:"登录",
  ministry:"市政与住房部", agency:"住房支援署", syntheticData:"合成演示数据 — 非真实受益人",
  login:"登录", username:"用户名", password:"密码", chooseRole:"选择演示身份",
  loginHint:"演示已预填密码（无真实认证）。", enter:"进入", logout:"退出登录", language:"语言", currency:"货币", resetDemo:"重置演示",
  analyst:"分析师", owner:"业务负责人", minister:"部长",
  analyst_full:"分析师", owner_full:"业务负责人", minister_full:"部长",
  analyst_desc:"运行分析与 What-if，组装并上报决策包。", owner_desc:"审阅并采纳战术级推荐。", minister_desc:"裁决战略事项（补贴上限 / 内部法规）。",
  nav_home:"仪表盘", nav_data:"数据就绪", nav_alloc:"配分方案", nav_forecast:"预测与公平",
  nav_whatif:"What-if 模拟", nav_packages:"决策包", nav_approvals:"审批中心",
  nav_audit:"审计轨迹", nav_copilot:"住房 Copilot", nav_cockpit:"战略驾驶舱", nav_decisions:"战略决策",
  kpi_savings:"预计节省（5年）", kpi_fairness:"公平性差距", kpi_hbr:"住房负担（HBR）",
  kpi_budget:"预算占用率", kpi_contracts:"契约达成进度", kpi_pending:"待决策项",
  kpi_forecastErr:"预测误差", kpi_dataReady:"数据就绪度", kpi_adoption:"采纳率",
  of_budget:"占 79 亿预算", target:"目标", baseline:"基线", current:"当前",
  fair_if:"≥ 1.0 视为公平", toTarget:"向 2030 目标 30–35%",
  explain:"查看理由", impact:"预测影响", submit:"组装并上报决策包", approve:"采纳",
  reject:"驳回并反馈", escalate:"上报部长", adjudicate:"裁决", view:"查看",
  run:"运行", running:"运行中…", done:"完成", apply:"应用", todo:"待办", status:"状态",
  region:"地区", incomeBand:"收入档", contracts:"契约数", subsidy:"平均支援", share:"占比",
  before:"前", after:"后", delta:"变化", scenario:"情景", recommended:"推荐",
  notifTitle:"决策包已上报", noItems:"暂无内容。",
  src_sakani:"Sakani 平台", src_redf:"房地产发展基金（REDF）", src_nhc:"国家住房公司（NHC）",
  src_rega:"房地产总局（Rega）", src_ncsi:"统计总局（NCSI）", src_sama:"中央银行（SAMA）",
  st_ok:"已更新", st_pending:"待批准", st_delayed:"延迟 3–6 个月", quality:"质量", freq:"更新频率",
  bl_lt5:"< 5,000", bl_5to8:"5,000–8,000", bl_8to10:"8,000–10,000",
  bl_10to13:"10,000–13,000", bl_13to16:"13,000–16,000", bl_gt16:"> 16,000",
  below10k:"1 万以下", above10k:"1 万以上",
  rg_riyadh:"利雅得", rg_makkah:"麦加", rg_eastern:"东部省", rg_madinah:"麦地那", rg_asir:"阿西尔",
  rg_qassim:"卡西姆", rg_tabuk:"塔布克", rg_hail:"哈伊勒", rg_jazan:"吉赞", rg_najran:"纳季兰",
  rg_bahah:"巴哈", rg_jawf:"焦夫", rg_northern:"北部边境",
  home_hello:"欢迎", monthlyCycle:"月度配分复核",
  data_sub:"每日自动循环清洗数据，并将价格与预算写入 BIDSC。",
  runCycle:"运行每日数据循环", writingBidsc:"写入 BIDSC", bidscDone:"BIDSC 已更新",
  alloc_sub:"在已批准政策矩阵内的可解释建议分配。",
  forecast_sub:"12 个月支出预测与预算上限，加多维公平性差距与漏损。",
  spendForecast:"支出预测（12 个月）", budgetCeiling:"预算上限", alert:"预警",
  alertMsg:"累计支出超过月度上限的 70% — 已发出预警。",
  fairnessByRegion:"各地区公平性差距", leakage:"漏损与不当受益信号",
  whatif_sub:"用自然语言提问或拖动杠杆——编排层调度智能体，KPI 实时更新。",
  nlPlaceholder:"例如：把 1 万以下家庭的支援上调 10%，评估影响",
  orchestration:"智能体编排", levers:"政策杠杆",
  lv_realloc:"再分配 >1万 → <1万", lv_cap:"封顶 >1万 支援", lv_boost:"提升 <1万 支援", lv_offplan:"限制期房（off-plan）",
  runWhatif:"运行模拟", compare:"基线 vs 情景", assembleFromHere:"由此情景组装决策包",
  pkg_sub:"组装已解释的决策包并沿决策链上报。",
  approvals_sub:"审阅分析师上报的战术级推荐。",
  cockpit_sub:"战略 KPI 与需部长裁决的事项。",
  decisions_sub:"上报待战略裁决的事项（补贴上限 / 内部法规）。",
  audit_sub:"每次提交、采纳、驳回、裁决都被记录。", auditDetail:"审计轨迹详情", openHint:"点击工单编号查看详情",
  copilot_sub:"经批准的输出通过 API 契约交付 Housing Copilot。",
  deliver:"交付至 Housing Copilot", opening:"正在打开 Housing Copilot…",
  redline:"系统只做推荐：永不自动审批、永不自动停补、永不修改法规。",
  pkgStatus_draft:"草稿", pkgStatus_submitted:"待业务负责人", pkgStatus_approved:"已采纳（战术）",
  pkgStatus_escalated:"待部长", pkgStatus_adjudicated:"已裁决", pkgStatus_rejected:"已驳回",
  needsMinister:"超出战术权限 — 涉及补贴上限。上报部长。",
  by:"由", at:"于", level:"级别", agentChain:"编排链路",
  ag_uc01:"补贴公式", ag_uc03:"优化", ag_uc04:"预测", ag_uc08:"公平",
  deliveredItems:"补贴推荐 · HBR · 公平性差距 · What-if 结果",
  annualSavings:"年度节省", phaseSavings:"5年节省", reviewRun:"审阅并运行 What-if",
  contractsTarget:"契约目标 2026–2030", ownership:"自有率",
  more:"更多", workOrder:"工单编号", colStatus:"状态", records:"记录数", vsPrev:"较上一循环",
  completeness:"完整度", lastUpdate:"最近更新", leversUsed:"所用杠杆", expectedImpact:"预期影响",
  alertTitle:"预算预警", quickActions:"快捷入口", action:"动作", time:"时间", note:"备注", noLevers:"无变化（基线）",
  td_alloc:"审阅本月配分方案", td_forecast:"处理支出预警", td_whatif:"运行利率情景的 What-if",
  td_packages:"上报已组装的决策包", td_copilot:"向 Housing Copilot 交付已批准输出",
  due_today:"今日到期", due_3:"3 项待处理", due_2:"2 项就绪", due_soon:"本周", due_1:"1 项待办",
  svc_section:"核心服务", btn_details:"详情", btn_open:"打开", aiWorking:"智能体编排中…", cycleDone:"循环完成 — 数据源已刷新",
  tag_auto:"每日自动", tag_monthly:"月度循环", tag_ai:"AI · 实时", tag_explain:"可解释", tag_audit:"已留痕", tag_api:"API 契约",
};
Object.assign(I18N.zh,{ act_submit:"已提交", act_approve:"已采纳（战术）", act_escalate:"已上报部长", act_adjudicate:"已裁决", act_reject:"已驳回" });
Object.assign(I18N.en,{ act_submit:"Submitted", act_approve:"Approved (tactical)", act_escalate:"Escalated to Minister", act_adjudicate:"Adjudicated", act_reject:"Rejected" });
Object.assign(I18N.ar,{ act_submit:"تم الرفع", act_approve:"اعتُمد (تكتيكي)", act_escalate:"رُفع للوزير", act_adjudicate:"تم البتّ", act_reject:"رُفض" });
Object.assign(I18N.en,{ alloc_autosync:"Monthly auto-sync · 1st at 06:00", lastSyncAt:"Last sync", recalc:"Recalculate", recalculating:"Recalculating…", lastRecalc:"Last recalculated", approveSubmit:"Approve & submit", allocStatus_draft:"Draft", allocStatus_submitted:"Awaiting Business Owner", allocStatus_approved:"Approved", allocStatus_rejected:"Rejected", rejectReason:"Rejection reason", rejectReasonPh:"Enter a reason for rejection…", needReason:"A rejection reason is required.", notSubmittedYet:"The analyst has not submitted the plan yet." });
Object.assign(I18N.zh,{ alloc_autosync:"月度自动同步 · 每月 1 日 06:00", lastSyncAt:"上次同步", recalc:"重算", recalculating:"重算中…", lastRecalc:"上次重算", approveSubmit:"审阅通过并上报", allocStatus_draft:"草稿", allocStatus_submitted:"待业务负责人", allocStatus_approved:"已采纳", allocStatus_rejected:"已驳回", rejectReason:"驳回理由", rejectReasonPh:"请填写驳回理由…", needReason:"请填写驳回理由。", notSubmittedYet:"分析师尚未上报该方案。" });
Object.assign(I18N.ar,{ alloc_autosync:"مزامنة شهرية تلقائية · اليوم 1 الساعة 06:00", lastSyncAt:"آخر مزامنة", recalc:"إعادة الحساب", recalculating:"جارٍ إعادة الحساب…", lastRecalc:"آخر إعادة حساب", approveSubmit:"اعتماد ورفع", allocStatus_draft:"مسودة", allocStatus_submitted:"بانتظار مالك الأعمال", allocStatus_approved:"معتمد", allocStatus_rejected:"مرفوض", rejectReason:"سبب الرفض", rejectReasonPh:"اكتب سبب الرفض…", needReason:"سبب الرفض مطلوب.", notSubmittedYet:"لم يرفع المحلل الخطة بعد." });
Object.assign(I18N.en,{ ff_how:"How it works · roles & data", ff_process:"Process", ff_processText:"Pull the actual distribution from BIDSC and compare it with the allocation plan → compute the multi-dimensional Fairness Gap → run leakage-detection models → produce the monthly report → route alerts to the decision chain.", ff_roles:"Roles", ff_inputs:"Data inputs", role_agent:"Agent (automatic)", role_audit:"Audit team", ff_agentDuty:"Computes the Fairness Gap, runs leakage models, produces the monthly report and alerts.", ff_analystDuty:"Reviews the Fairness Gap report and alerts; can trigger a check manually.", ff_ownerDuty:"Adopts action on detected leakage — a confirmed leak is escalated within 24h.", ff_ministerDuty:"Adjudicates large-scale leakage — over 100 cases, within 4h.", ff_auditDuty:"Reviews leakage reports; the monthly report is stored in the Audit Trail.", ff_inputBidsc:"Actual distribution (BIDSC)", ff_inputPlan:"Allocation plan", ff_inputSeg:"Income band & region", ff_inputTrack:"Beneficiary-review alerts", ff_sla:"Confirmed leak → Business Owner within 24h · Leak affecting >100 cases → Minister within 4h · Support is never auto-suspended — the decision is always human." });
Object.assign(I18N.zh,{ ff_how:"运作方式 · 分工与数据", ff_process:"流程", ff_processText:"从 BIDSC 取实际分配并与配分方案对比 → 计算多维公平性差距 → 跑漏损检测模型 → 出月度报告 → 将告警分级路由。", ff_roles:"分工", ff_inputs:"数据来源", role_agent:"智能体（自动）", role_audit:"审计团队", ff_agentDuty:"计算公平性差距、运行漏损模型、产出月度报告与告警。", ff_analystDuty:"审阅公平性差距报告与告警；可手工触发监测。", ff_ownerDuty:"对检测到的漏损采纳处置——确认漏损 24 小时内上报。", ff_ministerDuty:"裁决大规模漏损——超过 100 个案例，4 小时内升级。", ff_auditDuty:"复核漏损报告；月度报告存入审计轨迹。", ff_inputBidsc:"实际分配（BIDSC）", ff_inputPlan:"配分方案", ff_inputSeg:"收入档与地区", ff_inputTrack:"受益人复核告警", ff_sla:"确认漏损 → 业务负责人 24 小时内 · 影响 >100 案例 → 部长 4 小时内 · 绝不自动停补——决定永远在人。" });
Object.assign(I18N.ar,{ ff_how:"آلية العمل · الأدوار والبيانات", ff_process:"العملية", ff_processText:"سحب التوزيع الفعلي من BIDSC ومقارنته بخطة التخصيص ← حساب فجوة العدالة متعددة الأبعاد ← تشغيل نماذج كشف التسرب ← إنتاج التقرير الشهري ← توجيه التنبيهات.", ff_roles:"الأدوار", ff_inputs:"مصادر البيانات", role_agent:"الوكيل (آلي)", role_audit:"فريق التدقيق", ff_agentDuty:"يحسب فجوة العدالة، ويشغّل نماذج التسرب، ويُنتج التقرير الشهري والتنبيهات.", ff_analystDuty:"يراجع تقرير فجوة العدالة والتنبيهات؛ يمكنه تشغيل الفحص يدوياً.", ff_ownerDuty:"يعتمد إجراءً عند كشف تسرب — يُرفع التسرب المؤكد خلال ٢٤ ساعة.", ff_ministerDuty:"يبتّ في التسرب واسع النطاق — أكثر من ١٠٠ حالة، خلال ٤ ساعات.", ff_auditDuty:"يراجع تقارير التسرب؛ يُحفظ التقرير الشهري في سجل التدقيق.", ff_inputBidsc:"التوزيع الفعلي (BIDSC)", ff_inputPlan:"خطة التخصيص", ff_inputSeg:"شريحة الدخل والمنطقة", ff_inputTrack:"تنبيهات مراجعة المستفيدين", ff_sla:"تسرب مؤكد ← مالك الأعمال خلال ٢٤ ساعة · تسرب يؤثر على أكثر من ١٠٠ حالة ← الوزير خلال ٤ ساعات · لا يُوقف الدعم آلياً — القرار دائماً بشري." });
Object.assign(I18N.en,{ leak_report:"Report", leak_cases:"cases", leak_big:"Large-scale (>100 cases) — must escalate to the Minister", leak_routeHint:"Confirmed leak → Business Owner within 24h · >100 cases → Minister within 4h · Support is never auto-suspended.", leakSev_danger:"Confirmed", leakSev_amber:"Likely", leakSev_info:"Warning", leakStatus_detected:"Detected", leakStatus_submitted:"Awaiting Business Owner", leakStatus_adopted:"Action adopted", leakStatus_escalated:"Awaiting Minister", leakStatus_adjudicated:"Adjudicated", leakStatus_rejected:"Dismissed" });
Object.assign(I18N.zh,{ leak_report:"上报", leak_cases:"案例", leak_big:"大规模（>100 案例）— 必须上报部长", leak_routeHint:"确认漏损 → 业务负责人 24 小时内 · >100 案例 → 部长 4 小时内 · 绝不自动停补。", leakSev_danger:"确认", leakSev_amber:"疑似", leakSev_info:"警示", leakStatus_detected:"已检测", leakStatus_submitted:"待业务负责人", leakStatus_adopted:"已采纳处置", leakStatus_escalated:"待部长", leakStatus_adjudicated:"已裁决", leakStatus_rejected:"已驳回" });
Object.assign(I18N.ar,{ leak_report:"رفع", leak_cases:"حالات", leak_big:"واسع النطاق (>١٠٠ حالة) — يجب الرفع للوزير", leak_routeHint:"تسرب مؤكد ← مالك الأعمال خلال ٢٤ ساعة · >١٠٠ حالة ← الوزير خلال ٤ ساعات · لا يُوقف الدعم آلياً.", leakSev_danger:"مؤكد", leakSev_amber:"محتمل", leakSev_info:"تحذير", leakStatus_detected:"تم الكشف", leakStatus_submitted:"بانتظار مالك الأعمال", leakStatus_adopted:"تم اعتماد الإجراء", leakStatus_escalated:"بانتظار الوزير", leakStatus_adjudicated:"تم البتّ", leakStatus_rejected:"مرفوض" });
Object.assign(I18N.en,{ agent_auto:"auto", agent_forecast:"Forecasting & Flagging agent", agent_fair:"Fairness & Leakage agent", manualPush:"Manual push", srcGroup:"Source systems", connected:"connected", srcFlowCap:"ingested & validated → BIDSC" });
Object.assign(I18N.zh,{ agent_auto:"自动", agent_forecast:"支出预测与预警 agent", agent_fair:"公平与漏损监测 agent", manualPush:"手动推送", srcGroup:"源系统", connected:"已连接", srcFlowCap:"汇聚并校验 → BIDSC" });
Object.assign(I18N.ar,{ agent_auto:"آلي", agent_forecast:"وكيل التنبؤ والتنبيه", agent_fair:"وكيل العدالة والتسرب", manualPush:"دفع يدوي", srcGroup:"الأنظمة المصدر", connected:"متصل", srcFlowCap:"يُجمع ويُتحقق منه ← BIDSC" });
Object.assign(I18N.en,{ agent_data:"Data & Budget Update agent", agent_alloc:"Subsidy Optimization agent", agent_route:"Decision Routing agent", agent_orch:"Multi-agent orchestration",
  fml_fg:"Fairness Gap = (subsidy share to <10k) ÷ (population share of <10k). Fair when ≥ 1.0.",
  fml_hbr:"HBR = monthly housing cost (installment + upkeep) ÷ net monthly income. Target 30–35% by 2030.",
  fml_forecast:"12-month spend via OLS price-elasticity model (2017–2025 data). Early alert at 70% of the monthly ceiling.",
  fml_savings:"Savings = current-matrix spend − scenario spend, over the 5-year phase.",
  fml_commit:"Commitments to 2050 = projected total support outlay across the remaining phase.",
  fml_alloc:"Per band: max housing cost = disposable income × deduction rate (40% for >5k); monthly support = actual − optimal interest." });
Object.assign(I18N.zh,{ agent_data:"数据与预算更新 agent", agent_alloc:"补贴优化 agent", agent_route:"决策路由 agent", agent_orch:"多智能体编排",
  fml_fg:"公平性差距 =（<1万群体获得的支援占比）÷（<1万群体的人口占比）。≥ 1.0 视为公平。",
  fml_hbr:"HBR = 月度住房成本（月供 + 维护）÷ 净月收入。2030 目标 30–35%。",
  fml_forecast:"用 OLS 价格弹性模型（2017–2025 数据）预测 12 个月支出；累计达月度上限 70% 时预警。",
  fml_savings:"节省 = 当前矩阵支出 − 情景支出，按 5 年阶段计。",
  fml_commit:"至 2050 承诺 = 剩余阶段内预计的支援支出总额。",
  fml_alloc:"按收入档：最高住房成本 = 可支配收入 × 扣除率（>5千为 40%）；月度支援 = 实际利率 − 最优利率。" });
Object.assign(I18N.ar,{ agent_data:"وكيل تحديث البيانات والميزانية", agent_alloc:"وكيل تحسين الدعم", agent_route:"وكيل توجيه القرار", agent_orch:"تنسيق متعدد الوكلاء",
  fml_fg:"فجوة العدالة = (حصة الدعم لأقل من ١٠ك) ÷ (حصة سكان أقل من ١٠ك). عادلة عند ≥ ١٫٠.",
  fml_hbr:"HBR = تكلفة السكن الشهرية (القسط + الصيانة) ÷ صافي الدخل الشهري. المستهدف ٣٠–٣٥٪ بحلول ٢٠٣٠.",
  fml_forecast:"تنبؤ إنفاق ١٢ شهراً عبر نموذج OLS لمرونة السعر (بيانات ٢٠١٧–٢٠٢٥)؛ تنبيه مبكر عند ٧٠٪ من السقف الشهري.",
  fml_savings:"الوفورات = إنفاق المصفوفة الحالية − إنفاق السيناريو، على مدى ٥ سنوات.",
  fml_commit:"الالتزامات حتى ٢٠٥٠ = إجمالي إنفاق الدعم المتوقع للفترة المتبقية.",
  fml_alloc:"لكل شريحة: أقصى تكلفة سكن = الدخل المتاح × نسبة الخصم (٤٠٪ لأكثر من ٥ك)؛ الدعم الشهري = الفائدة الفعلية − المثلى." });
Object.assign(I18N.en,{ cop_sumTitle:"Delivery summary", cop_sumText:"After each approval, the outputs are delivered to Housing Copilot via the API Contract (< 30s) and surfaced in its presentation layer as a strategic brief.", cop_for:"For", cop_aud:"Minister · Business Owner · strategic decision-makers", cop_i1:"Support recommendation (type + amount + rationale)", cop_i2:"Current & projected HBR", cop_i3:"Fairness Gap (multi-dimensional)", cop_i4:"What-if results", cop_note:"Read-only consumption — Copilot never executes; decisions stay human." });
Object.assign(I18N.zh,{ cop_sumTitle:"交付摘要", cop_sumText:"每次批准后，输出通过 API 契约交付 Housing Copilot（< 30 秒），并在其展示层作为战略简报呈现。", cop_for:"供参考", cop_aud:"部长 · 业务负责人 · 战略决策层", cop_i1:"补贴推荐（类型 + 金额 + 理由）", cop_i2:"当前与预测 HBR", cop_i3:"公平性差距（多维）", cop_i4:"What-if 结果", cop_note:"只读消费 — Copilot 永不执行；决定始终在人。" });
Object.assign(I18N.ar,{ cop_sumTitle:"ملخص التسليم", cop_sumText:"بعد كل اعتماد، تُسلَّم المخرجات إلى مساعد الإسكان عبر عقد الـ API (< ٣٠ ثانية) وتُعرض في طبقة العرض كموجز استراتيجي.", cop_for:"للاطلاع", cop_aud:"الوزير · مالك الأعمال · صنّاع القرار الاستراتيجي", cop_i1:"توصية الدعم (النوع + المبلغ + المبرر)", cop_i2:"HBR الحالي والمتوقع", cop_i3:"فجوة العدالة (متعددة الأبعاد)", cop_i4:"نتائج المحاكاة", cop_note:"استهلاك للقراءة فقط — لا ينفّذ المساعد؛ القرار يبقى بشرياً." });
Object.assign(I18N.en,{ applyReco:"Apply AI suggestion", save_over:"⚠ Exceeds 43%", rel_title:"Release notes", rel_current:"Latest", rel_close:"Close", rel_tz:"All times in Saudi Arabia Standard Time (AST, UTC+3)" });
Object.assign(I18N.zh,{ applyReco:"应用 AI 建议", save_over:"⚠ 超出 43%", rel_title:"更新日志", rel_current:"最新", rel_close:"关闭", rel_tz:"时间均为沙特时间 (AST，UTC+3)" });
Object.assign(I18N.ar,{ applyReco:"تطبيق توصية الذكاء", save_over:"⚠ يتجاوز ٤٣٪", rel_title:"سجل الإصدارات", rel_current:"الأحدث", rel_close:"إغلاق", rel_tz:"جميع الأوقات بتوقيت السعودية (AST، UTC+3)" });
Object.assign(I18N.en,{ askAI:"Ask AI", runLevers:"Run with current levers", ai_title:"AI assessment", ai_start:"Drag the levers or use Ask AI to start a simulation — I'll assess the trade-offs.", ai_fairlow:"Fairness Gap is still {fg} (<1.0) — the low-income segment is still under-served. I'd raise ‘Reallocate’ or ‘Boost <10k’.", ai_tradeoff:"HBR improves to {hbr} and fairness rises, but boosting low-income support eats into savings (only {save}). I'd offset with a higher cap or off-plan restriction — or accept it as a people-first trade-off.", ai_win:"Savings {save} ({pct}% of budget) with Fairness Gap {fg} — fairness and savings both improve. I'd assemble the decision package and submit.", ai_neutral:"Current scenario: savings {save}, Fairness Gap {fg}, HBR {hbr}. You can fine-tune further or submit.", ai_minister:"Reallocation exceeds 20% — this needs the Minister's adjudication." });
Object.assign(I18N.zh,{ askAI:"Ask AI", runLevers:"按当前杠杆运行", ai_title:"AI 评估", ai_start:"拖动杠杆或用 Ask AI 开始推演 —— 我会评估其中的权衡。", ai_fairlow:"Fairness Gap 仍为 {fg}（<1.0），低收入群体仍偏少。建议提高‘再分配’或‘提升 <1万支援’。", ai_tradeoff:"HBR 降至 {hbr}、公平改善，但提升低收入支援吃掉了节省（仅 {save}）。建议适度提高封顶或限期房来对冲，或接受这是‘惠民优先’的取舍。", ai_win:"节省 {save}（占预算 {pct}%）同时 Fairness Gap 达 {fg}，公平与节流双赢，建议组装决策包并上报。", ai_neutral:"当前情景：节省 {save}、Fairness Gap {fg}、HBR {hbr}。可继续微调或上报。", ai_minister:"再分配超过 20%，按规则需上报部长裁决。" });
Object.assign(I18N.ar,{ askAI:"Ask AI", runLevers:"التشغيل بالروافع الحالية", ai_title:"تقييم الذكاء الاصطناعي", ai_start:"حرّك الروافع أو استخدم Ask AI لبدء المحاكاة — سأقيّم المفاضلات.", ai_fairlow:"فجوة العدالة لا تزال {fg} (<١٫٠) — الشريحة منخفضة الدخل ما زالت غير مخدومة. أنصح برفع ‘إعادة التوزيع’ أو ‘رفع دعم <١٠ك’.", ai_tradeoff:"يتحسّن HBR إلى {hbr} وترتفع العدالة، لكن رفع دعم منخفضي الدخل يستهلك الوفورات (فقط {save}). أنصح بتعويض ذلك برفع التقييد، أو قبولها كمفاضلة ‘الأولوية للناس’.", ai_win:"وفورات {save} ({pct}٪ من الميزانية) مع فجوة عدالة {fg} — تتحسّن العدالة والوفورات معاً. أنصح بتجميع حزمة القرار ورفعها.", ai_neutral:"السيناريو الحالي: وفورات {save}، فجوة العدالة {fg}، HBR {hbr}. يمكنك الضبط الدقيق أو الرفع.", ai_minister:"تتجاوز إعادة التوزيع ٢٠٪ — يتطلب ذلك بتّ الوزير." });
Object.assign(I18N.en,{ syncOk:"Daily data sync succeeded", syncFail:"Daily data sync failed", importTitle:"Import to BIDSC", dropHint:"Drag a file here, or click to choose", validating:"Validating data accuracy…", checkPass:"Validation passed — ready to import", checkFail:"Validation failed — completeness <90% or exceptions >10%", importBtn:"Import to BIDSC", fileLabel:"File" });
Object.assign(I18N.zh,{ syncOk:"每日数据同步成功", syncFail:"每日数据同步失败", importTitle:"导入到 BIDSC", dropHint:"拖拽文件到此，或点击选择", validating:"正在校验数据准确性…", checkPass:"校验通过 — 可导入", checkFail:"校验未通过 — 完整度 <90% 或异常 >10%", importBtn:"导入到 BIDSC", fileLabel:"文件" });
Object.assign(I18N.ar,{ syncOk:"نجحت المزامنة اليومية للبيانات", syncFail:"فشلت المزامنة اليومية للبيانات", importTitle:"استيراد إلى BIDSC", dropHint:"اسحب ملفاً هنا أو اضغط للاختيار", validating:"جارٍ التحقق من دقة البيانات…", checkPass:"اجتاز التحقق — جاهز للاستيراد", checkFail:"فشل التحقق — الاكتمال <٩٠٪ أو الاستثناءات >١٠٪", importBtn:"استيراد إلى BIDSC", fileLabel:"الملف" });
Object.assign(I18N.en,{ sla_window:"Response SLA", sla_left:"left", sla_overdue:"Overdue — escalated", cmp_commit:"Commitments to 2050", cmp_recls:"Households reclassified", cmp_contractsLow:"Contracts to <10k", compareNote:"Compared against the current approved plan (baseline).", notifications:"Notifications", noNotifs:"You're all caught up.", ntf_sla:"Decision package WO-2026-0309 awaiting approval · 8h left", ntf_leak:"Leakage LK-2026-021 escalated to the Minister", ntf_budget:"Budget balance not updated for 18 days", ntf_sync:"Daily data sync completed" });
Object.assign(I18N.zh,{ sla_window:"响应时限", sla_left:"剩余", sla_overdue:"已超时 — 已升级", cmp_commit:"至 2050 承诺", cmp_recls:"重新分类家庭数", cmp_contractsLow:"流向 <1万 合同", compareNote:"对照当前已批准方案（基线）。", notifications:"通知", noNotifs:"暂无新通知。", ntf_sla:"决策包 WO-2026-0309 待审批 · 剩余 8 小时", ntf_leak:"漏损 LK-2026-021 已升级至部长", ntf_budget:"预算余额已 18 天未更新", ntf_sync:"每日数据同步已完成" });
Object.assign(I18N.ar,{ sla_window:"مهلة الاستجابة", sla_left:"متبقٍ", sla_overdue:"تجاوز المهلة — تم التصعيد", cmp_commit:"الالتزامات حتى ٢٠٥٠", cmp_recls:"الأسر المُعاد تصنيفها", cmp_contractsLow:"عقود لأقل من ١٠ك", compareNote:"بالمقارنة مع الخطة المعتمدة الحالية (الأساس).", notifications:"الإشعارات", noNotifs:"لا إشعارات جديدة.", ntf_sla:"حزمة القرار WO-2026-0309 بانتظار الاعتماد · متبقٍ ٨ ساعات", ntf_leak:"التسرب LK-2026-021 صُعّد إلى الوزير", ntf_budget:"لم يُحدّث رصيد الميزانية منذ ١٨ يوماً", ntf_sync:"اكتملت المزامنة اليومية للبيانات" });
Object.assign(I18N.en,{ qreport:"Data quality report", totalRecords:"Total records", avgCompleteness:"Avg. completeness", exceptions:"Exceptions", thresholdNote:"Min. for BIDSC 90% · halts if exceptions >10%", qOk:"Within thresholds", qBelow:"Below 90% — analyst review required", qExc:"Exceptions >10% — update halted, analyst alerted", budgetBalance:"Budget balance", budgetSub:"Entered manually by the Business Owner from the official financial report.", bud_cash:"Cash support (monthly + package)", bud_inkind:"In-kind support (off-plan land discount)", bud_ceiling:"Interest support ceiling (bank agreements)", saveBalance:"Save balance", enteredBy:"Entered by", budStale:"No balance for >30 days — analyst & owner alerted.", ownerOnlyBudget:"Budget balance is entered by the Business Owner.", uploadBidsc:"Upload to BIDSC", uploadHint:"Manual upload until source integrations are ready.", uploadedOk:"uploaded to BIDSC", rulesTitle:"Key rules & exceptions", rule1:"Min. completeness to write BIDSC: 90% (adjustable).", rule2:"If exceptions exceed 10%, the update is halted and the analyst is alerted.", rule3:"If a source is unavailable, the last saved data is used with a warning.", rule4:"If no budget balance for 30+ days, analyst & owner are alerted.", rule5:"Allocation, Forecast & Beneficiary-tracking don't run until this cycle completes.", mSar:"M SAR" });
Object.assign(I18N.zh,{ qreport:"数据质量报告", totalRecords:"总记录数", avgCompleteness:"平均完整度", exceptions:"异常率", thresholdNote:"写入 BIDSC 最低 90% · 异常 >10% 即停止", qOk:"在门槛内", qBelow:"低于 90% — 需分析师复核", qExc:"异常 >10% — 更新已停止，已通知分析师", budgetBalance:"预算余额", budgetSub:"由业务负责人依据官方财务报告手工录入。", bud_cash:"现金支援预算（月度 + 套餐）", bud_inkind:"实物支援预算（期房土地折扣）", bud_ceiling:"利息支援上限（银行协议总额）", saveBalance:"保存余额", enteredBy:"录入人", budStale:"已超 30 天未录入余额 — 已告警分析师与业务负责人。", ownerOnlyBudget:"预算余额由业务负责人录入。", uploadBidsc:"上传到 BIDSC", uploadHint:"在数据源集成就绪前用手工上传。", uploadedOk:"已上传到 BIDSC", rulesTitle:"关键规则与异常", rule1:"写入 BIDSC 的最低完整度：90%（可调）。", rule2:"异常超过 10% 时停止更新并通知分析师。", rule3:"数据源不可用时，沿用最近一次有效数据并记警告。", rule4:"超过 30 天未录入预算余额，同时告警分析师与业务负责人。", rule5:"本循环未完成前，配分、预测、受益人追踪均不运行。", mSar:"百万 SAR" });
Object.assign(I18N.ar,{ qreport:"تقرير جودة البيانات", totalRecords:"إجمالي السجلات", avgCompleteness:"متوسط الاكتمال", exceptions:"الاستثناءات", thresholdNote:"الحد الأدنى لـ BIDSC ٩٠٪ · يتوقف إذا تجاوزت الاستثناءات ١٠٪", qOk:"ضمن الحدود", qBelow:"أقل من ٩٠٪ — يتطلب مراجعة المحلل", qExc:"الاستثناءات >١٠٪ — أُوقف التحديث وأُبلغ المحلل", budgetBalance:"رصيد الميزانية", budgetSub:"يُدخله مالك الأعمال يدوياً من التقرير المالي الرسمي.", bud_cash:"الدعم النقدي (شهري + باقة)", bud_inkind:"الدعم العيني (خصم أرض البيع على الخارطة)", bud_ceiling:"سقف دعم الفائدة (اتفاقيات البنوك)", saveBalance:"حفظ الرصيد", enteredBy:"أدخله", budStale:"لا رصيد منذ أكثر من ٣٠ يوماً — تم تنبيه المحلل ومالك الأعمال.", ownerOnlyBudget:"يُدخل رصيد الميزانية مالك الأعمال.", uploadBidsc:"رفع إلى BIDSC", uploadHint:"رفع يدوي حتى تجهز تكاملات المصادر.", uploadedOk:"تم الرفع إلى BIDSC", rulesTitle:"القواعد والاستثناءات الرئيسية", rule1:"الحد الأدنى للاكتمال للكتابة إلى BIDSC: ٩٠٪ (قابل للتعديل).", rule2:"إذا تجاوزت الاستثناءات ١٠٪ يتوقف التحديث ويُبلَّغ المحلل.", rule3:"إذا كان المصدر غير متاح، تُستخدم آخر بيانات محفوظة مع تحذير.", rule4:"إذا مرّ ٣٠+ يوماً دون رصيد، يُبلَّغ المحلل ومالك الأعمال.", rule5:"لا تعمل خطة التخصيص والتنبؤ وتتبع المستفيدين حتى تكتمل هذه الدورة.", mSar:"مليون ريال" });

function nowStr(lang){ return new Date().toLocaleString(lang==="ar"?"ar-SA":"en-GB",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}); }

/* ---- Leakage alerts: detected → analyst Report → Business Owner adopt/escalate → Minister adjudicate ---- */
const RAW_LEAKS = [
  { id:"LK-2026-021", k:"Riyadh · off-plan cluster",  sev:"danger", cases:140, status:"detected",  history:[] },
  { id:"LK-2026-022", k:"Makkah · duplicate benefit", sev:"amber",  cases:36,  status:"submitted", history:[{role:"analyst",kind:"report",ts:"02 Jun 09:10",note:""}] },
  { id:"LK-2026-023", k:"Eastern · price drift",      sev:"info",   cases:12,  status:"detected",  history:[] },
];
function seedLeaks(){ return RAW_LEAKS.map(l=>({ ...l, history:l.history.map(h=>({...h})) })); }
const LEAK_KIND_KEY = { report:"leak_report", adopt:"approve", escalate:"escalate", adjudicate:"adjudicate", reject:"reject" };

/* =========================================================================
   Seed mock data (work orders + audit trail) so every role page is populated.
   ========================================================================= */
const STATUS_OF = { act_submit:"submitted", act_approve:"approved", act_escalate:"escalated", act_adjudicate:"adjudicated", act_reject:"rejected" };
function makeKpis(params){ const s=computeAllocation(params); const sv=scenarioSavings(s);
  return { savingsPhase:sv.phase, pctBudget:sv.pctOfBudget, fg:s.FG, hbr:s.HBR }; }
const RAW_SEED = [
  { id:"WO-2026-0312", title:"Q2 reallocation · Riyadh & Makkah", params:{reallocatePct:0.10,boostLowPct:0.08,offPlanPct:0.05}, affectsCap:false, status:"submitted", sla:41,
    history:[{role:"analyst",action:"act_submit",ts:"03 Jun 09:12",note:""}] },
  { id:"WO-2026-0309", title:"Off-plan restriction · national", params:{offPlanPct:0.12,capHighPct:0.10}, affectsCap:true, status:"submitted", sla:8,
    history:[{role:"analyst",action:"act_submit",ts:"02 Jun 14:40",note:""}] },
  { id:"WO-2026-0305", title:"Monthly support rebalancing", params:{reallocatePct:0.12,boostLowPct:0.10,offPlanPct:0.06}, affectsCap:false, status:"approved",
    history:[{role:"analyst",action:"act_submit",ts:"28 May 10:05",note:""},{role:"owner",action:"act_approve",ts:"29 May 11:20",note:"Within tactical authority"}] },
  { id:"WO-2026-0299", title:"Support cap revision · >16k band", params:{capHighPct:0.22,reallocatePct:0.18}, affectsCap:true, status:"escalated", sla:50,
    history:[{role:"analyst",action:"act_submit",ts:"24 May 08:30",note:""},{role:"owner",action:"act_escalate",ts:"25 May 09:00",note:"Affects support cap"}] },
  { id:"WO-2026-0288", title:"Phase-3 fairness uplift", params:{reallocatePct:0.25,capHighPct:0.20,boostLowPct:0.15,offPlanPct:0.10}, affectsCap:true, status:"adjudicated",
    history:[{role:"analyst",action:"act_submit",ts:"18 May 09:00",note:""},{role:"owner",action:"act_escalate",ts:"19 May 10:00",note:""},{role:"minister",action:"act_adjudicate",ts:"21 May 12:30",note:"Approved with monitoring"}] },
  { id:"WO-2026-0276", title:"Aggressive cap scenario", params:{capHighPct:0.35,offPlanPct:0.20}, affectsCap:true, status:"rejected",
    history:[{role:"analyst",action:"act_submit",ts:"12 May 08:15",note:""},{role:"owner",action:"act_reject",ts:"13 May 09:40",note:"Too aggressive on >13k bands"}] },
];
function seedPackages(){ return RAW_SEED.map(p=>({ ...p, params:{...p.params}, history:p.history.map(h=>({...h})), kpis:makeKpis(p.params) })); }
function seedAudit(){ const out=[]; RAW_SEED.forEach(p=>p.history.forEach(h=>out.push({ role:h.role, action:h.action, target:p.id, status:STATUS_OF[h.action], ts:h.ts, note:h.note }))); return out.reverse(); }

/* ===== UC-05 Beneficiary Status Tracking (referral list) ===== */
const REFERRALS=[
  {id:"BEN****21",region:"Asir",band:"band_urgent",cur:36,start:52,source:"bt_gosi",months:3,status:"new"},
  {id:"BEN****08",region:"Riyadh",band:"band_low",cur:38,start:49,source:"bt_both",months:2,status:"monitoring"},
  {id:"BEN****55",region:"Makkah",band:"band_urgent",cur:33,start:47,source:"bt_housing",months:3,status:"new"},
  {id:"BEN****32",region:"Eastern",band:"band_low",cur:37,start:55,source:"bt_gosi",months:2,status:"monitoring"},
  {id:"BEN****19",region:"Qassim",band:"band_mid",cur:34,start:41,source:"bt_housing",months:3,status:"new"},
  {id:"BEN****77",region:"Madinah",band:"band_low",cur:35,start:46,source:"bt_both",months:3,status:"approved"},
];
function MiniTrend({start,cur}){
  const a=start,b=cur,m1=a-(a-b)*0.45,m2=a-(a-b)*0.75; const pts=[a,m1,m2,b];
  const mx=Math.max(...pts)+1,mn=Math.min(...pts)-2,W=280,H=72,step=W/(pts.length-1);
  const xy=pts.map((v,i)=>[i*step, H-((v-mn)/(mx-mn))*H]);
  const d=xy.map((p,i)=>(i?"L":"M")+p[0].toFixed(0)+" "+p[1].toFixed(0)).join(" ");
  return (<svg width={W} height={H} style={{display:"block",margin:"4px 0"}}>
    <path d={d} fill="none" stroke="var(--green)" strokeWidth="2.5"/>
    {xy.map((p,i)=><circle key={i} cx={p[0]} cy={p[1]} r="3.5" fill={i===xy.length-1?"var(--green)":"#9bc7b0"}/>)}
  </svg>);
}
function BeneficiaryTracking(){
  const {t}=useStore();
  const [list,setList]=useState(REFERRALS);
  const [busy,setBusy]=useState(false); const [sel,setSel]=useState(null);
  function runDetect(){ setBusy(true); setTimeout(()=>{
    setList(prev=>prev.map(b=>b.status==="monitoring"&&b.months<3?{...b,months:b.months+1}:b)
      .map(b=>b.status==="monitoring"&&b.months>=3?{...b,status:"new"}:b)); setBusy(false); },900); }
  function act(id,kind){ setList(prev=>prev.map(b=>b.id===id?{...b,status:kind==="refer"?"referred":"monitoring"}:b)); setSel(null); }
  const cnt=k=>list.filter(b=>b.status===k).length;
  const btChip=(s)=>{ const m={new:["bt_new",""],monitoring:["bt_review","info"],referred:["bt_referred","amber"],approved:["bt_approved",""]}; const [k,c]=m[s]; return <span className={"chip "+c}>{t(k)}</span>; };
  return (<div className="fade">
    <PageHeader title={t("nav_referrals")} sub={t("bt_sub")} right={<span className="sect-right">
      <button className="btn secondary sm" onClick={runDetect} disabled={busy}>{busy?t("running"):("⟳ "+t("bt_run"))}</button>
      <AgentBadge name={t("agent_track")} lvl="L1"/></span>}/>
    <div className="banner" style={{marginBottom:14}}>● {t("bt_redline")}</div>
    <div className="dr-strip" style={{marginBottom:14}}>
      {[["bt_new","new"],["bt_review","monitoring"],["bt_referred","referred"],["bt_approved","approved"]].map(([lk,k])=>(
        <div key={k} className="mini-kpi"><div className="muted" style={{fontSize:11.5}}>{t(lk)}</div><div className="v">{cnt(k)}</div></div>))}
    </div>
    <Section title={t("nav_referrals")} sub={t("bt_rule")}>
      <table className="tbl"><thead><tr>
        <th>{t("bt_id")}</th><th>{t("bt_region")}</th><th>{t("bt_band")}</th>
        <th className="right-num">{t("bt_curHBR")}</th><th className="right-num">{t("bt_startHBR")}</th>
        <th>{t("bt_source")}</th><th className="right-num">{t("bt_months")}</th><th>{t("bt_status")}</th><th></th></tr></thead>
        <tbody>{list.map(b=>(<tr key={b.id}>
          <td className="mono">{b.id}</td><td>{b.region}</td><td>{t(b.band)}</td>
          <td className="right-num mono" style={{color:"var(--green)",fontWeight:700}}>{b.cur}%</td>
          <td className="right-num mono muted">{b.start}%</td>
          <td>{t(b.source)}</td><td className="right-num mono">{b.months}/3</td>
          <td>{btChip(b.status)}</td>
          <td>{(b.status==="new"||b.status==="monitoring")&&<button className="btn ghost sm" onClick={()=>setSel(b)}>{t("bt_reviewBtn")}</button>}</td>
        </tr>))}</tbody></table>
    </Section>
    {sel&&<Modal title={t("bt_reviewTitle")+" · "+sel.id} onClose={()=>setSel(null)}>
      <div className="muted" style={{fontSize:13,marginBottom:8}}>{sel.region} · {t(sel.band)} · {t("bt_source")}: {t(sel.source)}</div>
      <div style={{fontSize:13,marginBottom:2,fontWeight:600}}>{t("bt_trend")}: <span className="mono muted">{sel.start}% → {sel.cur}%</span></div>
      <MiniTrend start={sel.start} cur={sel.cur}/>
      <div className="banner" style={{margin:"12px 0"}}>● {t("bt_redline")}</div>
      <div style={{display:"flex",gap:8}}>
        <button className="btn" onClick={()=>act(sel.id,"refer")}>↗ {t("bt_refer")}</button>
        <button className="btn secondary" onClick={()=>act(sel.id,"keep")}>{t("bt_keep")}</button>
      </div>
    </Modal>}
  </div>);
}

/* ===== UC-12 International Benchmarking ===== */
const BENCH=[
  {dim:"bm_hbr", ksa:40.5, target:34,  oecd:30,  best:25,  lowBetter:true,  unit:"%"},
  {dim:"bm_fair",ksa:0.58, target:1.0, oecd:0.90, best:1.10, lowBetter:false, unit:""},
  {dim:"bm_cov", ksa:65,   target:80,  oecd:72,  best:88,  lowBetter:false, unit:"%"},
  {dim:"bm_cost",ksa:1.0,  target:0.85,oecd:0.80, best:0.70, lowBetter:true,  unit:"x"},
  {dim:"bm_sat", ksa:3.9,  target:4.3, oecd:4.1, best:4.6, lowBetter:false, unit:"/5"},
];
const BM_PROGRAMS=[{k:"bmp_sg",tone:"good"},{k:"bmp_de",tone:"good"},{k:"bmp_uk",tone:"warn"},{k:"bmp_us",tone:"gray"}];
function Benchmarking(){
  const {t}=useStore(); const [gen,setGen]=useState(false);
  const meets=(b)=> b.lowBetter ? b.ksa<=b.target : b.ksa>=b.target;
  const cmpMax=(b)=>Math.max(b.ksa,b.oecd,b.best,b.target)*1.05;
  return (<div className="fade">
    <PageHeader title={t("nav_benchmark")} sub={t("bm_sub")} right={<span className="sect-right">
      <button className="btn secondary sm" onClick={()=>setGen(true)}>📄 {t("bm_gen")}</button>
      <AgentBadge name={t("agent_bench")} lvl="L2"/></span>}/>
    {gen&&<div className="banner" style={{marginBottom:14}}>✓ {t("bm_done")}</div>}
    <Section title={t("nav_benchmark")} sub={t("bm_dimsNote")}>
      <table className="tbl"><thead><tr>
        <th>{t("bm_dim")}</th><th className="right-num">{t("bm_ksa")}</th><th className="right-num">{t("bm_ksaTarget")}</th>
        <th className="right-num">{t("bm_oecd")}</th><th className="right-num">{t("bm_best")}</th><th>{t("bm_gap")}</th></tr></thead>
        <tbody>{BENCH.map(b=>{ const ok=meets(b); return (<tr key={b.dim}>
          <td>{t(b.dim)} <span className="muted" style={{fontSize:11}}>({t(b.lowBetter?"bm_low":"bm_high")})</span></td>
          <td className="right-num mono" style={{fontWeight:700,color:ok?"var(--green)":"var(--amber)"}}>{b.ksa}{b.unit}</td>
          <td className="right-num mono muted">{b.target}{b.unit}</td>
          <td className="right-num mono">{b.oecd}{b.unit}</td>
          <td className="right-num mono">{b.best}{b.unit}</td>
          <td><span className={"chip "+(ok?"":"amber")}>{ok?("✓ "+t("bm_meets")):t("bm_below")}</span></td>
        </tr>);})}</tbody></table>
    </Section>
    <Section title={t("bm_cmpTitle")} sub={t("bm_cmpNote")}>
      {BENCH.map(b=>{ const mx=cmpMax(b); const bar=(v,c)=>(<div className="bmbar-row"><span className="bmbar-lab muted">{c}</span><span className="bmbar"><span style={{width:(v/mx*100)+"%",background:c===t("bm_ksa")?"var(--info)":c===t("bm_best")?"var(--green)":"#c8cfd9"}}/></span><span className="bmbar-val mono">{v}{b.unit}</span></div>);
        return (<div key={b.dim} style={{marginBottom:14}}>
          <div style={{fontWeight:600,fontSize:13,marginBottom:6}}>{t(b.dim)}</div>
          {bar(b.ksa,t("bm_ksa"))}{bar(b.oecd,t("bm_oecd"))}{bar(b.best,t("bm_best"))}
        </div>);})}
    </Section>
    <Section title={t("bm_applic")}>
      <div className="cols-2">
        {BM_PROGRAMS.map(p=>(<div key={p.k} className={"insight-card "+p.tone}>
          <div className="ic-h">{t(p.k+"_h")}</div>
          <div className="ic-t">{t(p.k+"_t")}</div>
          <span className={"chip "+(p.tone==="good"?"":p.tone==="warn"?"amber":"gray")}>{t(p.k+"_tag")}</span>
        </div>))}
      </div>
    </Section>
    <Section title={t("bm_satTitle")}>
      <div className="muted" style={{fontSize:13,lineHeight:1.7}}>{t("bm_note")}</div>
    </Section>
  </div>);
}
Object.assign(I18N.en,{ bm_cmpTitle:"KSA vs OECD vs best-in-class", bm_cmpNote:"Normalised per dimension", bm_applic:"Reference programs — applicability",
  bmp_sg_h:"Singapore · CPF Housing Grant", bmp_sg_t:"Mandatory savings co-fund home purchase.", bmp_sg_tag:"Directly applicable",
  bmp_de_h:"Germany · Wohngeld", bmp_de_t:"Means-tested housing allowance indexed to rent and income.", bmp_de_tag:"Directly applicable",
  bmp_uk_h:"UK · Help to Buy", bmp_uk_t:"Equity loan for first-time buyers on new-builds.", bmp_uk_tag:"Needs legislative change",
  bmp_us_h:"USA · LIHTC", bmp_us_t:"Tax credits for affordable rental supply.", bmp_us_tag:"Not applicable to context" });
Object.assign(I18N.zh,{ bm_cmpTitle:"沙特 vs OECD vs 最佳实践", bm_cmpNote:"按维度归一化", bm_applic:"参照项目 —— 可借鉴性",
  bmp_sg_h:"新加坡 · CPF 购房补助", bmp_sg_t:"强制储蓄共同出资购房。", bmp_sg_tag:"可直接借鉴",
  bmp_de_h:"德国 · Wohngeld", bmp_de_t:"按租金与收入挂钩的经济状况审查住房津贴。", bmp_de_tag:"可直接借鉴",
  bmp_uk_h:"英国 · Help to Buy", bmp_uk_t:"为首次购房者提供新房股权贷款。", bmp_uk_tag:"需立法修改",
  bmp_us_h:"美国 · LIHTC", bmp_us_t:"为可负担租赁供给提供税收抵免。", bmp_us_tag:"不适用本国情境" });
Object.assign(I18N.ar,{ bm_cmpTitle:"السعودية مقابل OECD مقابل الأفضل", bm_cmpNote:"مُطبَّع لكل بُعد", bm_applic:"برامج مرجعية — قابلية التطبيق",
  bmp_sg_h:"سنغافورة · منحة CPF", bmp_sg_t:"ادخار إلزامي يشارك في تمويل الشراء.", bmp_sg_tag:"قابل للتطبيق مباشرة",
  bmp_de_h:"ألمانيا · Wohngeld", bmp_de_t:"بدل سكن مرتبط بالدخل والإيجار.", bmp_de_tag:"قابل للتطبيق مباشرة",
  bmp_uk_h:"بريطانيا · Help to Buy", bmp_uk_t:"قرض ملكية للمشترين لأول مرة.", bmp_uk_tag:"يتطلب تعديلاً تشريعياً",
  bmp_us_h:"أمريكا · LIHTC", bmp_us_t:"إعفاءات ضريبية لعرض الإيجار الميسور.", bmp_us_tag:"غير قابل للتطبيق" });
Object.assign(I18N.en,{ nav_referrals:"Beneficiary Tracking", nav_benchmark:"Intl. Benchmarking", agent_track:"Beneficiary Status Tracking agent", agent_bench:"Benchmarking agent",
  bt_sub:"Track beneficiary improvement and route referrals for human review", bt_rule:"Improvement = HBR ≤ 38% without support for 3 consecutive months → referral list",
  bt_redline:"Subsidy continues uninterrupted during review — the system never auto-terminates", bt_run:"Run detection",
  bt_new:"New", bt_review:"Monitoring", bt_referred:"Referred to BO", bt_approved:"Approved",
  bt_id:"Beneficiary", bt_region:"Region", bt_band:"Income band", bt_curHBR:"Current HBR", bt_startHBR:"Start HBR", bt_source:"Improvement source", bt_months:"Duration", bt_status:"Status",
  bt_gosi:"GOSI", bt_housing:"Housing", bt_both:"Both", band_urgent:"Most urgent", band_low:"Low income", band_mid:"Mid income",
  bt_reviewBtn:"Review", bt_reviewTitle:"Beneficiary review", bt_trend:"3-month HBR trend", bt_keep:"Keep support", bt_refer:"Refer to Business Owner",
  bm_sub:"Benchmark KSA housing support against reference countries (OECD + peers)", bm_gen:"Generate benchmark report", bm_done:"Benchmark report generated",
  bm_dim:"Benchmark", bm_ksa:"KSA (current)", bm_ksaTarget:"KSA target", bm_oecd:"OECD avg", bm_best:"Best-in-class", bm_gap:"Status",
  bm_hbr:"Housing Burden (HBR)", bm_fair:"Fairness Gap", bm_cov:"Coverage", bm_cost:"Cost ratio", bm_sat:"User satisfaction",
  bm_low:"lower better", bm_high:"higher better", bm_meets:"Meets target", bm_below:"Below target",
  bm_dimsNote:"5 benchmarks vs reference countries", bm_satTitle:"User satisfaction (BR-B06)",
  bm_note:"Satisfaction blends Sakani ratings, contract-cancellation rate (inverse) and the OECD Better Life Index — contextual only; it does not alter the other benchmark recommendations." });
Object.assign(I18N.zh,{ nav_referrals:"受益人追踪", nav_benchmark:"国际对标", agent_track:"受益人状态追踪 agent", agent_bench:"国际对标 agent",
  bt_sub:"追踪受益人改善情况，将转复核名单转交人工审核", bt_rule:"改善判定 = 无支援下 HBR ≤ 38% 连续 3 个月 → 进入转复核名单",
  bt_redline:"复核期间补贴持续不间断 — 系统永不自动停补", bt_run:"运行检测",
  bt_new:"新建", bt_review:"监测中", bt_referred:"已转业务负责人", bt_approved:"已批准",
  bt_id:"受益人", bt_region:"区域", bt_band:"收入档", bt_curHBR:"当前 HBR", bt_startHBR:"起始 HBR", bt_source:"改善来源", bt_months:"持续", bt_status:"状态",
  bt_gosi:"GOSI", bt_housing:"住宅", bt_both:"两者", band_urgent:"最急需", band_low:"低收入", band_mid:"中等收入",
  bt_reviewBtn:"复核", bt_reviewTitle:"受益人复核", bt_trend:"近 3 个月 HBR 趋势", bt_keep:"维持支援", bt_refer:"转业务负责人",
  bm_sub:"将沙特住房支持与参照国(OECD + 同侪)对标", bm_gen:"生成对标报告", bm_done:"对标报告已生成",
  bm_dim:"对标维度", bm_ksa:"沙特(当前)", bm_ksaTarget:"沙特目标", bm_oecd:"OECD 均值", bm_best:"最佳实践", bm_gap:"状态",
  bm_hbr:"住房负担 (HBR)", bm_fair:"公平性差距", bm_cov:"覆盖率", bm_cost:"成本比", bm_sat:"用户满意度",
  bm_low:"越低越好", bm_high:"越高越好", bm_meets:"达标", bm_below:"未达标",
  bm_dimsNote:"5 个维度 vs 参照国", bm_satTitle:"用户满意度 (BR-B06)",
  bm_note:"满意度综合 Sakani 评分、合同取消率(反向)与 OECD Better Life 指数 —— 仅作上下文参考，不改变其它对标建议。" });
Object.assign(I18N.ar,{ nav_referrals:"تتبع المستفيدين", nav_benchmark:"المقارنة الدولية", agent_track:"وكيل تتبع حالة المستفيد", agent_bench:"وكيل المقارنة المعيارية",
  bt_sub:"تتبّع تحسّن المستفيدين وإحالة القائمة للمراجعة البشرية", bt_rule:"التحسّن = HBR ≤ ٣٨٪ بدون دعم لمدة ٣ أشهر متتالية ← قائمة الإحالة",
  bt_redline:"يستمر الدعم دون انقطاع أثناء المراجعة — النظام لا يوقف الدعم تلقائياً أبداً", bt_run:"تشغيل الكشف",
  bt_new:"جديد", bt_review:"قيد المتابعة", bt_referred:"محال لمالك الأعمال", bt_approved:"معتمد",
  bt_id:"المستفيد", bt_region:"المنطقة", bt_band:"شريحة الدخل", bt_curHBR:"HBR الحالي", bt_startHBR:"HBR البدائي", bt_source:"مصدر التحسّن", bt_months:"المدة", bt_status:"الحالة",
  bt_gosi:"التأمينات", bt_housing:"سكني", bt_both:"كلاهما", band_urgent:"الأشد حاجة", band_low:"منخفض الدخل", band_mid:"متوسط الدخل",
  bt_reviewBtn:"مراجعة", bt_reviewTitle:"مراجعة المستفيد", bt_trend:"اتجاه HBR خلال ٣ أشهر", bt_keep:"الإبقاء على الدعم", bt_refer:"إحالة لمالك الأعمال",
  bm_sub:"مقارنة دعم الإسكان السعودي بالدول المرجعية (OECD + النظراء)", bm_gen:"توليد تقرير المقارنة", bm_done:"تم توليد تقرير المقارنة",
  bm_dim:"المعيار", bm_ksa:"السعودية (حالي)", bm_ksaTarget:"هدف السعودية", bm_oecd:"متوسط OECD", bm_best:"الأفضل", bm_gap:"الحالة",
  bm_hbr:"عبء السكن (HBR)", bm_fair:"فجوة العدالة", bm_cov:"التغطية", bm_cost:"نسبة التكلفة", bm_sat:"رضا المستخدم",
  bm_low:"الأقل أفضل", bm_high:"الأعلى أفضل", bm_meets:"محقق", bm_below:"دون الهدف",
  bm_dimsNote:"٥ معايير مقابل الدول المرجعية", bm_satTitle:"رضا المستخدم (BR-B06)",
  bm_note:"يجمع الرضا تقييمات سكني ونسبة إلغاء العقود (عكسياً) ومؤشر OECD لحياة أفضل — سياقي فقط، لا يغيّر التوصيات الأخرى." });

/* ===== UC-11 Mortgage-Aware Support Type (substep of UC-03) ===== */
const MORTGAGE_PROFILES=[
  {id:"mp_a", city:"Riyadh", income:9800, product:"prod_offplan", qual:"mt_actual",
    scen:[{k:"mt_cashpkg",hbr:39.2,bud:"−95k",elig:"ok"},{k:"mt_monthly",hbr:40.1,bud:"−1.6k/mo",elig:"ok"},
          {k:"mt_mix",hbr:37.8,bud:"−55k +0.9k/mo",elig:"ok"},{k:"mt_land",hbr:34.5,bud:"−230k land",elig:"ok",cond:"mt_condLand"},
          {k:"mt_interest",hbr:33.1,bud:"−interest",elig:"ok",cond:"mt_condRedf"}]},
  {id:"mp_b", city:"Makkah", income:7400, product:"prod_ready", qual:"mt_actual",
    scen:[{k:"mt_cashpkg",hbr:40.6,bud:"−95k",elig:"ok"},{k:"mt_monthly",hbr:41.2,bud:"−1.6k/mo",elig:"ok"},
          {k:"mt_mix",hbr:38.4,bud:"−55k +0.9k/mo",elig:"ok"},{k:"mt_land",hbr:35.0,bud:"−230k land",elig:"no",cond:"mt_noOffplan"},
          {k:"mt_interest",hbr:34.0,bud:"−interest",elig:"no",cond:"mt_noRedf"}]},
  {id:"mp_c", city:"Asir", income:6200, product:"prod_self", qual:"mt_virtual", fallback:true,
    scen:[{k:"mt_monthly",hbr:39.8,bud:"−1.6k/mo",elig:"ok"}]},
];
function MortgagePlanning(){
  const {t}=useStore(); const [pid,setPid]=useState("mp_a");
  const p=MORTGAGE_PROFILES.find(x=>x.id===pid);
  const eligible=p.scen.filter(s=>s.elig==="ok");
  const best=eligible.reduce((a,b)=>b.hbr<a.hbr?b:a, eligible[0]);
  const allOver=eligible.every(s=>s.hbr>38);
  return (<div className="fade">
    <PageHeader title={t("nav_mortgage")} sub={t("mt_sub")} right={<AgentBadge name={t("agent_alloc")} lvl="L2"/>}/>
    <div className="banner" style={{marginBottom:14}}>● {t("mt_note03")}</div>
    <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
      {MORTGAGE_PROFILES.map(x=>(<button key={x.id} className={"btn sm "+(x.id===pid?"":"secondary")} onClick={()=>setPid(x.id)}>{x.city}</button>))}
    </div>
    <div className="cols-2" style={{marginBottom:4}}>
      <Section title={t("mt_profile")}>
        <div className="kv">
          <div className="kv-row"><span className="muted">{t("mt_city")}</span><span>{p.city}</span></div>
          <div className="kv-row"><span className="muted">{t("mt_income")}</span><span className="mono">⃁ {n0(p.income)}/mo</span></div>
          <div className="kv-row"><span className="muted">{t("mt_product")}</span><span>{t(p.product)}</span></div>
          <div className="kv-row"><span className="muted">{t("mt_qual")}</span><span><span className={"chip "+(p.qual==="mt_actual"?"":"amber")}>{t(p.qual)}</span></span></div>
        </div>
        {p.fallback&&<div className="banner" style={{marginTop:12,background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("mt_fallback")}</div>}
      </Section>
      <Section title={t("mt_reco")}>
        <div className="brief-card" style={{margin:0}}><div className="bh">✦ {t(best.k)}</div>
          <div className="bv">HBR → {best.hbr}%</div>
          <div className="bs muted">{t("mt_budimpact")}: {best.bud}</div></div>
        {allOver&&<div className="banner" style={{marginTop:10,background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("mt_allover")}</div>}
        <div className="muted" style={{fontSize:12,marginTop:10}}>{t("mt_field17")}</div>
      </Section>
    </div>
    <Section title={t("mt_scenarios")}>
      <table className="tbl"><thead><tr><th>{t("mt_type")}</th><th className="right-num">{t("mt_exphbr")}</th><th>{t("mt_budimpact")}</th><th>{t("mt_elig")}</th></tr></thead>
        <tbody>{p.scen.map(s=>{ const isBest=s===best; return (<tr key={s.k} style={isBest?{background:"var(--green-50)"}:null}>
          <td>{isBest?"✦ ":""}{t(s.k)}{s.cond?<span className="muted" style={{fontSize:11}}> · {t(s.cond)}</span>:null}</td>
          <td className="right-num mono" style={{fontWeight:isBest?700:400,color:s.hbr<=38?"var(--green)":"var(--amber)"}}>{s.hbr}%</td>
          <td className="mono muted">{s.bud}</td>
          <td>{s.elig==="ok"?<span className="chip">{t("mt_eligible")}</span>:<span className="chip amber">{t("mt_inelig")}</span>}</td>
        </tr>);})}</tbody></table>
    </Section>
  </div>);
}

/* ===== UC-13 Product Portfolio / Inventory Absorption (UC-06 ext) ===== */
const INVENTORY=[
  {region:"Riyadh", units:4200, demand:3100, stale:false},
  {region:"Makkah", units:2600, demand:2450, stale:false},
  {region:"Asir",   units:1800, demand:520,  stale:false},
  {region:"Eastern",units:3100, demand:980,  stale:true},
];
function InventoryAbsorption(){
  const {t}=useStore(); const [reg,setReg]=useState("Riyadh"); const [approved,setApproved]=useState(false);
  const row=INVENTORY.find(r=>r.region===reg);
  const absorb=Math.min(100,Math.round(row.demand/row.units*100));
  const gap=100-absorb;
  const budgetPct=gap>50?24:gap>25?13:7;
  const escalate=budgetPct>20;
  const insufficient=row.demand < row.units*0.4;
  const afterUptake=Math.min(96, absorb+Math.round(gap*0.55));
  return (<div className="fade">
    <PageHeader title={t("nav_inventory")} sub={t("iv_sub")} right={<AgentBadge name={t("agent_realloc")} lvl="L2"/>}/>
    <div className="banner" style={{marginBottom:14}}>● {t("iv_rules")}</div>
    <Section title={t("iv_invTitle")} sub={t("iv_invNote")}>
      <table className="tbl"><thead><tr><th>{t("bt_region")}</th><th className="right-num">{t("iv_units")}</th><th className="right-num">{t("iv_demand")}</th><th>{t("iv_absorb")}</th><th></th></tr></thead>
        <tbody>{INVENTORY.map(r=>{ const ab=Math.min(100,Math.round(r.demand/r.units*100)); return (<tr key={r.region} style={r.region===reg?{background:"var(--green-50)"}:null}>
          <td>{r.region}{r.stale&&<span className="chip amber" style={{marginInlineStart:6,fontSize:10}}>⚠ {t("iv_stale")}</span>}</td>
          <td className="right-num mono">{n0(r.units)}</td><td className="right-num mono">{n0(r.demand)}</td>
          <td style={{minWidth:130}}><Progress v={ab/100} color={ab>=80?"var(--green)":"var(--amber)"}/><span className="muted" style={{fontSize:11}}>{ab}% {t("iv_absorbable")}</span></td>
          <td><button className="btn ghost sm" onClick={()=>{setReg(r.region);setApproved(false);}}>{t("iv_plan")}</button></td>
        </tr>);})}</tbody></table>
    </Section>
    <Section title={t("iv_planTitle")+" · "+reg} right={escalate&&!insufficient?<span className="chip amber">⚠ {t("iv_minister")}</span>:null}>
      {insufficient
        ? <div className="banner" style={{background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("iv_insufficient")}</div>
        : <div>
          <div className="muted" style={{fontSize:12.5,marginBottom:10}}>{t("iv_levers")}</div>
          <div className="cols-3" style={{marginBottom:12}}>
            <KPI label={t("iv_uptake")} value={absorb+"% → "+afterUptake+"%"} sub={t("iv_uptakeSub")} tone="good"/>
            <KPI label={t("kpi_budget")} value={"+"+budgetPct+"%"} sub={t("iv_budgetSub")} tone={escalate?"warn":"good"}/>
            <KPI label={t("kpi_fairness")} value="1.04" sub={t("fair_if")} tone="good"/>
          </div>
          <div className="muted" style={{fontSize:12}}>{t("iv_priority")}</div>
          <button className="btn" style={{marginTop:12}} disabled={approved} onClick={()=>setApproved(true)}>{approved?("✓ "+t("done")):t("iv_approve")}</button>
        </div>}
    </Section>
  </div>);
}

/* ===== UC-14 Policy & Market Impact Attribution ===== */
const ATTRIB={ total:18, events:[{d:"2026-06-01",k:"ev_landfee",type:"policy"},{d:"2026-05-12",k:"ev_ratecut",type:"market"},{d:"2026-04",k:"ev_migration",type:"demo"}] };
function ImpactAttribution(){
  const {t,setRoute}=useStore(); const [act,setAct]=useState(null);
  const segs=[{k:"ia_policy",v:11,c:"#6d5ae6"},{k:"ia_market",v:4,c:"var(--info)"},{k:"ia_demo",v:3,c:"var(--amber)"}];
  return (<div className="fade">
    <PageHeader title={t("nav_impact")} sub={t("ia_sub")} right={<AgentBadge name={t("agent_realloc")} lvl="L2"/>}/>
    <div className="banner" style={{marginBottom:14,background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("ia_trigger")}</div>
    <Section title={t("ia_didTitle")} sub={t("ia_didNote")}>
      <div style={{display:"flex",height:34,borderRadius:8,overflow:"hidden",marginBottom:10}}>
        {segs.map(s=>(<div key={s.k} style={{width:(s.v/ATTRIB.total*100)+"%",background:s.c,color:"#fff",display:"grid",placeItems:"center",fontSize:12,fontWeight:700}}>{s.v}%</div>))}
      </div>
      <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>{segs.map(s=>(<span key={s.k} style={{fontSize:12.5}}><span style={{display:"inline-block",width:10,height:10,background:s.c,borderRadius:2,marginInlineEnd:6}}/>{t(s.k)} <b>{s.v}%</b></span>))}</div>
      <div className="muted" style={{fontSize:12.5,marginTop:12,lineHeight:1.7}}>{t("ia_interpret")}</div>
    </Section>
    <Section title={t("ia_events")}>
      <table className="tbl"><thead><tr><th>{t("ia_date")}</th><th>{t("ia_event")}</th><th>{t("ia_factor")}</th></tr></thead>
        <tbody>{ATTRIB.events.map(e=>(<tr key={e.k}><td className="mono">{e.d}</td><td>{t(e.k)}</td>
          <td><span className={"chip "+(e.type==="market"?"info":e.type==="demo"?"amber":"")}>{t("ia_"+e.type)}</span></td></tr>))}</tbody></table>
    </Section>
    <Section title={t("ia_outputs")}>
      {act&&<div className="banner" style={{marginBottom:10}}>✓ {t(act)}</div>}
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button className="btn" onClick={()=>setRoute("whatif")}>✦ {t("ia_feedWhatif")}</button>
        <button className="btn secondary" onClick={()=>setAct("ia_doneUc06")}>{t("ia_uc06")}</button>
        <button className="btn secondary" onClick={()=>setAct("ia_doneUc07")}>↗ {t("ia_uc07")}</button>
      </div>
    </Section>
  </div>);
}
Object.assign(I18N.en,{ nav_mortgage:"Support-Type Optimizer", nav_inventory:"Inventory Absorption", nav_impact:"Policy & Market Impact", agent_realloc:"Reallocation Assessment agent",
  mt_sub:"Pick the optimal support type per beneficiary (substep of the allocation cycle)", mt_note03:"Substep of the allocation cycle — the recommendation feeds the Support Type field of the distribution plan",
  mt_profile:"Beneficiary profile", mt_city:"City", mt_income:"Disposable income", mt_product:"Product", mt_qual:"Analysis quality", mt_actual:"Actual mortgage", mt_virtual:"Virtual (no mortgage data)",
  mt_fallback:"No mortgage data — default monthly support applied, marked 'without mortgage analysis'",
  mt_reco:"Recommended support type", mt_budimpact:"Budget impact", mt_field17:"Delivered to the allocation plan as a Support-Type recommendation", mt_allover:"All scenarios exceed the 38% HBR threshold — shown with alert, not disabled",
  mt_scenarios:"Support-type scenarios (expected HBR)", mt_type:"Support type", mt_exphbr:"Expected HBR", mt_elig:"Eligibility",
  mt_cashpkg:"Cash package", mt_monthly:"Monthly cash", mt_mix:"Cash mix", mt_land:"In-kind land discount", mt_interest:"Bank interest support",
  mt_condLand:"off-plan · NHC list", mt_condRedf:"REDF agreement", mt_noOffplan:"not off-plan", mt_noRedf:"no REDF agreement", mt_eligible:"Eligible", mt_inelig:"Not eligible",
  prod_offplan:"Off-plan", prod_ready:"Ready home", prod_self:"Self-build",
  iv_sub:"Match unsold inventory to eligible demand and size a stimulus plan to accelerate absorption", iv_rules:"Priority: longest waiting list (not highest income) · Fairness Gap ≥ 1.0 · >20% budget → Minister",
  iv_invTitle:"Regional inventory vs eligible demand", iv_invNote:"NHC unsold units vs eligible unsigned beneficiaries", iv_units:"Unsold units", iv_demand:"Eligible demand", iv_absorb:"Absorption", iv_absorbable:"absorbable", iv_stale:"Outdated data",
  iv_plan:"Plan", iv_planTitle:"Stimulus plan", iv_minister:"Needs Minister (>20% budget)", iv_insufficient:"Insufficient eligible demand — inventory not absorbable with current support; review allocation policy",
  iv_levers:"Levers: raise unit price ceiling · adjust segment support rate · temporary project support", iv_uptake:"Uptake rate", iv_uptakeSub:"projected after stimulus", iv_budgetSub:"of available budget",
  iv_priority:"Priority given to longest-waiting beneficiaries (BR-P01)", iv_approve:"Approve plan (Business Owner)",
  ia_sub:"Isolate what's driving demand change — policy vs market vs demographic (Difference-in-Differences)", ia_trigger:"Signing rate +18% vs monthly average — exceeds the 15% threshold, attribution triggered",
  ia_didTitle:"Impact attribution (Difference-in-Differences)", ia_didNote:"Demand change +18% decomposed by factor", ia_policy:"Policy effect", ia_market:"Market effect", ia_demo:"Demographic effect",
  ia_interpret:"Mostly policy-driven (new land-fee relief), not market overheating — avoids over-allocating budget on a false demand signal.",
  ia_events:"Concurrent events", ia_date:"Date", ia_event:"Event", ia_factor:"Factor", ev_landfee:"New land-fee relief", ev_ratecut:"Interest rate cut", ev_migration:"Regional migration influx",
  ia_outputs:"Route the impact report", ia_feedWhatif:"Feed What-if with actual impact", ia_uc06:"Update reallocation", ia_uc07:"Escalate via decision routing",
  ia_doneUc06:"Reallocation recommendation updated with isolation results", ia_doneUc07:"Impact report routed to decision routing" });
Object.assign(I18N.zh,{ nav_mortgage:"补贴类型优选", nav_inventory:"库存去化", nav_impact:"政策与市场影响", agent_realloc:"再平衡评估 agent",
  mt_sub:"为每位受益人优选最优支援类型(配分周期的子步骤)", mt_note03:"配分周期的子步骤 —— 推荐结果写入配分方案的『支援类型』字段",
  mt_profile:"受益人画像", mt_city:"城市", mt_income:"可支配收入", mt_product:"产品", mt_qual:"分析质量", mt_actual:"真实抵押数据", mt_virtual:"虚拟(无抵押数据)",
  mt_fallback:"无抵押数据 —— 采用默认月度支援，标注『未做抵押分析』",
  mt_reco:"推荐支援类型", mt_budimpact:"预算影响", mt_field17:"作为支援类型推荐交付配分方案", mt_allover:"所有方案均超过 38% HBR 阈值 —— 带告警显示，不禁用",
  mt_scenarios:"支援类型情景(预计 HBR)", mt_type:"支援类型", mt_exphbr:"预计 HBR", mt_elig:"是否适用",
  mt_cashpkg:"现金一次性", mt_monthly:"按月现金", mt_mix:"现金混合", mt_land:"实物土地折扣", mt_interest:"银行利息支援",
  mt_condLand:"期房 · NHC 名录", mt_condRedf:"REDF 协议", mt_noOffplan:"非期房", mt_noRedf:"无 REDF 协议", mt_eligible:"适用", mt_inelig:"不适用",
  prod_offplan:"期房", prod_ready:"现房", prod_self:"自建",
  iv_sub:"将未售库存与合格需求匹配，测算去化激励方案", iv_rules:"优先级：最长等待名单(非最高收入)· Fairness Gap ≥ 1.0 · 预算 >20% → 部长",
  iv_invTitle:"区域库存 vs 合格需求", iv_invNote:"NHC 未售单元 vs 合格未签约受益人", iv_units:"未售单元", iv_demand:"合格需求", iv_absorb:"去化", iv_absorbable:"可去化", iv_stale:"数据过期",
  iv_plan:"方案", iv_planTitle:"去化激励方案", iv_minister:"需部长(预算 >20%)", iv_insufficient:"合格需求不足 —— 当前支援无法去化该库存；建议复核配分政策",
  iv_levers:"杠杆：提高单价上限 · 调整分档支援率 · 项目临时加码", iv_uptake:"去化率", iv_uptakeSub:"激励后预计", iv_budgetSub:"占可用预算",
  iv_priority:"优先长期等待的受益人(BR-P01)", iv_approve:"批准方案(业务负责人)",
  ia_sub:"用 Difference-in-Differences 拆解需求变化：政策 vs 市场 vs 人口", ia_trigger:"签约率较月均 +18% —— 超过 15% 阈值，触发影响归因",
  ia_didTitle:"影响归因(Difference-in-Differences)", ia_didNote:"需求变化 +18% 按因素拆解", ia_policy:"政策效应", ia_market:"市场效应", ia_demo:"人口效应",
  ia_interpret:"主要由政策驱动(新土地费减免)，并非市场过热 —— 避免因误判需求而盲目加预算。",
  ia_events:"并发事件", ia_date:"日期", ia_event:"事件", ia_factor:"因素", ev_landfee:"新土地费减免", ev_ratecut:"利率下调", ev_migration:"区域人口流入",
  ia_outputs:"分发影响报告", ia_feedWhatif:"用真实影响喂给 What-if", ia_uc06:"更新再平衡", ia_uc07:"经决策路由上报",
  ia_doneUc06:"再平衡建议已用归因结果更新", ia_doneUc07:"影响报告已分发至决策路由" });
Object.assign(I18N.ar,{ nav_mortgage:"مُحسِّن نوع الدعم", nav_inventory:"استيعاب المخزون", nav_impact:"أثر السياسات والسوق", agent_realloc:"وكيل تقييم إعادة التوزيع",
  mt_sub:"اختيار نوع الدعم الأمثل لكل مستفيد (خطوة ضمن دورة التخصيص)", mt_note03:"خطوة فرعية من دورة التخصيص — تُغذّي حقل نوع الدعم في خطة التوزيع",
  mt_profile:"ملف المستفيد", mt_city:"المدينة", mt_income:"الدخل المتاح", mt_product:"المنتج", mt_qual:"جودة التحليل", mt_actual:"رهن فعلي", mt_virtual:"افتراضي (بدون بيانات رهن)",
  mt_fallback:"لا توجد بيانات رهن — يُطبّق الدعم الشهري الافتراضي مع وسم 'بدون تحليل رهن'",
  mt_reco:"نوع الدعم الموصى به", mt_budimpact:"الأثر على الميزانية", mt_field17:"يُسلَّم إلى خطة التخصيص كتوصية بنوع الدعم", mt_allover:"كل السيناريوهات تتجاوز عتبة HBR ٣٨٪ — تُعرض مع تنبيه دون تعطيل",
  mt_scenarios:"سيناريوهات نوع الدعم (HBR المتوقع)", mt_type:"نوع الدعم", mt_exphbr:"HBR المتوقع", mt_elig:"الأهلية",
  mt_cashpkg:"حزمة نقدية", mt_monthly:"نقد شهري", mt_mix:"مزيج نقدي", mt_land:"خصم أرض عيني", mt_interest:"دعم فائدة بنكية",
  mt_condLand:"على الخارطة · قائمة NHC", mt_condRedf:"اتفاقية REDF", mt_noOffplan:"ليس على الخارطة", mt_noRedf:"لا اتفاقية REDF", mt_eligible:"مؤهل", mt_inelig:"غير مؤهل",
  prod_offplan:"على الخارطة", prod_ready:"جاهز", prod_self:"بناء ذاتي",
  iv_sub:"مطابقة المخزون غير المباع بالطلب المؤهل وتحديد خطة تحفيز لتسريع الاستيعاب", iv_rules:"الأولوية: أطول قائمة انتظار (لا الأعلى دخلاً) · فجوة العدالة ≥ ١٫٠ · >٢٠٪ ميزانية → الوزير",
  iv_invTitle:"المخزون الإقليمي مقابل الطلب المؤهل", iv_invNote:"وحدات NHC غير المباعة مقابل المستفيدين المؤهلين غير المتعاقدين", iv_units:"وحدات غير مباعة", iv_demand:"طلب مؤهل", iv_absorb:"الاستيعاب", iv_absorbable:"قابل للاستيعاب", iv_stale:"بيانات قديمة",
  iv_plan:"خطة", iv_planTitle:"خطة التحفيز", iv_minister:"يتطلب الوزير (>٢٠٪ ميزانية)", iv_insufficient:"طلب مؤهل غير كافٍ — لا يمكن استيعاب المخزون بالدعم الحالي؛ راجع سياسة التخصيص",
  iv_levers:"الروافع: رفع سقف سعر الوحدة · تعديل نسبة دعم الشريحة · دعم مؤقت للمشروع", iv_uptake:"معدل الاستيعاب", iv_uptakeSub:"متوقع بعد التحفيز", iv_budgetSub:"من الميزانية المتاحة",
  iv_priority:"الأولوية للمستفيدين الأطول انتظاراً (BR-P01)", iv_approve:"اعتماد الخطة (مالك الأعمال)",
  ia_sub:"عزل محرّك تغيّر الطلب — سياسة مقابل سوق مقابل سكان (الفروق في الفروق)", ia_trigger:"معدل التعاقد +١٨٪ مقابل المتوسط الشهري — يتجاوز عتبة ١٥٪، تم تفعيل العزل",
  ia_didTitle:"عزل الأثر (Difference-in-Differences)", ia_didNote:"تغيّر الطلب +١٨٪ مفصّلاً حسب العامل", ia_policy:"أثر السياسة", ia_market:"أثر السوق", ia_demo:"أثر سكاني",
  ia_interpret:"مدفوع غالباً بالسياسة (إعفاء رسوم الأراضي الجديد) لا بفورة السوق — يتجنّب تضخيم الميزانية على إشارة طلب خاطئة.",
  ia_events:"أحداث متزامنة", ia_date:"التاريخ", ia_event:"الحدث", ia_factor:"العامل", ev_landfee:"إعفاء رسوم أراضٍ جديد", ev_ratecut:"خفض سعر الفائدة", ev_migration:"تدفّق هجرة إقليمي",
  ia_outputs:"توجيه تقرير الأثر", ia_feedWhatif:"تغذية What-if بالأثر الفعلي", ia_uc06:"تحديث إعادة التوزيع", ia_uc07:"التصعيد عبر توجيه القرار",
  ia_doneUc06:"تم تحديث توصية إعادة التوزيع بنتائج العزل", ia_doneUc07:"تم توجيه تقرير الأثر إلى توجيه القرار" });

/* ===== Agent architecture overview (UC-SYS-01) ===== */
const AGENT_ARCH=[
  {k:"agent_data", lvl:"L1", scope:"aa_data"},
  {k:"agent_track", lvl:"L1", scope:"aa_track"},
  {k:"agent_alloc", lvl:"L2", scope:"aa_alloc"},
  {k:"agent_forecast", lvl:"L2", scope:"aa_forecast"},
  {k:"agent_realloc", lvl:"L2", scope:"aa_realloc"},
  {k:"agent_fair", lvl:"L3", scope:"aa_fair"},
  {k:"agent_route", lvl:"L3", scope:"aa_route"},
  {k:"agent_orch", lvl:"L3", scope:"aa_orch"},
];
function AgentArchitecture(){
  const {t}=useStore();
  return (<div className="fade">
    <PageHeader title={t("nav_agents")} sub={t("aa_sub")} right={<AgentBadge name={t("agent_orch")}/>}/>
    <div className="banner" style={{marginBottom:14}}>● {t("aa_note")}</div>
    {["L1","L2","L3"].map(lv=>(<Section key={lv} title={t("aa_"+lv)} sub={t("aa_"+lv+"_d")}>
      <div className="cols-2">
        {AGENT_ARCH.filter(a=>a.lvl===lv).map(a=>(<div key={a.k} className="agent-tile">
          <div className="at-head">{GearIcon}<strong>{t(a.k)}</strong><span className="chip gray" style={{marginInlineStart:"auto"}}>{a.lvl}</span></div>
          <div className="muted" style={{fontSize:12.5,lineHeight:1.65,marginTop:8}}>{t(a.scope)}</div>
          <div className="at-foot"><span className="ag-dot"/> {t("agent_auto")}</div>
        </div>))}
      </div>
    </Section>))}
  </div>);
}
Object.assign(I18N.en,{ nav_agents:"Agent Architecture",
  aa_sub:"The multi-agent system behind the platform — levels, scope and coordination", aa_note:"All agents run automatically; every decision stays human-in-the-loop",
  aa_L1:"L1 · Data agents", aa_L1_d:"Ingestion and beneficiary tracking", aa_L2:"L2 · Optimization agents", aa_L2_d:"Computation, forecasting and rebalancing", aa_L3:"L3 · Governance & orchestration", aa_L3_d:"Fairness, routing and coordination",
  aa_data:"Ingests and validates the six source systems into BIDSC; flags exceptions.", aa_track:"Monitors beneficiary improvement and generates referral lists — never auto-terminates support.",
  aa_alloc:"Computes the subsidy formula, the distribution plan and the optimal support type per beneficiary.", aa_forecast:"Projects 12-month spend and raises early/critical budget alerts.",
  aa_realloc:"Rebalancing assessment, inventory absorption and policy/market impact attribution.", aa_fair:"Computes the multi-dimensional Fairness Gap and detects leakage.",
  aa_route:"Routes decisions through the audit trail and delivers approved outputs to Housing Copilot.", aa_orch:"Coordinates all agents and runs What-if simulations on demand.",
  st_tactical:"Tactical sandbox", st_strategic:"Strategic sandbox", st_macro:"Macro-policy sandbox",
  fgdim_region:"Region", fgdim_income:"Income band", fgdim_loan:"Loan term", fgdim_age:"Age group" });
Object.assign(I18N.zh,{ nav_agents:"智能体架构",
  aa_sub:"平台背后的多智能体系统 —— 层级、职责与协同", aa_note:"所有智能体自动运行;每个决策都保留人工把关",
  aa_L1:"L1 · 数据智能体", aa_L1_d:"数据接入与受益人追踪", aa_L2:"L2 · 优化智能体", aa_L2_d:"计算、预测与再平衡", aa_L3:"L3 · 治理与编排", aa_L3_d:"公平、路由与协同",
  aa_data:"将六套源系统接入并校验入 BIDSC;标记异常。", aa_track:"监测受益人改善并生成转复核名单 —— 永不自动停补。",
  aa_alloc:"计算补贴公式、配分方案及每位受益人的最优支援类型。", aa_forecast:"预测 12 个月支出并发出早期/严重预算预警。",
  aa_realloc:"再平衡评估、库存去化与政策/市场影响归因。", aa_fair:"计算多维公平差距并检测漏损。",
  aa_route:"通过审计追踪路由决策,并把已批准结果交付 Housing Copilot。", aa_orch:"协调所有智能体,并按需运行 What-if 推演。",
  st_tactical:"战术沙箱", st_strategic:"战略沙箱", st_macro:"宏观政策沙箱",
  fgdim_region:"地区", fgdim_income:"收入档", fgdim_loan:"贷款期限", fgdim_age:"年龄段" });
Object.assign(I18N.ar,{ nav_agents:"بنية الوكلاء",
  aa_sub:"نظام الوكلاء المتعدد خلف المنصة — المستويات والنطاق والتنسيق", aa_note:"تعمل جميع الوكلاء آلياً؛ يبقى كل قرار بإشراف بشري",
  aa_L1:"L1 · وكلاء البيانات", aa_L1_d:"الاستيعاب وتتبع المستفيدين", aa_L2:"L2 · وكلاء التحسين", aa_L2_d:"الحساب والتنبؤ وإعادة التوازن", aa_L3:"L3 · الحوكمة والتنسيق", aa_L3_d:"العدالة والتوجيه والتنسيق",
  aa_data:"يستوعب ويتحقق من الأنظمة المصدر الستة في BIDSC؛ يضع علامة على الاستثناءات.", aa_track:"يراقب تحسّن المستفيدين ويولّد قوائم الإحالة — لا يوقف الدعم تلقائياً أبداً.",
  aa_alloc:"يحسب صيغة الدعم وخطة التوزيع ونوع الدعم الأمثل لكل مستفيد.", aa_forecast:"يتوقّع إنفاق ١٢ شهراً ويصدر تنبيهات ميزانية مبكرة/حرجة.",
  aa_realloc:"تقييم إعادة التوازن واستيعاب المخزون وعزل أثر السياسات/السوق.", aa_fair:"يحسب فجوة العدالة متعددة الأبعاد ويكشف التسرب.",
  aa_route:"يوجّه القرارات عبر سجل التدقيق ويسلّم المخرجات المعتمدة إلى مساعد الإسكان.", aa_orch:"ينسّق جميع الوكلاء ويشغّل محاكاة What-if عند الطلب.",
  st_tactical:"بيئة تكتيكية", st_strategic:"بيئة استراتيجية", st_macro:"بيئة سياسات كلية",
  fgdim_region:"المنطقة", fgdim_income:"شريحة الدخل", fgdim_loan:"مدة القرض", fgdim_age:"الفئة العمرية" });

/* ===== UC-00 Central Settings ===== */
const SETTINGS_GROUPS=[
  {g:"set_g_dq", at:"2026-06-16 10:44", items:[{k:"set_minComplete",v:90,unit:"%",hint:"0–100"}]},
  {g:"set_g_budget", at:"2026-06-15 10:09", items:[{k:"set_earlyAlert",v:70,unit:"%",hint:"0–100"},{k:"set_critAlert",v:90,unit:"%",hint:"> early"}]},
  {g:"set_g_budgetC", at:"2026-06-15 10:09", items:[{k:"set_annual",v:1580,unit:"M",hint:">0"},{k:"set_eligible",v:1400000,unit:"",hint:">0"}]},
  {g:"set_g_esc", at:"2026-06-15 10:09", items:[{k:"set_minThresh",v:20,unit:"%",hint:"→ Minister"},{k:"set_boTime",v:48,unit:"h",hint:">0"},{k:"set_minTime",v:72,unit:"h",hint:"> BO"}]},
  {g:"set_g_fair", at:"2026-06-15 10:09", items:[{k:"set_fgMin",v:1.0,unit:"",hint:"min 0"}]},
  {g:"set_g_hbr", at:"2026-06-15 10:09", items:[{k:"set_hbrCeil",v:38,unit:"%",hint:"30–50"}]},
  {g:"set_g_mon", at:"2026-06-15 10:09", items:[{k:"set_demandChg",v:15,unit:"%",hint:"0–100"},{k:"set_improveDur",v:3,unit:"mo",hint:"1–12"}]},
];
function SettingsPage(){
  const {t,user}=useStore(); const editable=user!=="minister";
  const [vals,setVals]=useState(()=>{ const o={}; SETTINGS_GROUPS.forEach(g=>g.items.forEach(it=>o[it.k]=it.v)); return o; });
  const [saved,setSaved]=useState(false);
  return (<div className="fade">
    <PageHeader title={t("nav_settings")} sub={t("set_sub")} right={editable?<button className="btn sm" onClick={()=>setSaved(true)}>💾 {t("set_save")}</button>:<span className="chip gray">{t("set_readonly")}</span>}/>
    {saved&&<div className="banner" style={{marginBottom:14}}>✓ {t("set_saved")}</div>}
    <div className="banner" style={{marginBottom:14}}>● {t("set_note")}</div>
    <div className="cols-2">
      {SETTINGS_GROUPS.map(grp=>(<Section key={grp.g} title={t(grp.g)} sub={t("set_lastMod")+": "+grp.at}>
        {grp.items.map(it=>(<div key={it.k} className="set-row">
          <div><div style={{fontWeight:600,fontSize:13.5}}>{t(it.k)}</div><div className="muted" style={{fontSize:11.5}}>{it.hint}{it.unit?(" · "+it.unit):""}</div></div>
          <input className="input mono" style={{width:120,textAlign:"end"}} type="number" value={vals[it.k]} disabled={!editable}
            onChange={e=>{setVals({...vals,[it.k]:e.target.value}); setSaved(false);}}/>
        </div>))}
      </Section>))}
    </div>
  </div>);
}

/* ===== UC-01 Subsidy Formula ===== */
const FORMULAS=[
  {k:"fml_hbr", title:"f_hbr", ex:"f_hbrEx"},
  {k:"fml_alloc", title:"f_alloc", ex:"f_allocEx"},
  {k:"fml_fg", title:"f_fg", ex:"f_fgEx"},
  {k:"fml_savings", title:"f_sav", ex:"f_savEx"},
];
function FormulaPage(){
  const {t,setRoute}=useStore();
  const [ded,setDed]=useState(40); const [dur,setDur]=useState(20); const [ceil,setCeil]=useState(500000); const [rate,setRate]=useState(4);
  const [act,setAct]=useState(null);
  const dirty = ded!==40||dur!==20||ceil!==500000||rate!==4;
  const bands=[3000,6000,9000,14000,22000];
  const preview=bands.map(inc=>{ const maxH=Math.round(inc*ded/100); const sup=Math.max(0,Math.round(maxH*0.16*(1-rate/100*0.5))); return {inc,maxH,sup}; });
  return (<div className="fade">
    <PageHeader title={t("nav_formula")} sub={t("f_sub")} right={<AgentBadge name={t("agent_alloc")} lvl="L2"/>}/>
    <div className="banner" style={{marginBottom:14}}>● {t("fv_br07")}</div>
    <div className="cols-2">
      <Section title={t("fp_params")}>
        <div className="field"><label style={{display:"flex",justifyContent:"space-between"}}><span>{t("fp_ded")}</span><span className="mono">{ded}%</span></label>
          <input className="range" type="range" min="10" max="60" value={ded} onChange={e=>{setDed(+e.target.value);setAct(null);}}/></div>
        <div className="field"><label>{t("fp_dur")}</label>
          <select className="input" value={dur} onChange={e=>{setDur(+e.target.value);setAct(null);}} style={{width:"auto"}}><option value={5}>5 {t("fp_yrs")}</option><option value={10}>10 {t("fp_yrs")}</option><option value={20}>20 {t("fp_yrs")}</option></select></div>
        <div className="field"><label>{t("fp_ceil")} <span className="muted">(SAR)</span></label>
          <input className="input mono" type="number" value={ceil} onChange={e=>{setCeil(+e.target.value);setAct(null);}}/></div>
        <div className="field"><label style={{display:"flex",justifyContent:"space-between"}}><span>{t("fp_rate")}</span><span className="mono">{rate}%</span></label>
          <input className="range" type="range" min="0" max="15" step="0.5" value={rate} onChange={e=>{setRate(+e.target.value);setAct(null);}}/></div>
        <div className="set-row"><div><div style={{fontWeight:600,fontSize:13.5}}>{t("fp_income")}</div><div className="muted" style={{fontSize:11.5}}>{t("fp_lockedNote")}</div></div><span className="chip gray">🔒 ⃁ 2,726/mo</span></div>
        <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
          <button className="btn secondary sm" onClick={()=>setRoute&&setRoute("whatif")}>✦ {t("fv_test")}</button>
          <button className="btn sm" onClick={()=>setAct("on")} disabled={!dirty}>✓ {t("fp_activate")}</button>
          <button className="btn ghost sm" onClick={()=>{setDed(40);setDur(20);setCeil(500000);setRate(4);setAct("rb");}}>↩ {t("fp_rollback")}</button>
        </div>
        {act==="on"&&<div className="banner" style={{marginTop:10}}>✓ {t("fp_activated")}</div>}
        {act==="rb"&&<div className="banner" style={{marginTop:10}}>↩ {t("fp_rolledback")}</div>}
      </Section>
      <Section title={t("fp_preview")} sub={t("fp_previewNote")}>
        <table className="tbl"><thead><tr><th className="right-num">{t("fp_inc")}</th><th className="right-num">{t("fp_maxH")}</th><th className="right-num">{t("fp_sup")}</th></tr></thead>
          <tbody>{preview.map(p=>(<tr key={p.inc}><td className="right-num mono">⃁ {n0(p.inc)}</td><td className="right-num mono">⃁ {n0(p.maxH)}</td><td className="right-num mono" style={{fontWeight:700,color:"var(--green)"}}>⃁ {n0(p.sup)}/mo</td></tr>))}</tbody></table>
        <div className="muted" style={{fontSize:11.5,marginTop:8}}>{dirty?("✎ "+t("fp_candidate")):("● "+t("fp_baseline"))}</div>
      </Section>
    </div>
    <Section title={t("fv_title")}>
      <div className="rel-time">
        <div className={"rel-item"+(dirty?" cur":"")}><span className="rel-dot"/><div className="rel-head"><b>FML-v1.1</b> <span className="muted" style={{fontSize:12}}>· {t("fv_candidate")}</span><span className="chip amber" style={{marginInlineStart:8}}>{t("fv_pending")}</span></div><ul className="rel-list"><li>{t("fv_v11")}</li></ul></div>
        <div className={"rel-item"+(dirty?"":" cur")}><span className="rel-dot"/><div className="rel-head"><b>FML-v1.0</b> <span className="muted" style={{fontSize:12}}>· 2026-05-01</span><span className="chip" style={{marginInlineStart:8}}>{t("fv_active")}</span></div><ul className="rel-list"><li>{t("fv_v10")}</li></ul></div>
      </div>
    </Section>
    {FORMULAS.map(f=>(<Section key={f.k} title={t(f.title)}>
      <div className="fml-eq">{t(f.k)}</div>
      <div className="muted" style={{fontSize:13,marginTop:10,lineHeight:1.7}}><b>{t("f_example")}:</b> {t(f.ex)}</div>
    </Section>))}
  </div>);
}

/* ===== AI insights (dashboard) ===== */
const INSIGHTS=[{k:"ins_tenure",tone:"info"},{k:"ins_fiscal",tone:"good"},{k:"ins_fair",tone:"warn"}];
function AIInsights(){
  const {t}=useStore();
  return (<Section title={<span className="sect-right">✦ {t("ins_title")}</span>} sub={t("ins_sub")}>
    <div className="cols-3">
      {INSIGHTS.map(i=>(<div key={i.k} className={"insight-card "+i.tone}>
        <div className="ic-h">{t(i.k+"_h")}</div>
        <div className="ic-t">{t(i.k+"_t")}</div>
        <div className="ic-r">✦ {t(i.k+"_r")}</div>
      </div>))}
    </div>
  </Section>);
}
Object.assign(I18N.en,{ nav_settings:"Settings", nav_formula:"Subsidy Formula",
  set_sub:"Central configuration — all thresholds and operating parameters", set_save:"Save changes", set_saved:"Settings saved", set_readonly:"Read-only", set_note:"Changing critical thresholds requires Business Owner approval", set_lastMod:"Last modified",
  set_g_dq:"Data quality", set_g_budget:"Budget thresholds", set_g_budgetC:"Budget constants", set_g_esc:"Escalation & time limits", set_g_fair:"Fairness gap", set_g_hbr:"Housing burden (HBR)", set_g_mon:"Monitoring thresholds",
  set_minComplete:"Minimum data completeness", set_earlyAlert:"Early budget alert", set_critAlert:"Critical budget alert", set_annual:"Annual budget (SAR M)", set_eligible:"Total eligible population", set_minThresh:"Ministerial escalation (redistribution)", set_boTime:"Business Owner response time", set_minTime:"Minister escalation deadline", set_fgMin:"Fairness Gap minimum acceptable", set_hbrCeil:"HBR ceiling", set_demandChg:"Significant change in demand", set_improveDur:"Improvement duration for HBR",
  f_sub:"The formulas behind the engine — with worked examples", f_note:"All figures anchored to BRD V0.5.1", f_example:"Example",
  f_hbr:"Housing Burden Ratio (HBR)", f_hbrEx:"Net income SAR 12,000/mo, housing cost SAR 4,860/mo → 4,860 ÷ 12,000 = 40.5%",
  f_alloc:"Per-band support", f_allocEx:"Disposable income SAR 6,000 × 40% deduction = SAR 2,400 max housing cost; monthly support = actual − optimal interest",
  f_fg:"Fairness Gap", f_fgEx:"<10k group receives 36% of subsidy but is 62% of beneficiaries → 0.36 ÷ 0.62 = 0.58 (<1.0, under-served)",
  f_sav:"5-year savings", f_savEx:"Current-matrix spend − optimized scenario spend over the phase = SAR 1.37–3.4B",
  fv_title:"Formula versions", fv_test:"Test in What-if", fv_br07:"A modified formula must be validated in What-if before it can be activated.", fv_candidate:"Candidate", fv_pending:"Pending validation", fv_active:"Active", fv_v11:"Deduction rate 40% → 43% — needs What-if validation.", fv_v10:"Baseline formula in production.",
  al_gate1:"Spot-checked recommendations", al_gate2:"Compared vs last month", al_gate3:"Validated in What-if", al_gateHint:"Complete the checklist to enable submission",
  fp_params:"Formula parameters", fp_ded:"Optimal deduction rate", fp_dur:"Support duration", fp_yrs:"yrs", fp_ceil:"Financing ceiling", fp_rate:"Reference interest rate", fp_income:"Income threshold (statutory)", fp_lockedNote:"Fixed — Ministry of Human Resources poverty line", fp_activate:"Activate v1.1", fp_rollback:"Rollback to v1.0", fp_activated:"Candidate activated (after What-if validation)", fp_rolledback:"Rolled back to v1.0", fp_preview:"Preview by income band", fp_previewNote:"Recomputed live as parameters change", fp_inc:"Income", fp_maxH:"Max housing cost", fp_sup:"Est. monthly support", fp_candidate:"Candidate (unsaved) — validate before activating", fp_baseline:"Matches active v1.0",
  fc_monthly:"Monthly", fc_cumulative:"Cumulative", fc_actual:"Actual", fc_forecast:"Forecast (OLS)", fc_ci:"Confidence ±12%",
  ins_title:"AI insights", ins_sub:"Natural-language reading of the current state",
  ins_tenure_h:"Structural tenure shift", ins_tenure_t:"Rent inflation 8–10% far outpaces wage growth 4–5%, while purchase prices stay in low single digits.", ins_tenure_r:"Shift budget toward purchase subsidies to move citizens out of the volatile rental market.",
  ins_fiscal_h:"Fiscal runway", ins_fiscal_t:"Projected annual spend tracks to ~76%, leaving ~24% (SAR 384M) of budget headroom.", ins_fiscal_r:"Use this headroom for strategic reallocation toward high-need applicants.",
  ins_fair_h:"Fairness gap", ins_fair_t:"FG 0.58 with HBR 40.5% signals misallocation — support isn't reaching the most vulnerable.", ins_fair_r:"Recalibrate the subsidy matrix to raise precision for high-vulnerability segments.",
  whatif_sandbox:"Sandbox-isolated — simulations never touch live allocations or budgets." });
Object.assign(I18N.zh,{ nav_settings:"设置", nav_formula:"补贴公式",
  set_sub:"中央配置 —— 所有阈值与运行参数", set_save:"保存修改", set_saved:"设置已保存", set_readonly:"只读", set_note:"修改关键阈值需业务负责人审批", set_lastMod:"最近修改",
  set_g_dq:"数据质量", set_g_budget:"预算阈值", set_g_budgetC:"预算常量", set_g_esc:"升级与时限", set_g_fair:"公平性差距", set_g_hbr:"住房负担 (HBR)", set_g_mon:"监测阈值",
  set_minComplete:"最低数据完整度", set_earlyAlert:"预算预警(早期)", set_critAlert:"预算预警(严重)", set_annual:"年度预算 (SAR M)", set_eligible:"合格总人口", set_minThresh:"部长升级阈值(再分配)", set_boTime:"业务负责人响应时限", set_minTime:"部长升级截止", set_fgMin:"公平差距最低可接受", set_hbrCeil:"HBR 上限", set_demandChg:"需求显著变化", set_improveDur:"HBR 改善持续",
  f_sub:"引擎背后的公式 —— 附算例", f_note:"数据均锚定 BRD V0.5.1", f_example:"算例",
  f_hbr:"住房负担比 (HBR)", f_hbrEx:"净收入 12,000/月,住房成本 4,860/月 → 4,860 ÷ 12,000 = 40.5%",
  f_alloc:"分档支援", f_allocEx:"可支配收入 6,000 × 40% 扣减 = 2,400 最高住房成本;月度支援 = 实际 − 最优利息",
  f_fg:"公平性差距", f_fgEx:"<1万群体获 36% 支援,却占 62% 受益人 → 0.36 ÷ 0.62 = 0.58(<1.0,偏少)",
  f_sav:"5 年节省", f_savEx:"现行矩阵支出 − 优化情景支出(整个阶段)= SAR 13.7–34 亿",
  fv_title:"公式版本", fv_test:"在 What-if 中测试", fv_br07:"修改后的公式必须先在 What-if 验证,才能激活。", fv_candidate:"候选", fv_pending:"待验证", fv_active:"生效中", fv_v11:"扣除率 40% → 43% —— 需 What-if 验证。", fv_v10:"生产环境基线公式。",
  al_gate1:"已抽查推荐", al_gate2:"已对比上月", al_gate3:"已在 What-if 验证", al_gateHint:"完成清单后方可提交",
  fp_params:"公式参数", fp_ded:"最优扣除率", fp_dur:"支援期限", fp_yrs:"年", fp_ceil:"融资上限", fp_rate:"参考利率", fp_income:"收入门槛(法定)", fp_lockedNote:"固定 —— 人力资源部贫困线", fp_activate:"激活 v1.1", fp_rollback:"回滚到 v1.0", fp_activated:"候选已激活(经 What-if 验证后)", fp_rolledback:"已回滚到 v1.0", fp_preview:"按收入档预览", fp_previewNote:"参数变化时实时重算", fp_inc:"收入", fp_maxH:"最高住房成本", fp_sup:"预估月补", fp_candidate:"候选(未保存)—— 激活前需验证", fp_baseline:"与生效 v1.0 一致",
  fc_monthly:"月度", fc_cumulative:"累计", fc_actual:"实际", fc_forecast:"预测(OLS)", fc_ci:"置信区间 ±12%",
  ins_title:"AI 洞察", ins_sub:"对当前态势的自然语言解读",
  ins_tenure_h:"结构性租购转变", ins_tenure_t:"租金通胀 8–10% 远超工资增长 4–5%,而购房价格仍处低个位数。", ins_tenure_r:"建议将预算转向购房补贴,把公民从动荡的租赁市场转移出来。",
  ins_fiscal_h:"财政空间", ins_fiscal_t:"预计年度支出约 76%,剩余约 24%(SAR 3.84 亿)预算空间。", ins_fiscal_r:"利用该空间向高需求申请者做战略再分配。",
  ins_fair_h:"公平差距", ins_fair_t:"FG 0.58 叠加 HBR 40.5%,显示资金配置不佳 —— 支援未触达最脆弱群体。", ins_fair_r:"校准补贴矩阵,提高对高脆弱性群体的精准度。",
  whatif_sandbox:"沙箱隔离 —— 推演绝不影响线上配分或预算。" });
Object.assign(I18N.ar,{ nav_settings:"الإعدادات", nav_formula:"صيغة الدعم",
  set_sub:"التهيئة المركزية — جميع العتبات ومعاملات التشغيل", set_save:"حفظ التغييرات", set_saved:"تم حفظ الإعدادات", set_readonly:"للقراءة فقط", set_note:"تغيير العتبات الحرجة يتطلب موافقة مالك الأعمال", set_lastMod:"آخر تعديل",
  set_g_dq:"جودة البيانات", set_g_budget:"عتبات الميزانية", set_g_budgetC:"ثوابت الميزانية", set_g_esc:"التصعيد والمهل", set_g_fair:"فجوة العدالة", set_g_hbr:"عبء السكن (HBR)", set_g_mon:"عتبات المراقبة",
  set_minComplete:"الحد الأدنى لاكتمال البيانات", set_earlyAlert:"تنبيه ميزانية مبكر", set_critAlert:"تنبيه ميزانية حرج", set_annual:"الميزانية السنوية (SAR M)", set_eligible:"إجمالي السكان المؤهلين", set_minThresh:"عتبة تصعيد الوزير (إعادة التوزيع)", set_boTime:"مهلة رد مالك الأعمال", set_minTime:"مهلة تصعيد الوزير", set_fgMin:"الحد الأدنى المقبول لفجوة العدالة", set_hbrCeil:"سقف HBR", set_demandChg:"تغيّر كبير في الطلب", set_improveDur:"مدة تحسّن HBR",
  f_sub:"الصيغ خلف المحرك — مع أمثلة محلولة", f_note:"جميع الأرقام مرتبطة بـ BRD V0.5.1", f_example:"مثال",
  f_hbr:"نسبة عبء السكن (HBR)", f_hbrEx:"دخل صافٍ ١٢٬٠٠٠/شهر، تكلفة سكن ٤٬٨٦٠/شهر → ٤٬٨٦٠ ÷ ١٢٬٠٠٠ = ٤٠٫٥٪",
  f_alloc:"الدعم حسب الشريحة", f_allocEx:"دخل متاح ٦٬٠٠٠ × خصم ٤٠٪ = ٢٬٤٠٠ أقصى تكلفة سكن؛ الدعم الشهري = الفعلي − الفائدة المثلى",
  f_fg:"فجوة العدالة", f_fgEx:"شريحة <١٠ك تحصل على ٣٦٪ من الدعم لكنها ٦٢٪ من المستفيدين → ٠٫٣٦ ÷ ٠٫٦٢ = ٠٫٥٨ (<١٫٠)",
  f_sav:"وفورات ٥ سنوات", f_savEx:"إنفاق المصفوفة الحالية − إنفاق السيناريو الأمثل = ١٫٣٧–٣٫٤ مليار ريال",
  fv_title:"إصدارات الصيغة", fv_test:"اختبار في What-if", fv_br07:"يجب التحقق من الصيغة المعدّلة في What-if قبل تفعيلها.", fv_candidate:"مرشّح", fv_pending:"بانتظار التحقق", fv_active:"فعّال", fv_v11:"معدل الخصم ٤٠٪ → ٤٣٪ — يحتاج تحقق What-if.", fv_v10:"الصيغة الأساسية في الإنتاج.",
  al_gate1:"تم فحص التوصيات", al_gate2:"تمت المقارنة بالشهر الماضي", al_gate3:"تم التحقق في What-if", al_gateHint:"أكمل القائمة لتمكين الإرسال",
  fp_params:"معاملات الصيغة", fp_ded:"معدل الخصم الأمثل", fp_dur:"مدة الدعم", fp_yrs:"سنة", fp_ceil:"سقف التمويل", fp_rate:"سعر الفائدة المرجعي", fp_income:"حدّ الدخل (نظامي)", fp_lockedNote:"ثابت — خط الفقر لوزارة الموارد البشرية", fp_activate:"تفعيل v1.1", fp_rollback:"التراجع إلى v1.0", fp_activated:"تم تفعيل المرشّح (بعد تحقق What-if)", fp_rolledback:"تم التراجع إلى v1.0", fp_preview:"معاينة حسب شريحة الدخل", fp_previewNote:"يُعاد حسابه فور تغيير المعاملات", fp_inc:"الدخل", fp_maxH:"أقصى تكلفة سكن", fp_sup:"الدعم الشهري التقديري", fp_candidate:"مرشّح (غير محفوظ) — تحقّق قبل التفعيل", fp_baseline:"مطابق للنسخة الفعّالة v1.0",
  fc_monthly:"شهري", fc_cumulative:"تراكمي", fc_actual:"فعلي", fc_forecast:"تنبؤ (OLS)", fc_ci:"ثقة ±١٢٪",
  ins_title:"رؤى الذكاء الاصطناعي", ins_sub:"قراءة لغوية للوضع الحالي",
  ins_tenure_h:"تحوّل هيكلي في الحيازة", ins_tenure_t:"تضخم الإيجار ٨–١٠٪ يفوق نمو الأجور ٤–٥٪، بينما تبقى أسعار الشراء منخفضة.", ins_tenure_r:"تحويل الميزانية نحو دعم الشراء لإخراج المواطنين من سوق الإيجار المتقلب.",
  ins_fiscal_h:"المتسع المالي", ins_fiscal_t:"الإنفاق السنوي المتوقع نحو ٧٦٪، يتبقى نحو ٢٤٪ (٣٨٤ مليون ريال).", ins_fiscal_r:"استخدام هذا المتسع لإعادة توزيع استراتيجية نحو الأشد حاجة.",
  ins_fair_h:"فجوة العدالة", ins_fair_t:"فجوة ٠٫٥٨ مع HBR ٤٠٫٥٪ تشير إلى سوء تخصيص — الدعم لا يصل للأكثر هشاشة.", ins_fair_r:"إعادة معايرة مصفوفة الدعم لرفع الدقة للشرائح الأشد هشاشة.",
  whatif_sandbox:"معزول في بيئة اختبار — المحاكاة لا تمسّ التخصيصات أو الميزانيات الحية." });

/* ===== Dashboard KPI detail modal (12-mo trend + drill) ===== */
const KMON=["Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar","Apr","May","Jun"];
const KPI_DETAIL={
  ownership:{titleKey:"kpi_ownership",unit:"%",thr:70,series:[63.0,63.5,64.0,64.2,64.6,65.0,65.2,65.5,65.8,66.0,66.1,66.24],drill:[["Riyadh",68],["Makkah",64],["Eastern",71],["Asir",60],["Madinah",66]],events:[]},
  savings:{titleKey:"kpi_savings",unit:"B",series:[0.2,0.5,0.8,1.0,1.3,1.6,1.8,2.0,2.3,2.6,2.9,3.1],drill:[["Riyadh",0.9],["Makkah",0.7],["Eastern",0.6],["Asir",0.5],["Others",0.4]],events:[]},
  fairness:{titleKey:"kpi_fairness",unit:"",thr:1.0,series:[0.58,0.62,0.66,0.71,0.76,0.81,0.86,0.90,0.94,0.97,1.00,1.02],drill:[["<5K",0.51],["5–10K",0.72],["10–15K",1.02],["15–20K",1.18],[">20K",1.25]],events:[["May","ev_rebalance"]]},
  hbr:{titleKey:"kpi_hbr",unit:"%",thr:38,series:[41.0,40.8,40.5,40.1,39.6,39.0,38.4,37.9,37.4,37.0,36.6,36.2],drill:[["<3K",38.5],["3–5K",35.1],["5–10K",31.4],["10–20K",28.2],[">20K",22.5]],events:[["Jun","ev_fmlAct"]]},
  budget:{titleKey:"kpi_budget",unit:"%",thr:90,series:[12,22,32,41,50,58,64,70,76,80,85,89],drill:[["Cash",54],["In-kind",22],["Interest",13]],events:[["Jun","ev_alert"]]},
};
function KpiDetailModal({kpi,onClose}){
  const {t}=useStore(); const d=KPI_DETAIL[kpi]; if(!d) return null;
  const C=RC; const ok=!!RC.ResponsiveContainer;
  const data=KMON.map((m,i)=>({m,v:d.series[i]}));
  const maxDrill=Math.max(...d.drill.map(x=>x[1]));
  return (<Modal title={<span className="rel-mtitle">📈 {t(d.titleKey)} · {t("kd_trend")}</span>} onClose={onClose}>
    <div style={{width:"100%",height:240,marginBottom:10}}>
      {!ok? <div className="muted" style={{padding:20}}>{t("kd_noChart")}</div> :
      <C.ResponsiveContainer>
        <C.LineChart data={data} margin={{top:8,right:14,left:0,bottom:4}}>
          <C.CartesianGrid strokeDasharray="3 3" stroke="#eef2ef"/>
          <C.XAxis dataKey="m" tick={{fontSize:10}}/>
          <C.YAxis tick={{fontSize:10}} width={36}/>
          <C.Tooltip formatter={(v)=>v+d.unit}/>
          {d.thr!=null?<C.ReferenceLine y={d.thr} stroke="#b3261e" strokeDasharray="4 4"/>:null}
          <C.Line type="monotone" dataKey="v" stroke="#006C35" strokeWidth={2.5} dot={false}/>
        </C.LineChart>
      </C.ResponsiveContainer>}
    </div>
    <div style={{fontWeight:700,fontSize:13,margin:"6px 0 10px"}}>{t("kd_drill")}</div>
    <div className="kd-bars">
      {d.drill.map(([n,v])=>{ const over=kpi==="hbr"&&v>d.thr;
        return (<div key={n} className="kd-row">
          <span className="kd-name">{n}</span>
          <span className="kd-bar"><span style={{width:(v/maxDrill*100)+"%",background:over?"var(--amber)":"var(--green)"}}/></span>
          <span className="kd-val mono">{v}{d.unit}</span>
        </div>);})}
    </div>
    {d.events.length>0?<div style={{marginTop:14}}>
      <div style={{fontWeight:700,fontSize:13,marginBottom:6}}>{t("kd_events")}</div>
      {d.events.map(([m,k])=>(<div key={k} className="muted" style={{fontSize:12.5}}>— {m}: {t(k)}</div>))}
    </div>:null}
    <div style={{display:"flex",justifyContent:"flex-end",marginTop:14}}>
      <button className="btn secondary" onClick={onClose}>{t("rel_close")}</button>
    </div>
  </Modal>);
}
Object.assign(I18N.en,{ viewTrend:"View trend", kd_trend:"12-month trend", kd_drill:"By income bracket", kd_events:"Key events", kd_noChart:"Chart unavailable (offline)", ev_fmlAct:"Formula update activated", ev_rebalance:"Rebalancing applied", ev_alert:"Budget alert at 73%", wf_runHint:"Run What-if", al_showTrace:"Show trace", al_vsPrev:"vs last month",
  tr_data:"GOSI income ingested · completeness 96.2%", tr_opt:"Applied HBR ≤ 38% · Fairness Gap ≥ 1.0 · optimal rate 2.4%", tr_type:"Compared 5 support types · selected best by HBR",
  alx_how:"How calculated", alx_howT:"GOSI income → deduction rate → max housing cost → optimal rate → monthly support", alx_why:"Why this amount", alx_impact:"Impact if adopted", alx_reason:"FML-v1.1 deduction rate +3pp", alx_annotate:"Annotate", alx_annoPh:"Note for the Business Owner — sent with the decision package" });
Object.assign(I18N.zh,{ viewTrend:"查看趋势", kd_trend:"12 个月趋势", kd_drill:"按收入档", kd_events:"关键事件", kd_noChart:"图表不可用(离线)", ev_fmlAct:"公式更新已激活", ev_rebalance:"已执行再平衡", ev_alert:"预算预警 73%", wf_runHint:"跑 What-if", al_showTrace:"展示链路", al_vsPrev:"环比上月",
  tr_data:"已接入 GOSI 收入 · 完整度 96.2%", tr_opt:"应用 HBR ≤ 38% · Fairness Gap ≥ 1.0 · 最优利率 2.4%", tr_type:"比较 5 种支援类型 · 按 HBR 选最优",
  alx_how:"如何算出", alx_howT:"GOSI 收入 → 扣除率 → 最高住房成本 → 最优利率 → 月度支援", alx_why:"为何是此金额", alx_impact:"采纳后影响", alx_reason:"FML-v1.1 扣除率 +3pp", alx_annotate:"加注释", alx_annoPh:"给业务负责人的备注 —— 随决策包一并提交" });
Object.assign(I18N.ar,{ viewTrend:"عرض الاتجاه", kd_trend:"اتجاه ١٢ شهراً", kd_drill:"حسب شريحة الدخل", kd_events:"أحداث رئيسية", kd_noChart:"الرسم غير متاح (دون اتصال)", ev_fmlAct:"تم تفعيل تحديث الصيغة", ev_rebalance:"تم تطبيق إعادة التوازن", ev_alert:"تنبيه ميزانية عند ٧٣٪", wf_runHint:"تشغيل What-if", al_showTrace:"عرض المسار", al_vsPrev:"مقارنة بالشهر الماضي",
  tr_data:"تم استيعاب دخل التأمينات · الاكتمال ٩٦٫٢٪", tr_opt:"تطبيق HBR ≤ ٣٨٪ · فجوة العدالة ≥ ١٫٠ · معدل أمثل ٢٫٤٪", tr_type:"مقارنة ٥ أنواع دعم · اختيار الأفضل حسب HBR",
  alx_how:"كيف حُسب", alx_howT:"دخل التأمينات → معدل الخصم → أقصى تكلفة سكن → المعدل الأمثل → الدعم الشهري", alx_why:"لماذا هذا المبلغ", alx_impact:"الأثر عند الاعتماد", alx_reason:"FML-v1.1 معدل الخصم +٣ نقاط", alx_annotate:"إضافة ملاحظة", alx_annoPh:"ملاحظة لمالك الأعمال — تُرسل مع حزمة القرار" });

/* ===== Mega KPI visualisations (inline SVG, no chart dep) ===== */
function arcPts(cx,cy,r,a0,a1,n){ const p=[]; for(let i=0;i<=n;i++){ const a=(a0+(a1-a0)*i/n)*Math.PI/180; p.push((cx+r*Math.cos(a)).toFixed(1)+","+(cy-r*Math.sin(a)).toFixed(1)); } return p.join(" "); }
function RadialGauge({value,target,max,unit,color}){
  const frac=Math.max(0,Math.min(1,value/max)); const r=44,cx=56,cy=52;
  const ta=(180-180*(target/max))*Math.PI/180;
  return (<svg viewBox="0 0 112 60" width="100%" height="72">
    <polyline points={arcPts(cx,cy,r,180,0,30)} fill="none" stroke="#e6ece9" strokeWidth="9" strokeLinecap="round"/>
    <polyline points={arcPts(cx,cy,r,180,180-180*frac,30)} fill="none" stroke={color||"var(--green)"} strokeWidth="9" strokeLinecap="round"/>
    <line x1={cx+(r-8)*Math.cos(ta)} y1={cy-(r-8)*Math.sin(ta)} x2={cx+(r+6)*Math.cos(ta)} y2={cy-(r+6)*Math.sin(ta)} stroke="#085D3A" strokeWidth="2"/>
    <text x={cx} y={cy-4} textAnchor="middle" fontSize="17" fontWeight="800" fill="#16211c">{value}{unit}</text>
  </svg>);
}
function MiniArea({series,thr,min,max,color}){
  const W=120,H=54,mn=min??Math.min(...series)-1,mx=max??Math.max(...series)+1;
  const xy=series.map((v,i)=>[(i/(series.length-1))*W,H-((v-mn)/(mx-mn))*H]);
  const line="M"+xy.map(p=>p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" L");
  const ty=thr!=null?H-((thr-mn)/(mx-mn))*H:null;
  return (<svg viewBox={"0 0 "+W+" "+H} width="100%" height="60" preserveAspectRatio="none">
    <path d={line+" L"+W+" "+H+" L0 "+H+" Z"} fill="rgba(27,131,84,.12)"/>
    <path d={line} fill="none" stroke={color||"var(--green)"} strokeWidth="2"/>
    {ty!=null?<line x1="0" y1={ty} x2={W} y2={ty} stroke="#b3261e" strokeDasharray="4 3" strokeWidth="1.2"/>:null}
  </svg>);
}
function MiniBars({data,thr}){
  const mx=Math.max(...data.map(d=>d[1]),thr||0)*1.1;
  return (<div style={{display:"flex",alignItems:"flex-end",gap:6,height:60}}>
    {data.map(([n,v],i)=>{ const c=v>=(thr||1)?"var(--green)":v>=0.9?"var(--amber)":"var(--danger)";
      return <div key={i} title={n+": "+v} style={{flex:1,height:Math.max(4,v/mx*100)+"%",background:c,borderRadius:"3px 3px 0 0"}}/>;})}
  </div>);
}
function StackedBar({segments,marks,total}){
  return (<div style={{paddingTop:6}}>
    <div style={{position:"relative",height:18,borderRadius:9,overflow:"hidden",background:"#eef2ef",display:"flex"}}>
      {segments.map((s,i)=><span key={i} style={{width:(s.v/total*100)+"%",background:s.c}}/>)}
      {marks.map((m,i)=><span key={"m"+i} style={{position:"absolute",insetInlineStart:m+"%",top:-3,width:2,height:24,background:m>=90?"#b3261e":"#9a6b00"}}/>)}
    </div>
  </div>);
}
function MegaKpi({title,value,delta,children,onClick}){
  const {t}=useStore();
  const dcol=delta&&delta[0]==="▲"?"var(--green)":delta&&delta[0]==="▼"?"var(--amber)":"var(--muted)";
  return (<div className={"mega-kpi"+(onClick?" kpi-click":"")} onClick={onClick}>
    <div className="mk-title">{title}</div>
    <div className="mk-viz">{children}</div>
    <div className="mk-foot">{value?<span className="mk-val">{value}</span>:<span/>}{delta?<span className="mk-delta" style={{color:dcol}}>{delta}</span>:null}</div>
    {onClick?<div className="kpi-more">{t("viewTrend")} ↗</div>:null}
  </div>);
}
Object.assign(I18N.en,{ kpi_ownership:"Home Ownership", dl_title:"Data lineage & gate", dl_go:"GO — ready for downstream", dl_hold:"HOLD — completeness below 90%", dl_opt:"Optimization", dl_fc:"Forecast", dl_track:"Tracking" });
Object.assign(I18N.zh,{ kpi_ownership:"住房拥有率", dl_title:"数据血缘与门控", dl_go:"GO —— 可供下游使用", dl_hold:"HOLD —— 完整度低于 90%", dl_opt:"优化", dl_fc:"预测", dl_track:"追踪" });
Object.assign(I18N.ar,{ kpi_ownership:"نسبة التملّك", dl_title:"سلالة البيانات والبوابة", dl_go:"GO — جاهز للمراحل التالية", dl_hold:"HOLD — الاكتمال دون ٩٠٪", dl_opt:"التحسين", dl_fc:"التنبؤ", dl_track:"التتبّع" });

function App(){
  const [user,setUserState]=useState(null);
  const [lang,setLang]=useState(()=>{ try{ const q=new URLSearchParams(window.location.search).get("ln"); if(q==="zh"||q==="ar"||q==="en") return q; }catch(e){} return "en"; });
  const [currency,setCurrency]=useState("symbol");
  const [route,setRoute]=useState("home");
  const [packages,setPackages]=useState(seedPackages);
  const [audit,setAudit]=useState(seedAudit);
  const [allocation,setAllocation]=useState({lastSync:"2026-06-01 06:00", recalcAt:null, status:"draft", rejectNote:"", at:null});
  const [leaks,setLeaks]=useState(seedLeaks);
  const [budget,setBudget]=useState({cash:1580, inkind:220, ceiling:4200, enteredBy:"owner", enteredAt:"2026-05-28 10:00", daysSince:18});
  const t=(k)=>{ const d=I18N[lang]; if(d && d[k]!==undefined) return d[k]; const e=I18N.en; return (e && e[k]!==undefined) ? e[k] : k; };

  useEffect(()=>{ const html=document.documentElement; html.lang=lang; html.dir=lang==="ar"?"rtl":"ltr"; },[lang]);

  function setUser(r){ setUserState(r); setRoute(r==="minister"?"cockpit":"home"); }
  function pushAudit(ev){ setAudit(prev=>[{...ev,ts:nowStr(lang)},...prev]); }
  function addPackage(data){
    const ts=nowStr(lang);
    const id="WO-2026-0"+(400+packages.length);
    const pkg={ id, status:"submitted", sla:48,
      history:[{role:"analyst",action:"act_submit",ts,note:""}], ...data };
    setPackages(prev=>[pkg,...prev]);
    pushAudit({role:"analyst",action:"act_submit",target:id,status:"submitted"});
  }
  function actOnPackage(id,kind,note){
    const map={ approve:["approved","act_approve","owner"], escalate:["escalated","act_escalate","owner"],
      reject:["rejected","act_reject",user], adjudicate:["adjudicated","act_adjudicate","minister"] };
    const [status,action,role]=map[kind]; const ts=nowStr(lang);
    setPackages(prev=>prev.map(p=>p.id===id?{...p,status,history:[...p.history,{role,action,ts,note:note||""}]}:p));
    pushAudit({role,action,target:id,status,note:note||""});
  }
  function recalcAlloc(){ setAllocation(a=>({...a, recalcAt:nowStr(lang), status:"draft", rejectNote:"", at:null})); }
  function submitAlloc(){ setAllocation(a=>({...a, status:"submitted", at:nowStr(lang), rejectNote:""})); }
  function actAlloc(kind,note){ setAllocation(a=>({...a, status:kind==="approve"?"approved":"rejected", rejectNote:kind==="reject"?(note||""):"", at:nowStr(lang)})); }
  function leakAct(id,kind,note){
    const map={ report:["submitted","analyst"], adopt:["adopted","owner"], escalate:["escalated","owner"], adjudicate:["adjudicated","minister"], reject:["rejected",user] };
    const [status,role]=map[kind]; const ts=nowStr(lang);
    setLeaks(prev=>prev.map(l=>l.id===id?{...l,status,history:[...l.history,{role,kind,ts,note:note||""}]}:l));
  }
  function saveBudget(vals){ setBudget(b=>({...b,...vals, enteredBy:user, enteredAt:nowStr(lang), daysSince:0})); }
  function reset(){ setPackages(seedPackages()); setAudit(seedAudit()); setAllocation({lastSync:"2026-06-01 06:00", recalcAt:null, status:"draft", rejectNote:"", at:null}); setLeaks(seedLeaks()); setBudget({cash:1580, inkind:220, ceiling:4200, enteredBy:"owner", enteredAt:"2026-05-28 10:00", daysSince:18}); setRoute(user==="minister"?"cockpit":"home"); }

  const store={ t,lang,setLang,currency,setCurrency,user,setUser,route,setRoute,packages,audit,addPackage,actOnPackage,reset,allocation,recalcAlloc,submitAlloc,actAlloc,leaks,leakAct,budget,saveBudget };

  if(!user) return (<Ctx.Provider value={store}><Login/></Ctx.Provider>);

  let page=null;
  if(user==="analyst"){
    page = route==="data"?<DataReadiness/> : route==="formula"?<FormulaPage/> : route==="alloc"?<Allocation/> : route==="mortgage"?<MortgagePlanning/> : route==="forecast"?<ForecastFairness/>
      : route==="referrals"?<BeneficiaryTracking/> : route==="impact"?<ImpactAttribution/> : route==="whatif"?<WhatIf/> : route==="packages"?<DecisionPackages/>
      : route==="inventory"?<InventoryAbsorption/> : route==="benchmark"?<Benchmarking/> : route==="audit"?<AuditTrailPage/>
      : route==="copilot"?<CopilotHandoff/> : route==="agents"?<AgentArchitecture/> : route==="settings"?<SettingsPage/> : <AnalystHome/>;
  } else if(user==="owner"){
    page = route==="data"?<DataReadiness/> : route==="alloc"?<Allocation/> : route==="approvals"?<DecisionPackages filter={p=>p.status!=="draft"}/> : route==="referrals"?<BeneficiaryTracking/> : route==="forecast"?<ForecastFairness/>
      : route==="inventory"?<InventoryAbsorption/> : route==="impact"?<ImpactAttribution/> : route==="benchmark"?<Benchmarking/> : route==="audit"?<AuditTrailPage/> : route==="agents"?<AgentArchitecture/> : route==="settings"?<SettingsPage/> : <OwnerHome/>;
  } else {
    page = route==="decisions"?<DecisionPackages filter={p=>["escalated","adjudicated","rejected"].includes(p.status)}/>
      : route==="forecast"?<ForecastFairness/> : route==="impact"?<ImpactAttribution/> : route==="benchmark"?<Benchmarking/> : route==="audit"?<AuditTrailPage/> : route==="agents"?<AgentArchitecture/> : route==="settings"?<SettingsPage/> : <MinisterHome/>;
  }
  return (<Ctx.Provider value={store}>
    <TopBar/>
    <div className="shell"><Sidebar/><div className="content">{page}</div></div>
  </Ctx.Provider>);
}

export default App;
