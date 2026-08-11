// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let categoryChart = null;
let monthlyBarChart = null;
let cashflowChart = null;
let lastMonthlyData = {};

// Populated server-side (see the inline script in app_shell.html) so the
// page already knows the signed-in user without an extra round trip.
const account = window.LEDGER_USER || { username: "", profile_pic: null, currency_symbol: "₹", currency_locale: "en-IN" };

const currency = (n) => {
  const symbol = account.currency_symbol || "₹";
  const locale = account.currency_locale || "en-IN";
  return symbol + Number(n).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const monthLabel = (ymKey) => {
  const [y, m] = ymKey.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleString("default", { month: "short", year: "numeric" });
};

// Reads a live CSS custom property off <html> so chart colors always match
// the current theme + light/dark appearance chosen in Settings.
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// Small inline icon set for insight severities — kept local to this file
// since insight cards are built dynamically (the shared Jinja icon macro
// only helps with server-rendered markup).
const SEVERITY_ICONS = {
  critical: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  warning: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  positive: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  info: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 00-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0012 2z"/></svg>',
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  renderAvatars();
  const pdfBtn = document.getElementById("downloadPdfBtn");
  if (pdfBtn) pdfBtn.addEventListener("click", () => { window.location.href = "/api/reports/pdf"; });

  loadReports();
});

function renderAvatars() {
  const avatarBtn = document.getElementById("avatarBtn");
  const sidebarAvatar = document.getElementById("sidebarAvatar");
  [avatarBtn, sidebarAvatar].forEach((el) => {
    if (!el) return;
    if (account.profile_pic) {
      el.innerHTML = `<img src="${account.profile_pic}" alt="Profile photo" />`;
    } else {
      el.textContent = (account.username || "?").charAt(0).toUpperCase();
    }
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Not authenticated");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function loadReports() {
  const [summaryData] = await Promise.all([loadSummary(), loadInsights(), loadReportCashflow()]);
  return summaryData;
}

async function loadReportCashflow() {
  try {
    const data = await apiFetch("/api/money-flow");
    renderCashflowChart(data);
  } catch (err) {
    const svg = document.getElementById("cashflowChart");
    if (svg) svg.innerHTML = "";
  }
}

// ---------------------------------------------------------------------------
// Summary: stat cards, gauge, charts
// ---------------------------------------------------------------------------
async function loadSummary() {
  const summaryData = await apiFetch("/api/summary");
  lastMonthlyData = summaryData.monthly;

  countUpTo("reportIncomeValue", summaryData.total_income);
  countUpTo("reportExpenseValue", summaryData.total_expense);
  renderSavingsGauge(summaryData.monthly);

  renderCategoryChart(summaryData.by_category);
  renderMonthlyBarChart(summaryData.monthly);
  renderCashflowChart(summaryData.monthly);

  return summaryData;
}

// Animates a currency value counting up from 0 — small, well-established
// pattern for making a dashboard feel alive rather than just appearing.
function countUpTo(elementId, target, duration = 900) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const start = performance.now();
  const startVal = 0;

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
    const value = startVal + (target - startVal) * eased;
    el.textContent = currency(value);
    if (progress < 1) requestAnimationFrame(tick);
    else el.textContent = currency(target);
  }
  requestAnimationFrame(tick);
}

// Circular "this month's savings rate" gauge. Colors and label adapt to
// how healthy the rate is; the ring fills via an animated stroke-dashoffset.
function renderSavingsGauge(monthly) {
  const valueEl = document.getElementById("savingsRateValue");
  const labelEl = document.getElementById("savingsRateLabel");
  const fillEl = document.getElementById("gaugeFill");

  const months = Object.keys(monthly).sort();
  const lastMonth = months[months.length - 1];
  const circumference = 2 * Math.PI * 42;
  fillEl.style.strokeDasharray = `${circumference}`;
  fillEl.style.strokeDashoffset = `${circumference}`; // start empty, animate to target

  if (!lastMonth || !monthly[lastMonth] || monthly[lastMonth].income <= 0) {
    valueEl.textContent = "—";
    labelEl.textContent = "Not enough data yet this month";
    fillEl.style.stroke = cssVar("--muted");
    return;
  }

  const { income, expense } = monthly[lastMonth];
  const rate = (income - expense) / income; // can be negative
  const displayPct = Math.round(rate * 100);
  const clampedForRing = Math.max(0, Math.min(rate, 1)); // ring itself can't go below 0 or above full

  let color = cssVar("--income");
  let label = `${monthLabel(lastMonth)}'s savings rate`;
  if (rate < 0) {
    color = cssVar("--expense");
    label = `${monthLabel(lastMonth)}: spent more than earned`;
  } else if (rate < 0.2) {
    color = "#f59e0b";
  }

  fillEl.style.stroke = color;
  labelEl.textContent = label;

  // Animate the ring fill and the percentage text together, after layout
  // has settled (two rAFs — one to commit the 0% starting state, one to
  // trigger the CSS transition to the target offset).
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fillEl.style.strokeDashoffset = `${circumference * (1 - clampedForRing)}`;
    });
  });
  countUpPercent(valueEl, displayPct);
}

