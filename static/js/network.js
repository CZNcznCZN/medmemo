/* 知识网络可视化：vis-network + 层级展开 + 学科筛选 + 自定义背景
 *
 * 核心机制：
 * - 初始只显示所有知识点（根节点 level 0）
 * - 单击节点 → 展开/收起子节点
 * - 长按节点（>300ms）→ 进入拖拽模式（不触发展开）
 * - 学科筛选：只显示某学科的根节点
 * - 背景色自定义（localStorage 记住）
 * - 隐藏节点（localStorage 记住）
 *
 * 节点配色：用浅色背景 + 深色边框 + 深色字，避免白色文字
 */

const TAG_COLORS = {
  "药理": "#2563eb", "病理": "#dc2626", "生理": "#16a34a",
  "解剖": "#d97706", "内科": "#9333ea", "外科": "#0891b2",
  "微生物": "#65a30d", "生化": "#c026d3", "免疫": "#e11d48",
  "通用": "#64748b",
};
// 获取科目颜色：预设的用映射，自定义的用哈希生成稳定颜色
function tagColor(tag) {
  if (TAG_COLORS[tag]) return TAG_COLORS[tag];
  // 字符串哈希 → HSL 色（饱和度/明度固定，保证可读）
  let h = 0;
  for (let i = 0; i < tag.length; i++) {
    h = (h * 31 + tag.charCodeAt(i)) % 360;
  }
  // HSL 转 HEX
  const s = 0.6, l = 0.45;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r,g,b]=[c,x,0]; else if (h<120) [r,g,b]=[x,c,0];
  else if (h<180) [r,g,b]=[0,c,x]; else if (h<240) [r,g,b]=[0,x,c];
  else if (h<300) [r,g,b]=[x,0,c]; else [r,g,b]=[c,0,x];
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return "#" + toHex(r) + toHex(g) + toHex(b);
}
// 把学科色转成浅色背景 + 深色字（同色系）
function lighten(hex) {
  // hex 转 rgb 后混入大量白色，得到浅色背景
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  const mix = (c) => Math.round(c + (255 - c) * 0.82);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}
// 各层级样式：浅背景 + 深字（绝不用白字）
function levelStyle(level, tagColor, isSmall) {
  // 小知识点（根节点）：菱形、更小、灰色，一眼区别于大知识点
  if (level === 0 && isSmall) {
    return { bg: "#f1f5f9", border: "#94a3b8", fontColor: "#475569", size: 14 };
  }
  if (level === 0) {
    // 根节点：学科浅色背景 + 学科色粗边框 + 学科深色字
    return { bg: lighten(tagColor), border: tagColor, fontColor: tagColor, size: 26 };
  }
  if (level === 1) return { bg: "#e0e7ff", border: "#6366f1", fontColor: "#312e81", size: 20 };
  if (level === 2) return { bg: "#fef9c3", border: "#ca8a04", fontColor: "#713f12", size: 16 };
  return { bg: "#dcfce7", border: "#16a34a", fontColor: "#14532d", size: 14 };
}

let networkInstance = null;
let nodesDataset = null;
let edgesDataset = null;
let expandedNodes = new Set();
let nodeMeta = {};
let allRoots = [];           // 所有根节点缓存
let allComparisons = [];     // 所有对比知识点缓存（对比视图用）
let smallAttachMap = {};     // 小知识点归属：{ bigPointId: [小根节点对象...] }
let attachedSmallRootIds = new Set();  // 已归属小点的根节点 id（这些不作为独立根节点显示）
let currentView = "main";    // 视图：main(知识点网络) / compare(对比网络)
let currentTag = "";          // 当前学科筛选
let hiddenPoints = new Set(   // 隐藏的知识点 id（持久化）
  JSON.parse(localStorage.getItem("net_hidden") || "[]")
);
let currentBg = localStorage.getItem("net_bg") || "#fafbfc";

/* ---------------- 物理预设 ---------------- */
// 拖动时：强物理（流动感，全图跟随漂移，像最初版本）
const PHYSICS_FLOW = {
  enabled: true,
  barnesHut: { gravitationalConstant: -6000, centralGravity: 0.3, springConstant: 0.08, springLength: 130, damping: 0.4 },
  stabilization: false,
};
// 静止时：粘性弱物理（局部弹性，远处纹丝不动，防瞬移）
const PHYSICS_CALM = {
  enabled: true,
  barnesHut: { gravitationalConstant: -300, centralGravity: 0, springConstant: 0.01, springLength: 130, damping: 0.9 },
  stabilization: false,
};

