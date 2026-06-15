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
  { key:"sakani",  status:"ok",      quality:96, freq:"daily",     records:1402360, delta:0.4,  completeness:98, updated:"Today 06:00" },
  { key:"redf",    status:"ok",      quality:93, freq:"daily",     records:318540,  delta:1.2,  completeness:95, updated:"Today 05:30" },
  { key:"nhc",     status:"ok",      quality:90, freq:"weekly",    records:84210,   delta:-0.6, completeness:91, updated:"2 days ago" },
  { key:"rega",    status:"pending", quality:88, freq:"monthly",   records:51300,   delta:0.3,  completeness:88, updated:"Last month" },
  { key:"ncsi",    status:"delayed", quality:84, freq:"quarterly", records:540000,  delta:0.1,  completeness:86, updated:"1 quarter ago" },
  { key:"sama",    status:"ok",      quality:95, freq:"daily",     records:1250,    delta:0.0,  completeness:99, updated:"Today 06:00" },
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
function buildForecast(scn){
  const annualCeiling = BRD.phase3BudgetSAR / BRD.phase3Years; // 1.58B
  const monthlyCeiling = annualCeiling/12;
  const monthlyAvg = scn.spend/12;
  const months=[];
  let cum=0;
  for(let m=1;m<=12;m++){
    const seasonal = 1 + 0.12*Math.sin((m/12)*Math.PI*2 - 0.6); // mild seasonality
    const projected = monthlyAvg*seasonal;
    cum += projected;
    months.push({ m, projected:Math.round(projected), cumulative:Math.round(cum),
      ceiling:Math.round(monthlyCeiling*m) });
  }
  const alertMonth = months.find(x=>x.cumulative > monthlyCeiling*x.m*0.70);
  return { months, annualCeiling, alertMonth: alertMonth? alertMonth.m : null };
}

/* =========================================================================
   i18n  (English + Arabic).  Switching AR flips the whole app to RTL.
   ========================================================================= */
