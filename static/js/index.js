/* 主页逻辑：统计、科目筛选、手动新增知识点、列表管理、关联管理 */

const CARD_TYPES = ["forward", "reverse", "mechanism", "apply"];
// 注意：TYPE_LABELS 已在 api.js 全局声明，这里直接复用，切勿重复声明（否则浏览器抛 SyntaxError，整个文件不执行）
const REL_TYPE_LABELS = {
  cause: "因果", compare: "对比", upstream: "上游", downstream: "下游", related: "相关"
};

let cardEditorCount = 0;
let currentTag = "";        // 当前筛选的科目
let allPointsCache = null;   // 缓存所有知识点（科目筛选用）
let relModalPointId = null; // 当前打开关联弹窗的知识点 id

document.addEventListener("DOMContentLoaded", () => {
  loadTags();
  loadStats();
  loadPoints();
  bindAddForm();
  bindAdvancedToggle();
  bindRelationModal();
  addCardRow("forward");
});

/* ---------------- 科目筛选 ---------------- */

async function loadTags() {
  const box = document.getElementById("tagButtons");
  try {
    const tags = await API.getTags();
    // 同步更新科目 datalist（让用户能选到已用过的自定义科目）
    const dl = document.getElementById("tagList");
    if (dl) {
      const existing = new Set(Array.from(dl.options).map(o => o.value));
      tags.forEach(t => {
        const v = t.tag || "通用";
        if (!existing.has(v)) {
          const opt = document.createElement("option");
          opt.value = v;
          dl.appendChild(opt);
        }
      });
    }
    box.innerHTML = `<button class="tag-btn ${!currentTag ? 'active' : ''}" data-tag="">全部</button>` +
      tags.map(t => {
        const due = t.due || 0;
        const label = t.tag || "未分类";
        const count = t.count || 0;
        return `<span class="tag-wrap">
          <button class="tag-btn ${currentTag === t.tag ? 'active' : ''}" data-tag="${esc(t.tag)}">${esc(label)}${due ? ` <small>(${due})</small>` : ''}</button>
          <button class="tag-manage" data-tag="${esc(t.tag)}" data-count="${count}" title="管理该学科">⚙</button>
        </span>`;
      }).join("");
    box.querySelectorAll(".tag-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        currentTag = btn.dataset.tag;
        box.querySelectorAll(".tag-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        loadPoints();
        loadStats();
      });
    });
    // 学科管理小按钮：弹出清空/合并菜单
    box.querySelectorAll(".tag-manage").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        manageTag(btn.dataset.tag, parseInt(btn.dataset.count));
      });
    });
  } catch (e) {
    box.innerHTML = `<span class="muted" style="color:var(--danger);">加载失败：<br>${esc(e.message)}<br><button class="btn-primary" onclick="loadTags()" style="margin-top:6px;">重试</button></span>`;
  }
}

/* ---------------- 学科管理（清空 / 合并）---------------- */

async function manageTag(tag, count) {
  const action = prompt(
    `管理学科「${tag}」（共 ${count} 个知识点）\n\n` +
    `输入对应数字选择操作：\n` +
    `1 = 清空该学科（删除全部 ${count} 个知识点，不可恢复）\n` +
    `2 = 合并到其他学科（知识点保留，改归到别的学科）\n` +
    `（留空或取消 = 不操作）`
  );
  if (!action) return;
  if (action.trim() === "1") {
    if (!confirm(`确定清空学科「${tag}」？将删除全部 ${count} 个知识点及其卡片/关联/复习记录，不可恢复！`)) return;
    try {
      const r = await API.clearTag(tag);
      alert(`已清空「${tag}」，删除 ${r.count} 个知识点。`);
      currentTag = "";
      loadStats(); loadTags(); loadPoints();
    } catch (e) { alert("清空失败：" + e.message); }
  } else if (action.trim() === "2") {
    const target = prompt(`把「${tag}」的全部知识点合并到哪个学科？（输入目标学科名）`);
    if (!target || !target.trim() || target.trim() === tag) return;
    try {
      const r = await API.mergeTag(tag, target.trim());
      alert(`已合并：${r.count} 个知识点从「${tag}」改归到「${target.trim()}」。`);
      currentTag = "";
      loadStats(); loadTags(); loadPoints();
    } catch (e) { alert("合并失败：" + e.message); }
  }
}

