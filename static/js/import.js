/* AI 导入页逻辑：调用 AI 拆卡 → 审核编辑 → 入库 */

// 获取当前选中的科目（处理"自定义"选项）
function getSubject() {
  const sel = document.getElementById("subject");
  const v = sel.value;
  if (v === "__custom__") {
    const custom = document.getElementById("customSubject").value.trim();
    return custom || "通用";
  }
  return v;
}

// 动态填充科目下拉：把已用过的（含自定义）科目加进 select
// 已用过的科目（即已有知识点的）自动出现在列表里，不必每次走"自定义"
async function loadSubjectOptions() {
  try {
    const tags = await API.getTags();
    const sel = document.getElementById("subject");
    const customOpt = document.getElementById("customOption");
    // 收集 select 里已有的值（写死的预设科目）
    const existing = new Set(Array.from(sel.options).map(o => o.value));
    // 把已有知识点用过的、但不在预设里的科目，插到「自定义」选项之前
    (tags || []).forEach(t => {
      const v = t.tag || "";
      if (v && !existing.has(v)) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        sel.insertBefore(opt, customOpt);
      }
    });
  } catch (e) { /* 拉取失败不影响手动输入 */ }
}

async function loadExistingPointTitles() {
  try {
    const points = await API.listPoints();
    existingPointTitles = new Set(
      (points || []).map(p => (p.title || "").trim().toLowerCase()).filter(Boolean)
    );
  } catch {
    existingPointTitles = new Set();
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  bindGenerate();
  bindImport();
  loadSubjectOptions();
  loadExistingPointTitles();
  // 自定义科目输入框的显示/隐藏
  document.getElementById("subject").addEventListener("change", (e) => {
    const custom = document.getElementById("customSubject");
    custom.style.display = e.target.value === "__custom__" ? "" : "none";
    if (e.target.value === "__custom__") custom.focus();
  });
  // 检查是否配置了 API key
  try {
    const cfg = await API.getConfig();
    const status = document.getElementById("aiStatus");
    if (!cfg.has_api_key) {
      status.className = "ai-status warn";
      status.innerHTML = "⚠️ 未配置 DeepSeek API key。请在项目根目录的 <code>config.json</code> 填入 <code>deepseek_api_key</code> 后重启服务器，才能使用 AI 拆卡。";
    } else {
      status.className = "ai-status ok";
      status.innerHTML = "✅ AI 已就绪，粘贴医学文本即可智能拆卡。";
    }
  } catch (e) { /* 忽略 */ }
});

let aiResult = null;  // 缓存 AI 返回结果，供入库用
let existingPointTitles = new Set();

const AI_CHUNK_LIMIT = 2400;
const AI_LONG_ANSWER_LIMIT = 220;

function bindGenerate() {
  document.getElementById("generateBtn").addEventListener("click", onGenerate);
}

function splitTextForAI(text, maxLen = AI_CHUNK_LIMIT) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxLen) return [normalized];

  const blocks = normalized
    .split(/\n(?=#{1,6}\s|\d+[.、]\s|[一二三四五六七八九十]+[、.]\s)/)
    .flatMap(part => part.split(/\n{2,}/))
    .map(part => part.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";
  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const block of blocks.length ? blocks : [normalized]) {
    if (block.length > maxLen) {
      pushCurrent();
      for (let i = 0; i < block.length; i += maxLen) {
        chunks.push(block.slice(i, i + maxLen).trim());
      }
      continue;
    }
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length > maxLen) {
      pushCurrent();
      current = block;
    } else {
      current = next;
    }
  }
  pushCurrent();
  return chunks;
}

