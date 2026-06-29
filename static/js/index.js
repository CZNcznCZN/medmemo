/* 主页逻辑：统计、科目筛选、手动新增知识点、列表管理、关联管理 */

const CARD_TYPES = ["forward", "reverse", "mechanism", "apply"];
// 注意：TYPE_LABELS 已在 api.js 全局声明，这里直接复用，切勿重复声明（否则浏览器抛 SyntaxError，整个文件不执行）
const REL_TYPE_LABELS = {
  cause: "因果", compare: "对比", upstream: "上游", downstream: "下游", related: "相关"
};

let cardEditorCount = 0;
let currentTag = "";        // 当前筛选的科目
let currentPointsCache = [];  // 当前列表知识点（搜索用）
let currentCardsByPoint = {}; // 当前列表卡片缓存（搜索用）
let relModalPointId = null; // 当前打开关联弹窗的知识点 id
let selectedBulkPointIds = new Set();

document.addEventListener("DOMContentLoaded", () => {
  loadTags();
  loadStats();
  loadPoints();
  bindAddForm();
  bindAdvancedToggle();
  bindRelationModal();
  bindPointEditModal();
  bindBackupImport();
  bindPointSearch();
  bindBulkToolbar();
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
        const searchInput = document.getElementById("pointSearch");
        if (searchInput) searchInput.value = "";
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

/* ---------------- 备份恢复 ---------------- */

function bindBackupImport() {
  const btn = document.getElementById("importBackupBtn");
  const input = document.getElementById("backupFileInput");
  if (!btn || !input) return;

  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (!confirm(buildBackupRestoreMessage(file, backup))) {
        return;
      }
      btn.disabled = true;
      btn.textContent = "恢复中...";
      const result = await API.importBackup(backup);
      const s = result.stats || {};
      const safety = result.safety_backup ? `\n\n恢复前的当前数据已自动保存到：\n${result.safety_backup}` : "";
      alert(`恢复完成：${s.points || 0} 个知识点，${s.cards || 0} 张卡片，${s.reviews || 0} 条复习记录。${safety}`);
      currentTag = "";
      await loadTags();
      await loadStats();
      await loadPoints();
    } catch (e) {
      alert("恢复失败：" + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "↥ 恢复备份";
    }
  });
}

function backupCount(backup, key) {
  return Array.isArray(backup?.[key]) ? backup[key].length : 0;
}