function countUpPercent(el, target, duration = 900) {
  const start = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.round(target * eased);
    el.textContent = `${value}%`;
    if (progress < 1) requestAnimationFrame(tick);
    else el.textContent = `${target}%`;
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------
function categoryPalette() {
  return [cssVar("--primary"), "#16a34a", "#dc2626", "#f59e0b", "#0ea5e9", "#8a5cae", "#3aa7a0"];
}

function renderCategoryChart(byCategory) {
  const ctx = document.getElementById("categoryChart");
  const palette = categoryPalette();
  const entries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const labels = entries.map(([cat]) => cat);
  const values = entries.map(([, amt]) => amt);
  const total = values.reduce((s, v) => s + v, 0);

  document.getElementById("donutTotalValue").textContent = currency(total);

  if (categoryChart) { categoryChart.destroy(); categoryChart = null; }

  const legendList = document.getElementById("categoryLegendList");
  if (!labels.length) {
    ctx.getContext("2d").clearRect(0, 0, ctx.width, ctx.height);
    legendList.innerHTML = '<li class="empty-state" style="padding:10px 0;">No expenses yet.</li>';
    return;
  }

  // Animated proportion bars behind each legend row — width transitions in
  // from 0 on the next frame, after the 0%-wide starting state has painted.
  legendList.innerHTML = entries.map(([cat, amt], i) => {
    const pct = total ? Math.round((amt / total) * 100) : 0;
    return `
      <li>
        <div class="legend-row">
          <span class="legend-name"><span class="legend-dot" style="background:${palette[i % palette.length]}"></span>${escapeHtml(cat)}</span>
          <span class="legend-value">${currency(amt)}</span>
        </div>
        <span class="legend-bar-track"><span class="legend-bar-fill" data-pct="${pct}" style="background:${palette[i % palette.length]}"></span></span>
      </li>
    `;
  }).join("");

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.querySelectorAll(".legend-bar-fill").forEach((el) => {
        el.style.width = `${el.dataset.pct}%`;
      });
    });
  });

  categoryChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: palette,
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "72%",
      plugins: { legend: { display: false } },
      animation: { duration: 900, easing: "easeOutQuart", animateScale: true },
    },
  });
}

function renderMonthlyBarChart(monthly) {
  const ctx = document.getElementById("monthlyBarChart");
  const labels = Object.keys(monthly).map(monthLabel);
  const income = Object.values(monthly).map((m) => m.income);
  const expense = Object.values(monthly).map((m) => m.expense);
  const gridColor = cssVar("--border");
  const tickColor = cssVar("--muted");

  if (monthlyBarChart) { monthlyBarChart.destroy(); monthlyBarChart = null; }

  if (!labels.length) {
    ctx.getContext("2d").clearRect(0, 0, ctx.width, ctx.height);
    return;
  }

  monthlyBarChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Income", data: income, backgroundColor: cssVar("--income"), borderRadius: 4, maxBarThickness: 18 },
        { label: "Expense", data: expense, backgroundColor: cssVar("--expense"), borderRadius: 4, maxBarThickness: 18 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      animation: { duration: 900, easing: "easeOutQuart", delay: (ctx) => ctx.dataIndex * 60 },
      scales: {
        y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor } },
        x: { grid: { display: false }, ticks: { color: tickColor } },
      },
    },
  });
}