function mergeAiResults(results) {
  const merged = { points: [], comparisons: [], relations: [] };
  const pointSeen = new Set();
  const comparisonSeen = new Set();
  const relationSeen = new Set();

  results.forEach(result => {
    (result.points || []).forEach(point => {
      const key = (point.title || "").trim();
      if (!key || pointSeen.has(key)) return;
      pointSeen.add(key);
      merged.points.push(point);
    });

    (result.comparisons || []).forEach(cmp => {
      const a = (cmp.a || "").trim();
      const b = (cmp.b || "").trim();
      const key = [a, b].sort().join("::");
      if (!a || !b || comparisonSeen.has(key)) return;
      comparisonSeen.add(key);
      merged.comparisons.push(cmp);
    });

    (result.relations || []).forEach(rel => {
      const from = (rel.from || rel.from_title || "").trim();
      const to = (rel.to || rel.to_title || "").trim();
      const type = rel.type || "related";
      const key = `${from}::${to}::${type}`;
      if (!from || !to || relationSeen.has(key)) return;
      relationSeen.add(key);
      merged.relations.push(rel);
    });
  });

  return merged;
}

async function onGenerate() {
  const text = document.getElementById("sourceText").value.trim();
  const subject = getSubject();
  const btn = document.getElementById("generateBtn");
  const progress = document.getElementById("genProgress");

  if (!text) {
    alert("请先粘贴医学文本。");
    return;
  }

  btn.disabled = true;
  const chunks = splitTextForAI(text);
  progress.textContent = chunks.length === 1
    ? "⏳ AI 正在拆卡，约需 10-30 秒，请稍候..."
    : `⏳ 文本较长，已拆成 ${chunks.length} 段，正在生成第 1 段...`;
  try {
    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      if (chunks.length > 1) {
        progress.textContent = `⏳ AI 正在拆卡：第 ${i + 1} / ${chunks.length} 段...`;
      }
      results.push(await API.aiGenerate(chunks[i], subject));
    }
    const result = mergeAiResults(results);
    aiResult = result;
    await loadExistingPointTitles();
    renderResult(result);
    document.getElementById("resultPanel").style.display = "";
    progress.textContent = chunks.length === 1
      ? ""
      : `✅ 已完成 ${chunks.length} 段生成，合并为 ${result.points.length} 个知识点。`;
  } catch (e) {
    progress.textContent = "";
    const keyHint = /key|api key|deepseek_api_key/i.test(e.message)
      ? "\n\n若提示未配置 key，请先在 config.json 填入 deepseek_api_key。"
      : "";
    alert("AI 拆卡失败：" + e.message + keyHint);
  } finally {
    btn.disabled = false;
  }
}

