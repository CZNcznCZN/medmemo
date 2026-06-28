/* 复习页逻辑：模式选择(科目/知识点) → 提取练习 + 交错队列 + SM-2 评分 + 关联提示 */

let queue = [];
let currentIdx = 0;
let flipped = false;
let selectedTag = "";
let selectedMode = "subject";      // subject(按科目) / point(按知识点)
let selectedPointIds = [];         // 按知识点模式选中的知识点 id 数组（多选）
let lastReviewUndo = null;
let sessionStartedAt = null;
let sessionRated = 0;
let sessionCorrect = 0;
let sessionReviews = [];

const REL_TYPE_LABELS = {
  cause: "因果", compare: "对比", upstream: "上游", downstream: "下游", related: "相关"
};

document.addEventListener("DOMContentLoaded", () => {
  loadStudyTags();
  loadStudyPoints();
  bindStudyEvents();
});

/* ---------------- 模式切换 ---------------- */

function bindStudyEvents() {
  // 模式切换
  document.querySelectorAll(".mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedMode = btn.dataset.mode;
      document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      // subject/point/wrong 三模式：wrong 时两个面板都隐藏
      document.getElementById("subjectPanel").style.display = selectedMode === "subject" ? "" : "none";
      document.getElementById("pointPanel").style.display = selectedMode === "point" ? "" : "none";
      document.getElementById("wrongModeHint").style.display = selectedMode === "wrong" ? "" : "none";
      updateStartBtn();
    });
  });
  // 知识点模式的科目筛选
  document.getElementById("pointSubjectFilter").addEventListener("change", () => loadStudyPoints());
  // 开始复习
  document.getElementById("startStudyBtn").addEventListener("click", startStudy);
  document.getElementById("undoReviewBtn").addEventListener("click", undoLastReview);
}

/* ---------------- 按科目：加载科目按钮 ---------------- */