/* ---------------- 位置持久化（localStorage，按视图+学科隔离）---------------- */
// 存档结构：{ nodeId: {x,y}, expanded: [...ids], scale, viewPos:{x,y} }
function posStorageKey() {
  return `net_pos_${currentView}_${currentTag || "all"}`;
}
function loadPositions() {
  try {
    const raw = localStorage.getItem(posStorageKey());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function savePositions() {
  if (!networkInstance || !nodesDataset) return;
  const positions = {};
  nodesDataset.forEach(n => {
    const p = networkInstance.getPositions([n.id])[n.id];
    if (p) positions[n.id] = { x: Math.round(p.x), y: Math.round(p.y) };
  });
  const vp = networkInstance.getViewPosition();
  const archive = {
    positions,
    expanded: [...expandedNodes],
    scale: networkInstance.getScale(),
    viewPos: { x: Math.round(vp.x), y: Math.round(vp.y) },
  };
  try { localStorage.setItem(posStorageKey(), JSON.stringify(archive)); } catch { /* 满 */ }
}

/* ---------------- 用户主动固定的节点（持久化）---------------- */
// 与加载时的临时 fixed 不同：这是用户明确"钉住"的节点，刷新后保持，拖不动、不被物理推。
let pinnedNodes = new Set();  // 当前视图下被钉住的节点 id

function pinStorageKey() {
  return `net_pin_${currentView}_${currentTag || "all"}`;
}
function loadPinned() {
  pinnedNodes = new Set();
  try {
    const raw = localStorage.getItem(pinStorageKey());
    if (raw) pinnedNodes = new Set(JSON.parse(raw));
  } catch {}
}
function savePinned() {
  try { localStorage.setItem(pinStorageKey(), JSON.stringify([...pinnedNodes])); } catch {}
}
function togglePin(nodeId) {
  if (pinnedNodes.has(nodeId)) {
    pinnedNodes.delete(nodeId);
    nodesDataset.update({ id: nodeId, fixed: false });
  } else {
    pinnedNodes.add(nodeId);
    nodesDataset.update({ id: nodeId, fixed: { x: true, y: true } });
  }
  savePinned();
}

// 关联虚线样式
const REL_DASH_COLOR = "#dc2626";  // 跨知识点关联虚线颜色（红色醒目）
const REL_EDGE_PREFIX = "rel_";    // 关联虚线边的 id 前缀（区分于层级父子边）

document.addEventListener("DOMContentLoaded", () => {
  waitForVis(initNetwork, 15000);
});

function waitForVis(cb, timeout) {
  if (typeof vis !== "undefined" && vis.Network) { cb(); return; }
  const start = Date.now();
  const loading = document.getElementById("networkLoading");
  if (loading) loading.textContent = "正在加载网络图组件...";
  const timer = setInterval(() => {
    if (typeof vis !== "undefined" && vis.Network) {
      clearInterval(timer);
      cb();
    } else if (Date.now() - start > timeout) {
      clearInterval(timer);
      const l = document.getElementById("networkLoading");
      if (l) l.style.display = "none";
      showError("vis-network 库加载失败（CDN 不可达）。请检查网络后刷新。");
    }
  }, 200);
}

/* 构建小知识点归属映射：{ bigPointId: [小根节点对象...] }
   有归属的小知识点不作为独立根节点显示，而是作为大知识点的子节点融入 */
async function buildSmallAttachMap() {
  smallAttachMap = {};
  attachedSmallRootIds = new Set();
  try {
    const rels = await API.getAllRelations();
    // belongs_to: from=大点 point_id, to=小点 point_id
    const belongs = (rels || []).filter(r => r.type === "belongs_to");
    // point_id → 根节点对象
    const rootByPid = {};
    allRoots.forEach(r => { rootByPid[r.point_id] = r; });
    belongs.forEach(r => {
      const bigRoot = rootByPid[r.from_id];
      const smallRoot = rootByPid[r.to_id];
      if (bigRoot && smallRoot) {
        if (!smallAttachMap[r.from_id]) smallAttachMap[r.from_id] = [];
        smallAttachMap[r.from_id].push(smallRoot);
        attachedSmallRootIds.add(smallRoot.id);
      }
    });
  } catch { /* 拉取失败则不融入，小点仍独立显示 */ }
}

async function initNetwork() {
  const loading = document.getElementById("networkLoading");
  const emptyBox = document.getElementById("networkEmpty");
  const box = document.getElementById("networkBox");

  try {
    allRoots = await fetch("/api/nodes/roots").then(r => r.json()).then(d => d.nodes);
    allComparisons = await API.getComparisons();
    // 拉 belongs_to 关系：小知识点归属到大知识点 → 作为子节点融入
    await buildSmallAttachMap();
  } catch (e) {
    loading.style.display = "none";
    showError("加载失败：" + esc(e.message));
    return;
  }

  loading.style.display = "none";
  box.style.display = "";

  bindViewSwitch();
  bindBgControls();
  bindEditMode();
  applyBgColor(currentBg);
  buildTagButtons();
  updateHiddenUI();
  rebuildNetwork();
}

/* ---------------- 视图切换（知识点网络 / 对比网络）---------------- */

function bindViewSwitch() {
  document.querySelectorAll(".view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      if (view === currentView) return;
      currentView = view;
      document.querySelectorAll(".view-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      // 切换视图：重建数据集（详情面板清空）
      document.getElementById("nodeDetail").innerHTML = "";
      rebuildNetwork();
    });
  });
}

/* ---------------- 编辑模式（连线 / 增删节点）---------------- */
// 编辑模式三档：off / connect(选两点连线) / delete(点节点/边删除)
let editMode = "off";
let connectFirstNode = null;  // 连线模式下选中的第一个节点

function bindEditMode() {
  document.getElementById("editModeBtn").addEventListener("click", toggleEditMode);
  document.getElementById("addNodeBtn").addEventListener("click", () => setEditSubMode("add"));
  document.getElementById("connectBtn").addEventListener("click", () => setEditSubMode("connect"));
  document.getElementById("deleteBtn").addEventListener("click", () => setEditSubMode("delete"));
  document.getElementById("attachSmallBtn").addEventListener("click", attachSmallPoints);
  document.getElementById("nodeListToggleBtn").addEventListener("click", toggleNodeListPanel);
}

/* 左侧知识点列表面板：列出当前可见知识点，点击聚焦对应节点 */
let nodeListVisible = false;

function toggleNodeListPanel() {
  nodeListVisible = !nodeListVisible;
  const panel = document.getElementById("nodeListPanel");
  const btn = document.getElementById("nodeListToggleBtn");
  btn.classList.toggle("active", nodeListVisible);
  if (nodeListVisible) {
    renderNodeListPanel();
    panel.classList.add("show");
  } else {
    panel.classList.remove("show");
  }
}

function renderNodeListPanel() {
  const panel = document.getElementById("nodeListPanel");
  // 主视图用 roots；对比视图用 comparisons 的概念
  let items = [];
  if (currentView === "main") {
    const roots = allRoots.filter(r => {
      if (currentTag && (r.point_tag || "通用") !== currentTag) return false;
      if (hiddenPoints.has(r.point_id)) return false;
      if (attachedSmallRootIds.has(r.id)) return false;
      return true;
    });
    items = roots.map(r => ({
      id: r.id, label: r.label, tag: r.point_tag || "通用",
      isSmall: r.size === "small", count: r.child_count || 0,
    }));
  } else {
    (allComparisons || []).forEach(c => {
      if (currentTag && (c.tag || "通用") !== currentTag) return;
      items.push({ id: c.point_id, label: `${c.concept_a} vs ${c.concept_b}`, tag: c.tag || "通用", isCompare: true, count: (c.dimensions || []).length });
    });
  }
  let html = `<div class="nlp-title">📋 知识点（${items.length}）<button class="nlp-close" id="nlpClose" title="收起">✕</button></div>`;
  if (items.length === 0) {
    html += `<div class="nlp-empty">该筛选下无知识点</div>`;
  } else {
    items.forEach(it => {
      const c = tagColor(it.tag);
      const icon = it.isSmall ? `<span class="nlp-diamond">◆</span>`
                : it.isCompare ? `<span class="nlp-diamond">🔀</span>`
                : `<span class="nlp-dot" style="background:${c};"></span>`;
      const cnt = it.count ? `<span class="nlp-count">${it.count}</span>` : "";
      html += `<div class="nlp-item" data-id="${it.id}" data-view="${currentView}">
        ${icon}<span>${esc(it.label)}</span>${cnt}
      </div>`;
    });
  }
  panel.innerHTML = html;
  // 关闭按钮
  const closeBtn = document.getElementById("nlpClose");
  if (closeBtn) closeBtn.addEventListener("click", toggleNodeListPanel);
  // 点击列表项：聚焦对应节点
  panel.querySelectorAll(".nlp-item").forEach(el => {
    el.addEventListener("click", () => {
      const nid = Number(el.dataset.id);
      const view = el.dataset.view;
      panel.querySelectorAll(".nlp-item").forEach(x => x.classList.remove("active"));
      el.classList.add("active");
      if (networkInstance && nodesDataset && nodesDataset.get(nid)) {
        // 聚焦 + 显示详情
        try {
          const pos = networkInstance.getPositions([nid])[nid];
          networkInstance.moveTo({ scale: 1.2, position: { x: pos.x, y: pos.y }, animation: { duration: 400 } });
        } catch {}
        networkInstance.selectNodes([nid]);
        if (view === "main") {
          showNodeDetail(nid);
        } else {
          const meta = nodeMeta[nid];
          if (meta && meta.isCompareNode) showCompareDetail(nid);
        }
      }
    });
  });
}