function buildBackupRestoreMessage(file, backup) {
  const exportedAt = backup?.exported_at || "未知";
  const version = backup?.version || "未知";
  const points = backupCount(backup, "points");
  const cards = backupCount(backup, "cards");
  const reviews = backupCount(backup, "reviews");
  const relations = backupCount(backup, "relations");
  const nodes = backupCount(backup, "nodes");
  const comparisons = backupCount(backup, "comparison_dims");
  const customEdges = backupCount(backup, "custom_edges");
  const warnings = [];
  if (!Array.isArray(backup?.points) || !Array.isArray(backup?.cards)) {
    warnings.push("这个文件缺少 points/cards 字段，可能不是 MedMemo 完整备份。");
  }
  if (points === 0 && cards === 0) {
    warnings.push("备份里没有知识点和卡片。");
  }
  const warningText = warnings.length ? `\n\n注意：\n${warnings.map(w => `- ${w}`).join("\n")}` : "";
  return (
    `准备恢复备份：${file.name}\n\n` +
    `导出时间：${exportedAt}\n` +
    `备份版本：${version}\n` +
    `知识点：${points}\n` +
    `卡片：${cards}\n` +
    `复习记录：${reviews}\n` +
    `知识关联：${relations}\n` +
    `知识节点：${nodes}\n` +
    `对比维度：${comparisons}\n` +
    `手动连线：${customEdges}` +
    warningText +
    `\n\n恢复会清空当前全部学习数据，并替换为以上备份内容。继续？`
  );
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
      renderWeakPointPanel(rs.weak_points || []);
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

function renderWeakPointPanel(points) {
  const panel = document.getElementById("weakPanel");
  const list = document.getElementById("weakPointList");
  if (!panel || !list) return;
  if (!points || points.length === 0) {
    panel.style.display = "none";
    list.innerHTML = "";
    return;
  }

  panel.style.display = "";
  list.innerHTML = points.map(p => `
    <button type="button" class="weak-point-item" data-title="${esc(p.title)}">
      <span class="weak-point-title">${esc(p.title)}</span>
      <span class="weak-point-meta">
        <span>${esc(p.tag || "未分类")}</span>
        <span><b>${p.wrong_count || 0}</b> 次错误</span>
        <span>${p.active_wrong_cards || 0} 张错题卡</span>
      </span>
    </button>
  `).join("");

  list.querySelectorAll(".weak-point-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = document.getElementById("pointSearch");
      if (!input) return;
      input.value = btn.dataset.title || "";
      input.focus();
      renderPointsList();
      document.getElementById("pointsList")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

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

function bindPointSearch() {
  const input = document.getElementById("pointSearch");
  const clearBtn = document.getElementById("clearPointSearch");
  if (!input || !clearBtn) return;
  input.addEventListener("input", () => renderPointsList());
  clearBtn.addEventListener("click", () => {
    input.value = "";
    input.focus();
    renderPointsList();
  });
}

function getVisiblePointIds() {
  const query = (document.getElementById("pointSearch")?.value || "").trim().toLowerCase();
  return currentPointsCache
    .filter(p => pointMatchesSearch(p, currentCardsByPoint[p.id] || [], query))
    .map(p => p.id);
}

function updateBulkToolbar() {
  const visibleIds = getVisiblePointIds();
  const selectedVisible = visibleIds.filter(id => selectedBulkPointIds.has(id));
  const countEl = document.getElementById("bulkSelectedCount");
  const selectAll = document.getElementById("bulkSelectAll");
  const retagBtn = document.getElementById("bulkRetagBtn");
  const deleteBtn = document.getElementById("bulkDeleteBtn");
  const hasSelection = selectedBulkPointIds.size > 0;
  if (countEl) countEl.textContent = `已选 ${selectedBulkPointIds.size} 个`;
  if (selectAll) {
    selectAll.checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
    selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
  }
  if (retagBtn) retagBtn.disabled = !hasSelection;
  if (deleteBtn) deleteBtn.disabled = !hasSelection;
}

function bindBulkToolbar() {
  const selectAll = document.getElementById("bulkSelectAll");
  const retagBtn = document.getElementById("bulkRetagBtn");
  const deleteBtn = document.getElementById("bulkDeleteBtn");
  const exportBtn = document.getElementById("bulkExportBtn");
  if (!selectAll || !retagBtn || !deleteBtn || !exportBtn) return;

  selectAll.addEventListener("change", () => {
    getVisiblePointIds().forEach(id => {
      if (selectAll.checked) selectedBulkPointIds.add(id);
      else selectedBulkPointIds.delete(id);
    });
    renderPointsList();
  });

  retagBtn.addEventListener("click", async () => {
    const target = document.getElementById("bulkTagInput").value.trim();
    const ids = [...selectedBulkPointIds];
    if (!target) {
      alert("请输入要批量改到的学科。");
      return;
    }
    if (!ids.length) return;
    if (!confirm(`确定把 ${ids.length} 个知识点改到「${target}」吗？`)) return;
    retagBtn.disabled = true;
    try {
      await Promise.all(ids.map(id => API.updatePoint(id, { tag: target })));
      selectedBulkPointIds.clear();
      currentTag = "";
      await loadTags();
      await loadStats();
      await loadPoints();
    } catch (e) {
      alert("批量改学科失败：" + e.message);
    } finally {
      updateBulkToolbar();
    }
  });

  deleteBtn.addEventListener("click", async () => {
    const ids = [...selectedBulkPointIds];
    if (!ids.length) return;
    if (!confirm(`确定删除选中的 ${ids.length} 个知识点及其卡片、复习记录和网络关系吗？此操作不可恢复。`)) return;
    deleteBtn.disabled = true;
    try {
      for (const id of ids) {
        await API.deletePoint(id);
      }
      selectedBulkPointIds.clear();
      await loadTags();
      await loadStats();
      await loadPoints();
    } catch (e) {
      alert("批量删除失败：" + e.message);
    } finally {
      updateBulkToolbar();
    }
  });

  exportBtn.addEventListener("click", () => {
    const ids = [...selectedBulkPointIds];
    if (ids.length) {
      window.location.href = `/api/export?${ids.map(id => `point_id=${encodeURIComponent(id)}`).join("&")}`;
      return;
    }
    const tag = currentTag || document.getElementById("bulkTagInput").value.trim();
    if (!tag) {
      alert("请先筛选一个学科、输入学科名，或勾选要导出的知识点。");
      return;
    }
    window.location.href = `/api/export?tag=${encodeURIComponent(tag)}`;
  });
  updateBulkToolbar();
}

async function loadPoints() {
  const box = document.getElementById("pointsList");
  try {
    const points = await API.listPoints(currentTag);
    if (points.length === 0) {
      currentPointsCache = [];
      currentCardsByPoint = {};
      selectedBulkPointIds.clear();
      updatePointsCount(0, 0);
      updateBulkToolbar();
      box.innerHTML = `<div class="muted">${currentTag ? `「${esc(currentTag)}」分类下暂无知识点。` : '还没有知识点。去「AI 导入」粘贴教材让 AI 帮你拆卡，或在上方手动添加。'}</div>`;
      return;
    }
    const cards = await API.listCards();
    const cardsByPoint = {};
    cards.forEach(c => {
      (cardsByPoint[c.point_id] = cardsByPoint[c.point_id] || []).push(c);
    });
    currentPointsCache = points;
    const existingIds = new Set(points.map(p => p.id));
    selectedBulkPointIds = new Set([...selectedBulkPointIds].filter(id => existingIds.has(id)));
    currentCardsByPoint = cardsByPoint;
    renderPointsList();
  } catch (e) {
    box.innerHTML = `<div class="muted" style="color:var(--danger);">加载失败：${esc(e.message)}<br>请确认服务器已启动（python server.py）</div>`;
  }
}

function updatePointsCount(visible, total) {
  const el = document.getElementById("pointsCount");
  if (!el) return;
  el.textContent = total ? (visible === total ? `${total} 个知识点` : `${visible} / ${total} 个知识点`) : "";
}

function pointMatchesSearch(point, cards, query) {
  if (!query) return true;
  const haystack = [
    point.title, point.tag, point.mechanism, point.clinical, point.mnemonic,
    point.diagnosis, point.treatment, point.differential, point.etiology, point.prevention,
    ...cards.flatMap(c => [c.question, c.answer, TYPE_LABELS[c.type] || c.type]),
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(query);
}

function renderPointsList() {
  const box = document.getElementById("pointsList");
  const query = (document.getElementById("pointSearch")?.value || "").trim().toLowerCase();
  const filtered = currentPointsCache.filter(p => pointMatchesSearch(p, currentCardsByPoint[p.id] || [], query));
  updatePointsCount(filtered.length, currentPointsCache.length);

  if (filtered.length === 0) {
    box.innerHTML = `<div class="muted">${query ? `没有找到包含「${esc(query)}」的知识点。` : "暂无知识点。"}</div>`;
    updateBulkToolbar();
    return;
  }

  box.innerHTML = filtered.map(p => renderPoint(p, currentCardsByPoint[p.id] || [])).join("");
  bindPointListActions(box);
  updateBulkToolbar();
}

function bindPointListActions(box) {
  box.querySelectorAll(".point-select").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = parseInt(cb.value, 10);
      if (cb.checked) selectedBulkPointIds.add(id);
      else selectedBulkPointIds.delete(id);
      cb.closest(".point-item")?.classList.toggle("selected", cb.checked);
      updateBulkToolbar();
    });
  });
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
  box.querySelectorAll(".edit-point").forEach(btn => {
    btn.addEventListener("click", () => openPointEditModal(parseInt(btn.dataset.id)));
  });
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
  const selected = selectedBulkPointIds.has(p.id);
  return `
    <div class="point-item ${selected ? "selected" : ""}">
      <div class="point-head">
        <div class="point-title-wrap">
          <input type="checkbox" class="point-select" value="${p.id}" ${selected ? "checked" : ""} aria-label="选择知识点">
          <div>
            <span class="point-title">${esc(p.title)}</span>
            <span class="point-tag">${esc(p.tag)}</span>
            ${sizeBadge}
          </div>
        </div>
        <div class="point-actions">
          <button class="edit-point" data-id="${p.id}">编辑</button>
          <button class="rel-point" data-id="${p.id}" data-title="${esc(p.title)}">🔗</button>
          <button class="del-point" data-id="${p.id}">删除</button>
        </div>
      </div>
      ${uk.length ? `<div class="point-understand">${uk.join("")}</div>` : ""}
      ${cardChips ? `<div class="point-cards">${cardChips}</div>` : ""}
    </div>
  `;
}

