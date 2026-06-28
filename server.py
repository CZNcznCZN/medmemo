"""HTTP 服务器：路由分发 + 静态文件服务。

路由：
  GET    /                    主页
  GET    /study.html          复习页
  GET    /import.html         AI 导入页
  GET    /network.html        知识网络页
  GET    /api/stats?tag=      统计（可选科目筛选）
  GET    /api/tags            科目列表（含每科统计）
  GET    /api/points?tag=     知识点列表（可选科目筛选）
  POST   /api/points          新增知识点 + 卡片
  PUT    /api/points/{id}     编辑知识点
  DELETE /api/points/{id}     删除知识点（级联删卡片和关联）
  GET    /api/cards           卡片列表
  GET    /api/cards/due?tag=  今日待复习（可选科目筛选 + 交错排序）
  POST   /api/cards/review/{id}  评分复习
  PUT    /api/cards/{id}      编辑卡片
  DELETE /api/cards/{id}      删除卡片
  GET    /api/relations?point_id=  获取知识点关联
  POST   /api/relations       批量创建关联
  DELETE /api/relations/{id}   删除关联
  GET    /api/relations/all   获取所有关联（网络可视化）
  POST   /api/ai/generate     AI 拆卡
  GET    /api/config          返回是否已配置 key
"""
import json
import os
import re
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import db
from db import (
    init_db, stats, list_points, get_point, create_point, update_point,
    delete_point, list_cards, get_due_cards, review_card, create_card,
    delete_card, update_card, seed_if_empty, export_all, import_backup, list_point_titles,
    get_tags, get_relations, create_relation, delete_relation,
    batch_create_relations, get_all_relations, list_points_with_due,
    get_root_nodes, get_children, batch_create_nodes, get_cards_by_point,
    backfill_root_nodes, backfill_comparisons,
    save_comparison, get_comparison, get_comparisons,
    create_custom_edge, get_custom_edges, delete_custom_edge,
    delete_node, update_node, create_node,
    delete_points_by_tag, retag_points,
    get_wrong_cards, get_review_stats,
    import_ai_result,
    write_backup_snapshot,
)
from ai import generate_cards, attach_small_points
from config import load_config, has_api_key
from paths import STATIC_DIR, SEED_PATH, SEED_MARKER

# 静态文件 MIME 映射
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def _get_param(parsed, key):
    """从 URL query string 取第一个参数值（无则 None）。"""
    qs = parse_qs(parsed.query)
    vals = qs.get(key)
    return vals[0] if vals else None