function renderResult(result) {
  const list = document.getElementById("resultList");
  const parts = [];

  // 知识点
  (result.points || []).forEach((p, i) => {
    const cards = (p.cards || []).map(c =>
      renderEditableCard(c)
    ).join("");
    // 层级节点树（用于知识网络展开）——小知识点无 nodes
    let nodesHtml = "";
    if (p.nodes && p.nodes.length) {
      const renderNode = (n, depth) => {
        const indent = depth * 14;
        const childHtml = (n.children || []).map(ch => renderNode(ch, depth + 1)).join("");
        return `<div class="ai-node-line" style="margin-left:${indent}px;">${depth === 0 ? "📁" : "🔹"} ${esc(n.label)}${n.detail ? ` <span class="muted">(${esc(n.detail)})</span>` : ""}</div>${childHtml}`;
      };
      nodesHtml = `<div class="uk-block"><strong>层级节点：</strong><div class="ai-nodes-tree">${p.nodes.map(n => renderNode(n, 0)).join("")}</div></div>`;
    }
    // 大小标记 + 重复提示
    const isSmall = p.size === "small";
    const sizeBadge = isSmall
      ? `<span class="size-badge size-small">🔖 小知识点（单卡）</span>`
      : `<span class="size-badge size-big">📘 大知识点</span>`;
    const dup = p.duplicate_of ? (typeof p.duplicate_of === "string" ? p.duplicate_of.trim() : "") : "";
    const dupHtml = dup
      ? `<div class="ai-dup-warn">⚠️ 可能与已有知识点「${esc(dup)}」重复</div>`
      : "";
    const itemClass = `ai-result-item${dup ? " ai-result-dup" : ""}${isSmall ? " ai-result-small" : ""}`;
    parts.push(`
      <div class="${itemClass} ai-result-point" data-index="${i}">
        <div class="ai-result-head">
          <h3>📌 ${esc(p.title || "未命名知识点")} ${sizeBadge}</h3>
          <button type="button" class="btn-mini ai-remove-point">删除</button>
        </div>
        ${dupHtml}
        <div class="ai-edit-grid">
          <label>标题<input type="text" class="ai-edit-title" value="${esc(p.title || "")}"></label>
          <label>类型
            <select class="ai-edit-size">
              <option value="big" ${p.size !== "small" ? "selected" : ""}>大知识点</option>
              <option value="small" ${p.size === "small" ? "selected" : ""}>小知识点</option>
            </select>
          </label>
          <label>机制<textarea class="ai-edit-mechanism" rows="2">${esc(p.mechanism || "")}</textarea></label>
          <label>临床<textarea class="ai-edit-clinical" rows="2">${esc(p.clinical || "")}</textarea></label>
          <label>记忆画面<textarea class="ai-edit-mnemonic" rows="2">${esc(p.mnemonic || "")}</textarea></label>
          <label>诊断<textarea class="ai-edit-diagnosis" rows="2">${esc(p.diagnosis || "")}</textarea></label>
          <label>治疗<textarea class="ai-edit-treatment" rows="2">${esc(p.treatment || "")}</textarea></label>
          <label>鉴别<textarea class="ai-edit-differential" rows="2">${esc(p.differential || "")}</textarea></label>
          <label>病因<textarea class="ai-edit-etiology" rows="2">${esc(p.etiology || "")}</textarea></label>
          <label>预防<textarea class="ai-edit-prevention" rows="2">${esc(p.prevention || "")}</textarea></label>
        </div>
        <div class="ai-cards-head">
          <strong>卡片</strong>
          <button type="button" class="btn-mini ai-add-card">+ 加一张卡</button>
        </div>
        <div class="ai-cards-mini">${cards}</div>
        ${nodesHtml}
      </div>
    `);
  });

  // 对照卡
  if (result.comparisons && result.comparisons.length) {
    result.comparisons.forEach((c, i) => {
      const dims = (c.dimensions || []).map(d =>
        `<tr><td><strong>${esc(d.dim)}</strong></td><td>${esc(d.value_a)}</td><td>${esc(d.value_b)}</td></tr>`
      ).join("");
      // 把对照卡包装成一个特殊"知识点"
      parts.push(`
        <div class="ai-result-item ai-result-comparison" data-index="${i}">
          <div class="ai-result-head">
            <h3>🔀 对照：${esc(c.a)} vs ${esc(c.b)}</h3>
            <button type="button" class="btn-mini ai-remove-comparison">删除</button>
          </div>
          <table style="width:100%; font-size:13px; border-collapse:collapse;">
            <thead><tr style="background:#f1f5f9;"><th style="text-align:left;padding:6px;">维度</th><th style="text-align:left;padding:6px;">${esc(c.a)}</th><th style="text-align:left;padding:6px;">${esc(c.b)}</th></tr></thead>
            <tbody style="border-top:1px solid #e2e8f0;">${dims}</tbody>
          </table>
        </div>
      `);
    });
  }

  if (parts.length === 0) {
    list.innerHTML = `<div class="muted">AI 未解析出知识点，换个文本试试。</div>`;
    const panel = document.getElementById("qualityPanel");
    if (panel) {
      panel.className = "ai-quality-panel warn";
      panel.textContent = "未解析出可入库内容。";
    }
  } else {
    list.innerHTML = parts.join("");
    bindResultEditing();
    updateQualityPanel();
  }
}

function renderEditableCard(card = {}) {
  const type = card.type || "forward";
  return `
    <div class="ai-card-line ai-edit-card">
      <select class="ai-card-type">
        ${["forward", "reverse", "mechanism", "apply", "compare"].map(t =>
          `<option value="${t}" ${type === t ? "selected" : ""}>${TYPE_LABELS[t] || t}</option>`
        ).join("")}
      </select>
      <input type="text" class="ai-card-question" placeholder="问题" value="${esc(card.question || "")}">
      <input type="text" class="ai-card-answer" placeholder="答案" value="${esc(card.answer || "")}">
      <button type="button" class="del-card ai-remove-card" title="删除">✕</button>
    </div>
  `;
}