const I18N = {
  en:{
    appName:"Dynamic Subsidy Allocation & Optimization",
    sso_title:"Momrah Single Sign-On", sso_sub:"Unified national access to the Ministry of Municipalities & Housing digital services.", identity:"Identity",
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
    nav_home:"Home", nav_data:"Data Readiness", nav_alloc:"Allocation Plan", nav_forecast:"Forecast & Fairness",
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
    nav_home:"الرئيسية", nav_data:"جاهزية البيانات", nav_alloc:"خطة التخصيص", nav_forecast:"التنبؤ والعدالة",
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
function KPI({label,value,sub,tone}){
  const color = tone==="good"?"var(--green)":tone==="bad"?"var(--danger)":tone==="warn"?"var(--amber)":"var(--ink)";
  return (<div className={"kpi"+(tone?" kpi-"+tone:"")}><div className="label">{label}</div>
    <div className="value" style={{color}}>{value}</div>{sub&&<div className="sub">{sub}</div>}</div>);
}
function Section({title,sub,right,children}){
  return (<div className="card pad acc" style={{marginBottom:16}}>
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
  analyst:[["nav_home","◧"],["nav_data","⛁"],["nav_alloc","▦"],["nav_forecast","📈"],["nav_whatif","✦"],["nav_packages","📦"],["nav_audit","🕓"],["nav_copilot","🤝"]],
  owner:[["nav_home","◧"],["nav_data","⛁"],["nav_alloc","▦"],["nav_approvals","✔"],["nav_forecast","📈"],["nav_audit","🕓"]],
  minister:[["nav_cockpit","◧"],["nav_decisions","⚖"],["nav_forecast","📈"],["nav_audit","🕓"]],
};
function Sidebar(){
  const {t,user,route,setRoute,packages}=useStore();
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
  </div>);
}

const RECO_PARAMS = { reallocatePct:0.15, capHighPct:0.12, boostLowPct:0.10, offPlanPct:0.08 };

function PageHeader({title,sub,right}){
  return (<div className="page-h"><div><h1>{title}</h1>{sub&&<div className="sub">{sub}</div>}</div>{right}</div>);
}
function bandLabel(t,key){ return t("bl_"+key); }

/* ---- Analyst home ---- */
function AnalystHome(){
  const {t,setRoute,packages}=useStore(); const {money}=useMoney();
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
      <KPI label={t("kpi_savings")+" ("+t("recommended")+")"} value={money(sv.phase)} sub={(sv.pctOfBudget*100).toFixed(0)+"% "+t("of_budget")} tone="good"/>
      <KPI label={t("kpi_fairness")} value={BASELINE.FG.toFixed(2)} sub={t("fair_if")} tone="bad"/>
      <KPI label={t("kpi_hbr")} value={pct1(BASELINE.HBR)} sub={t("toTarget")} tone="warn"/>
      <KPI label={t("kpi_budget")} value={(BASELINE.spend/(BRD.phase3BudgetSAR/BRD.phase3Years)*100).toFixed(0)+"%"} sub={t("baseline")} />
    </div>
    <Section title={t("todo")}>
      {items.map((it,i)=>(<div key={i} className="todo-row">
        <span className="av sm">{it.ic}</span>
        <div style={{flex:1}}><div style={{fontWeight:600}}>{t(it.k)}</div></div>
        <span className={"chip "+it.chip}>{t(it.due)}</span>
        <button className="btn secondary sm" onClick={()=>setRoute(it.route)}>{t("more")} {ArrowIcon}</button>
      </div>))}
    </Section>
    <Section title={t("quickActions")}>
      <div className="cols-4">
        {quick.map(([k,ic,r])=>(<button key={k} className="role-opt" onClick={()=>setRoute(r)}>
          <span className="av">{ic}</span><span style={{fontWeight:600}}>{t(k)}</span></button>))}
      </div>
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
  const {t,user,budget,saveBudget,lang}=useStore();
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
          quality: Math.min(99, s.quality + 1 + Math.floor(Math.random()*2)),
          completeness: Math.min(99, s.completeness + 1 + Math.floor(Math.random()*2)),
          delta: +(Math.random()*1.7 - 0.3).toFixed(1),
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
            <div className="muted" style={{fontSize:11.5}}>{t(lk)}</div>
            {user==="owner"
              ? <input className="input mono" style={{height:30,padding:"0 8px",marginTop:4,fontSize:14,width:"100%"}} type="number" value={bform[f]} onChange={e=>{setBform({...bform,[f]:e.target.value});setSaved(false);}}/>
              : <div className="v">{budget[f]}<span className="muted" style={{fontSize:11,fontWeight:400}}> {t("mSar")}</span></div>}
          </div>))}
      </div>
      {user==="owner"&&<div style={{display:"flex",alignItems:"center",gap:12,marginTop:12,flexWrap:"wrap"}}>
        <button className="btn sm" onClick={()=>{saveBudget({cash:+bform.cash,inkind:+bform.inkind,ceiling:+bform.ceiling});setSaved(true);}}>💾 {t("saveBalance")}</button>
        {saved&&<span className="chip">✓ {t("done")}</span>}
        <span className="muted" style={{fontSize:12}}>{t("enteredBy")}: {t(budget.enteredBy)} · {budget.enteredAt}</span>
      </div>}
      {budget.daysSince>30&&<div className="banner" style={{marginTop:12,background:"var(--amber-50)",borderColor:"#ecdcae",color:"#6b5210"}}>⚠ {t("budStale")}</div>}
    </Section>
    <Section title="BIDSC">
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
    <div className={"cols-3"+(flash?" flash-sources":"")}>
      {sources.map(s=>{
        const tone=s.status==="ok"?"var(--green)":s.status==="pending"?"var(--amber)":"var(--danger)";
        const dCol=s.delta>0?"var(--green)":s.delta<0?"var(--danger)":"var(--muted)";
        const dStr=(s.delta>0?"▲ +":s.delta<0?"▼ ":"– ")+Math.abs(s.delta)+"%";
        return (<div key={s.key} className="card pad">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <strong>{t("src_"+s.key)}</strong>
            <span className="chip" style={{background:tone+"22",color:tone}}>● {statusToText(t,s.status)}</span></div>
          <div className="kv">
            <div className="kv-row"><span className="muted">{t("records")}</span>
              <span><span className="mono">{n0(s.records)}</span> <span className="mono" style={{color:dCol,fontSize:11}}>{dStr}</span> <span className="muted" style={{fontSize:11}}>{t("vsPrev")}</span></span></div>
            <div className="kv-row"><span className="muted">{t("freq")}</span><span>{s.freq}</span></div>
            <div className="kv-row"><span className="muted">{t("lastUpdate")}</span><span>{s.updated}</span></div>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,margin:"10px 0 4px"}}>
            <span className="muted">{t("quality")}</span><span className="mono">{s.quality}%</span></div>
          <Progress v={s.quality/100} color={tone}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,margin:"8px 0 4px"}}>
            <span className="muted">{t("completeness")}</span><span className="mono">{s.completeness}%</span></div>
          <Progress v={s.completeness/100} color="var(--info)"/>
        </div>);
      })}
    </div>
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
function Allocation(){
  const {t,user,allocation,recalcAlloc,submitAlloc,actAlloc}=useStore(); const {moneyFull}=useMoney();
  const [open,setOpen]=useState(null);
  const [busy,setBusy]=useState(false); const [note,setNote]=useState(""); const [err,setErr]=useState(false);
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
      {user==="analyst"&&<div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <button className="btn secondary sm" onClick={doRecalc} disabled={busy}>{busy?t("recalculating"):("↻ "+t("recalc"))}</button>
        {(a.status==="draft"||a.status==="rejected")&&<button className="btn sm" onClick={()=>submitAlloc&&submitAlloc()}>✔ {t("approveSubmit")}</button>}
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
    <Section title={t("monthlyCycle")} right={<span className="chip">{t("kpi_budget")}: {(data.spend/(BRD.phase3BudgetSAR/BRD.phase3Years)*100).toFixed(0)}%</span>}>
      <div className="scrollx"><table className="tbl">
        <thead><tr><th>{t("incomeBand")}</th><th className="right-num">{t("contracts")}</th><th className="right-num">{t("subsidy")}</th><th className="right-num">{t("share")}</th><th></th></tr></thead>
        <tbody>{data.rows.map((r,i)=>(<React.Fragment key={r.key}>
          <tr>
            <td>{bandLabel(t,r.key)} {r.below?<span className="chip gray" style={{marginInlineStart:6}}>{t("below10k")}</span>:null}</td>
            <td className="right-num mono">{n0(r.contracts)}</td>
            <td className="right-num mono">{moneyFull(r.subsidy)}</td>
            <td className="right-num mono">{(r.cShare*100).toFixed(1)}%</td>
            <td className="right-num"><button className="btn sm" onClick={()=>setOpen(open===i?null:i)}>{t("explain")}</button></td>
          </tr>
          {open===i&&<tr className="expand-row"><td colSpan={5}>
            <div style={{fontSize:12.5}}>
              <strong>{t("impact")}:</strong> {bandLabel(t,r.key)} — {r.below?t("below10k"):t("above10k")} · {t("subsidy")} {moneyFull(r.subsidy)} · {t("share")} {(r.cShare*100).toFixed(1)}% · HBR {pct1(r.hbr)}.
              <div className="muted" style={{marginTop:4}}>Within the approved policy matrix · contributes to Fairness Gap {BASELINE.FG.toFixed(2)}.</div>
            </div></td></tr>}
        </React.Fragment>))}</tbody>
      </table></div>
    </Section>
  </div>);
}