/* 用 AI 关联小知识点到同学科大知识点，然后重载网络 */
async function attachSmallPoints() {
  const btn = document.getElementById("attachSmallBtn");
  if (!confirm("将用 AI 把小知识点自动归属到同学科最相关的大知识点（可能需要 10-60 秒）。继续？")) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "⏳ AI 关联中...";
  try {
    const r = await API.attachSmall();
    btn.textContent = orig;
    btn.disabled = false;
    alert(`关联完成：${r.attached} 个小知识点已归属到大知识点${r.unmatched ? `，${r.unmatched} 个未找到合适归属` : ""}。\n刷新页面查看效果。`);
    // 重新加载网络（重拉 roots + belongs_to）
    location.reload();
  } catch (e) {
    btn.textContent = orig;
    btn.disabled = false;
    alert("关联失败：" + e.message);
  }
}

function toggleEditMode() {
  const on = editMode === "off";
  editMode = on ? "connect" : "off";  // 默认进入连线模式
  connectFirstNode = null;
  const btn = document.getElementById("editModeBtn");
  btn.classList.toggle("active", on);
  btn.textContent = on ? "✏️ 编辑中（点此退出）" : "✏️ 编辑模式";
  // 显示子工具栏
  ["addNodeBtn", "connectBtn", "deleteBtn"].forEach(id => {
    document.getElementById(id).style.display = on ? "" : "none";
  });
  if (on) {
    setEditSubMode("connect");
    bindEditClick();
  } else {
    unbindEditClick();
    setHint("已退出编辑模式");
  }
}

function setEditSubMode(mode) {
  editMode = mode;
  connectFirstNode = null;
  ["addNodeBtn", "connectBtn", "deleteBtn"].forEach(id => {
    document.getElementById(id).classList.toggle("active", false);
  });
  const map = { add: "addNodeBtn", connect: "connectBtn", delete: "deleteBtn" };
  document.getElementById(map[mode]).classList.add("active", true);
  const hint = {
    connect: "连线模式：依次点击两个节点创建连线",
    delete: "删除模式：点击节点或连线删除（根节点不可删）",
    add: "新增节点：点击空白处或某节点旁添加子节点",
  }[mode];
  setHint(hint);
}

function setHint(text) {
  const detail = document.getElementById("nodeDetail");
  detail.innerHTML = `<div class="nd-title">✏️ 编辑模式</div><div class="nd-line">${esc(text)}</div>`;
}

// 编辑模式下的点击处理（与正常展开/详情点击互斥）
let editClickBound = false;
function bindEditClick() {
  if (editClickBound || !networkInstance) return;
  networkInstance.on("click", onEditClick);
  editClickBound = true;
}
function unbindEditClick() {
  if (!editClickBound || !networkInstance) return;
  networkInstance.off("click", onEditClick);
  editClickBound = false;
}

function onEditClick(params) {
  if (editMode === "connect") {
    if (params.nodes.length === 0) return;
    const clicked = params.nodes[0];
    if (connectFirstNode === null) {
      connectFirstNode = clicked;
      const lbl = nodesDataset.get(clicked).label;
      setHint(`已选「${lbl}」，再点另一个节点完成连线`);
    } else if (connectFirstNode !== clicked) {
      createEdgeDB(connectFirstNode, clicked);
      connectFirstNode = null;
    }
  } else if (editMode === "delete") {
    if (params.nodes.length > 0) {
      const nid = params.nodes[0];
      const meta = nodeMeta[nid];
      if (meta && meta.level === 0 && !meta.isCompareNode) {
        setHint("根节点（知识点本身）不可删除，请去主页删整个知识点");
        return;
      }
      API.deleteNode(nid).then(() => {
        nodesDataset.remove(nid);
        delete nodeMeta[nid];
        setHint("已删除节点");
      }).catch(e => setHint("删除失败：" + e.message));
    } else if (params.edges.length > 0) {
      const eid = params.edges[0];
      // 区分自定义连线 vs 层级/关联边
      if (String(eid).startsWith("cust_")) {
        const realId = Number(String(eid).slice(5));
        API.deleteCustomEdge(realId).then(() => {
          edgesDataset.remove(eid);
          setHint("已删除连线");
        }).catch(e => setHint("删除失败：" + e.message));
      } else {
        setHint("该连线是层级/关联线，不能在此删除");
      }
    }
  } else if (editMode === "add") {
    // 新增节点：需要知道归属哪个知识点。简化：点空白则提示，点节点则在其下加子节点
    if (params.nodes.length > 0) {
      const pid = params.nodes[0];
      const meta = nodeMeta[pid];
      const label = prompt("新节点名称：");
      if (!label || !meta) return;
      API.createNode({ point_id: meta.point_id, label: label, parent_id: pid, level: (meta.level || 0) + 1 })
        .then(newId => {
          addNodeVisual(newId, label, meta.point_tag, pid);
          setHint(`已新增节点「${label}」`);
        }).catch(e => setHint("新增失败：" + e.message));
    } else {
      setHint("新增节点：请点击一个已有节点（在其下添加子节点）");
    }
  }
}

