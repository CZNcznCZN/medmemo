/* MedMemo 前端 API 封装 —— 统一调用后端接口 */

const API = {
  // 默认超时 8 秒（普通 API）；慢请求（如 AI 拆卡）可传更长的 timeout
  async _req(method, path, body, timeout = 8000) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    // 超时保护：避免页面永久卡在"加载中"
    const hasTimeout = timeout != null && timeout > 0;
    const ctrl = hasTimeout ? new AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    const timer = hasTimeout ? setTimeout(() => ctrl.abort(), timeout) : null;
    let resp;
    try {
      resp = await fetch(path, opts);
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e.name === "AbortError") {
        // 区分：是连不上服务器，还是请求处理太久被超时中断
        throw new Error(
          timeout > 8000
            ? "请求超时（AI 处理较慢，稍后重试，或缩短文本）"
            : "请求超时，请确认服务器已启动（python server.py）"
        );
      }
      throw new Error("无法连接服务器，请确认已启动（python server.py）");
    }
    if (timer) clearTimeout(timer);
    let data;
    try { data = await resp.json(); } catch { data = {}; }
    if (!resp.ok) {
      throw new Error(data.error || `请求失败 (${resp.status})`);
    }
    return data;
  },

  getStats: (tag) => API._req("GET", `/api/stats${tag ? "?tag=" + encodeURIComponent(tag) : ""}`),
  getTags: () => API._req("GET", "/api/tags").then(r => r.tags),
  listPoints: (tag) => API._req("GET", `/api/points${tag ? "?tag=" + encodeURIComponent(tag) : ""}`).then(r => r.points),
  listPointsWithDue: (tag) => API._req("GET", `/api/points/due${tag ? "?tag=" + encodeURIComponent(tag) : ""}`).then(r => r.points),
  getPoint: (id) => API._req("GET", `/api/points/${id}`),
  createPoint: (data, timeout) => API._req("POST", "/api/points", data, timeout),
  updatePoint: (id, data) => API._req("PUT", `/api/points/${id}`, data),
  deletePoint: (id) => API._req("DELETE", `/api/points/${id}`),

  listCards: () => API._req("GET", "/api/cards").then(r => r.cards),
  createCard: (data) => API._req("POST", "/api/cards", data),
  getDue: (tag, pointIds) => {
    const params = [];
    if (tag) params.push("tag=" + encodeURIComponent(tag));
    if (Array.isArray(pointIds)) {
      pointIds.forEach(id => params.push("point_id=" + encodeURIComponent(id)));
    } else if (pointIds) {
      params.push("point_id=" + encodeURIComponent(pointIds));
    }
    return API._req("GET", `/api/cards/due${params.length ? "?" + params.join("&") : ""}`).then(r => r.cards);
  },
  reviewCard: (id, rating) => API._req("POST", `/api/cards/review/${id}`, { rating }),
  undoReview: (reviewId) => API._req("POST", `/api/reviews/${reviewId}/undo`, {}),
  deleteCard: (id) => API._req("DELETE", `/api/cards/${id}`),
  updateCard: (id, data) => API._req("PUT", `/api/cards/${id}`, data),
  getWrongCards: (tag) => API._req("GET", `/api/cards/wrong${tag ? "?tag=" + encodeURIComponent(tag) : ""}`).then(r => r.cards),
  getReviewStats: (tag) => API._req("GET", `/api/stats/reviews${tag ? "?tag=" + encodeURIComponent(tag) : ""}`),

  getCardsByPoint: (pointId) => API._req("GET", `/api/cards/by_point?point_id=${pointId}`).then(r => r.cards),
  getRelations: (pointId) => API._req("GET", `/api/relations?point_id=${pointId}`).then(r => r.relations),
  getAllRelations: () => API._req("GET", "/api/relations/all").then(r => r.relations),
  createRelations: (relations, timeout) => API._req("POST", "/api/relations", { relations }, timeout),
  deleteRelation: (id) => API._req("DELETE", `/api/relations/${id}`),

  // AI 拆卡是慢请求；传 null 表示不设置浏览器端超时。
  aiGenerate: (text, subject) => API._req("POST", "/api/ai/generate", { text, subject }, null),
  // AI 关联小知识点到同学科大知识点（慢请求）
  attachSmall: () => API._req("POST", "/api/ai/attach-small", {}, null),
  importBatch: (result, tag) => API._req("POST", "/api/import/batch", { result, tag }, null),
  getConfig: () => API._req("GET", "/api/config"),

  // 对比维度（对比网络视图）
  getComparisons: (tag) => API._req("GET", `/api/comparisons${tag ? "?tag=" + encodeURIComponent(tag) : ""}`).then(r => r.comparisons),
  getComparison: (pointId) => API._req("GET", `/api/comparisons/get?point_id=${pointId}`).then(r => r.comparison),

  // 节点 CRUD（编辑模式）
  createNode: (data) => API._req("POST", "/api/nodes", data).then(r => r.id),
  updateNode: (id, data) => API._req("PUT", `/api/nodes/${id}`, data),
  deleteNode: (id) => API._req("DELETE", `/api/nodes/${id}`),

  // 自定义连线 CRUD（编辑模式）
  getCustomEdges: () => API._req("GET", "/api/edges").then(r => r.edges),
  createCustomEdge: (data) => API._req("POST", "/api/edges", data).then(r => r.id),
  deleteCustomEdge: (id) => API._req("DELETE", `/api/edges/${id}`),

  // 学科管理
  clearTag: (tag) => API._req("DELETE", `/api/tags?tag=${encodeURIComponent(tag)}`),
  mergeTag: (from, to) => API._req("PUT", "/api/tags", { from, to }),
  importBackup: (backup) => API._req("POST", "/api/backup/import", backup, null),
};

/* 卡片类型中文映射 */
const TYPE_LABELS = {
  forward: "正向",
  reverse: "反向",
  mechanism: "机制",
  apply: "应用",
  compare: "对比",
};

/* 简易 HTML 转义，防注入 */
function esc(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