function bindResultEditing() {
  document.querySelectorAll(".ai-remove-point").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.closest(".ai-result-point").remove();
      updateQualityPanel();
    });
  });
  document.querySelectorAll(".ai-remove-comparison").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.closest(".ai-result-comparison").remove();
      updateQualityPanel();
    });
  });
  document.querySelectorAll(".ai-remove-card").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.closest(".ai-edit-card").remove();
      updateQualityPanel();
    });
  });
  document.querySelectorAll(".ai-add-card").forEach(btn => {
    btn.addEventListener("click", () => {
      const cardsBox = btn.closest(".ai-result-point").querySelector(".ai-cards-mini");
      cardsBox.insertAdjacentHTML("beforeend", renderEditableCard({ type: "forward" }));
      cardsBox.lastElementChild.querySelector(".ai-remove-card")
        .addEventListener("click", (e) => {
          e.target.closest(".ai-edit-card").remove();
          updateQualityPanel();
        });
      bindQualityInputs(cardsBox.lastElementChild);
      updateQualityPanel();
    });
  });
  bindQualityInputs(document.getElementById("resultList"));
}

function bindQualityInputs(root) {
  root.querySelectorAll("input, textarea, select").forEach(el => {
    el.addEventListener("input", updateQualityPanel);
    el.addEventListener("change", updateQualityPanel);
  });
}

function collectEditedResult() {
  if (!aiResult) return null;
  const points = Array.from(document.querySelectorAll(".ai-result-point")).map(el => {
    const original = aiResult.points[parseInt(el.dataset.index)] || {};
    const cards = Array.from(el.querySelectorAll(".ai-edit-card")).map(row => ({
      type: row.querySelector(".ai-card-type").value,
      question: row.querySelector(".ai-card-question").value.trim(),
      answer: row.querySelector(".ai-card-answer").value.trim(),
    })).filter(card => card.question || card.answer);
    return {
      ...original,
      title: el.querySelector(".ai-edit-title").value.trim(),
      size: el.querySelector(".ai-edit-size").value,
      mechanism: el.querySelector(".ai-edit-mechanism").value.trim(),
      clinical: el.querySelector(".ai-edit-clinical").value.trim(),
      mnemonic: el.querySelector(".ai-edit-mnemonic").value.trim(),
      diagnosis: el.querySelector(".ai-edit-diagnosis").value.trim(),
      treatment: el.querySelector(".ai-edit-treatment").value.trim(),
      differential: el.querySelector(".ai-edit-differential").value.trim(),
      etiology: el.querySelector(".ai-edit-etiology").value.trim(),
      prevention: el.querySelector(".ai-edit-prevention").value.trim(),
      cards,
    };
  });
  const comparisons = Array.from(document.querySelectorAll(".ai-result-comparison"))
    .map(el => aiResult.comparisons[parseInt(el.dataset.index)])
    .filter(Boolean);
  return { ...aiResult, points, comparisons };
}

function validateEditedResult(result) {
  if (!result.points.length && !result.comparisons.length) {
    return "没有可入库的知识点或对照卡。";
  }
  for (const point of result.points) {
    if (!point.title) return "有知识点缺少标题。";
    if (!point.cards || !point.cards.length) return `「${point.title}」至少需要一张卡片。`;
    if (point.cards.some(card => !card.question || !card.answer)) {
      return `「${point.title}」里有卡片缺少问题或答案。`;
    }
  }
  return "";
}