async function loadStudyTags() {
  const box = document.getElementById("studyTagButtons");
  try {
    const tags = await API.getTags();
    let html = `<button class="tag-btn tag-btn-lg active" data-tag="">全部科目（交错推荐）</button>`;
    (tags || []).forEach(t => {
      const label = t.tag || "未分类";
      const due = t.due || 0;
      html += `<button class="tag-btn tag-btn-lg" data-tag="${esc(t.tag)}">${esc(label)}${due ? ` <small>(${due}张待复习)</small>` : ''}</button>`;
    });
    box.innerHTML = html;
    box.querySelectorAll(".tag-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        selectedTag = btn.dataset.tag;
        box.querySelectorAll(".tag-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });
  } catch (e) {
    box.innerHTML = `<span class="muted" style="color:var(--danger);">加载科目失败：${esc(e.message)}</span>`;
  }
}

/* ---------------- 按知识点：加载知识点列表 ---------------- */

async function loadStudyPoints() {
  const list = document.getElementById("pointList");
  const filter = document.getElementById("pointSubjectFilter");
  try {
    // 第一次加载时填充科目筛选下拉框
    if (filter.options.length <= 1) {
      const tags = await API.getTags();
      tags.forEach(t => {
        const opt = document.createElement("option");
        opt.value = t.tag || "";
        opt.textContent = t.tag || "未分类";
        filter.appendChild(opt);
      });
    }
    const tag = filter.value;
    const points = await API.listPointsWithDue(tag);
    if (!points || points.length === 0) {
      list.innerHTML = `<span class="muted">${tag ? `「${esc(tag)}」下` : ''}暂无知识点</span>`;
      updateStartBtn();
      return;
    }
    selectedPointIds = [];
    list.innerHTML = points.map(p => {
      const due = p.due || 0;
      const total = p.total || 0;
      const dueText = due > 0 ? `<span class="ps-due">${due}待复习</span>` : `<span class="ps-done">无待复习</span>`;
      const disabled = due === 0;
      return `<label class="point-study-item ${disabled ? 'disabled' : ''}" data-id="${p.id}">
        <input type="checkbox" class="ps-check" value="${p.id}" ${disabled ? 'disabled' : ''}>
        <div class="ps-main">
          <span class="ps-title">${esc(p.title)}</span>
          <span class="ps-tag">${esc(p.tag)}</span>
          <span class="ps-count">${total}问</span>
          ${dueText}
        </div>
      </label>`;
    }).join("");
    // checkbox 变化 → 更新选中数组 + 按钮状态
    list.querySelectorAll(".ps-check").forEach(cb => {
      cb.addEventListener("change", () => {
        const id = parseInt(cb.value);
        if (cb.checked) {
          if (!selectedPointIds.includes(id)) selectedPointIds.push(id);
        } else {
          selectedPointIds = selectedPointIds.filter(x => x !== id);
        }
        updateStartBtn();
      });
    });
    updateStartBtn();
  } catch (e) {
    list.innerHTML = `<span class="muted" style="color:var(--danger);">加载失败：${esc(e.message)}</span>`;
  }
}

function updateStartBtn() {
  const btn = document.getElementById("startStudyBtn");
  if (selectedMode === "point") {
    const n = selectedPointIds.length;
    btn.textContent = n > 0 ? `开始复习（已选 ${n} 个知识点）` : "开始复习（请勾选知识点）";
    btn.disabled = n === 0;
  } else if (selectedMode === "wrong") {
    btn.textContent = "开始错题重练";
    btn.disabled = false;
  } else {
    btn.textContent = "开始复习";
    btn.disabled = false;
  }
}

function setEmptyStateText() {
  const empty = document.getElementById("emptyState");
  if (selectedMode === "wrong") {
    empty.querySelector("h2").textContent = "错题池清空啦！";
    empty.querySelector("p").textContent = "这些卡片已经连续答对毕业。以后如果再答错，会重新进入错题重练。";
  } else {
    empty.querySelector("h2").textContent = "今天的复习完成啦！";
    empty.querySelector("p").textContent = "没有到期的卡片了。理解 + 持久，慢慢来才记得牢。";
  }
}

/* ---------------- 开始复习 ---------------- */

async function startStudy() {
  if (selectedMode === "point" && selectedPointIds.length === 0) {
    alert("请至少勾选一个知识点");
    return;
  }
  document.getElementById("tagSelector").style.display = "none";
  document.getElementById("studyArea").style.display = "";
  hideReviewFeedback();
  await loadQueue();
  document.querySelectorAll(".rating-btn").forEach(btn => {
    btn.addEventListener("click", () => rate(btn.dataset.rating));
  });
  document.getElementById("flashcard").addEventListener("click", flip);
}

/* ---------------- 加载复习队列 ---------------- */

async function loadQueue() {
  try {
    if (selectedMode === "wrong") {
      // 错题重练：拉取当前仍在错题池里的卡片，按错误次数降序。
      // 连续答对 2 次会从错题池毕业；再次答错会重新进入。
      queue = await API.getWrongCards(selectedTag);
    } else {
      // 按知识点模式：只复习选中的多个知识点；按科目模式：按科目筛选
      const pids = selectedMode === "point" ? selectedPointIds : null;
      const tag = selectedMode === "point" ? null : selectedTag;
      queue = await API.getDue(tag, pids);
    }
    currentIdx = 0;
    sessionStartedAt = Date.now();
    sessionRated = 0;
    sessionCorrect = 0;
    sessionReviews = [];
    hideCompletionSummary();
    if (queue.length === 0) {
      document.getElementById("cardArea").style.display = "none";
      document.getElementById("emptyState").style.display = "";
      setEmptyStateText();
      document.getElementById("progressText").textContent = "0 / 0";
      document.getElementById("progressFill").style.width = "100%";
      updateSessionMetrics();
      return;
    }
    document.getElementById("cardArea").style.display = "";
    document.getElementById("emptyState").style.display = "none";
    showCard();
  } catch (e) {
    document.getElementById("cardArea").innerHTML =
      `<div class="muted" style="color:var(--danger);">加载失败：${esc(e.message)}<br>请确认服务器已启动</div>`;
  }
}

/* ---------------- 显示卡片 ---------------- */

function showCard() {
  const card = queue[currentIdx];
  flipped = false;
  const fc = document.getElementById("flashcard");
  fc.classList.remove("flipped");

  document.getElementById("cardQuestion").textContent = card.question;
  document.getElementById("cardAnswer").textContent = card.answer;

  // 理解辅助
  const ub = document.getElementById("understandBox");
  const uk = [];
  if (card.point_title)
    uk.push(`<div class="uk-line"><span class="uk-label">知识点：</span>${esc(card.point_title)}</div>`);
  if (card.mechanism)
    uk.push(`<div class="uk-line uk-mech"><span class="uk-label">机制：</span>${esc(card.mechanism)}</div>`);
  if (card.clinical)
    uk.push(`<div class="uk-line uk-clinical"><span class="uk-label">临床：</span>${esc(card.clinical)}</div>`);
  if (card.mnemonic)
    uk.push(`<div class="uk-line uk-mnemonic"><span class="uk-label">记忆画面：</span>${esc(card.mnemonic)}</div>`);
  ub.innerHTML = uk.join("");

  // 隐藏关联提示（翻面后再异步加载）
  document.getElementById("relationHint").style.display = "none";

  // 元信息
  const typeLabel = { forward: "正向", reverse: "反向", mechanism: "机制", apply: "应用", compare: "对比" }[card.type] || card.type;
  document.getElementById("cardMeta").innerHTML =
    `<span class="point-tag">${esc(card.point_tag || "通用")}</span> ` +
    `<span class="type-badge type-${card.type}">${typeLabel}问法</span>`;

  document.getElementById("ratingButtons").style.display = "none";
  updateProgress();
}

function showReviewFeedback(text, undoState = null) {
  lastReviewUndo = undoState;
  const box = document.getElementById("studyFeedback");
  const label = document.getElementById("studyFeedbackText");
  const undoBtn = document.getElementById("undoReviewBtn");
  label.textContent = text;
  undoBtn.style.display = undoState ? "" : "none";
  box.style.display = "";
}

function hideReviewFeedback() {
  lastReviewUndo = null;
  document.getElementById("studyFeedback").style.display = "none";
}

/* ---------------- 翻面（提取练习核心） ---------------- */

function flip() {
  if (flipped) return;
  flipped = true;
  document.getElementById("flashcard").classList.add("flipped");
  document.getElementById("ratingButtons").style.display = "grid";
  // 翻面时异步加载关联知识点（不阻塞评分）
  loadRelationHint();
}

async function loadRelationHint() {
  const card = queue[currentIdx];
  if (!card.point_id) return;
  try {
    const rels = await API.getRelations(card.point_id);
    if (!rels || rels.length === 0) return;
    const hint = document.getElementById("relationHint");
    const list = document.getElementById("relationHintList");
    // 最多显示 3 条，避免信息过载
    const shown = rels.slice(0, 3);
    list.innerHTML = shown.map(r => {
      const dir = r.direction === "outgoing" ? "→" : "←";
      const typeLabel = REL_TYPE_LABELS[r.type] || r.type;
      return `<div class="rel-hint-item">
        <span class="rel-hint-dir">${dir}</span>
        <span class="rel-hint-type">${typeLabel}</span>
        <span class="rel-hint-title">${esc(r.other_title)}</span>
        ${r.note ? `<span class="rel-hint-note">${esc(r.note)}</span>` : ""}
      </div>`;
    }).join("");
    hint.style.display = "";
  } catch (e) {
    /* 关联加载失败不影响复习，静默忽略 */
  }
}

function updateProgress() {
  const total = queue.length;
  const done = currentIdx;
  document.getElementById("progressText").textContent = `${done} / ${total}`;
  const pct = total === 0 ? 0 : (done / total) * 100;
  document.getElementById("progressFill").style.width = pct + "%";
  updateSessionMetrics();
}

function formatEta(msPerCard, remaining) {
  if (!Number.isFinite(msPerCard) || msPerCard <= 0 || remaining <= 0) return "-";
  const minutes = Math.ceil((msPerCard * remaining) / 60000);
  if (minutes <= 1) return "1 分钟内";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}小时${rest}分` : `${hours}小时`;
}

function updateSessionMetrics() {
  const metrics = document.getElementById("studyMetrics");
  if (!metrics) return;

  const total = queue.length;
  const done = Math.min(currentIdx, total);
  const remaining = Math.max(total - done, 0);
  const progress = total === 0 ? 0 : Math.round((done / total) * 100);
  const accuracy = sessionRated === 0 ? "-" : `${Math.round((sessionCorrect / sessionRated) * 100)}%`;
  const elapsed = sessionStartedAt ? Date.now() - sessionStartedAt : 0;
  const eta = remaining === 0 && total > 0
    ? "完成"
    : sessionRated === 0
      ? "-"
      : formatEta(elapsed / sessionRated, remaining);

  document.getElementById("metricRemaining").textContent = String(remaining);
  document.getElementById("metricProgress").textContent = `${progress}%`;
  document.getElementById("metricAccuracy").textContent = accuracy;
  document.getElementById("metricEta").textContent = eta;
  metrics.style.display = total > 0 ? "grid" : "none";
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "1 分钟内";
  const minutes = Math.ceil(ms / 60000);
  if (minutes <= 1) return "1 分钟内";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}小时${rest}分` : `${hours}小时`;
}

function isCorrectRating(rating) {
  return rating === "good" || rating === "easy";
}

function hideCompletionSummary() {
  const box = document.getElementById("completionSummary");
  if (!box) return;
  box.style.display = "none";
  box.innerHTML = "";
}

function buildWeakPointList() {
  const grouped = new Map();
  sessionReviews.forEach(item => {
    const key = item.point_id || item.point_title;
    if (!grouped.has(key)) {
      grouped.set(key, {
        title: item.point_title,
        tag: item.point_tag,
        total: 0,
        weak: 0,
      });
    }
    const row = grouped.get(key);
    row.total++;
    if (!isCorrectRating(item.rating)) row.weak++;
  });
  return Array.from(grouped.values())
    .filter(row => row.weak > 0)
    .sort((a, b) => b.weak - a.weak || b.total - a.total)
    .slice(0, 4);
}

function showCompletionSummary() {
  const box = document.getElementById("completionSummary");
  if (!box || sessionRated === 0) {
    hideCompletionSummary();
    return;
  }

  const accuracy = Math.round((sessionCorrect / sessionRated) * 100);
  const duration = formatDuration(Date.now() - sessionStartedAt);
  const weakPoints = buildWeakPointList();
  const missed = sessionReviews
    .filter(item => !isCorrectRating(item.rating))
    .slice(-5)
    .reverse();

  const weakHtml = weakPoints.length
    ? `<ul class="summary-list">${weakPoints.map(item => `
        <li><b>${esc(item.title)}</b>${item.tag ? ` · ${esc(item.tag)}` : ""}：${item.weak}/${item.total} 题需要回看</li>
      `).join("")}</ul>`
    : `<div class="summary-empty">这轮没有明显薄弱知识点，保持节奏。</div>`;

  const missedHtml = missed.length
    ? `<ul class="summary-list">${missed.map(item => `
        <li><b>${ratingLabel(item.rating)}</b> · ${esc(item.point_title)}：${esc(item.question)}</li>
      `).join("")}</ul>`
    : `<div class="summary-empty">本轮没有错题，可以直接收工。</div>`;

  box.innerHTML = `
    <div class="summary-grid">
      <div class="summary-stat"><strong>${sessionRated}</strong><span>本轮题数</span></div>
      <div class="summary-stat"><strong>${accuracy}%</strong><span>正确率</span></div>
      <div class="summary-stat"><strong>${duration}</strong><span>用时</span></div>
    </div>
    <div class="summary-section">
      <h3>优先回看</h3>
      ${weakHtml}
    </div>
    <div class="summary-section">
      <h3>本轮错题</h3>
      ${missedHtml}
    </div>
  `;
  box.style.display = "";
}

/* ---------------- 键盘快捷键 ---------------- */

document.addEventListener("keydown", (e) => {
  // 科目选择界面不响应键盘
  if (document.getElementById("tagSelector").style.display !== "none") return;
  if (queue.length === 0 || currentIdx >= queue.length) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!flipped) flip();
  } else if (flipped) {
    const map = { "1": "again", "2": "hard", "3": "good", "4": "easy" };
    if (map[e.key]) rate(map[e.key]);
  }
});