/* ---------------- 知识点编辑弹窗 ---------------- */

function bindPointEditModal() {
  const modal = document.getElementById("pointEditModal");
  const close = document.getElementById("editModalClose");
  const addBtn = document.getElementById("editAddCardBtn");
  const form = document.getElementById("editPointForm");
  if (!modal || !close || !addBtn || !form) return;

  close.addEventListener("click", closePointEditModal);
  modal.addEventListener("click", (e) => {
    if (e.target.id === "pointEditModal") closePointEditModal();
  });
  addBtn.addEventListener("click", () => addEditCardRow());
  form.addEventListener("submit", savePointEdits);
}

function closePointEditModal() {
  document.getElementById("pointEditModal").style.display = "none";
  document.getElementById("editMsg").textContent = "";
}

function setEditValue(id, value) {
  document.getElementById(id).value = value || "";
}

function openPointEditModal(pointId) {
  const point = currentPointsCache.find(p => p.id === pointId);
  if (!point) return;
  document.getElementById("editModalTitle").textContent = `编辑「${point.title}」`;
  setEditValue("editPointId", point.id);
  setEditValue("editTitle", point.title);
  setEditValue("editTag", point.tag);
  setEditValue("editMechanism", point.mechanism);
  setEditValue("editClinical", point.clinical);
  setEditValue("editMnemonic", point.mnemonic);
  setEditValue("editDiagnosis", point.diagnosis);
  setEditValue("editTreatment", point.treatment);
  setEditValue("editDifferential", point.differential);
  setEditValue("editEtiology", point.etiology);
  setEditValue("editPrevention", point.prevention);
  const list = document.getElementById("editCardsList");
  list.innerHTML = "";
  (currentCardsByPoint[point.id] || []).forEach(card => addEditCardRow(card));
  document.getElementById("pointEditModal").style.display = "flex";
}