function createEdgeDB(fromId, toId) {
  const fromPid = nodeMeta[fromId] && nodeMeta[fromId].point_id;
  const toPid = nodeMeta[toId] && nodeMeta[toId].point_id;
  API.createCustomEdge({ from_node: fromId, to_node: toId, label: "" })
    .then(realId => {
      edgesDataset.add({
        id: "cust_" + realId, from: fromId, to: toId,
        color: { color: "#0891b2", highlight: "#0891b2" },
        width: 2, label: "",
        smooth: { enabled: false },
      });
      setHint("已创建连线");
    }).catch(e => setHint("连线失败：" + e.message));
}

function addNodeVisual(id, label, tag, parentId) {
  const c = tagColor(tag || "通用");
  // 放在父节点附近
  let cx = 0, cy = 0;
  try {
    const pp = networkInstance.getPositions([parentId])[parentId];
    cx = pp.x + 100; cy = pp.y + 60;
  } catch {}
  nodesDataset.add({
    id, label, x: cx, y: cy,
    color: { background: "#e0e7ff", border: "#6366f1", highlight: { background: "#e0e7ff", border: "#6366f1" } },
    font: { color: "#312e81", size: 18, face: "sans-serif" },
    shape: "dot", size: 18, borderWidth: 2,
    title: label,
  });
  edgesDataset.add({ from: parentId, to: id, color: { color: "#94a3b8", opacity: 0.5 } });
  nodeMeta[id] = { level: 1, point_tag: tag || "通用", label };
}

/* 加载已存的自定义连线到图上 */
async function loadCustomEdgesIntoGraph() {
  if (!edgesDataset) return;
  try {
    const edges = await API.getCustomEdges();
    edges.forEach(e => {
      // 只渲染两端节点都在当前图上的连线
      if (nodesDataset.get(e.from_node) && nodesDataset.get(e.to_node)) {
        edgesDataset.add({
          id: "cust_" + e.id, from: e.from_node, to: e.to_node,
          label: e.label || "",
          color: { color: "#0891b2", highlight: "#0891b2" },
          width: 2, smooth: { enabled: false },
        });
      }
    });
  } catch { /* 忽略 */ }
}

function showError(msg) {
  const errorBox = document.getElementById("networkError");
  errorBox.style.display = "";
  errorBox.innerHTML = msg + '<br><button class="btn-primary" onclick="location.reload()" style="margin-top:12px;">重试</button>';
}

/* ---------------- 学科筛选按钮 ---------------- */

function buildTagButtons() {
  const box = document.getElementById("netTagButtons");
  // 收集所有出现的学科
  const tagSet = new Set();
  allRoots.forEach(r => tagSet.add(r.point_tag || "通用"));
  let html = `<button class="net-tag-btn ${!currentTag ? "active" : ""}" data-tag="">全部</button>`;
  tagSet.forEach(t => {
    const color = tagColor(t);
    html += `<button class="net-tag-btn ${currentTag === t ? "active" : ""}" data-tag="${esc(t)}" style="border-color:${color};">${esc(t)}</button>`;
  });
  box.innerHTML = html;
  box.querySelectorAll(".net-tag-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      currentTag = btn.dataset.tag;
      box.querySelectorAll(".net-tag-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      rebuildNetwork();
    });
  });
}

/* ---------------- 背景色控制 ---------------- */

function applyBgColor(color) {
  currentBg = color;
  const c = document.getElementById("networkContainer");
  if (c) c.style.background = color;
  localStorage.setItem("net_bg", color);
  const picker = document.getElementById("bgColorPicker");
  if (picker) picker.value = color;
}

function bindBgControls() {
  document.getElementById("bgColorPicker").addEventListener("input", (e) => applyBgColor(e.target.value));
  document.querySelectorAll(".net-preset").forEach(btn => {
    btn.addEventListener("click", () => applyBgColor(btn.dataset.bg));
  });
}

/* ---------------- 重建网络（学科/隐藏变化时） ---------------- */

function rebuildNetwork() {
  expandedNodes.clear();
  nodeMeta = {};

  if (networkInstance) {
    networkInstance.destroy();
    networkInstance = null;
  }

  // 对比视图：单独构建
  if (currentView === "compare") {
    const cmps = (allComparisons || []).filter(c => {
      if (currentTag && (c.tag || "通用") !== currentTag) return false;
      if (hiddenPoints.has(c.point_id)) return false;
      return true;
    });
    document.getElementById("networkContainer").innerHTML = "";
    if (cmps.length === 0) {
      document.getElementById("networkContainer").innerHTML =
        '<div class="muted" style="padding:40px;text-align:center;">该筛选下无对比知识点。<br>对比知识点会在 AI 拆卡识别到易混概念时自动生成。</div>';
      return;
    }
    buildCompareNetwork(cmps);
    return;
  }

  // 主视图：按学科筛选 + 排除隐藏的知识点 + 排除已归属到大点的小根节点（融入大点子树）
  const roots = allRoots.filter(r => {
    if (currentTag && (r.point_tag || "通用") !== currentTag) return false;
    if (hiddenPoints.has(r.point_id)) return false;
    if (attachedSmallRootIds.has(r.id)) return false;  // 已归属的小点不独立显示
    return true;
  });

  if (roots.length === 0) {
    document.getElementById("networkContainer").innerHTML =
      '<div class="muted" style="padding:40px;text-align:center;">该筛选下无可见节点。<br><button class="btn-mini" onclick="showAllPoints()" style="margin-top:8px;">显示全部</button></div>';
    return;
  }
  document.getElementById("networkContainer").innerHTML = "";
  buildNetwork(roots);
  // 左侧列表可见时刷新内容
  if (nodeListVisible) renderNodeListPanel();
}

// 全局函数：取消所有隐藏
window.showAllPoints = function () {
  hiddenPoints.clear();
  localStorage.setItem("net_hidden", "[]");
  updateHiddenUI();
  rebuildNetwork();
};

// 更新"显示全部"按钮的显示状态
function updateHiddenUI() {
  const group = document.getElementById("netHiddenGroup");
  const count = document.getElementById("hiddenCount");
  if (!group) return;
  if (hiddenPoints.size > 0) {
    group.style.display = "";
    if (count) count.textContent = `（已隐藏 ${hiddenPoints.size} 个）`;
  } else {
    group.style.display = "none";
  }
}

/* ---------------- 构建网络图 ---------------- */