class Handler(BaseHTTPRequestHandler):
    # 静音默认日志，保留错误
    def log_message(self, fmt, *args):
        pass

    # ---------------- 通用响应工具 ----------------

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # API 响应禁缓存：否则改了 config.json 后 /api/config 仍返回旧值，
        # 导致"明明配了 key 却显示未配置"。所有 API 响应都应实时反映后端状态。
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, msg, status=400):
        self._send_json({"error": msg}, status)

    def _send_download(self, filename, body_bytes):
        """发送一个文件下载（attachment，浏览器自动保存）。"""
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body_bytes)))
        # attachment + 带时间戳的文件名，避免覆盖旧备份
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="{filename}"',
        )
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(body_bytes)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            raise ValueError("请求体不是合法 JSON。")

    def _serve_static(self, path):
        """安全地返回静态文件（防目录穿越）。"""
        rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR):
            self._send_error("非法路径", 403)
            return
        if not os.path.isfile(full):
            self._send_error("文件不存在", 404)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # 开发期禁缓存：确保浏览器总是加载最新文件（避免"加载中"卡在旧JS）
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    # ---------------- GET ----------------

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            # 静态页 / 资源
            if path in ("/", ""):
                return self._serve_static("index.html")
            if path in ("/study.html", "/import.html", "/network.html"):
                return self._serve_static(path.lstrip("/"))
            if path.startswith("/css/") or path.startswith("/js/") or path.startswith("/vendor/"):
                return self._serve_static(path)

            # API
            if path == "/api/stats":
                tag = _get_param(parsed, "tag")
                return self._send_json(stats(tag=tag))
            if path == "/api/tags":
                return self._send_json({"tags": get_tags()})
            if path == "/api/points":
                tag = _get_param(parsed, "tag")
                return self._send_json({"points": list_points(tag=tag)})
            if path == "/api/points/due":
                tag = _get_param(parsed, "tag")
                return self._send_json({"points": list_points_with_due(tag=tag)})
            if path == "/api/cards":
                return self._send_json({"cards": list_cards()})
            if path == "/api/cards/due":
                tag = _get_param(parsed, "tag")
                qs = parse_qs(parsed.query)
                pid_vals = qs.get("point_id", [])
                pids = [int(v) for v in pid_vals if v.isdigit()]
                # 新卡每日上限（0 = 不限）。仅在「按科目」无具体知识点筛选时生效——
                # 用户主动选了知识点复习时，说明要集中练，不应再截断新卡。
                cfg = load_config()
                new_card_limit = 0 if pids else int(cfg.get("new_cards_per_day", 0))
                if len(pids) > 1:
                    cards = get_due_cards(tag=tag, point_ids=pids)
                elif len(pids) == 1:
                    cards = get_due_cards(tag=tag, point_id=pids[0])
                else:
                    cards = get_due_cards(tag=tag, new_card_limit=new_card_limit)
                return self._send_json({"cards": cards})
            if path == "/api/cards/wrong":
                # 错题（至少答错过 1 次的卡），按错误次数降序，可按学科筛选
                tag = _get_param(parsed, "tag")
                return self._send_json({"cards": get_wrong_cards(tag=tag)})
            if path == "/api/stats/reviews":
                # 复习统计：总次数/各评分次数/正确率/错题数
                tag = _get_param(parsed, "tag")
                return self._send_json(get_review_stats(tag=tag))
            if path == "/api/relations/all":
                return self._send_json({"relations": get_all_relations()})
            if path == "/api/cards/by_point":
                # 知识网络详情：获取某知识点的所有卡片
                point_id = _get_param(parsed, "point_id")
                if not point_id:
                    return self._send_error("需要 point_id 参数")
                return self._send_json({"cards": get_cards_by_point(int(point_id))})
            if path == "/api/relations":
                point_id = _get_param(parsed, "point_id")
                if not point_id:
                    return self._send_error("需要 point_id 参数")
                return self._send_json({"relations": get_relations(int(point_id))})
            if path == "/api/nodes/roots":
                # 层级网络：初始只加载所有根节点（知识点本身）
                return self._send_json({"nodes": get_root_nodes()})
            if path == "/api/nodes/children":
                # 点击展开：加载某节点的子节点
                node_id = _get_param(parsed, "node_id")
                if not node_id:
                    return self._send_error("需要 node_id 参数")
                return self._send_json({"nodes": get_children(int(node_id))})
            if path == "/api/comparisons":
                # 对比网络：返回所有结构化对比知识点（可按 tag 筛选）
                tag = _get_param(parsed, "tag")
                return self._send_json({"comparisons": get_comparisons(tag=tag)})
            if path == "/api/comparisons/get":
                # 单个对比知识点的详细维度
                point_id = _get_param(parsed, "point_id")
                if not point_id:
                    return self._send_error("需要 point_id 参数")
                return self._send_json({"comparison": get_comparison(int(point_id))})
            if path == "/api/edges":
                # 用户自定义连线（编辑模式）
                return self._send_json({"edges": get_custom_edges()})
            if path == "/api/config":
                return self._send_json({"has_api_key": has_api_key()})
            if path == "/api/export":
                # 完整备份导出：所有知识点/卡片/关联/节点/复习历史
                data = export_all()
                # 文件名带日期，方便多次导出留存多个版本
                today = data["exported_at"][:10].replace("-", "")
                fname = f"medmemo-backup-{today}.json"
                body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
                return self._send_download(fname, body)

            return self._send_error("未知路径", 404)
        except Exception as e:
            return self._send_error(f"服务器错误: {e}", 500)

    # ---------------- POST ----------------

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            body = self._read_body()
            if path == "/api/points":
                return self._handle_create_point(body)
            if path == "/api/ai/generate":
                return self._handle_ai_generate(body)
            if path == "/api/ai/attach-small":
                return self._handle_attach_small(body)
            if path == "/api/import/batch":
                return self._handle_import_batch(body)
            if path == "/api/backup/import":
                return self._handle_backup_import(body)
            if path == "/api/relations":
                return self._handle_batch_relations(body)
            if path == "/api/nodes":
                # 新增节点（编辑模式）
                nid = self._handle_create_node(body)
                return self._send_json({"id": nid}, 201)
            if path == "/api/edges":
                # 新增自定义连线（编辑模式）
                eid = create_custom_edge(
                    int(body.get("from_node")),
                    int(body.get("to_node")),
                    body.get("label", ""),
                )
                return self._send_json({"id": eid}, 201)
            m = re.match(r"^/api/cards/review/(\d+)$", path)
            if m:
                result = review_card(int(m.group(1)), body.get("rating"))
                return self._send_json(result)
            return self._send_error("未知路径", 404)
        except (ValueError, RuntimeError) as e:
            return self._send_error(str(e), 400)
        except Exception as e:
            return self._send_error(f"服务器错误: {e}", 500)

    def _handle_create_point(self, body):
        """新增知识点 + 关联卡片 + 层级节点 + (可选)对比维度。

        body 中所有 _POINT_COLUMNS 字段透传给 create_point（它会自动建根节点）。
        特殊字段：cards / nodes / comparison。
        """
        title = (body.get("title") or "").strip()
        if not title:
            return self._send_error("title 不能为空")
        # 提取 cards / nodes / comparison（不属于知识点表）
        cards_data = body.pop("cards", [])
        nodes_data = body.pop("nodes", None)
        comparison = body.pop("comparison", None)
        pid = create_point(**body)
        card_ids = []
        for c in cards_data:
            if c.get("question") and c.get("answer"):
                cid = create_card(
                    point_id=pid,
                    card_type=c.get("type", "forward"),
                    question=c["question"],
                    answer=c["answer"],
                )
                card_ids.append(cid)
        # 层级子节点：create_point 已建好根节点，这里只挂子节点
        node_count = 0
        if nodes_data:
            # 拿到刚建的根节点 id 作为父节点
            node_count = batch_create_nodes(pid, [{"label": title, "detail": "", "children": nodes_data}])
        # 结构化对比维度（对比网络用）
        if comparison and isinstance(comparison, dict):
            save_comparison(
                pid,
                comparison.get("a", ""),
                comparison.get("b", ""),
                comparison.get("dimensions", []),
            )
        self._send_json({"id": pid, "card_ids": card_ids, "node_count": node_count}, 201)

    def _handle_create_node(self, body):
        """新增节点（编辑模式）。需要 point_id + label，可选 detail/parent_id。"""
        point_id = body.get("point_id")
        label = (body.get("label") or "").strip()
        if not point_id or not label:
            raise ValueError("需要 point_id 和 label")
        return create_node(
            point_id=int(point_id),
            label=label,
            parent_id=body.get("parent_id"),
            level=body.get("level", 1),
            detail=body.get("detail", ""),
            link_to_point=body.get("link_to_point"),
        )

    def _handle_ai_generate(self, body):
        """调用 AI 拆卡，返回结构化 JSON（不入库，由前端审核后入库）。

        传入现有知识点标题清单，让 AI 区分大小知识点并做去重判断。
        """
        text = body.get("text", "")
        subject = body.get("subject", "通用")
        existing_titles = list_point_titles()
        result = generate_cards(text, subject, existing_titles)
        self._send_json(result)

    def _handle_attach_small(self, body):
        """用 AI 把小知识点分配到同学科最相关的大知识点，存为 belongs_to 关联。

        网络图加载时，有 belongs_to 归属的小知识点会作为大知识点的子节点显示，
        不再作为独立根节点散落。可重复执行（只处理还没归属的小点）。
        """
        all_points = list_points()
        big_points = [{"id": p["id"], "title": p["title"], "tag": p["tag"]} for p in all_points if p.get("size") != "small"]
        small_points = [{"id": p["id"], "title": p["title"], "tag": p["tag"]} for p in all_points if p.get("size") == "small"]
        # 只处理还没有 belongs_to 归属的小点
        existing_relations = get_all_relations()
        already_attached = {r["to_id"] for r in existing_relations if r["type"] == "belongs_to"}
        small_points = [s for s in small_points if s["id"] not in already_attached]

        if not small_points:
            return self._send_json({"ok": True, "attached": 0, "message": "没有待关联的小知识点"})

        mappings = attach_small_points(big_points, small_points)
        relations = [{"from_id": m["big_id"], "to_id": m["small_id"], "type": "belongs_to", "note": "小知识点自动归属"} for m in mappings]
        if relations:
            batch_create_relations(relations)
        self._send_json({"ok": True, "attached": len(mappings), "unmatched": len(small_points) - len(mappings)})

    def _handle_import_batch(self, body):
        """批量入库 AI 拆卡结果。使用单个 SQLite transaction，失败则整体回滚。"""
        tag = body.get("tag", "")
        result = body.get("result") or {}
        stats = import_ai_result(
            result.get("points", []),
            result.get("comparisons", []),
            result.get("relations", []),
            tag=tag,
        )
        self._send_json({"ok": True, **stats}, 201)

    def _handle_backup_import(self, body):
        """从完整备份 JSON 恢复数据。当前数据会被备份内容替换。"""
        safety_backup = write_backup_snapshot("before-restore")
        stats = import_backup(body)
        self._send_json({"ok": True, "stats": stats, "safety_backup": safety_backup}, 201)

    def _handle_batch_relations(self, body):
        """批量创建知识点关联。"""
        relations = body.get("relations", [])
        if not relations:
            return self._send_error("relations 不能为空")
        batch_create_relations(relations)
        self._send_json({"ok": True, "count": len(relations)}, 201)

    # ---------------- PUT ----------------

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            body = self._read_body()
            m = re.match(r"^/api/points/(\d+)$", path)
            if m:
                update_point(int(m.group(1)), **body)
                return self._send_json({"ok": True})
            m = re.match(r"^/api/cards/(\d+)$", path)
            if m:
                update_card(int(m.group(1)), question=body.get("question"),
                            answer=body.get("answer"))
                return self._send_json({"ok": True})
            m = re.match(r"^/api/nodes/(\d+)$", path)
            if m:
                # 编辑节点（编辑模式）
                update_node(int(m.group(1)), label=body.get("label"),
                            detail=body.get("detail"))
                return self._send_json({"ok": True})
            if path == "/api/tags":
                # 合并学科：{from: "外科", to: "内科"}
                frm = (body.get("from") or "").strip()
                to = (body.get("to") or "").strip()
                if not frm or not to:
                    return self._send_error("需要 from 和 to 参数")
                if frm == to:
                    return self._send_error("源学科和目标学科不能相同")
                n = retag_points(frm, to)
                return self._send_json({"ok": True, "count": n})
            return self._send_error("未知路径", 404)
        except Exception as e:
            return self._send_error(f"服务器错误: {e}", 500)

    # ---------------- DELETE ----------------

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            m = re.match(r"^/api/points/(\d+)$", path)
            if m:
                delete_point(int(m.group(1)))
                return self._send_json({"ok": True})
            m = re.match(r"^/api/cards/(\d+)$", path)
            if m:
                delete_card(int(m.group(1)))
                return self._send_json({"ok": True})
            m = re.match(r"^/api/relations/(\d+)$", path)
            if m:
                delete_relation(int(m.group(1)))
                return self._send_json({"ok": True})
            m = re.match(r"^/api/nodes/(\d+)$", path)
            if m:
                # 删节点（编辑模式；根节点会被拒，抛 ValueError -> 400）
                delete_node(int(m.group(1)))
                return self._send_json({"ok": True})
            m = re.match(r"^/api/edges/(\d+)$", path)
            if m:
                # 删自定义连线（编辑模式）
                delete_custom_edge(int(m.group(1)))
                return self._send_json({"ok": True})
            if path == "/api/tags":
                # 清空学科：删除该 tag 下所有知识点（危险操作，前端需确认）
                tag = _get_param(parsed, "tag")
                if not tag:
                    return self._send_error("需要 tag 参数")
                n = delete_points_by_tag(tag)
                return self._send_json({"ok": True, "count": n})
            return self._send_error("未知路径", 404)
        except (ValueError, KeyError) as e:
            return self._send_error(str(e), 400)
        except Exception as e:
            return self._send_error(f"服务器错误: {e}", 500)
        except Exception as e:
            return self._send_error(f"服务器错误: {e}", 500)


