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

function bindGenerate() {
  document.getElementById("generateBtn").addEventListener("click", onGenerate);
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
  progress.textContent = "⏳ AI 正在拆卡，约需 10-30 秒，请稍候...";
  try {
    const result = await API.aiGenerate(text, subject);
    aiResult = result;
    renderResult(result);
    document.getElementById("resultPanel").style.display = "";
    progress.textContent = "";
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

  let okCount = 0;
  let failCount = 0;
  try {
    // 普通知识点（含所有扩展字段）
    const subjectTag = getSubject();
    for (const p of (aiResult.points || [])) {
      const cards = (p.cards || []).filter(c => c.question && c.answer).map(c => ({
        type: c.type, question: c.question, answer: c.answer,
      }));
      try {
        await API.createPoint({
          title: p.title,
          tag: subjectTag,
          size: p.size || "big",
          duplicate_of: p.duplicate_of || "",
          mechanism: p.mechanism || "",
          clinical: p.clinical || "",
          mnemonic: p.mnemonic || "",
          diagnosis: p.diagnosis || "",
          treatment: p.treatment || "",
          differential: p.differential || "",
          etiology: p.etiology || "",
          prevention: p.prevention || "",
          cards,
          nodes: p.nodes && p.nodes.length ? p.nodes : null,
        }, null);
        okCount++;
      } catch {
        failCount++;
      }
    }
    // 对照卡：每个对照维度做成一张问答卡，同时存结构化维度（供对比网络用）
    for (const c of (aiResult.comparisons || [])) {
      const dims = (c.dimensions || []).filter(d => d && d.dim);
      const cards = [];
      cards.push({
        type: "compare",
        question: `${c.a} 与 ${c.b} 的主要区别？`,
        answer: dims.map(d => `【${d.dim}】${d.value_a} vs ${d.value_b}`).join("；"),
      });
      try {
        await API.createPoint({
          title: `${c.a} vs ${c.b} 对比`,
          tag: subjectTag,
          size: "big",
          mechanism: "",
          clinical: "易混概念对照，重点辨析",
          mnemonic: "",
          // differential 仍存一份（兼容旧读取、复习页展示）
          differential: dims.map(d => `${d.dim}：${d.value_a} vs ${d.value_b}`).join("；"),
          // 结构化维度：供对比网络视图按维度渲染
          comparison: { a: c.a, b: c.b, dimensions: dims },
          cards,
        }, null);
        okCount++;
      } catch {
        failCount++;
      }
    }

    // 知识关联入库（用标题匹配知识点 id）
    if (aiResult.relations && aiResult.relations.length) {
      msg.textContent = "⏳ 入库关联...";
      const allPoints = await API.listPoints();
      const titleToId = {};
      allPoints.forEach(p => { titleToId[p.title] = p.id; });
      const relations = [];
      for (const r of aiResult.relations) {
        const fromId = titleToId[r.from] || titleToId[r.from_title];
        const toId = titleToId[r.to] || titleToId[r.to_title];
        if (fromId && toId && fromId !== toId) {
          relations.push({ from_id: fromId, to_id: toId, type: r.type || "related", note: r.note || "" });
        }
      }
      if (relations.length) {
        try { await API.createRelations(relations, null); } catch (e) { /* 忽略关联失败 */ }
      }
    }

    msg.textContent = `✅ 已入库 ${okCount} 个知识点${failCount ? `（${failCount} 个失败）` : ""}`;
    aiResult = null;
    document.getElementById("resultPanel").style.display = "none";
    document.getElementById("sourceText").value = "";
  } catch (e) {
    msg.textContent = "入库出错：" + e.message;
  } finally {
    btn.disabled = false;
  }
}