function addEditCardRow(card = {}) {
  const list = document.getElementById("editCardsList");
  const row = document.createElement("div");
  row.className = "edit-card-row";
  row.dataset.id = card.id || "";
  row.innerHTML = `
    <select class="edit-card-type">
      ${CARD_TYPES.concat("compare").map(t => `<option value="${t}" ${card.type === t ? "selected" : ""}>${TYPE_LABELS[t] || t}</option>`).join("")}
    </select>
    <input type="text" class="edit-card-q" placeholder="问题" value="${esc(card.question || "")}">
    <input type="text" class="edit-card-a" placeholder="答案" value="${esc(card.answer || "")}">
    <button type="button" class="del-card" title="删除">✕</button>
  `;
  row.querySelector(".del-card").addEventListener("click", () => row.remove());
  list.appendChild(row);
}

function collectEditCards() {
  return Array.from(document.querySelectorAll("#editCardsList .edit-card-row"))
    .map(row => ({
      id: row.dataset.id ? parseInt(row.dataset.id) : null,
      type: row.querySelector(".edit-card-type").value,
      question: row.querySelector(".edit-card-q").value.trim(),
      answer: row.querySelector(".edit-card-a").value.trim(),
    }))
    .filter(card => card.question || card.answer);
}

async function savePointEdits(e) {
  e.preventDefault();
  const pointId = parseInt(document.getElementById("editPointId").value);
  const cards = collectEditCards();
  if (!cards.length || cards.some(card => !card.question || !card.answer)) {
    alert("至少保留一张完整卡片（问题 + 答案）。");
    return;
  }

  const saveBtn = document.getElementById("editSaveBtn");
  const msg = document.getElementById("editMsg");
  saveBtn.disabled = true;
  msg.textContent = "保存中...";
  try {
    await API.updatePoint(pointId, {
      title: document.getElementById("editTitle").value.trim(),
      tag: document.getElementById("editTag").value.trim(),
      mechanism: document.getElementById("editMechanism").value.trim(),
      clinical: document.getElementById("editClinical").value.trim(),
      mnemonic: document.getElementById("editMnemonic").value.trim(),
      diagnosis: document.getElementById("editDiagnosis").value.trim(),
      treatment: document.getElementById("editTreatment").value.trim(),
      differential: document.getElementById("editDifferential").value.trim(),
      etiology: document.getElementById("editEtiology").value.trim(),
      prevention: document.getElementById("editPrevention").value.trim(),
      cards,
    });
    closePointEditModal();
    await loadStats();
    await loadTags();
    await loadPoints();
  } catch (err) {
    msg.textContent = "保存失败：" + err.message;
  } finally {
    saveBtn.disabled = false;
  }
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