function buildNetwork(roots) {
  const archive = loadPositions();
  loadPinned();  // 加载用户主动钉住的节点
  const visNodes = roots.map(r => {
    const isSmall = r.size === "small";
    const c = tagColor(r.point_tag || "通用");
    const style = levelStyle(0, c, isSmall);
    // 可展开：有正常子节点，或有归属到此大点的小知识点
    const hasChildren = (r.child_count || 0) > 0 || (smallAttachMap[r.point_id] && smallAttachMap[r.point_id].length > 0);
    nodeMeta[r.id] = {
      level: 0, point_id: r.point_id, point_tag: r.point_tag || "通用",
      isSmall, hasChildren, label: r.label,
    };
    const node = {
      id: r.id,
      label: r.label,
      color: { background: style.bg, border: style.border, highlight: { background: style.bg, border: style.border } },
      font: { color: style.fontColor, size: style.size, face: "sans-serif", multi: false },
      shape: isSmall ? "diamond" : "dot",   // 小知识点菱形，大知识点圆点
      size: style.size,
      borderWidth: isSmall ? 2 : 3,
      title: r.label + (isSmall ? "（🔖 小知识点）" : "")
        + (hasChildren ? "\n（单击展开/收起，拖拽移动）" : "\n（拖拽移动）"),
    };
    // 有存档位置则设坐标（防瞬移）；用户主动钉住的节点强制 fixed
    if (archive && archive.positions[r.id]) {
      node.x = archive.positions[r.id].x;
      node.y = archive.positions[r.id].y;
      node.fixed = { x: true, y: true };  // 临时固定，dragStart 会解除（非钉住的）
    }
    // 用户主动钉住：覆盖为永久固定
    if (pinnedNodes.has(r.id)) {
      node.fixed = { x: true, y: true };
    }
    return node;
  });

  nodesDataset = new vis.DataSet(visNodes);
  edgesDataset = new vis.DataSet([]);

  const container = document.getElementById("networkContainer");
  const options = {
    nodes: { shadow: { enabled: true, size: 6, x: 0, y: 0 } },
    edges: { smooth: { type: "continuous", roundness: 0.4 }, color: { color: "#94a3b8", opacity: 0.5 } },
    physics: {
      barnesHut: { gravitationalConstant: -6000, springConstant: 0.04, springLength: 130, damping: 0.4 },
      stabilization: { iterations: 120 },
    },
    interaction: { hover: true, tooltipDelay: 200, zoomView: true, dragNodes: true, dragView: true },
  };

  networkInstance = new vis.Network(container, { nodes: nodesDataset, edges: edgesDataset }, options);

  // 首次物理布局稳定后切到「静止弱物理」（PHYSICS_CALM）：
  // 远处节点纹丝不动防瞬移；拖动时再切强物理（PHYSICS_FLOW）恢复流动感。
  networkInstance.once("stabilizationIterationsDone", () => {
    networkInstance.setOptions({ physics: PHYSICS_CALM });
    // 还原视口（缩放 + 平移）
    if (archive && archive.scale && archive.viewPos) {
      networkInstance.moveTo({ scale: archive.scale, position: archive.viewPos });
    }
    // 自动恢复上次的展开状态
    if (archive && archive.expanded) {
      archive.expanded.forEach(nid => {
        const meta = nodeMeta[nid];
        if (meta && meta.hasChildren && !expandedNodes.has(nid)) expandNode(nid);
      });
    }
    // 加载已存的自定义连线（编辑模式创建的）
    loadCustomEdgesIntoGraph();
  });

  setupInteractions();
  bindPersistenceEvents();
}

/* ---------------- 对比网络：直观呈现两概念如何对比 ---------------- */

function buildCompareNetwork(comparisons) {
  const container = document.getElementById("networkContainer");
  const archive = loadPositions();
  loadPinned();
  // 概念名 → 节点 id（同一概念跨多个对比共用一个节点，自动连成网）
  const conceptNodes = new Map();
  const visNodes = [];
  const visEdges = [];

  function nodeFor(concept, tag) {
    if (conceptNodes.has(concept)) return conceptNodes.get(concept);
    const id = "cmp_c_" + visNodes.length;  // 字符串 id 避免与主视图数字 id 冲突
    const c = tagColor(tag || "通用");
    conceptNodes.set(concept, id);
    nodeMeta[id] = { level: 0, isCompareNode: true, label: concept, tag: tag || "通用" };
    const node = {
      id, label: concept,
      color: { background: lighten(c), border: c, highlight: { background: lighten(c), border: c } },
      font: { color: c, size: 22, face: "sans-serif" },
      shape: "box", borderWidth: 3, shapeProperties: { borderRadius: 8 },
      title: concept + "\n（单击查看对比详情）",
    };
    // 存档位置则固定（防瞬移）
    if (archive && archive.positions && archive.positions[id]) {
      node.x = archive.positions[id].x;
      node.y = archive.positions[id].y;
      node.fixed = { x: true, y: true };
    }
    // 用户主动钉住：强制固定
    if (pinnedNodes.has(id)) {
      node.fixed = { x: true, y: true };
    }
    visNodes.push(node);
    return id;
  }

  // 每个对比：两个概念节点 + 一条带维度标签的连线
  comparisons.forEach((cmp, idx) => {
    const idA = nodeFor(cmp.concept_a, cmp.tag);
    const idB = nodeFor(cmp.concept_b, cmp.tag);
    // 边 label：维度名拼接（直观看出怎么对比）
    const label = (cmp.dimensions || [])
      .map(d => `${d.dim}：${d.value_a} / ${d.value_b}`)
      .join("\n");
    const edgeId = "cmp_e_" + idx;
    nodeMeta[edgeId] = { isCompareEdge: true, comparison: cmp };
    visEdges.push({
      id: edgeId, from: idA, to: idB,
      label: label.length > 60 ? label.slice(0, 60) + "…" : label,
      title: label,  // 悬停显示完整对比
      color: { color: "#9333ea", highlight: "#9333ea" },
      width: 2,
      font: { size: 11, color: "#475569", align: "top", multi: false },
      smooth: { type: "continuous", roundness: 0.1 },
    });
  });

  nodesDataset = new vis.DataSet(visNodes);
  edgesDataset = new vis.DataSet(visEdges);

  const options = {
    nodes: { shadow: { enabled: true, size: 6, x: 0, y: 0 } },
    edges: { color: { color: "#9333ea", opacity: 0.6 }, smooth: { type: "continuous", roundness: 0.1 } },
    physics: {
      barnesHut: { gravitationalConstant: -5000, springConstant: 0.05, springLength: 160, damping: 0.4 },
      stabilization: { iterations: 120 },
    },
    interaction: { hover: true, tooltipDelay: 200, zoomView: true, dragNodes: true, dragView: true },
  };
  networkInstance = new vis.Network(container, { nodes: nodesDataset, edges: edgesDataset }, options);

  // 稳定后切静止弱物理（拖动时再切强物理恢复流动感）+ 还原视口
  networkInstance.once("stabilizationIterationsDone", () => {
    networkInstance.setOptions({
      physics: {
        enabled: true,
        barnesHut: { gravitationalConstant: -300, centralGravity: 0, springConstant: 0.01, springLength: 160, damping: 0.9 },
        stabilization: false,
      },
    });
    if (archive && archive.scale && archive.viewPos) {
      networkInstance.moveTo({ scale: archive.scale, position: archive.viewPos });
    }
  });

  bindPersistenceEvents();

  // 对比视图：单击节点/边显示完整对比详情
  networkInstance.on("click", (params) => {
    if (params.nodes.length > 0) {
      showCompareDetail(params.nodes[0]);
    } else if (params.edges.length > 0) {
      const meta = nodeMeta[params.edges[0]];
      if (meta && meta.comparison) showComparisonPanel(meta.comparison);
    }
  });
}