/* ---------------- 统计 ---------------- */

async function loadStats() {
  try {
    const s = await API.getStats(currentTag);
    document.getElementById("statDue").textContent = s.due_today;
    document.getElementById("statCards").textContent = s.total_cards;
    document.getElementById("statPoints").textContent = s.total_points;
    const due = s.due_today;
    const cta = document.querySelector("#studyCta a");
    if (cta) cta.textContent = due > 0 ? `立即复习 ${due} 张 →` : "暂无待复习 →";
    // 复习统计：正确率 + 错题数（getReviewStats 是独立请求，失败不阻断主统计）
    try {
      const rs = await API.getReviewStats(currentTag);
      const accEl = document.getElementById("statAccuracy");
      const wrongEl = document.getElementById("statWrong");
      if (accEl) accEl.textContent = rs.total_reviews > 0 ? `${Math.round(rs.accuracy * 100)}%` : "-";
      if (wrongEl) {
        wrongEl.textContent = rs.wrong_cards || 0;
        // 有错题时点击可跳错题重练
        if (rs.wrong_cards > 0) {
          wrongEl.parentElement.style.cursor = "pointer";
          wrongEl.parentElement.title = "点击去错题重练";
          wrongEl.parentElement.onclick = () => { window.location.href = "/study.html"; };
        }
      }
    } catch { /* 绍兴统计可选，失败不影响主统计 */ }
  } catch (e) {
    document.getElementById("statDue").textContent = "!";
    document.getElementById("statCards").textContent = "!";
    document.getElementById("statPoints").textContent = "!";
    console.error("统计加载失败:", e);
  }
}

/* ---------------- 高级字段折叠 ---------------- */

function bindAdvancedToggle() {
  document.getElementById("toggleAdvanced").addEventListener("click", () => {
    const af = document.getElementById("advancedFields");
    const link = document.getElementById("toggleAdvanced");
    if (af.style.display === "none") {
      af.style.display = "";
      link.textContent = "▲ 收起高级字段";
    } else {
      af.style.display = "none";
      link.textContent = "▼ 展开高级字段";
    }
  });
}

/* ---------------- 卡片编辑器 ---------------- */

function addCardRow(type = "forward") {
  cardEditorCount++;
  const list = document.getElementById("cardsList");
  const row = document.createElement("div");
  row.className = "card-edit-row";
  row.dataset.idx = cardEditorCount;
  row.innerHTML = `
    <select class="ce-type">
      ${CARD_TYPES.map(t => `<option value="${t}" ${t === type ? "selected" : ""}>${TYPE_LABELS[t]}</option>`).join("")}
    </select>
    <input type="text" class="ce-q" placeholder="问题" />
    <input type="text" class="ce-a" placeholder="答案" />
    <button type="button" class="del-card" title="删除">✕</button>
  `;
  row.querySelector(".del-card").addEventListener("click", () => row.remove());
  list.appendChild(row);
}

function collectCards() {
  const rows = document.querySelectorAll("#cardsList .card-edit-row");
  const cards = [];
  rows.forEach(r => {
    const t = r.querySelector(".ce-type").value;
    const q = r.querySelector(".ce-q").value.trim();
    const a = r.querySelector(".ce-a").value.trim();
    if (q && a) cards.push({ type: t, question: q, answer: a });
  });
  return cards;
}