function renderCashflowChart(data) {
  const svg = document.getElementById("cashflowChart");
  const tooltip = document.getElementById("reportFlowTooltip");
  if (!svg) return;
  svg.innerHTML = "";
  const income = Object.entries(data.income_by_category || {}).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).slice(0,7);
  const expenses = Object.entries(data.expense_by_category || {}).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).slice(0,9);
  const savings = Math.max(0, Number(data.savings)||0);
  if (!income.length || !expenses.length) return;
  const width=980, height=Math.max(300,(income.length+expenses.length)*25), nodeW=14, gap=8;
  svg.setAttribute("viewBox",`0 0 ${width} ${height+35}`);
  const ns="http://www.w3.org/2000/svg";
  const el=(tag,attrs={})=>{const x=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>x.setAttribute(k,v));return x;};
  const paletteIn=["#2563eb","#0ea5e9","#0d9488","#6366f1","#0891b2","#64748b","#14b8a6"];
  const paletteEx=["#dc2626","#f97316","#d946ef","#e11d48","#c2410c","#a855f7","#ef4444","#f43f5e","#fb7185"];
  const totalIncome=income.reduce((s,[,v])=>s+v,0);
  const right=[...expenses.map((n,i)=>({id:n[0],value:n[1],color:paletteEx[i%paletteEx.length]}))];
  if(savings>0) right.push({id:"Savings",value:savings,color:"#16a34a"});
  const left=income.map((n,i)=>({id:n[0],value:n[1],color:paletteIn[i%paletteIn.length]}));
  const total=totalIncome||1;
  const plotH=height-10;
  const distribute=(nodes)=>{let y=0; const totalGap=gap*(nodes.length-1); const avail=Math.max(20,plotH-totalGap); return nodes.map(n=>{const h=Math.max(7,n.value/total*avail);const out={...n,y0:y,y1:y+h};y+=h+gap;return out;});};
  const L=distribute(left), R=distribute(right);
  const midX=width/2, leftX=18, rightX=width-nodeW-18, hubX=midX-nodeW/2;
  const g=el("g",{transform:"translate(0,18)"}); svg.appendChild(g);
  const slot=(nodes)=>{let y=0;return nodes.map(n=>{const h=n.value/total*plotH;const out={y0:y,y1:y+h};y+=h;return out;});};
  const LS=slot(L), RS=slot(R);
  const pathFor=(x0,x1,a,b,color,label,value)=>{const mid=(x0+x1)/2;const p=el("path",{d:`M${x0},${a.y0} C${mid},${a.y0} ${mid},${b.y0} ${x1},${b.y0} L${x1},${b.y1} C${mid},${b.y1} ${mid},${a.y1} ${x0},${a.y1} Z`,fill:color,class:"sankey-link"});p.addEventListener("mouseenter",e=>{if(!tooltip)return;tooltip.textContent=`${label}: ${currency(value)}`;tooltip.classList.add("show");tooltip.style.left=`${Math.min(e.offsetX+10,Math.max(0,svg.clientWidth-220))}px`;tooltip.style.top=`${Math.max(8,e.offsetY-10)}px`;});p.addEventListener("mouseleave",()=>tooltip&&tooltip.classList.remove("show"));g.appendChild(p);};
  L.forEach((n,i)=>pathFor(leftX+nodeW,hubX,{y0:n.y0,y1:n.y1},{y0:LS[i].y0,y1:LS[i].y1},n.color,n.id,n.value));
  R.forEach((n,i)=>pathFor(hubX+nodeW,rightX,{y0:RS[i].y0,y1:RS[i].y1},{y0:n.y0,y1:n.y1},n.color,n.id,n.value));
  L.forEach(n=>g.appendChild(el("rect",{x:leftX,y:n.y0,width:nodeW,height:Math.max(2,n.y1-n.y0),rx:4,fill:n.color,class:"sankey-node-animated"})));
  R.forEach(n=>g.appendChild(el("rect",{x:rightX,y:n.y0,width:nodeW,height:Math.max(2,n.y1-n.y0),rx:4,fill:n.color,class:"sankey-node-animated"})));
  g.appendChild(el("rect",{x:hubX,y:0,width:nodeW,height:plotH,rx:5,fill:"#6366f1",class:"sankey-node-animated"}));
  const title=el("text",{x:midX,y:-2,"text-anchor":"middle",class:"sankey-hub-label",fill:cssVar("--ink")}); title.textContent="Income → Expenses + Savings"; g.appendChild(title);
  L.forEach(n=>{const t=el("text",{x:leftX+nodeW+8,y:n.y0+12,class:"sankey-label",fill:cssVar("--ink")});t.textContent=`${n.id} · ${currency(n.value)}`;g.appendChild(t);});
  R.forEach(n=>{const t=el("text",{x:rightX-8,y:n.y0+12,"text-anchor":"end",class:"sankey-label",fill:cssVar("--ink")});t.textContent=`${n.id} · ${currency(n.value)}`;g.appendChild(t);});
}


// ---------------------------------------------------------------------------
// Smart insights
// ---------------------------------------------------------------------------
async function loadInsights() {
  const loading = document.getElementById("insightsLoading");
  const list = document.getElementById("insightsList");
  const empty = document.getElementById("insightsEmptyState");

  try {
    const result = await apiFetch("/api/insights");
    loading.style.display = "none";

    if (!result.has_enough_data || !result.insights.length) {
      empty.style.display = "block";
      list.innerHTML = "";
      return result;
    }

    empty.style.display = "none";
    list.innerHTML = result.insights.map((ins, i) => `
      <div class="insight-card" data-severity="${ins.severity}" style="animation-delay:${i * 90}ms">
        <div class="insight-icon">${SEVERITY_ICONS[ins.severity] || SEVERITY_ICONS.info}</div>
        <div class="insight-body">
          <div class="insight-title">${escapeHtml(ins.title)}</div>
          <div class="insight-message">${escapeHtml(ins.message)}</div>
        </div>
      </div>
    `).join("");
    return result;
  } catch (err) {
    loading.style.display = "none";
    empty.style.display = "block";
    empty.textContent = "Couldn't load insights right now — try refreshing the page.";
    return null;
  }
}