/* 通用：填充详情面板内容并触发弹出动画 */
function openDetail(html) {
  const detail = document.getElementById("nodeDetail");
  detail.innerHTML = `<button class="nd-close" id="ndCloseBtn" title="关闭">✕</button>` + html;
  detail.classList.remove("show");
  void detail.offsetWidth;  // 强制 reflow 重置动画
  detail.classList.add("show");
  const closeBtn = document.getElementById("ndCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", () => detail.classList.remove("show"));
}

/* 对比视图：点击概念节点，列出涉及它的所有对比 */
function showCompareDetail(nodeId) {
  const meta = nodeMeta[nodeId];
  if (!meta || !meta.isCompareNode) return;
  const concept = meta.label;
  const related = (allComparisons || []).filter(c =>
    c.concept_a === concept || c.concept_b === concept);
  let html = `<div class="nd-title">${esc(concept)} <span class="nd-tag">${esc(meta.tag)}</span></div>`;
  html += `<div class="nd-line">共参与 ${related.length} 组对比：</div>`;
  related.forEach(c => {
    const other = c.concept_a === concept ? c.concept_b : c.concept_a;
    html += `<div class="cmp-rel-item" data-pid="${c.point_id}">
      <b>↔ ${esc(other)}</b>
      <button class="btn-mini cmp-view-btn" data-pid="${c.point_id}">查看</button>
    </div>`;
  });
  openDetail(html);
  document.querySelectorAll(".cmp-view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const cmp = related.find(c => String(c.point_id) === btn.dataset.pid);
      if (cmp) showComparisonPanel(cmp);
    });
  });
}

/* 对比详情面板：展示某组对比的全部维度差异（表格形式） */
function showComparisonPanel(cmp) {
  const dims = cmp.dimensions || [];
  let html = `<div class="nd-title">🔀 ${esc(cmp.concept_a)} <span style="color:#9333ea;">vs</span> ${esc(cmp.concept_b)}</div>`;
  if (dims.length === 0) {
    html += `<div class="nd-line muted">无维度数据</div>`;
  } else {
    html += `<table class="cmp-table"><thead><tr>
      <th>维度</th><th>${esc(cmp.concept_a)}</th><th>${esc(cmp.concept_b)}</th>
    </tr></thead><tbody>`;
    dims.forEach(d => {
      html += `<tr><td><b>${esc(d.dim)}</b></td><td>${esc(d.value_a)}</td><td>${esc(d.value_b)}</td></tr>`;
    });
    html += `</tbody></table>`;
  }
  openDetail(html);
}

/* ---------------- 位置持久化事件绑定 ---------------- */

function bindPersistenceEvents() {
  if (!networkInstance) return;

  // 拖动节点开始 → 解除被拖节点的临时 fixed（存档位置会钉死它，导致拉不动）
  // 但跳过用户主动钉住的节点（pinnedNodes 里的不该被解锁）
  // + 切强物理（流动感：全图跟随漂移，像最初版本）
  networkInstance.on("dragStart", (params) => {
    if (params.nodes.length > 0) {
      params.nodes.forEach(nid => {
        if (!pinnedNodes.has(nid)) nodesDataset.update({ id: nid, fixed: false });
      });
      networkInstance.setOptions({ physics: PHYSICS_FLOW });
    }
  });

  // 拖动节点结束 → 切回弱物理（静止防瞬移）+ 保存位置
  networkInstance.on("dragEnd", (params) => {
    if (params.nodes.length > 0) {
      networkInstance.setOptions({ physics: PHYSICS_CALM });
      // 弱物理微调需要点时间稳定，延迟保存
      setTimeout(savePositions, 700);
    }
  });

  // 画布平移（没拖节点）→ 存视口
  networkInstance.on("dragging", (params) => {
    if (params.nodes.length === 0) savePositions();
  });
  // 缩放 → 存视口
  networkInstance.on("zoom", () => savePositions());
}

/* 收集一个节点的所有子孙节点 id（沿 edgesDataset 的父子边递归） */
function collectDescendants(nodeId) {
  const result = [];
  const seen = new Set([nodeId]);
  const visit = (pid) => {
    edgesDataset.forEach(e => {
      if (e.from === pid && !seen.has(e.to)) {
        seen.add(e.to);
        result.push(e.to);
        visit(e.to);
      }
    });
  };
  visit(nodeId);
  return result;
}

/* ---------------- 交互：单击展开 / 拖拽移动（互不干扰） ---------------- */

function setupInteractions() {
  // 只用 vis 原生事件区分单击和拖拽，不碰 DOM（最可靠）
  // 关键：vis 拖拽节点会触发 dragStart，之后的 click 是"拖拽结束的点击"，要忽略
  let nodeDragged = false;

  // 拖拽节点开始时标记。注意：拖拽空白画布（平移）不算，只有拖节点才算
  networkInstance.on("dragStart", (params) => {
    if (params.nodes.length > 0) {
      nodeDragged = true;
    }
  });

  networkInstance.on("hold", () => {
    // hold（长按）也可能是拖拽的前奏，确保不会误触发展开
  });

  // click：只有「没拖过节点」才展开/收起
  networkInstance.on("click", async (params) => {
    if (nodeDragged) {
      nodeDragged = false;  // 重置，下次纯单击可正常展开
      return;               // 拖拽产生的点击，绝不动展开状态
    }
    if (params.nodes.length === 0) return;
    const nodeId = params.nodes[0];
    const meta = nodeMeta[nodeId];
    if (!meta) return;
    if (expandedNodes.has(nodeId)) {
      collapseNode(nodeId);
    } else if (meta.hasChildren) {
      await expandNode(nodeId);
    }
    showNodeDetail(nodeId);
  });
}