function bindAddForm() {
  document.getElementById("addCardBtn").addEventListener("click", () => addCardRow());
  document.getElementById("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const cards = collectCards();
    if (cards.length === 0) {
      alert("至少需要一张卡片（问题 + 答案）。");
      return;
    }
    const payload = {
      title: document.getElementById("fTitle").value.trim(),
      tag: document.getElementById("fTag").value,
      mechanism: document.getElementById("fMechanism").value.trim(),
      clinical: document.getElementById("fClinical").value.trim(),
      mnemonic: document.getElementById("fMnemonic").value.trim(),
      // 高级可选字段
      diagnosis: document.getElementById("fDiagnosis").value.trim(),
      treatment: document.getElementById("fTreatment").value.trim(),
      differential: document.getElementById("fDifferential").value.trim(),
      etiology: document.getElementById("fEtiology").value.trim(),
      prevention: document.getElementById("fPrevention").value.trim(),
      cards,
    };
    try {
      await API.createPoint(payload);
      document.getElementById("addForm").reset();
      document.getElementById("cardsList").innerHTML = "";
      document.getElementById("advancedFields").style.display = "none";
      document.getElementById("toggleAdvanced").textContent = "▼ 展开高级字段";
      addCardRow("forward");
      loadStats();
      loadTags();
      loadPoints();
    } catch (err) {
      alert("保存失败：" + err.message);
    }
  });
}

/* ---------------- 知识点列表 ---------------- */

async function loadPoints() {
  const box = document.getElementById("pointsList");
  try {
    const points = await API.listPoints(currentTag);
    if (points.length === 0) {
      box.innerHTML = `<div class="muted">${currentTag ? `「${esc(currentTag)}」分类下暂无知识点。` : '还没有知识点。去「AI 导入」粘贴教材让 AI 帮你拆卡，或在上方手动添加。'}</div>`;
      return;
    }
    const cards = await API.listCards();
    const cardsByPoint = {};
    cards.forEach(c => {
      (cardsByPoint[c.point_id] = cardsByPoint[c.point_id] || []).push(c);
    });
    box.innerHTML = points.map(p => renderPoint(p, cardsByPoint[p.id] || [])).join("");
    // 绑定按钮事件
    box.querySelectorAll(".del-point").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("删除该知识点及其所有卡片和关联？")) return;
        try {
          await API.deletePoint(parseInt(btn.dataset.id));
          loadStats(); loadTags(); loadPoints();
        } catch (e) { alert("删除失败：" + e.message); }
      });
    });
    box.querySelectorAll(".rel-point").forEach(btn => {
      btn.addEventListener("click", () => openRelationModal(parseInt(btn.dataset.id), btn.dataset.title));
    });
  } catch (e) {
    box.innerHTML = `<div class="muted" style="color:var(--danger);">加载失败：${esc(e.message)}<br>请确认服务器已启动（python server.py）</div>`;
  }
}

function renderPoint(p, cards) {
  const uk = [];
  if (p.mechanism) uk.push(`<div class="uk-line"><span class="uk-label">机制：</span>${esc(p.mechanism)}</div>`);
  if (p.clinical) uk.push(`<div class="uk-line"><span class="uk-label">临床：</span>${esc(p.clinical)}</div>`);
  if (p.mnemonic) uk.push(`<div class="uk-line"><span class="uk-label">画面：</span>${esc(p.mnemonic)}</div>`);
  // 高级字段（仅在有值时显示）
  if (p.diagnosis) uk.push(`<div class="uk-line"><span class="uk-label">诊断：</span>${esc(p.diagnosis)}</div>`);
  if (p.treatment) uk.push(`<div class="uk-line"><span class="uk-label">治疗：</span>${esc(p.treatment)}</div>`);
  if (p.differential) uk.push(`<div class="uk-line"><span class="uk-label">鉴别：</span>${esc(p.differential)}</div>`);
  if (p.etiology) uk.push(`<div class="uk-line"><span class="uk-label">病因：</span>${esc(p.etiology)}</div>`);
  if (p.prevention) uk.push(`<div class="uk-line"><span class="uk-label">预防：</span>${esc(p.prevention)}</div>`);
  const cardChips = cards.map(c =>
    `<span class="point-card-chip"><span class="type-badge type-${c.type}">${esc(TYPE_LABELS[c.type] || c.type)}</span>${esc(c.question)}</span>`
  ).join("");
  const sizeBadge = p.size === "small"
    ? `<span class="size-badge size-small">🔖 小</span>`
    : "";
  return `
    <div class="point-item">
      <div class="point-head">
        <div>
          <span class="point-title">${esc(p.title)}</span>
          <span class="point-tag">${esc(p.tag)}</span>
          ${sizeBadge}
        </div>
        <div class="point-actions">
          <button class="rel-point" data-id="${p.id}" data-title="${esc(p.title)}">🔗</button>
          <button class="del-point" data-id="${p.id}">删除</button>
        </div>
      </div>
      ${uk.length ? `<div class="point-understand">${uk.join("")}</div>` : ""}
      ${cardChips ? `<div class="point-cards">${cardChips}</div>` : ""}
    </div>
  `;
}