/* ---- Forecast & Fairness ---- */
function ForecastFairness(){
  const {t,user,leaks,leakAct}=useStore(); const {money}=useMoney();
  const scn=BASELINE; const fc=useMemo(()=>buildForecast(scn),[]);
  const regions=useMemo(()=>fgByRegion(scn.FG),[]);
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
    <Section title={t("spendForecast")}>
      <div style={{width:"100%",height:260}}>
        {!ok? noChart :
        <C.ResponsiveContainer>
          <C.LineChart data={fc.months} margin={{top:8,right:16,left:8,bottom:4}}>
            <C.CartesianGrid strokeDasharray="3 3" stroke="#eef2ef"/>
            <C.XAxis dataKey="m" tick={{fontSize:11}}/>
            <C.YAxis tickFormatter={abbr} tick={{fontSize:11}} width={48}/>
            <C.Tooltip formatter={(v)=>money(v)}/>
            <C.Line type="monotone" dataKey="cumulative" stroke="#006C35" strokeWidth={2} dot={false} name={t("kpi_budget")}/>
            <C.Line type="monotone" dataKey="ceiling" stroke="#b3261e" strokeDasharray="5 4" strokeWidth={2} dot={false} name={t("budgetCeiling")}/>
          </C.LineChart>
        </C.ResponsiveContainer>}
      </div>
    </Section>
    <Section title={t("fairnessByRegion")}>
      <div style={{width:"100%",height:300}}>
        {!ok? noChart :
        <C.ResponsiveContainer>
          <C.BarChart data={regions.map(r=>({name:t("rg_"+r.key),fg:r.fg}))} margin={{top:4,right:8,left:0,bottom:4}}>
            <C.CartesianGrid strokeDasharray="3 3" stroke="#eef2ef"/>
            <C.XAxis dataKey="name" tick={{fontSize:10}} interval={0} angle={-30} textAnchor="end" height={64}/>
            <C.YAxis tick={{fontSize:11}} domain={[0,1.4]}/>
            <C.Tooltip/>
            <C.ReferenceLine y={1.0} stroke="#006C35" strokeDasharray="4 4"/>
            <C.Bar dataKey="fg" radius={[3,3,0,0]}>
              {regions.map((r,i)=><C.Cell key={i} fill={r.fg>=1?"#006C35":r.fg>=0.9?"#9a6b00":"#b3261e"}/>)}
            </C.Bar>
          </C.BarChart>
        </C.ResponsiveContainer>}
      </div>
    </Section>
    <Section title={t("leakage")} sub={t("leak_routeHint")}>
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
      return (<div key={nd.k} className={"node "+(s==="run"?"run":s==="done"?"done":"")}>
        <span className="node-dot" style={{background:s==="done"?"var(--green)":s==="run"?"var(--info)":"#cbd5d0"}}/>
        <span style={{flex:1,fontSize:13,fontWeight:600}}>{t(nd.k)}</span>
        <span className="node-metric"><span className="ml">{t(nd.labelKey)}</span> <RollingMetric active={s==="run"} target={nd.target} format={nd.fmt}/></span>
        <span className="st" style={{color:s==="done"?"var(--green)":s==="run"?"var(--info)":"var(--muted)"}}>
          {s==="run"?t("running"):s==="done"?("✓ "+t("done")):"—"}</span>
      </div>); })}
  </div>);
}

