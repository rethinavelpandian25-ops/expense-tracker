// ---------------------------------------------------------------------------
// Hand-built Sankey diagram — no chart library dependency by design. A
// three-column flow (income sources -> "Income" hub -> expense categories +
// savings) is simple enough to lay out directly, and after a CDN chart
// plugin (jspdf-autotable) turned out to be an unreliable dependency in
// this project before, a self-contained implementation is the safer bet
// for something this central to the page.
// ---------------------------------------------------------------------------

const MAX_INCOME_NODES = 5;   // top N income categories; rest collapse into "Other income"
const MAX_EXPENSE_NODES = 7;  // top N expense categories; rest collapse into "Other expenses"

const account = window.LEDGER_USER || { username: "", profile_pic: null };

const currency = (n) =>
  "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

document.addEventListener("DOMContentLoaded", () => {
  renderAvatars();
  loadMoneyFlow();
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

async function loadMoneyFlow() {
  try {
    const data = await apiFetch("/api/money-flow");
    renderMoneyFlow(data);
  } catch (err) {
    document.getElementById("sankeyEmptyState").style.display = "block";
    document.getElementById("sankeyEmptyState").textContent = "Couldn't load your money flow right now — try refreshing the page.";
  }
}

// Collapses long tails of small categories into a single "Other" bucket so
// the diagram stays readable regardless of how many categories someone has.
function topCategoriesWithOther(byCategory, maxNodes, otherLabel) {
  const entries = Object.entries(byCategory).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (entries.length <= maxNodes) {
    return entries.map(([id, value]) => ({ id, value }));
  }
  const top = entries.slice(0, maxNodes - 1).map(([id, value]) => ({ id, value }));
  const otherTotal = entries.slice(maxNodes - 1).reduce((s, [, v]) => s + v, 0);
  if (otherTotal > 0) top.push({ id: otherLabel, value: otherTotal });
  return top;
}

function renderMoneyFlow(data) {
  const incomeEntries = topCategoriesWithOther(data.income_by_category, MAX_INCOME_NODES, "Other income");
  const expenseEntries = topCategoriesWithOther(data.expense_by_category, MAX_EXPENSE_NODES, "Other expenses");
  const savings = data.savings;

  const emptyState = document.getElementById("sankeyEmptyState");
  const wrap = document.getElementById("sankeyWrap");
  const shortfallNote = document.getElementById("shortfallNote");

  if (!incomeEntries.length || !expenseEntries.length) {
    emptyState.style.display = "block";
    wrap.style.display = "none";
    shortfallNote.style.display = "none";
    return;
  }

  emptyState.style.display = "none";
  wrap.style.display = "block";

  if (savings <= 0) {
    shortfallNote.style.display = "block";
    shortfallNote.textContent = savings < 0
      ? `You've spent ${currency(Math.abs(savings))} more than you've earned so far, so there's no surplus flowing to savings yet — the diagram shows income flowing entirely to expenses.`
      : `Income and expenses are exactly balanced — there's no surplus flowing to savings yet.`;
  } else {
    shortfallNote.style.display = "none";
  }

  drawSankey(incomeEntries, expenseEntries, Math.max(0, savings));
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
function layoutColumn(nodes, height, gap) {
  const total = nodes.reduce((s, n) => s + n.value, 0) || 1;
  const totalGap = gap * Math.max(0, nodes.length - 1);
  const avail = Math.max(0, height - totalGap);
  let y = 0;
  nodes.forEach((n) => {
    const h = Math.max(6, (n.value / total) * avail);
    n.y0 = y;
    n.y1 = y + h;
    y += h + gap;
  });
  return nodes;
}

// Divides `height` into slots proportional to each node's value, in the
// given order, with no gaps — used for the two edges of the "Income" hub,
// whose incoming/outgoing totals must exactly match its own height.
function layoutSlots(nodesInOrder, totalValue, height) {
  let y = 0;
  return nodesInOrder.map((n) => {
    const h = totalValue > 0 ? (n.value / totalValue) * height : 0;
    const slot = { y0: y, y1: y + h };
    y += h;
    return slot;
  });
}

const INCOME_PALETTE = ["#2563eb", "#0ea5e9", "#0d9488", "#6366f1", "#0891b2", "#64748b"];
const EXPENSE_PALETTE = ["#dc2626", "#f97316", "#d946ef", "#e11d48", "#c2410c", "#a855f7", "#ef4444", "#f43f5e"];
const SAVINGS_COLOR = "#16a34a";

function buildSankeyModel(incomeEntries, expenseEntries, savings, width, height) {
  const gap = 8;
  const nodeWidth = 14;
  const totalIncome = incomeEntries.reduce((s, n) => s + n.value, 0);

  const leftNodes = incomeEntries.map((n, i) => ({ ...n, color: INCOME_PALETTE[i % INCOME_PALETTE.length] }))
    .sort((a, b) => b.value - a.value);
  layoutColumn(leftNodes, height, gap);

  const rightRaw = expenseEntries.map((n, i) => ({ ...n, color: EXPENSE_PALETTE[i % EXPENSE_PALETTE.length] }));
  if (savings > 0) rightRaw.push({ id: "Savings", value: savings, color: SAVINGS_COLOR, isSavings: true });
  const rightNodes = rightRaw.sort((a, b) => b.value - a.value);
  layoutColumn(rightNodes, height, gap);

  const leftSlots = layoutSlots(leftNodes, totalIncome, height);
  const rightSlots = layoutSlots(rightNodes, totalIncome, height);

  const leftX = 0;
  const rightX = width - nodeWidth;
  const midX = width / 2;
  const incomeNode = { id: "Income", value: totalIncome, x: midX - nodeWidth / 2, y0: 0, y1: height };

  const links = [];
  leftNodes.forEach((n, i) => {
    links.push({
      x0: leftX + nodeWidth, x1: incomeNode.x,
      y0top: n.y0, y0bot: n.y1,
      y1top: leftSlots[i].y0, y1bot: leftSlots[i].y1,
      color: n.color, label: n.id, value: n.value,
    });
  });
  rightNodes.forEach((n, i) => {
    links.push({
      x0: incomeNode.x + nodeWidth, x1: rightX,
      y0top: rightSlots[i].y0, y0bot: rightSlots[i].y1,
      y1top: n.y0, y1bot: n.y1,
      color: n.color, label: n.id, value: n.value,
    });
  });

  return { leftNodes, rightNodes, incomeNode, links, leftX, rightX, nodeWidth, totalIncome };
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function linkPath(l) {
  const midX = (l.x0 + l.x1) / 2;
  return `M${l.x0},${l.y0top} C${midX},${l.y0top} ${midX},${l.y1top} ${l.x1},${l.y1top} ` +
    `L${l.x1},${l.y1bot} C${midX},${l.y1bot} ${midX},${l.y0bot} ${l.x0},${l.y0bot} Z`;
}

function drawSankey(incomeEntries, expenseEntries, savings) {
  const svg = document.getElementById("sankeySvg");
  const tooltip = document.getElementById("sankeyTooltip");
  svg.innerHTML = "";

  const width = 960;
  const height = Math.max(420, (incomeEntries.length + expenseEntries.length + (savings > 0 ? 1 : 0)) * 26);
  svg.setAttribute("viewBox", `0 0 ${width} ${height + 24}`);

  const model = buildSankeyModel(incomeEntries, expenseEntries, savings, width, height);
  const g = svgEl("g", { transform: "translate(0,12)" });
  svg.appendChild(g);

  const inkColor = cssVar("--ink");
  const mutedColor = cssVar("--muted");

  // Links (drawn first so nodes sit on top)
  model.links.forEach((l) => {
    const path = svgEl("path", {
      d: linkPath(l),
      fill: l.color,
      "fill-opacity": "0.45",
      class: "sankey-link",
    });
    path.addEventListener("mouseenter", (e) => showTooltip(e, l.label, l.value, path));
    path.addEventListener("mousemove", (e) => positionTooltip(e));
    path.addEventListener("mouseleave", () => hideTooltip(path));
    path.addEventListener("click", (e) => showTooltip(e, l.label, l.value, path)); // tap support on touch devices
    g.appendChild(path);
  });

  // Left nodes (income sources)
  model.leftNodes.forEach((n) => {
    g.appendChild(svgEl("rect", {
      x: model.leftX, y: n.y0, width: model.nodeWidth, height: Math.max(1, n.y1 - n.y0),
      rx: 3, fill: n.color, class: "sankey-node",
    }));
    const label = svgEl("text", {
      x: model.leftX + model.nodeWidth + 8, y: (n.y0 + n.y1) / 2,
      "dominant-baseline": "middle", class: "sankey-label", fill: inkColor,
    });
    label.textContent = `${n.id}`;
    g.appendChild(label);
    const sub = svgEl("text", {
      x: model.leftX + model.nodeWidth + 8, y: (n.y0 + n.y1) / 2 + 14,
      "dominant-baseline": "middle", class: "sankey-sublabel", fill: mutedColor,
    });
    sub.textContent = currency(n.value);
    g.appendChild(sub);
  });

  // Income hub
  g.appendChild(svgEl("rect", {
    x: model.incomeNode.x, y: 0, width: model.nodeWidth, height: Math.max(1, height),
    rx: 3, fill: cssVar("--primary"), class: "sankey-node",
  }));
  const hubLabel = svgEl("text", {
    x: model.incomeNode.x + model.nodeWidth / 2, y: -10,
    "text-anchor": "middle", class: "sankey-hub-label", fill: inkColor,
  });
  hubLabel.textContent = "Income";
  g.appendChild(hubLabel);

  // Right nodes (expenses + savings)
  model.rightNodes.forEach((n) => {
    g.appendChild(svgEl("rect", {
      x: model.rightX, y: n.y0, width: model.nodeWidth, height: Math.max(1, n.y1 - n.y0),
      rx: 3, fill: n.color, class: "sankey-node",
    }));
    const label = svgEl("text", {
      x: model.rightX - 8, y: (n.y0 + n.y1) / 2,
      "text-anchor": "end", "dominant-baseline": "middle", class: "sankey-label", fill: inkColor,
    });
    label.textContent = n.isSavings ? "Savings" : n.id;
    g.appendChild(label);
    const sub = svgEl("text", {
      x: model.rightX - 8, y: (n.y0 + n.y1) / 2 + 14,
      "text-anchor": "end", "dominant-baseline": "middle", class: "sankey-sublabel", fill: mutedColor,
    });
    sub.textContent = currency(n.value);
    g.appendChild(sub);
  });

  function showTooltip(e, label, value, el) {
    document.querySelectorAll(".sankey-link.is-active").forEach((p) => p.classList.remove("is-active"));
    el.classList.add("is-active");
    tooltip.innerHTML = `<strong>${escapeHtml(label)}</strong><br>${currency(value)}`;
    tooltip.classList.add("show");
    positionTooltip(e);
  }
  function positionTooltip(e) {
    const wrapRect = document.getElementById("sankeyWrap").getBoundingClientRect();
    tooltip.style.left = `${e.clientX - wrapRect.left + 14}px`;
    tooltip.style.top = `${e.clientY - wrapRect.top + 14}px`;
  }
  function hideTooltip(el) {
    el.classList.remove("is-active");
    tooltip.classList.remove("show");
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}