/* ---------------- 关联弹窗 ---------------- */

async function openRelationModal(pointId, pointTitle) {
  relModalPointId = pointId;
  document.getElementById("relModalTitle").textContent = `🔗 「${pointTitle}」的知识关联`;
  document.getElementById("relationModal").style.display = "flex";
  // 加载已有关联
  const body = document.getElementById("relModalBody");
  body.innerHTML = `<p class="muted">加载中...</p>`;
  try {
    const resp = await fetch(`/api/relations?point_id=${pointId}`);
    const data = await resp.json();
    const rels = data.relations || [];
    if (rels.length === 0) {
      body.innerHTML = `<p class="muted">暂无关联。可以手动添加，或通过 AI 导入时自动识别。</p>`;
    } else {
      body.innerHTML = rels.map(r => {
        const dir = r.direction === "outgoing" ? "→" : "←";
        const typeLabel = REL_TYPE_LABELS[r.type] || r.type;
        return `<div class="rel-item">
          <button class="del-rel" data-id="${r.id}" title="删除关联">✕</button>
          <span class="rel-dir">${dir}</span>
          <span class="rel-type">${typeLabel}</span>
          <a href="#" class="rel-other" data-id="${r.other_id}">${esc(r.other_title)}</a>
          <span class="rel-tag">[${esc(r.other_tag)}]</span>
          ${r.note ? `<span class="rel-note">${esc(r.note)}</span>` : ""}
        </div>`;
      }).join("");
      body.querySelectorAll(".del-rel").forEach(btn => {
        btn.addEventListener("click", async () => {
          try {
            await API._req("DELETE", `/api/relations/${btn.dataset.id}`);
            openRelationModal(pointId, pointTitle);
          } catch (e) { alert("删除失败：" + e.message); }
        });
      });
    }
  } catch (e) {
    body.innerHTML = `<p class="muted" style="color:var(--danger);">加载失败：${esc(e.message)}</p>`;
  }
  // 填充"选择关联知识点"下拉框（排除自身）
  const select = document.getElementById("relOtherPoint");
  try {
    const data = await fetch("/api/points").then(r => r.json());
    select.innerHTML = `<option value="">选择关联知识点...</option>` +
      (data.points || []).filter(p => p.id !== pointId).map(p =>
        `<option value="${p.id}">[${esc(p.tag)}] ${esc(p.title)}</option>`
      ).join("");
  } catch (e) { /* 忽略 */ }
}

function bindRelationModal() {
  document.getElementById("relModalClose").addEventListener("click", () => {
    document.getElementById("relationModal").style.display = "none";
  });
  document.getElementById("relationModal").addEventListener("click", (e) => {
    if (e.target.id === "relationModal") {
      document.getElementById("relationModal").style.display = "none";
    }
  });
  document.getElementById("relAddBtn").addEventListener("click", async () => {
    const otherId = parseInt(document.getElementById("relOtherPoint").value);
    const relType = document.getElementById("relType").value;
    const note = document.getElementById("relNote").value.trim();
    if (!otherId) { alert("请选择一个知识点"); return; }
    if (!relModalPointId) return;
    try {
      await API._req("POST", "/api/relations", {
        relations: [{ from_id: relModalPointId, to_id: otherId, type: relType, note }]
      });
      document.getElementById("relOtherPoint").value = "";
      document.getElementById("relNote").value = "";
      // 刷新弹窗
      const title = document.getElementById("relModalTitle").textContent.replace(/🔗 |「|」的知识关联/g, "");
      openRelationModal(relModalPointId, title);
    } catch (e) { alert("添加失败：" + e.message); }
  });
}