/* ---- What-if — centerpiece ---- */
function WhatIf(){
  const {t,setRoute,addPackage,user}=useStore(); const {money}=useMoney();
  const [p,setP]=useState({reallocatePct:0,capHighPct:0,boostLowPct:0,offPlanPct:0});
  const [nl,setNl]=useState("");
  const [chain,setChain]=useState(["idle","idle","idle","idle"]);
  const [busy,setBusy]=useState(false);
  const [flash,setFlash]=useState(false);
  const [phase,setPhase]=useState(null);
  const scn=useMemo(()=>computeAllocation(p),[p]);
  const sv=scenarioSavings(scn);
  const C=RC;
  function animateChain(then){
    setBusy(true); setPhase("run");
    [0,1,2,3].forEach((i)=>{
      setTimeout(()=>{ setChain(c=>{const n=[...c];n[i]="run";return n;}); },i*450);
      setTimeout(()=>{ setChain(c=>{const n=[...c];n[i]="done";return n;}); if(i===3){setBusy(false); then&&then(); setFlash(true); setPhase("converge"); setTimeout(()=>{setFlash(false); setPhase(null);},1300);} },i*450+380);
    });
  }
  function runSim(){ animateChain(); }
  function runNL(){
    // light NL parse: first number → boost <10k; mention of cap/reduce → cap; else recommended preset
    const m=nl.match(/(\d+)\s*%?/); const num=m?clamp(parseInt(m[1])/100,0,0.45):0.10;
    const next={...RECO_PARAMS, boostLowPct:num};
    if(/cap|reduce|تقييد|خفض/i.test(nl)) next.capHighPct=0.20;
    animateChain(()=>setP(next));
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
  const cmp=[
    {k:t("kpi_savings"),b:"0",a:money(sv.phase),tone:"good"},
    {k:t("kpi_fairness"),b:BASELINE.FG.toFixed(2),a:scn.FG.toFixed(2),tone:scn.FG>=1?"good":"warn"},
    {k:t("kpi_hbr"),b:pct1(BASELINE.HBR),a:pct1(scn.HBR),tone:"good"},
  ];
  const Slider=({lk,field,max})=>(<div className="field">
    <label style={{display:"flex",justifyContent:"space-between"}}><span>{t(lk)}</span><span className="mono">{Math.round(p[field]*100)}%</span></label>
    <input className="range" type="range" min="0" max={max} step="1" value={Math.round(p[field]*100)}
      onChange={e=>setP({...p,[field]:parseInt(e.target.value)/100})}/></div>);
  return (<div className="fade">
    <PageHeader title={t("nav_whatif")} sub={t("whatif_sub")}/>
    <Section title={t("orchestration")}>
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <input className="input" placeholder={t("nlPlaceholder")} value={nl} onChange={e=>setNl(e.target.value)}/>
        <button className="btn" onClick={runNL} disabled={busy}>✦ {t("run")}</button>
      </div>
      {phase&&<ParticleField mode={phase}/>}
      {busy&&<div className="ai-working">✦ {t("aiWorking")}</div>}
      <OrchestrationChain states={chain}/>
    </Section>
    <div className="cols-2">
      <Section title={t("levers")} right={<button className="btn secondary sm" onClick={runSim} disabled={busy}>{busy?t("running"):t("runWhatif")}</button>}>
        <Slider lk="lv_realloc" field="reallocatePct" max="30"/>
        <Slider lk="lv_cap" field="capHighPct" max="35"/>
        <Slider lk="lv_boost" field="boostLowPct" max="45"/>
        <Slider lk="lv_offplan" field="offPlanPct" max="20"/>
      </Section>
      <div>
        <div className={"cols-3"+(flash?" flash-kpis":"")} style={{marginBottom:16}}>
          <KPI label={t("kpi_savings")} value={money(sv.phase)} sub={(sv.pctOfBudget*100).toFixed(0)+"% "+t("of_budget")} tone="good"/>
          <KPI label={t("kpi_fairness")} value={scn.FG.toFixed(2)} sub={t("fair_if")} tone={scn.FG>=1?"good":"warn"}/>
          <KPI label={t("kpi_hbr")} value={pct1(scn.HBR)} sub={t("toTarget")} tone="good"/>
        </div>
        <Section title={t("compare")}>
          <table className="tbl"><thead><tr><th></th><th className="right-num">{t("before")}</th><th className="right-num">{t("after")}</th></tr></thead>
            <tbody>{cmp.map((r,i)=>(<tr key={i}><td>{r.k}</td><td className="right-num mono muted">{r.b}</td>
              <td className="right-num mono" style={{fontWeight:700,color:r.tone==="good"?"var(--green)":"var(--amber)"}}>{r.a}</td></tr>))}</tbody></table>
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
  return (<div className="card pad" style={{marginBottom:14}}>
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
    <PageHeader title={t("nav_packages")} sub={t("pkg_sub")}/>
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
  const {t,audit}=useStore();
  const [sent,setSent]=useState(false);
  function deliver(){ setSent(true); setTimeout(()=>{ window.open("http://momah.test.hyrhui.com","_blank"); },700); }
  return (<div className="fade">
    <PageHeader title={t("nav_copilot")} sub={t("copilot_sub")}/>
    <Section title="API Contract → Housing Copilot">
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
  nav_home:"首页", nav_data:"数据就绪", nav_alloc:"配分方案", nav_forecast:"预测与公平",
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
Object.assign(I18N.en,{ syncOk:"Daily data sync succeeded", syncFail:"Daily data sync failed", importTitle:"Import to BIDSC", dropHint:"Drag a file here, or click to choose", validating:"Validating data accuracy…", checkPass:"Validation passed — ready to import", checkFail:"Validation failed — completeness <90% or exceptions >10%", importBtn:"Import to BIDSC", fileLabel:"File" });
Object.assign(I18N.zh,{ syncOk:"每日数据同步成功", syncFail:"每日数据同步失败", importTitle:"导入到 BIDSC", dropHint:"拖拽文件到此，或点击选择", validating:"正在校验数据准确性…", checkPass:"校验通过 — 可导入", checkFail:"校验未通过 — 完整度 <90% 或异常 >10%", importBtn:"导入到 BIDSC", fileLabel:"文件" });
Object.assign(I18N.ar,{ syncOk:"نجحت المزامنة اليومية للبيانات", syncFail:"فشلت المزامنة اليومية للبيانات", importTitle:"استيراد إلى BIDSC", dropHint:"اسحب ملفاً هنا أو اضغط للاختيار", validating:"جارٍ التحقق من دقة البيانات…", checkPass:"اجتاز التحقق — جاهز للاستيراد", checkFail:"فشل التحقق — الاكتمال <٩٠٪ أو الاستثناءات >١٠٪", importBtn:"استيراد إلى BIDSC", fileLabel:"الملف" });
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
  { id:"WO-2026-0312", title:"Q2 reallocation · Riyadh & Makkah", params:{reallocatePct:0.10,boostLowPct:0.08,offPlanPct:0.05}, affectsCap:false, status:"submitted",
    history:[{role:"analyst",action:"act_submit",ts:"03 Jun 09:12",note:""}] },
  { id:"WO-2026-0309", title:"Off-plan restriction · national", params:{offPlanPct:0.12,capHighPct:0.10}, affectsCap:true, status:"submitted",
    history:[{role:"analyst",action:"act_submit",ts:"02 Jun 14:40",note:""}] },
  { id:"WO-2026-0305", title:"Monthly support rebalancing", params:{reallocatePct:0.12,boostLowPct:0.10,offPlanPct:0.06}, affectsCap:false, status:"approved",
    history:[{role:"analyst",action:"act_submit",ts:"28 May 10:05",note:""},{role:"owner",action:"act_approve",ts:"29 May 11:20",note:"Within tactical authority"}] },
  { id:"WO-2026-0299", title:"Support cap revision · >16k band", params:{capHighPct:0.22,reallocatePct:0.18}, affectsCap:true, status:"escalated",
    history:[{role:"analyst",action:"act_submit",ts:"24 May 08:30",note:""},{role:"owner",action:"act_escalate",ts:"25 May 09:00",note:"Affects support cap"}] },
  { id:"WO-2026-0288", title:"Phase-3 fairness uplift", params:{reallocatePct:0.25,capHighPct:0.20,boostLowPct:0.15,offPlanPct:0.10}, affectsCap:true, status:"adjudicated",
    history:[{role:"analyst",action:"act_submit",ts:"18 May 09:00",note:""},{role:"owner",action:"act_escalate",ts:"19 May 10:00",note:""},{role:"minister",action:"act_adjudicate",ts:"21 May 12:30",note:"Approved with monitoring"}] },
  { id:"WO-2026-0276", title:"Aggressive cap scenario", params:{capHighPct:0.35,offPlanPct:0.20}, affectsCap:true, status:"rejected",
    history:[{role:"analyst",action:"act_submit",ts:"12 May 08:15",note:""},{role:"owner",action:"act_reject",ts:"13 May 09:40",note:"Too aggressive on >13k bands"}] },
];
function seedPackages(){ return RAW_SEED.map(p=>({ ...p, params:{...p.params}, history:p.history.map(h=>({...h})), kpis:makeKpis(p.params) })); }
function seedAudit(){ const out=[]; RAW_SEED.forEach(p=>p.history.forEach(h=>out.push({ role:h.role, action:h.action, target:p.id, status:STATUS_OF[h.action], ts:h.ts, note:h.note }))); return out.reverse(); }

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
    const pkg={ id, status:"submitted",
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
    page = route==="data"?<DataReadiness/> : route==="alloc"?<Allocation/> : route==="forecast"?<ForecastFairness/>
      : route==="whatif"?<WhatIf/> : route==="packages"?<DecisionPackages/> : route==="audit"?<AuditTrailPage/>
      : route==="copilot"?<CopilotHandoff/> : <AnalystHome/>;
  } else if(user==="owner"){
    page = route==="data"?<DataReadiness/> : route==="alloc"?<Allocation/> : route==="approvals"?<DecisionPackages filter={p=>p.status!=="draft"}/> : route==="forecast"?<ForecastFairness/>
      : route==="audit"?<AuditTrailPage/> : <OwnerHome/>;
  } else {
    page = route==="decisions"?<DecisionPackages filter={p=>["escalated","adjudicated","rejected"].includes(p.status)}/>
      : route==="forecast"?<ForecastFairness/> : route==="audit"?<AuditTrailPage/> : <MinisterHome/>;
  }
  return (<Ctx.Provider value={store}>
    <TopBar/>
    <div className="shell"><Sidebar/><div className="content">{page}</div></div>
  </Ctx.Provider>);
}

export default App;