/* ---------------- 展开子节点 ---------------- */

async function expandNode(nodeId) {
  const meta = nodeMeta[nodeId];
  const node = nodesDataset.get(nodeId);
  nodesDataset.update({ id: nodeId, label: node.label + " ..." });

  let children;
  try {
    children = await fetch(`/api/nodes/children?node_id=${nodeId}`).then(r => r.json()).then(d => d.nodes);
  } catch (e) {
    nodesDataset.update({ id: nodeId, label: node.label });
    return;
  }

  nodesDataset.update({ id: nodeId, label: node.label });
  children = children || [];
  // 该大点是否有归属的小知识点要融入
  const attachedSmalls = (smallAttachMap[meta.point_id] || []).filter(s => !nodesDataset.get(s.id));

  const childLevel = meta.level + 1;
  // 取父节点当前位置，新子节点围绕它圆形分布（物理已关，不会瞬移）
  let centerX = 0, centerY = 0;
  try {
    const pp = networkInstance.getPositions([nodeId])[nodeId];
    centerX = pp.x; centerY = pp.y;
  } catch { /* 取不到就原点附近 */ }
  const radius = 120;
  const newChildren = children.filter(ch => !nodesDataset.get(ch.id));
  children.forEach(ch => {
    if (nodesDataset.get(ch.id)) return;
    const c = tagColor(ch.point_tag || "通用");
    const style = levelStyle(childLevel, c);
    const hasLink = !!ch.link_to_point;
    nodeMeta[ch.id] = {
      level: childLevel, point_id: ch.point_id, point_tag: ch.point_tag || "通用",
      hasChildren: (ch.child_count || 0) > 0, label: ch.label,
      linkTo: ch.link_to_point || null,  // 该子节点指向的另一个知识点
    };
    // 圆形分布坐标（基于父节点 + 偏移）
    const idx = newChildren.indexOf(ch);
    const angle = (2 * Math.PI * idx) / newChildren.length;
    const cx = Math.round(centerX + radius * Math.cos(angle));
    const cy = Math.round(centerY + radius * Math.sin(angle));
    nodesDataset.add({
      id: ch.id,
      label: ch.label,
      x: cx, y: cy,
      color: { background: style.bg, border: style.border, highlight: { background: style.bg, border: style.border } },
      font: { color: style.fontColor, size: style.size, face: "sans-serif" },
      shape: hasLink ? "diamond" : "dot",  // 有跨知识点关联的用菱形，醒目
      size: style.size,
      borderWidth: hasLink ? 3 : 2,
      title: ch.label
        + ((ch.child_count || 0) > 0 ? "\n（单击展开）" : "")
        + (hasLink ? "\n🔗 关联到其他知识点（虚线连接）" : "")
        + (ch.detail ? "\n" + ch.detail : ""),
    });
    edgesDataset.add({ from: nodeId, to: ch.id });
  });

  // 追加归属到此大知识点的小知识点（融入大点子树，不再独立散落）
  const allForLayout = newChildren.concat(attachedSmalls);
  attachedSmalls.forEach(s => {
    const sc = tagColor(s.point_tag || "通用");
    const sstyle = levelStyle(childLevel, sc, true);  // 小知识点样式（小菱形）
    nodeMeta[s.id] = {
      level: childLevel, point_id: s.point_id, point_tag: s.point_tag || "通用",
      isSmall: true, hasChildren: false, label: s.label,
    };
    const idx = allForLayout.indexOf(s);
    const angle = (2 * Math.PI * idx) / allForLayout.length;
    const cx = Math.round(centerX + radius * Math.cos(angle));
    const cy = Math.round(centerY + radius * Math.sin(angle));
    nodesDataset.add({
      id: s.id,
      label: s.label,
      x: cx, y: cy,
      color: { background: sstyle.bg, border: sstyle.border, highlight: { background: sstyle.bg, border: sstyle.border } },
      font: { color: sstyle.fontColor, size: sstyle.size, face: "sans-serif" },
      shape: "diamond",  // 小知识点菱形
      size: sstyle.size,
      borderWidth: 2,
      title: s.label + "（🔖 小知识点，归属到此大知识点）",
    });
    edgesDataset.add({ from: nodeId, to: s.id });
  });

  expandedNodes.add(nodeId);
  nodesDataset.update({ id: nodeId, borderWidth: 5 });
  refreshRelationLinks();
}

function collapseNode(nodeId) {
  const toRemove = [];
  const edgesToRemove = [];
  const collect = (pid) => {
    edgesDataset.forEach(e => {
      // 跳过关联虚线（它们由 refreshRelationLinks 统一管理）
      if (typeof e.id === "string" && e.id.startsWith(REL_EDGE_PREFIX)) return;
      if (e.from === pid) {
        toRemove.push(e.to);
        edgesToRemove.push(e.id);
        collect(e.to);
      }
    });
  };
  collect(nodeId);
  toRemove.forEach(id => {
    nodesDataset.remove(id);
    expandedNodes.delete(id);
    delete nodeMeta[id];
  });
  edgesToRemove.forEach(id => edgesDataset.remove(id));
  expandedNodes.delete(nodeId);
  const isRoot = nodeMeta[nodeId] && nodeMeta[nodeId].level === 0;
  nodesDataset.update({ id: nodeId, borderWidth: isRoot ? 3 : 2 });
  refreshRelationLinks();
}

/* ---------------- 关联虚线：两端知识点都展开时连接 ---------------- */

