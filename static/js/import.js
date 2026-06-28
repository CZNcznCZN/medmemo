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

document.addEventListener("DOMContentLoaded", async () => {
  bindGenerate();
  bindImport();
  loadSubjectOptions();
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

const AI_CHUNK_LIMIT = 2400;

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
      `<div class="ai-card-line"><span class="type-badge type-${c.type}">${esc(TYPE_LABELS[c.type] || c.type)}</span><strong>问：</strong>${esc(c.question)} <strong>答：</strong>${esc(c.answer)}</div>`
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
      <div class="${itemClass}">
        <h3>📌 ${esc(p.title)} ${sizeBadge}</h3>
        ${dupHtml}
        ${p.mechanism ? `<div class="uk-block"><strong>机制：</strong>${esc(p.mechanism)}</div>` : ""}
        ${p.clinical ? `<div class="uk-block"><strong>临床：</strong>${esc(p.clinical)}</div>` : ""}
        ${p.mnemonic ? `<div class="uk-block"><strong>记忆画面：</strong>${esc(p.mnemonic)}</div>` : ""}
        <div class="ai-cards-mini">${cards}</div>
        ${nodesHtml}
      </div>
    `);
  });

  // 对照卡
  if (result.comparisons && result.comparisons.length) {
    result.comparisons.forEach(c => {
      const dims = (c.dimensions || []).map(d =>
        `<tr><td><strong>${esc(d.dim)}</strong></td><td>${esc(d.value_a)}</td><td>${esc(d.value_b)}</td></tr>`
      ).join("");
      // 把对照卡包装成一个特殊"知识点"
      parts.push(`
        <div class="ai-result-item">
          <h3>🔀 对照：${esc(c.a)} vs ${esc(c.b)}</h3>
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
  } else {
    list.innerHTML = parts.join("");
  }
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