function analyzeEditedResult(result) {
  const issues = [];
  const titleMap = new Map();
  result.points.forEach((point, index) => {
    const name = point.title || `第 ${index + 1} 个知识点`;
    if (!point.title) {
      issues.push({ level: "error", text: `第 ${index + 1} 个知识点缺少标题。` });
    } else {
      const normalized = point.title.toLowerCase();
      const current = titleMap.get(normalized) || { title: point.title, count: 0 };
      current.count += 1;
      titleMap.set(normalized, current);
      if (existingPointTitles.has(normalized)) {
        issues.push({ level: "warn", text: `「${point.title}」与已有知识点同名，请确认是否重复。` });
      }
    }
    if (!point.cards || !point.cards.length) {
      issues.push({ level: "error", text: `「${name}」没有卡片。` });
    }
    if (!point.mechanism && point.size !== "small") {
      issues.push({ level: "warn", text: `「${name}」缺少机制解释。` });
    }
    if (!point.clinical && point.size !== "small") {
      issues.push({ level: "warn", text: `「${name}」缺少临床联系。` });
    }
    if (!point.mnemonic && point.size !== "small") {
      issues.push({ level: "warn", text: `「${name}」缺少记忆画面。` });
    }

    const seenCards = new Set();
    (point.cards || []).forEach((card, cardIndex) => {
      if (!card.question || !card.answer) {
        issues.push({ level: "error", text: `「${name}」第 ${cardIndex + 1} 张卡片缺少问题或答案。` });
      }
      if (card.answer && card.answer.length > AI_LONG_ANSWER_LIMIT) {
        issues.push({ level: "warn", text: `「${name}」第 ${cardIndex + 1} 张卡片答案较长，可能不利于回忆。` });
      }
      const key = `${card.type || ""}::${card.question || ""}::${card.answer || ""}`.toLowerCase();
      if (seenCards.has(key)) {
        issues.push({ level: "warn", text: `「${name}」有重复卡片。` });
      }
      seenCards.add(key);
    });
  });
  titleMap.forEach(item => {
    if (item.count > 1) issues.push({ level: "error", text: `标题「${item.title}」重复。` });
  });
  return issues;
}

function updateQualityPanel() {
  const panel = document.getElementById("qualityPanel");
  if (!panel || !aiResult) return;
  const result = collectEditedResult();
  const issues = analyzeEditedResult(result);
  const errors = issues.filter(i => i.level === "error");
  const warnings = issues.filter(i => i.level === "warn");
  if (!issues.length) {
    panel.className = "ai-quality-panel ok";
    panel.innerHTML = "✅ 质量检查通过，可以入库。";
    return;
  }
  panel.className = `ai-quality-panel ${errors.length ? "bad" : "warn"}`;
  const shown = issues.slice(0, 8).map(i =>
    `<li class="${i.level}">${i.level === "error" ? "必须修复" : "建议检查"}：${esc(i.text)}</li>`
  ).join("");
  const more = issues.length > 8 ? `<li class="muted">还有 ${issues.length - 8} 条提示未显示。</li>` : "";
  panel.innerHTML = `
    <div><strong>${errors.length ? "发现必须修复的问题" : "发现建议检查的问题"}</strong>：${errors.length} 个错误，${warnings.length} 个提醒。</div>
    <ul>${shown}${more}</ul>
  `;
}

function bindImport() {
  document.getElementById("importBtn").addEventListener("click", onImport);
}

async function onImport() {
  if (!aiResult) {
    alert("请先生成拆卡结果。");
    return;
  }
  const btn = document.getElementById("importBtn");
  const msg = document.getElementById("importMsg");
  btn.disabled = true;
  msg.textContent = "⏳ 入库中...";

  try {
    aiResult = collectEditedResult();
    const validationError = validateEditedResult(aiResult);
    if (validationError) {
      msg.textContent = validationError;
      return;
    }
    const qualityErrors = analyzeEditedResult(aiResult).filter(i => i.level === "error");
    if (qualityErrors.length) {
      msg.textContent = `还有 ${qualityErrors.length} 个必须修复的问题，请先处理质量检查提示。`;
      updateQualityPanel();
      return;
    }
    const subjectTag = getSubject();
    const result = await API.importBatch(aiResult, subjectTag);
    msg.textContent = `✅ 已入库 ${result.point_count} 个知识点，${result.card_count} 张卡片，${result.relation_count} 条关联`;
    aiResult = null;
    document.getElementById("resultPanel").style.display = "none";
    document.getElementById("sourceText").value = "";
  } catch (e) {
    msg.textContent = "入库出错：" + e.message;
  } finally {
    btn.disabled = false;
  }
}