function refreshRelationLinks() {
  if (!edgesDataset) return;

  // 1. 先删除所有旧关联虚线（id 以 rel_ 开头）
  const oldRelEdges = [];
  edgesDataset.forEach(e => {
    if (typeof e.id === "string" && e.id.startsWith(REL_EDGE_PREFIX)) {
      oldRelEdges.push(e.id);
    }
  });
  oldRelEdges.forEach(id => edgesDataset.remove(id));

  // 2. 构建 point_id → 根节点id 映射（图上可见的根节点，不管是否展开）
  //    子节点的 linkTo 指向某个知识点，只要那个知识点的根节点在图上就画虚线
  const rootByPoint = {};  // point_id -> 根节点id
  Object.keys(nodeMeta).forEach(nid => {
    const m = nodeMeta[nid];
    if (m && m.level === 0) {
      rootByPoint[m.point_id] = Number(nid);
    }
  });

  // 3. 遍历图上的所有子节点，有 linkTo 且目标根节点在图上 → 画虚线
  Object.keys(nodeMeta).forEach(nid => {
    const m = nodeMeta[nid];
    if (!m || m.level === 0 || !m.linkTo) return;  // 只处理有 linkTo 的子节点
    const targetNodeId = rootByPoint[m.linkTo];
    if (!targetNodeId) return;  // 目标根节点不在图上，不画
    edgesDataset.add({
      id: REL_EDGE_PREFIX + nid + "_" + m.linkTo,
      from: Number(nid),       // 子节点
      to: targetNodeId,         // 目标知识点根节点
      color: { color: REL_DASH_COLOR, opacity: 0.75, highlight: REL_DASH_COLOR },
      width: 2,
      dashes: [10, 6],  // 虚线
      title: "🔗 跨知识点关联",
      smooth: { enabled: false },  // 关联线用直线，区别于层级曲线
    });
  });
}

/* ---------------- 节点详情面板（含卡片展示 + 隐藏按钮） ---------------- */

function showNodeDetail(nodeId) {
  const meta = nodeMeta[nodeId];
  if (!meta) return;
  const detail = document.getElementById("nodeDetail");
  const sizeBadge = meta.isSmall
    ? `<span class="size-badge size-small">🔖 小知识点</span>`
    : `<span class="size-badge size-big">📘 大知识点</span>`;
  let html = `<button class="nd-close" id="ndCloseBtn" title="关闭">✕</button>`;
  html += `<div class="nd-title">${esc(meta.label)} <span class="nd-tag">${esc(meta.point_tag || "")}</span> ${sizeBadge}</div>`;
  const childCount = countDescendants(nodeId);
  if (meta.hasChildren) {
    html += `<div class="nd-line"><b>${expandedNodes.has(nodeId) ? "已展开" : "可展开"}</b>${childCount > 0 ? `（${childCount} 个子节点）` : ""}</div>`;
  }
  html += `<div class="nd-line nd-hint">💡 单击展开/收起，拖拽可移动节点（不影响展开）</div>`;
  // 固定/解锁按钮：钉住后该节点拖不动、不被物理推动
  const pinned = pinnedNodes.has(nodeId);
  html += `<button class="btn-mini" id="pinBtn" data-nid="${nodeId}" style="margin-top:8px;margin-right:6px;">
    ${pinned ? "📌 已固定（点此解锁）" : "📌 固定此节点"}
  </button>`;
  // 隐藏按钮（只对根节点显示）
  if (meta.level === 0) {
    html += `<button class="btn-mini" style="margin-top:8px;color:var(--danger);border-color:var(--danger);" onclick="hidePoint(${meta.point_id})">隐藏此知识点</button>`;
  }
  // 卡片占位（异步加载）
  html += `<div id="ndCards" class="nd-cards"><div class="muted">加载卡片中...</div></div>`;
  detail.innerHTML = html;
  // 触发弹出动画（先确保隐藏态再加 show 类，过渡才生效）
  detail.classList.remove("show");
  void detail.offsetWidth;  // 强制 reflow，重置动画
  detail.classList.add("show");
  // 绑定关闭按钮
  const closeBtn = document.getElementById("ndCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", () => detail.classList.remove("show"));
  // 绑定固定按钮
  const pinBtn = document.getElementById("pinBtn");
  if (pinBtn) {
    pinBtn.addEventListener("click", () => {
      togglePin(parseInt(pinBtn.dataset.nid));
      pinBtn.textContent = pinnedNodes.has(parseInt(pinBtn.dataset.nid))
        ? "📌 已固定（点此解锁）" : "📌 固定此节点";
    });
  }
  // 异步加载该知识点的卡片
  loadNodeCards(meta.point_id);
}

async function loadNodeCards(pointId) {
  const box = document.getElementById("ndCards");
  if (!box) return;
  try {
    const cards = await API.getCardsByPoint(pointId);
    if (!cards || cards.length === 0) {
      box.innerHTML = `<div class="muted">该知识点暂无卡片</div>`;
      return;
    }
    // 取第一条的知识点级信息（机制/临床等，所有卡片共享同一知识点）
    const info = cards[0];
    let html = "";
    // 理解层信息
    const fields = [
      ["机制", info.mechanism], ["临床", info.clinical], ["记忆画面", info.mnemonic],
      ["诊断", info.diagnosis], ["治疗", info.treatment], ["鉴别", info.differential],
      ["病因", info.etiology], ["预防", info.prevention],
    ];
    const ukLines = fields.filter(f => f[1]).map(f =>
      `<div class="nd-line"><b>${f[0]}：</b>${esc(f[1])}</div>`
    ).join("");
    if (ukLines) html += `<div class="nd-section-title">📖 理解层</div>${ukLines}`;
    // 卡片列表
    html += `<div class="nd-section-title">🗂️ 问答卡（${cards.length}张）</div>`;
    html += cards.map(c => {
      const typeLabel = TYPE_LABELS[c.type] || c.type;
      const due = c.due_date || "";
      return `<div class="nd-card">
        <div class="nd-card-head"><span class="type-badge type-${c.type}">${typeLabel}</span></div>
        <div class="nd-card-q"><b>问：</b>${esc(c.question)}</div>
        <div class="nd-card-a"><b>答：</b>${esc(c.answer)}</div>
      </div>`;
    }).join("");
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = `<div class="muted" style="color:var(--danger);">卡片加载失败：${esc(e.message)}</div>`;
  }
}

window.hidePoint = function (pointId) {
  hiddenPoints.add(pointId);
  localStorage.setItem("net_hidden", JSON.stringify([...hiddenPoints]));
  updateHiddenUI();
  rebuildNetwork();
  document.getElementById("nodeDetail").innerHTML =
    '<div class="nd-line muted">已隐藏。点顶部「👁 显示全部知识点」可恢复。</div>';
};

function countDescendants(nodeId) {
  let n = 0;
  const visit = (pid) => {
    edgesDataset.forEach(e => { if (e.from === pid) { n++; visit(e.to); } });
  };
  visit(nodeId);
  return n;
}