def _open_browser(url, delay=1.0):
    """延迟打开浏览器（等服务器就绪）。跨平台。"""
    import threading
    def _open():
        import time
        time.sleep(delay)
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass
    threading.Thread(target=_open, daemon=True).start()


def _find_free_port(host, start_port):
    """端口被占用时，自动找下一个可用端口（最多试 20 个）。"""
    import socket
    for port in range(start_port, start_port + 20):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind((host, port))
                return port
        except OSError:
            continue
    return start_port  # 都试不通就用默认值，让服务器自己报错


def main():
    # 单实例锁：防止重复启动多个 exe（避免多进程操作同一数据库导致数据错乱）
    # 用一个独立端口（与服务器端口区分）作为锁，绑不上说明已有实例在运行
    _lock_socket = None
    try:
        _lock_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        _lock_socket.bind(("127.0.0.1", 17530))
        _lock_socket.listen(1)
    except OSError:
        # 已有实例在运行，直接打开浏览器到现有实例，然后退出
        try:
            import webbrowser
            cfg0 = load_config()
            webbrowser.open(f"http://{cfg0.get('host','localhost')}:{cfg0.get('port',8000)}")
        except Exception:
            pass
        return

    init_db()
    seed_if_empty(SEED_PATH, SEED_MARKER)
    # 回填：给历史数据里缺少根节点的小知识点/对比点补建，让它们在网络图可见
    backfill_root_nodes()
    # 回填：把旧版对比知识点的结构化维度从 differential 解析出来，让它们进对比网络
    backfill_comparisons()
    cfg = load_config()
    host = cfg.get("host", "localhost")
    port = _find_free_port(host, int(cfg.get("port", 8000)))
    try:
        server = ThreadingHTTPServer((host, port), Handler)
    except OSError as e:
        print(f"无法启动服务器: {e}")
        input("按回车退出...")
        return
    url = f"http://{host}:{port}"
    print(f"MedMemo: {url}")
    print(f"  DB: {db.DB_PATH}")
    print(f"  AI: {'ON (' + cfg.get('deepseek_model') + ')' if has_api_key() else 'OFF (edit config.json -> deepseek_api_key)'}")
    print("  Ctrl+C to stop")
    print("  Browser will open automatically...")
    # 自动开浏览器
    _open_browser(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()


if __name__ == "__main__":
    main()