/* ---------------- 评分 ---------------- */

async function rate(rating) {
  const card = queue[currentIdx];
  const before = {
    queue: queue.map(item => ({ ...item })),
    currentIdx,
    sessionStartedAt,
    sessionRated,
    sessionCorrect,
    sessionReviews: sessionReviews.map(item => ({ ...item })),
  };
  try {
    const review = await API.reviewCard(card.id, rating);
    sessionRated++;
    if (rating === "good" || rating === "easy") sessionCorrect++;
    sessionReviews.push({
      card_id: card.id,
      point_id: card.point_id,
      point_title: card.point_title || "未命名知识点",
      point_tag: card.point_tag || "",
      question: card.question || "",
      rating,
    });
    if (selectedMode === "wrong" && (rating === "again" || rating === "hard")) {
      queue.push({
        ...card,
        wrong_count: (card.wrong_count || 0) + 1,
        correct_streak: 0,
      });
    } else if (selectedMode === "wrong" && (rating === "good" || rating === "easy")) {
      const nextStreak = (card.correct_streak || 0) + 1;
      if (nextStreak < 2) {
        queue.push({ ...card, correct_streak: nextStreak });
      }
    }
    currentIdx++;
    showReviewFeedback(`已记录「${ratingLabel(rating)}」`, {
      reviewId: review.review_id,
      ...before,
    });
    if (currentIdx >= queue.length) {
      document.getElementById("cardArea").style.display = "none";
      document.getElementById("emptyState").style.display = "";
      setEmptyStateText();
      document.getElementById("progressText").textContent = `${queue.length} / ${queue.length}`;
      document.getElementById("progressFill").style.width = "100%";
      updateSessionMetrics();
      showCompletionSummary();
    } else {
      showCard();
    }
  } catch (e) {
    alert("评分失败：" + e.message);
  }
}

function ratingLabel(rating) {
  return { again: "重记", hard: "困难", good: "良好", easy: "简单" }[rating] || rating;
}

async function undoLastReview() {
  if (!lastReviewUndo) return;
  const undo = lastReviewUndo;
  try {
    await API.undoReview(undo.reviewId);
    queue = undo.queue;
    currentIdx = undo.currentIdx;
    sessionStartedAt = undo.sessionStartedAt;
    sessionRated = undo.sessionRated;
    sessionCorrect = undo.sessionCorrect;
    sessionReviews = undo.sessionReviews || [];
    document.getElementById("emptyState").style.display = "none";
    document.getElementById("cardArea").style.display = "";
    hideCompletionSummary();
    showCard();
    showReviewFeedback("已撤销上次评分", null);
  } catch (e) {
    alert("撤销失败：" + e.message);
  }
}
