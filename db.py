"""SQLite 数据访问层。

三张表：
- knowledge_points：知识点父节点，装"理解层"信息
- cards：卡片子节点，每种问法一张，各自独立 SM-2 调度
- knowledge_relations：知识点之间的关联（因果/对比/上下游/相关）

连接管理：每函数内部独立 open/close 连接。
"""
import os
import sqlite3
import json
from contextlib import contextmanager
from datetime import datetime, date, timedelta

from sm2 import review, RATING_TO_QUALITY
from paths import DB_PATH, USER_DATA_DIR


@contextmanager
def _conn():
    """连接上下文管理器：自动开启外键，用完自动关闭。"""
    c = sqlite3.connect(DB_PATH, timeout=30)
    try:
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        yield c
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _today():
    return date.today().isoformat()


def _write_marker(marker_path):
    """写入初始化标记文件（记录已导入过种子数据）。"""
    try:
        import datetime as _dt
        with open(marker_path, "w", encoding="utf-8") as f:
            f.write(_dt.datetime.now().isoformat())
    except OSError:
        pass  # 写不进去也无妨，最坏情况是下次再判断数据库是否为空


# ============ 所有可扩展字段（统一维护） ============
# knowledge_points 表的列名集合，用于 insert/update 白名单
_POINT_COLUMNS = {
    "title", "tag", "source_text",
    "mechanism", "clinical", "mnemonic",
    # 扩展的医学可选字段
    "diagnosis",      # 诊断要点
    "treatment",      # 治疗方式
    "differential",    # 鉴别诊断
    "etiology",        # 病因
    "prevention",      # 预防
    # 知识点体量：big（大知识点，4 卡 + 机制/临床/记忆画面 + 层级节点）
    # / small（一句话小事实，仅 1 张卡）。缺省 big。
    "size",
}


def init_db():
    """建表（如不存在）。支持增量迁移（新增列不会丢旧数据）。"""
    with _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS knowledge_points (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                tag TEXT DEFAULT '',
                source_text TEXT DEFAULT '',
                mechanism TEXT DEFAULT '',
                clinical TEXT DEFAULT '',
                mnemonic TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS cards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                point_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                compare_with INTEGER,
                easiness REAL DEFAULT 2.5,
                interval INTEGER DEFAULT 0,
                repetition INTEGER DEFAULT 0,
                due_date TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(point_id) REFERENCES knowledge_points(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS knowledge_relations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_id INTEGER NOT NULL,
                to_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                note TEXT DEFAULT '',
                FOREIGN KEY(from_id) REFERENCES knowledge_points(id) ON DELETE CASCADE,
                FOREIGN KEY(to_id) REFERENCES knowledge_points(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS knowledge_nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                point_id INTEGER NOT NULL,
                parent_id INTEGER,
                level INTEGER DEFAULT 0,
                label TEXT NOT NULL,
                detail TEXT DEFAULT '',
                FOREIGN KEY(point_id) REFERENCES knowledge_points(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id INTEGER NOT NULL,
                rating TEXT NOT NULL,
                quality INTEGER,
                reviewed_at TEXT NOT NULL,
                FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS comparison_dims (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                point_id INTEGER NOT NULL,
                concept_a TEXT NOT NULL,
                concept_b TEXT NOT NULL,
                dim TEXT NOT NULL,
                value_a TEXT DEFAULT '',
                value_b TEXT DEFAULT '',
                FOREIGN KEY(point_id) REFERENCES knowledge_points(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS custom_edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_node INTEGER NOT NULL,
                to_node INTEGER NOT NULL,
                label TEXT DEFAULT '',
                FOREIGN KEY(from_node) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
                FOREIGN KEY(to_node) REFERENCES knowledge_nodes(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS wrong_card_state (
                card_id INTEGER PRIMARY KEY,
                wrong_count INTEGER DEFAULT 0,
                correct_streak INTEGER DEFAULT 0,
                active INTEGER DEFAULT 0,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS review_snapshots (
                review_id INTEGER PRIMARY KEY,
                card_id INTEGER NOT NULL,
                prev_easiness REAL NOT NULL,
                prev_interval INTEGER NOT NULL,
                prev_repetition INTEGER NOT NULL,
                prev_due_date TEXT NOT NULL,
                prev_wrong_exists INTEGER DEFAULT 0,
                prev_wrong_count INTEGER DEFAULT 0,
                prev_correct_streak INTEGER DEFAULT 0,
                prev_wrong_active INTEGER DEFAULT 0,
                prev_wrong_updated_at TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY(review_id) REFERENCES reviews(id) ON DELETE CASCADE,
                FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due_date);
            CREATE INDEX IF NOT EXISTS idx_cards_point ON cards(point_id);
            CREATE INDEX IF NOT EXISTS idx_relations_from ON knowledge_relations(from_id);
            CREATE INDEX IF NOT EXISTS idx_relations_to ON knowledge_relations(to_id);
            CREATE INDEX IF NOT EXISTS idx_nodes_parent ON knowledge_nodes(parent_id);
            CREATE INDEX IF NOT EXISTS idx_nodes_point ON knowledge_nodes(point_id);
            CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews(card_id);
            CREATE INDEX IF NOT EXISTS idx_reviews_time ON reviews(reviewed_at);
            CREATE INDEX IF NOT EXISTS idx_cmpdims_point ON comparison_dims(point_id);
            CREATE INDEX IF NOT EXISTS idx_customedges_from ON custom_edges(from_node);
            CREATE INDEX IF NOT EXISTS idx_customedges_to ON custom_edges(to_node);
            CREATE INDEX IF NOT EXISTS idx_wrong_state_active ON wrong_card_state(active);
            CREATE INDEX IF NOT EXISTS idx_review_snapshots_card ON review_snapshots(card_id);
            """
        )
        # 增量迁移：为旧数据库新增扩展列（幂等，列已存在则跳过）
        existing = {row["name"] for row in c.execute("PRAGMA table_info(knowledge_points)")}
        for col in ("diagnosis", "treatment", "differential", "etiology", "prevention"):
            if col not in existing:
                c.execute(f"ALTER TABLE knowledge_points ADD COLUMN {col} TEXT DEFAULT ''")
        # size 列：知识点体量（big/small），旧库默认 big（兼容）
        if "size" not in existing:
            c.execute("ALTER TABLE knowledge_points ADD COLUMN size TEXT DEFAULT 'big'")
        # knowledge_nodes 加 link_to_point 字段（子节点指向另一个知识点的关联）
        existing_nodes = {row["name"] for row in c.execute("PRAGMA table_info(knowledge_nodes)")}
        if "link_to_point" not in existing_nodes:
            c.execute("ALTER TABLE knowledge_nodes ADD COLUMN link_to_point INTEGER")


def backfill_root_nodes():
    """一次性回填：给所有缺少 level=0 根节点的知识点补建根节点。

    历史数据里，小知识点和对比点导入时没有创建 knowledge_nodes 根节点，
    导致它们在知识网络里不可见。本函数在 init_db 后调用一次，补齐。
    幂等：已有根节点的知识点不重复创建。
    """
    with _conn() as c:
        # 找出所有没有 level=0 根节点的知识点
        missing = c.execute(
            """SELECT k.id AS pid, k.title AS title FROM knowledge_points k
               WHERE NOT EXISTS (
                   SELECT 1 FROM knowledge_nodes n
                   WHERE n.point_id = k.id AND n.level = 0
               )"""
        ).fetchall()
        for row in missing:
            c.execute(
                """INSERT INTO knowledge_nodes (point_id, parent_id, level, label, detail)
                   VALUES (?, NULL, 0, ?, '')""",
                (row["pid"], row["title"]),
            )
    return len(missing)


# -------------------- 科目（标签）--------------------

def get_tags():
    """获取所有科目及其统计（总卡片数、今日待复习数）。

    返回 [{"tag": "药理", "count": 8, "due": 5}, ...]
    """
    with _conn() as c:
        rows = c.execute(
            """SELECT k.tag AS tag,
                      COUNT(c.id) AS count,
                      SUM(CASE WHEN c.due_date <= ? THEN 1 ELSE 0 END) AS due
               FROM knowledge_points k
               LEFT JOIN cards c ON c.point_id = k.id
               GROUP BY k.tag
               ORDER BY count DESC""",
            (_today(),),
        ).fetchall()
    return [dict(r) for r in rows]


# -------------------- 知识点（父节点）--------------------

def create_point(**fields):
    """新增一个知识点，返回 id。

    接受所有 _POINT_COLUMNS 中的字段，其余忽略。
    自动创建一个 level=0 根节点（用知识点标题），保证该知识点在知识网络可见。
    """
    cols = []
    vals = []
    for k in _POINT_COLUMNS:
        if k in fields:
            cols.append(k)
            vals.append(fields[k])
    if "title" not in cols:
        raise ValueError("title 不能为空")
    if "created_at" not in cols:
        cols.append("created_at")
        vals.append(_now())
    placeholders = ", ".join(["?"] * len(cols))
    col_names = ", ".join(cols)
    with _conn() as c:
        cur = c.execute(
            f"INSERT INTO knowledge_points ({col_names}) VALUES ({placeholders})",
            vals,
        )
        pid = cur.lastrowid
        # 自动建根节点（保证小知识点/对比点也能在网络图显示）
        c.execute(
            """INSERT INTO knowledge_nodes (point_id, parent_id, level, label, detail)
               VALUES (?, NULL, 0, ?, '')""",
            (pid, fields["title"]),
        )
        return pid


def import_ai_result(points_data, comparisons_data=None, relations_data=None, tag=""):
    """Atomically import an AI result.

    Returns {"point_count", "card_count", "node_count", "relation_count"}.
    Any exception rolls the whole import back through the surrounding _conn().
    """
    comparisons_data = comparisons_data or []
    relations_data = relations_data or []
    title_to_pid = {}
    stats = {"point_count": 0, "card_count": 0, "node_count": 0, "relation_count": 0}

    def _insert_point(c, fields):
        cols = []
        vals = []
        for k in _POINT_COLUMNS:
            if k in fields:
                cols.append(k)
                vals.append(fields[k])
        if "title" not in cols or not str(fields.get("title", "")).strip():
            raise ValueError("title 不能为空")
        if "created_at" not in cols:
            cols.append("created_at")
            vals.append(_now())
        placeholders = ", ".join(["?"] * len(cols))
        col_names = ", ".join(cols)
        cur = c.execute(
            f"INSERT INTO knowledge_points ({col_names}) VALUES ({placeholders})",
            vals,
        )
        pid = cur.lastrowid
        c.execute(
            """INSERT INTO knowledge_nodes (point_id, parent_id, level, label, detail)
               VALUES (?, NULL, 0, ?, '')""",
            (pid, fields["title"]),
        )
        return pid

    def _insert_card(c, point_id, card):
        question = (card.get("question") or "").strip()
        answer = (card.get("answer") or "").strip()
        if not question or not answer:
            return None
        cur = c.execute(
            """INSERT INTO cards
               (point_id, type, question, answer, compare_with,
                easiness, interval, repetition, due_date, created_at)
               VALUES (?, ?, ?, ?, NULL, 2.5, 0, 0, ?, ?)""",
            (point_id, card.get("type", "forward"), question, answer, _today(), _now()),
        )
        stats["card_count"] += 1
        return cur.lastrowid

    def _resolve_link_to(link_to, current_pid):
        if not link_to:
            return None
        if link_to in title_to_pid and title_to_pid[link_to] != current_pid:
            return title_to_pid[link_to]
        for title, pid in title_to_pid.items():
            if pid == current_pid:
                continue
            if link_to in title or title in link_to:
                return pid
        return None

    def _insert_node_tree(c, point_id, parent_id, level, item):
        label = (item.get("label") or "").strip()
        if not label:
            return
        link_pid = _resolve_link_to(item.get("link_to"), point_id)
        cur = c.execute(
            """INSERT INTO knowledge_nodes (point_id, parent_id, level, label, detail, link_to_point)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (point_id, parent_id, level, label, item.get("detail", ""), link_pid),
        )
        stats["node_count"] += 1
        nid = cur.lastrowid
        for child in item.get("children", []) or []:
            _insert_node_tree(c, point_id, nid, level + 1, child)

    def _insert_nodes(c, point_id, title, nodes):
        if not nodes:
            return
        root = c.execute(
            "SELECT id FROM knowledge_nodes WHERE point_id=? AND parent_id IS NULL ORDER BY id LIMIT 1",
            (point_id,),
        ).fetchone()
        parent_id = root["id"] if root else None
        for item in nodes:
            _insert_node_tree(c, point_id, parent_id, 1, item)

    def _insert_comparison(c, point_id, comparison):
        if not comparison:
            return
        c.execute("DELETE FROM comparison_dims WHERE point_id = ?", (point_id,))
        for d in comparison.get("dimensions", []) or []:
            dim = (d.get("dim") or "").strip()
            if not dim:
                continue
            c.execute(
                """INSERT INTO comparison_dims
                   (point_id, concept_a, concept_b, dim, value_a, value_b)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    point_id,
                    comparison.get("a", ""),
                    comparison.get("b", ""),
                    dim,
                    d.get("value_a", ""),
                    d.get("value_b", ""),
                ),
            )

    with _conn() as c:
        pending_nodes = []
        for row in c.execute("SELECT id, title FROM knowledge_points").fetchall():
            title_to_pid[row["title"]] = row["id"]

        for p in points_data or []:
            fields = {
                "title": (p.get("title") or "").strip(),
                "tag": tag,
                "size": p.get("size") or "big",
                "mechanism": p.get("mechanism", ""),
                "clinical": p.get("clinical", ""),
                "mnemonic": p.get("mnemonic", ""),
                "diagnosis": p.get("diagnosis", ""),
                "treatment": p.get("treatment", ""),
                "differential": p.get("differential", ""),
                "etiology": p.get("etiology", ""),
                "prevention": p.get("prevention", ""),
            }
            pid = _insert_point(c, fields)
            title_to_pid[fields["title"]] = pid
            stats["point_count"] += 1
            for card in p.get("cards", []) or []:
                _insert_card(c, pid, card)
            pending_nodes.append((pid, fields["title"], p.get("nodes") or []))

        for cmp in comparisons_data:
            dims = [d for d in (cmp.get("dimensions") or []) if d and d.get("dim")]
            a = cmp.get("a", "")
            b = cmp.get("b", "")
            cards = [{
                "type": "compare",
                "question": f"{a} 与 {b} 的主要区别？",
                "answer": "；".join([f"【{d.get('dim', '')}】{d.get('value_a', '')} vs {d.get('value_b', '')}" for d in dims]),
            }]
            fields = {
                "title": f"{a} vs {b} 对比",
                "tag": tag,
                "size": "big",
                "mechanism": "",
                "clinical": "易混概念对照，重点辨析",
                "mnemonic": "",
                "differential": "；".join([f"{d.get('dim', '')}：{d.get('value_a', '')} vs {d.get('value_b', '')}" for d in dims]),
            }
            pid = _insert_point(c, fields)
            title_to_pid[fields["title"]] = pid
            stats["point_count"] += 1
            for card in cards:
                _insert_card(c, pid, card)
            _insert_comparison(c, pid, {"a": a, "b": b, "dimensions": dims})

        for pid, title, nodes in pending_nodes:
            _insert_nodes(c, pid, title, nodes)

        for r in relations_data:
            from_id = title_to_pid.get(r.get("from")) or title_to_pid.get(r.get("from_title"))
            to_id = title_to_pid.get(r.get("to")) or title_to_pid.get(r.get("to_title"))
            if not from_id or not to_id or from_id == to_id:
                continue
            cur = c.execute(
                "INSERT OR IGNORE INTO knowledge_relations (from_id, to_id, type, note) VALUES (?,?,?,?)",
                (from_id, to_id, r.get("type", "related"), r.get("note", "")),
            )
            stats["relation_count"] += cur.rowcount

    return stats


def get_point(point_id):
    with _conn() as c:
        row = c.execute(
            "SELECT * FROM knowledge_points WHERE id = ?", (point_id,)
        ).fetchone()
        return dict(row) if row else None


def list_points(tag=None):
    """列出所有知识点，可按科目筛选。"""
    with _conn() as c:
        _backfill_wrong_state(c)
        if tag:
            rows = c.execute(
                "SELECT * FROM knowledge_points WHERE tag = ? ORDER BY id DESC",
                (tag,),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT * FROM knowledge_points ORDER BY id DESC"
            ).fetchall()
        return [dict(r) for r in rows]


def update_point(point_id, **fields):
    """更新知识点字段。只允许更新 _POINT_COLUMNS 中的字段。"""
    sets, vals = [], []
    for k in fields:
        if k in _POINT_COLUMNS:
            sets.append(f"{k} = ?")
            vals.append(fields[k])
    if not sets:
        return False
    vals.append(point_id)
    with _conn() as c:
        c.execute(
            f"UPDATE knowledge_points SET {', '.join(sets)} WHERE id = ?", vals
        )
    return True


def update_point_with_cards(point_id, fields, cards):
    """原子更新知识点和它的卡片列表。"""
    title = (fields.get("title") or "").strip()
    if not title:
        raise ValueError("title 不能为空")
    valid_cards = []
    for card in cards or []:
        question = (card.get("question") or "").strip()
        answer = (card.get("answer") or "").strip()
        if not question or not answer:
            raise ValueError("卡片问题和答案不能为空")
        valid_cards.append({
            "id": card.get("id"),
            "type": card.get("type", "forward"),
            "question": question,
            "answer": answer,
        })
    if not valid_cards:
        raise ValueError("至少需要一张卡片")

    sets, vals = [], []
    for k in fields:
        if k in _POINT_COLUMNS:
            sets.append(f"{k} = ?")
            vals.append(fields[k])
    if not sets:
        raise ValueError("没有可更新的知识点字段")

    with _conn() as c:
        exists = c.execute("SELECT id FROM knowledge_points WHERE id = ?", (point_id,)).fetchone()
        if not exists:
            raise KeyError(f"知识点不存在: {point_id}")

        vals.append(point_id)
        c.execute(f"UPDATE knowledge_points SET {', '.join(sets)} WHERE id = ?", vals)

        existing_ids = {
            row["id"] for row in c.execute("SELECT id FROM cards WHERE point_id = ?", (point_id,)).fetchall()
        }
        incoming_existing_ids = {
            int(card["id"]) for card in valid_cards if card.get("id") and int(card["id"]) in existing_ids
        }
        for card_id in existing_ids - incoming_existing_ids:
            c.execute("DELETE FROM cards WHERE id = ? AND point_id = ?", (card_id, point_id))

        created = 0
        updated = 0
        for card in valid_cards:
            card_id = card.get("id")
            if card_id and int(card_id) in existing_ids:
                c.execute(
                    "UPDATE cards SET type = ?, question = ?, answer = ? WHERE id = ? AND point_id = ?",
                    (card["type"], card["question"], card["answer"], int(card_id), point_id),
                )
                updated += 1
            else:
                c.execute(
                    """INSERT INTO cards
                       (point_id, type, question, answer, compare_with,
                        easiness, interval, repetition, due_date, created_at)
                       VALUES (?, ?, ?, ?, NULL, 2.5, 0, 0, ?, ?)""",
                    (point_id, card["type"], card["question"], card["answer"], _today(), _now()),
                )
                created += 1
    return {"updated": updated, "created": created, "deleted": len(existing_ids - incoming_existing_ids)}


def list_point_titles():
    """返回现有所有知识点 [{id, title, tag, size}]，供 AI 拆卡时去重参考。

    只取轻量字段（不拉机制/临床等长文本），标题清单会注入 AI prompt。
    """
    with _conn() as c:
        rows = c.execute(
            "SELECT id, title, tag, size FROM knowledge_points ORDER BY id"
        ).fetchall()
    return [dict(r) for r in rows]


def delete_point(point_id):
    """删除知识点，级联删卡片和关联。"""
    with _conn() as c:
        c.execute("DELETE FROM knowledge_points WHERE id = ?", (point_id,))


# -------------------- 知识关联（串联）--------------------

def create_relation(from_id, to_id, rel_type, note=""):
    """创建两个知识点之间的关联。

    rel_type: cause(因果) / compare(对比) / upstream(上游基础) / downstream(下游延伸) / related(相关)
    自动去重（同一对 + 同一类型不重复创建）。
    """
    with _conn() as c:
        exists = c.execute(
            "SELECT id FROM knowledge_relations WHERE from_id=? AND to_id=? AND type=?",
            (from_id, to_id, rel_type),
        ).fetchone()
        if exists:
            return exists["id"]
        cur = c.execute(
            "INSERT INTO knowledge_relations (from_id, to_id, type, note) VALUES (?,?,?,?)",
            (from_id, to_id, rel_type, note),
        )
        return cur.lastrowid


def get_relations(point_id):
    """获取一个知识点所有关联（双向查询：A→B 和 B→A）。

    返回 [{"id", "from_id", "to_id", "type", "note",
            "other_id", "other_title", "other_tag", "direction"}]
    direction: "outgoing"(我指向它) 或 "incoming"(它指向我)
    """
    with _conn() as c:
        # 从我出发的关联
        rows_out = c.execute(
            """SELECT r.id, r.from_id, r.to_id, r.type, r.note,
                      p.id AS other_id, p.title AS other_title, p.tag AS other_tag,
                      'outgoing' AS direction
               FROM knowledge_relations r
               JOIN knowledge_points p ON p.id = r.to_id
               WHERE r.from_id = ?""",
            (point_id,),
        ).fetchall()
        # 指向我的关联
        rows_in = c.execute(
            """SELECT r.id, r.from_id, r.to_id, r.type, r.note,
                      p.id AS other_id, p.title AS other_title, p.tag AS other_tag,
                      'incoming' AS direction
               FROM knowledge_relations r
               JOIN knowledge_points p ON p.id = r.from_id
               WHERE r.to_id = ?""",
            (point_id,),
        ).fetchall()
    results = [dict(r) for r in rows_out] + [dict(r) for r in rows_in]
    return results


def delete_relation(rel_id):
    with _conn() as c:
        c.execute("DELETE FROM knowledge_relations WHERE id = ?", (rel_id,))


def batch_create_relations(relations_data):
    """批量创建关联。

    relations_data: [{"from_id", "to_id", "type", "note"}, ...]
    自动去重。
    """
    with _conn() as c:
        for rd in relations_data:
            from_id = rd.get("from_id")
            to_id = rd.get("to_id")
            rel_type = rd.get("type", "related")
            note = rd.get("note", "")
            if not from_id or not to_id or from_id == to_id:
                continue
            c.execute(
                "INSERT OR IGNORE INTO knowledge_relations (from_id, to_id, type, note) VALUES (?,?,?,?)",
                (from_id, to_id, rel_type, note),
            )


def get_all_relations():
    """获取所有关联（供前端知识网络可视化用）。"""
    with _conn() as c:
        rows = c.execute(
            """SELECT r.from_id, r.to_id, r.type, r.note,
                      f.title AS from_title, t.title AS to_title
               FROM knowledge_relations r
               JOIN knowledge_points f ON f.id = r.from_id
               JOIN knowledge_points t ON t.id = r.to_id"""
        ).fetchall()
    return [dict(r) for r in rows]


# -------------------- 卡片（子节点）--------------------

def create_card(point_id, card_type, question, answer, compare_with=None):
    """新增一张卡片，due_date 设为今天（新卡立即进入队列）。"""
    with _conn() as c:
        cur = c.execute(
            """INSERT INTO cards
               (point_id, type, question, answer, compare_with,
                easiness, interval, repetition, due_date, created_at)
               VALUES (?, ?, ?, ?, ?, 2.5, 0, 0, ?, ?)""",
            (point_id, card_type, question, answer, compare_with, _today(), _now()),
        )
        return cur.lastrowid


def get_card(card_id):
    with _conn() as c:
        row = c.execute(
            """SELECT c.*, k.title AS point_title, k.tag AS point_tag,
                      k.mechanism, k.clinical, k.mnemonic
               FROM cards c
               JOIN knowledge_points k ON c.point_id = k.id
               WHERE c.id = ?""",
            (card_id,),
        ).fetchone()
        return dict(row) if row else None


def list_cards():
    with _conn() as c:
        rows = c.execute(
            """SELECT c.*, k.title AS point_title, k.tag AS point_tag
               FROM cards c
               JOIN knowledge_points k ON c.point_id = k.id
               ORDER BY c.id DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_cards_by_point(point_id):
    """获取一个知识点的所有卡片（含扩展字段，供知识网络详情展示）。"""
    with _conn() as c:
        rows = c.execute(
            """SELECT c.id, c.type, c.question, c.answer,
                      c.easiness, c.interval, c.repetition, c.due_date,
                      k.title AS point_title, k.tag AS point_tag,
                      k.mechanism, k.clinical, k.mnemonic,
                      k.diagnosis, k.treatment, k.differential, k.etiology, k.prevention
               FROM cards c
               JOIN knowledge_points k ON c.point_id = k.id
               WHERE c.point_id = ?
               ORDER BY c.id ASC""",
            (point_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_due_cards(tag=None, point_id=None, point_ids=None, new_card_limit=0):
    """获取今天到期的卡片，可按科目和/或知识点筛选，按【交错练习】原则混排。

    - tag：按科目筛选
    - point_id：按单个知识点筛选（向后兼容）
    - point_ids：按多个知识点筛选（列表），与 point_id 互斥优先
    - new_card_limit：新卡每日上限（0 或负数 = 不限）。
      新卡定义为 repetition == 0（从未正确复习过）。
      已学过的复习卡永不截断，遵循「复习优先」原则。
    """
    where = ["c.due_date <= ?"]
    params = [_today()]
    if tag:
        where.append("k.tag = ?")
        params.append(tag)
    if point_ids:
        # 多选：用 IN 子句
        placeholders = ",".join(["?"] * len(point_ids))
        where.append(f"c.point_id IN ({placeholders})")
        params.extend(point_ids)
    elif point_id:
        where.append("c.point_id = ?")
        params.append(point_id)
    where_clause = " AND ".join(where)

    with _conn() as c:
        rows = c.execute(
            f"""SELECT c.*, k.title AS point_title, k.tag AS point_tag,
                       k.mechanism, k.clinical, k.mnemonic
                FROM cards c
                JOIN knowledge_points k ON c.point_id = k.id
                WHERE {where_clause}
                ORDER BY c.due_date ASC""",
            params,
        ).fetchall()
        cards = [dict(r) for r in rows]
    # 新卡每日上限：截断新卡，保留全部复习卡
    if new_card_limit and new_card_limit > 0:
        review_cards = [c for c in cards if c["repetition"] > 0]
        new_cards = [c for c in cards if c["repetition"] == 0][:new_card_limit]
        cards = review_cards + new_cards
    return interleave(cards)


def interleave(cards):
    """交错排序：把同一知识点/标签的卡片尽量打散，避免连续同主题。

    贪心策略：每轮从剩余卡片里挑一张「与上一张不同 point_id」的，
    优先选还没用过的 point_id，实现学科/主题交错。
    """
    if not cards:
        return []
    result = []
    remaining = list(cards)
    last_point = None
    while remaining:
        pick = None
        for i, c in enumerate(remaining):
            if c["point_id"] != last_point:
                pick = i
                break
        if pick is None:
            pick = 0  # 只剩同 point 了，照取
        chosen = remaining.pop(pick)
        result.append(chosen)
        last_point = chosen["point_id"]
    return result


def review_card(card_id, rating):
    """对一张卡片评分，更新 SM-2 状态。

    rating: again/hard/good/easy 四档
    """
    if rating not in RATING_TO_QUALITY:
        raise ValueError(f"未知评分: {rating}")
    quality = RATING_TO_QUALITY[rating]

    with _conn() as c:
        row = c.execute(
            "SELECT easiness, interval, repetition, due_date FROM cards WHERE id = ?",
            (card_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"卡片不存在: {card_id}")

        easiness, interval, repetition = row["easiness"], row["interval"], row["repetition"]
        prev_wrong = c.execute(
            "SELECT * FROM wrong_card_state WHERE card_id = ?",
            (card_id,),
        ).fetchone()
        new_e, new_i, new_r, days = review(easiness, interval, repetition, quality)

        due = (date.today() + timedelta(days=days)).isoformat()
        c.execute(
            """UPDATE cards
               SET easiness = ?, interval = ?, repetition = ?, due_date = ?
               WHERE id = ?""",
            (new_e, new_i, new_r, due, card_id),
        )
        # 记录本次评分（复习历史，供后续保留率/leech/热力图统计）
        cur = c.execute(
            "INSERT INTO reviews (card_id, rating, quality, reviewed_at) VALUES (?,?,?,?)",
            (card_id, rating, quality, _now()),
        )
        review_id = cur.lastrowid
        c.execute(
            """INSERT INTO review_snapshots
               (review_id, card_id, prev_easiness, prev_interval, prev_repetition, prev_due_date,
                prev_wrong_exists, prev_wrong_count, prev_correct_streak, prev_wrong_active,
                prev_wrong_updated_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                review_id, card_id, easiness, interval, repetition, row["due_date"],
                1 if prev_wrong else 0,
                prev_wrong["wrong_count"] if prev_wrong else 0,
                prev_wrong["correct_streak"] if prev_wrong else 0,
                prev_wrong["active"] if prev_wrong else 0,
                prev_wrong["updated_at"] if prev_wrong else "",
                _now(),
            ),
        )
        if rating in ("again", "hard"):
            c.execute(
                """INSERT INTO wrong_card_state
                   (card_id, wrong_count, correct_streak, active, updated_at)
                   VALUES (?, 1, 0, 1, ?)
                   ON CONFLICT(card_id) DO UPDATE SET
                     wrong_count = wrong_count + 1,
                     correct_streak = 0,
                     active = 1,
                     updated_at = excluded.updated_at""",
                (card_id, _now()),
            )
        elif rating in ("good", "easy"):
            state = c.execute(
                "SELECT active, correct_streak FROM wrong_card_state WHERE card_id = ?",
                (card_id,),
            ).fetchone()
            if state and state["active"]:
                streak = state["correct_streak"] + 1
                c.execute(
                    """UPDATE wrong_card_state
                       SET correct_streak = ?, active = ?, updated_at = ?
                       WHERE card_id = ?""",
                    (streak, 0 if streak >= 2 else 1, _now(), card_id),
                )
    return {"review_id": review_id, "easiness": new_e, "interval": new_i, "repetition": new_r, "due_date": due}


def undo_review(review_id):
    """撤销一条最近评分，恢复卡片调度和错题池状态。"""
    with _conn() as c:
        snap = c.execute(
            """SELECT rs.*, r.rating
               FROM review_snapshots rs
               JOIN reviews r ON r.id = rs.review_id
               WHERE rs.review_id = ?""",
            (review_id,),
        ).fetchone()
        if snap is None:
            raise KeyError(f"复习记录不存在或不可撤销: {review_id}")
        latest = c.execute(
            "SELECT MAX(id) AS id FROM reviews WHERE card_id = ?",
            (snap["card_id"],),
        ).fetchone()["id"]
        if latest != review_id:
            raise ValueError("只能撤销该卡片的最近一次评分")

        c.execute(
            """UPDATE cards
               SET easiness = ?, interval = ?, repetition = ?, due_date = ?
               WHERE id = ?""",
            (
                snap["prev_easiness"], snap["prev_interval"],
                snap["prev_repetition"], snap["prev_due_date"], snap["card_id"],
            ),
        )
        if snap["prev_wrong_exists"]:
            c.execute(
                """INSERT INTO wrong_card_state
                   (card_id, wrong_count, correct_streak, active, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(card_id) DO UPDATE SET
                     wrong_count = excluded.wrong_count,
                     correct_streak = excluded.correct_streak,
                     active = excluded.active,
                     updated_at = excluded.updated_at""",
                (
                    snap["card_id"], snap["prev_wrong_count"],
                    snap["prev_correct_streak"], snap["prev_wrong_active"],
                    snap["prev_wrong_updated_at"],
                ),
            )
        else:
            c.execute("DELETE FROM wrong_card_state WHERE card_id = ?", (snap["card_id"],))
        c.execute("DELETE FROM review_snapshots WHERE review_id = ?", (review_id,))
        c.execute("DELETE FROM reviews WHERE id = ?", (review_id,))
    return {"ok": True, "card_id": snap["card_id"]}


def _backfill_wrong_state(c):
    """把旧 reviews 中的错题回填到 wrong_card_state，仅补不存在的卡片。"""
    c.execute(
        """INSERT OR IGNORE INTO wrong_card_state
           (card_id, wrong_count, correct_streak, active, updated_at)
           SELECT card_id, COUNT(*) AS wrong_count, 0, 1, ?
           FROM reviews
           WHERE rating IN ('again', 'hard')
           GROUP BY card_id""",
        (_now(),),
    )


def get_wrong_cards(tag=None, min_wrong=1):
    """获取当前仍在错题池里的卡片，按错误次数降序。

    min_wrong: 至少答错几次（默认 1）。
    返回 [{id, card_id, point_id, wrong_count, title, tag, question, answer, type,
           easiness, interval, repetition, due_date}]
    （id 和 card_id 同值，id 供前端 reviewCard(card.id) 用）
    """
    where = ["ws.active = 1", "ws.wrong_count >= ?"]
    params = [min_wrong]
    if tag:
        where.append("k.tag = ?")
        params.append(tag)
    where_clause = " AND ".join(where)
    with _conn() as c:
        _backfill_wrong_state(c)
        rows = c.execute(
            f"""SELECT c.id AS id, c.id AS card_id, c.point_id, c.type, c.question, c.answer,
                       c.easiness, c.interval, c.repetition, c.due_date,
                       k.title, k.tag,
                       ws.wrong_count AS wrong_count,
                       ws.correct_streak AS correct_streak
                FROM wrong_card_state ws
                JOIN cards c ON c.id = ws.card_id
                JOIN knowledge_points k ON k.id = c.point_id
                WHERE {where_clause}
                ORDER BY ws.wrong_count DESC, c.id""",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


def get_review_stats(tag=None):
    """复习统计：总复习次数、各评分次数、正确率、错题数。"""
    with _conn() as c:
        if tag:
            base = """FROM reviews r
                     JOIN cards c ON c.id = r.card_id
                     JOIN knowledge_points k ON k.id = c.point_id
                     WHERE k.tag = ?"""
            params = (tag,)
        else:
            base = "FROM reviews"
            params = ()
        total = c.execute(f"SELECT COUNT(*) AS n {base}", params).fetchone()["n"]
        by_rating = {}
        for r in c.execute(
            f"""SELECT rating, COUNT(*) AS n {base} GROUP BY rating""", params
        ):
            by_rating[r["rating"]] = r["n"]
        # 当前错题池数量（已连续答对毕业的卡不再计入）
        wrong_tag_clause = "AND k.tag = ?" if tag else ""
        wrong_params = (tag,) if tag else ()
        wrong_cards = c.execute(
            f"""SELECT COUNT(*) AS n
                FROM wrong_card_state ws JOIN cards c ON c.id = ws.card_id
                JOIN knowledge_points k ON k.id = c.point_id
                WHERE ws.active = 1 {wrong_tag_clause}""",
            wrong_params,
        ).fetchone()["n"]
    correct = by_rating.get("good", 0) + by_rating.get("easy", 0)
    return {
        "total_reviews": total,
        "again": by_rating.get("again", 0),
        "hard": by_rating.get("hard", 0),
        "good": by_rating.get("good", 0),
        "easy": by_rating.get("easy", 0),
        "accuracy": round(correct / total, 2) if total else 0,
        "wrong_cards": wrong_cards,
    }


def delete_card(card_id):
    with _conn() as c:
        c.execute("DELETE FROM cards WHERE id = ?", (card_id,))


def update_card(card_id, question=None, answer=None, card_type=None):
    """编辑卡片的问题/答案/类型。"""
    sets, vals = [], []
    if card_type is not None:
        sets.append("type = ?")
        vals.append(card_type)
    if question is not None:
        sets.append("question = ?")
        vals.append(question)
    if answer is not None:
        sets.append("answer = ?")
        vals.append(answer)
    if not sets:
        return False
    vals.append(card_id)
    with _conn() as c:
        c.execute(f"UPDATE cards SET {', '.join(sets)} WHERE id = ?", vals)
    return True


# -------------------- 统计 --------------------

def stats(tag=None):
    """汇总统计：可按科目筛选。"""
    with _conn() as c:
        if tag:
            due = c.execute(
                """SELECT COUNT(*) AS n FROM cards c
                   JOIN knowledge_points k ON c.point_id = k.id
                   WHERE c.due_date <= ? AND k.tag = ?""",
                (_today(), tag),
            ).fetchone()["n"]
            total_cards = c.execute(
                """SELECT COUNT(*) AS n FROM cards c
                   JOIN knowledge_points k ON c.point_id = k.id
                   WHERE k.tag = ?""",
                (tag,),
            ).fetchone()["n"]
            total_points = c.execute(
                "SELECT COUNT(*) AS n FROM knowledge_points WHERE tag = ?",
                (tag,),
            ).fetchone()["n"]
        else:
            due = c.execute(
                "SELECT COUNT(*) AS n FROM cards WHERE due_date <= ?", (_today(),)
            ).fetchone()["n"]
            total_cards = c.execute("SELECT COUNT(*) AS n FROM cards").fetchone()["n"]
            total_points = c.execute(
                "SELECT COUNT(*) AS n FROM knowledge_points"
            ).fetchone()["n"]
    return {
        "due_today": due,
        "total_cards": total_cards,
        "total_points": total_points,
    }


def list_points_with_due(tag=None):
    """列出知识点及其今日待复习卡片数，供「按知识点复习」选择。

    返回 [{"id", "title", "tag", "due", "total"}]
    """
    where = []
    params = [_today()]
    if tag:
        where.append("k.tag = ?")
        params.append(tag)
    where_clause = ("WHERE " + " AND ".join(where)) if where else ""
    with _conn() as c:
        rows = c.execute(
            f"""SELECT k.id AS id, k.title AS title, k.tag AS tag,
                       SUM(CASE WHEN c.due_date <= ? THEN 1 ELSE 0 END) AS due,
                       COUNT(c.id) AS total
                FROM knowledge_points k
                LEFT JOIN cards c ON c.point_id = k.id
                {where_clause}
                GROUP BY k.id
                ORDER BY due DESC, k.id DESC""",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


# -------------------- 完整备份导入/导出 --------------------

_BACKUP_TABLES = {
    "points": "knowledge_points",
    "cards": "cards",
    "relations": "knowledge_relations",
    "nodes": "knowledge_nodes",
    "reviews": "reviews",
    "review_snapshots": "review_snapshots",
    "wrong_card_state": "wrong_card_state",
    "comparison_dims": "comparison_dims",
    "custom_edges": "custom_edges",
}

_BACKUP_DELETE_ORDER = [
    "custom_edges",
    "comparison_dims",
    "wrong_card_state",
    "review_snapshots",
    "reviews",
    "knowledge_relations",
    "knowledge_nodes",
    "cards",
    "knowledge_points",
]

_BACKUP_INSERT_ORDER = [
    "points",
    "cards",
    "nodes",
    "relations",
    "reviews",
    "review_snapshots",
    "wrong_card_state",
    "comparison_dims",
    "custom_edges",
]


def _table_columns(c, table):
    return {row["name"] for row in c.execute(f"PRAGMA table_info({table})")}


def _insert_backup_rows(c, table, rows):
    if not rows:
        return 0
    columns = _table_columns(c, table)
    inserted = 0
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError(f"{table} 备份记录格式不正确")
        keys = [k for k in row.keys() if k in columns]
        if not keys:
            continue
        placeholders = ", ".join(["?"] * len(keys))
        col_names = ", ".join(keys)
        c.execute(
            f"INSERT INTO {table} ({col_names}) VALUES ({placeholders})",
            [row[k] for k in keys],
        )
        inserted += 1
    return inserted

def export_all():
    """导出全部数据为自包含 dict（完整备份，可灾备恢复）。

    包含核心学习数据、知识网络、对比网络和手动连线。
    """
    with _conn() as c:
        exported = {}
        for key, table in _BACKUP_TABLES.items():
            columns = _table_columns(c, table)
            order_col = "id" if "id" in columns else next(iter(columns))
            exported[key] = [
                dict(r) for r in c.execute(f"SELECT * FROM {table} ORDER BY {order_col}").fetchall()
            ]
    return {
        "version": 2,
        "exported_at": _now(),
        **exported,
    }


def write_backup_snapshot(prefix="medmemo-backup"):
    """把当前学习数据写入用户数据目录下的 backups，返回文件路径。

    用于恢复前的安全快照，不包含 config.json 或 API key。
    """
    backup_dir = os.path.join(USER_DATA_DIR, "backups")
    os.makedirs(backup_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"{prefix}-{timestamp}.json"
    path = os.path.join(backup_dir, filename)
    data = export_all()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return path


def auto_backup_if_needed(keep=7):
    """每天首次启动时自动备份一次，并保留最近 keep 份自动备份。"""
    backup_dir = os.path.join(USER_DATA_DIR, "backups")
    os.makedirs(backup_dir, exist_ok=True)
    today = date.today().strftime("%Y%m%d")
    existing_today = [
        name for name in os.listdir(backup_dir)
        if name.startswith(f"auto-{today}-") and name.endswith(".json")
    ]
    if existing_today:
        return {"created": False, "path": os.path.join(backup_dir, existing_today[-1])}

    path = write_backup_snapshot(f"auto-{today}")
    auto_files = sorted(
        os.path.join(backup_dir, name)
        for name in os.listdir(backup_dir)
        if name.startswith("auto-") and name.endswith(".json")
    )
    for old_path in auto_files[:-keep]:
        try:
            os.remove(old_path)
        except OSError:
            pass
    return {"created": True, "path": path}


def import_backup(data):
    """用备份 JSON 恢复完整学习数据。

    这是破坏性替换操作：先清空当前学习数据，再按外键顺序恢复备份。
    整个过程在一个 transaction 内完成，失败会回滚到恢复前状态。
    """
    if not isinstance(data, dict):
        raise ValueError("备份文件不是合法的 JSON 对象")
    if "points" not in data or "cards" not in data:
        raise ValueError("备份文件缺少 points/cards，无法恢复")
    for key in _BACKUP_INSERT_ORDER:
        rows = data.get(key, [])
        if rows is None:
            data[key] = []
        elif not isinstance(rows, list):
            raise ValueError(f"备份字段 {key} 格式不正确")

    stats = {}
    with _conn() as c:
        c.execute("PRAGMA defer_foreign_keys = ON")
        for table in _BACKUP_DELETE_ORDER:
            c.execute(f"DELETE FROM {table}")
        for key in _BACKUP_INSERT_ORDER:
            table = _BACKUP_TABLES[key]
            stats[key] = _insert_backup_rows(c, table, data.get(key, []))
    return stats


# -------------------- 对比维度（结构化对比存储）--------------------

def save_comparison(point_id, concept_a, concept_b, dimensions):
    """保存一个对比知识点的结构化维度。

    先清空该 point 的旧维度，再批量插入。dimensions: [{dim, value_a, value_b}]
    concept_a/concept_b 存进每一行（冗余但便于按概念查询）。
    """
    with _conn() as c:
        c.execute("DELETE FROM comparison_dims WHERE point_id = ?", (point_id,))
        for d in (dimensions or []):
            c.execute(
                """INSERT INTO comparison_dims
                   (point_id, concept_a, concept_b, dim, value_a, value_b)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (point_id, concept_a, concept_b,
                 d.get("dim", ""), d.get("value_a", ""), d.get("value_b", "")),
            )


def _parse_dimensions_from_differential(diff_text):
    """从旧 differential 字符串解析结构化维度。

    旧格式：'维度名：值A vs 值B；维度名：值A vs 值B；...'
    返回 [{dim, value_a, value_b}]。解析失败的片段跳过。
    """
    if not diff_text:
        return []
    dims = []
    # 先按中文分号/英文分号切段
    for seg in diff_text.replace("；", ";").split(";"):
        seg = seg.strip()
        if not seg or "：" not in seg and ":" not in seg:
            continue
        # 分离维度名和值（取第一个冒号）
        for sep in ("：", ":"):
            if sep in seg:
                idx = seg.index(sep)
                dim = seg[:idx].strip()
                rest = seg[idx + 1:].strip()
                break
        else:
            continue
        # rest 里用 ' vs ' 或 ' VS ' 分割 A/B
        parts = rest.split(" vs ") if " vs " in rest else rest.split(" VS ")
        if len(parts) == 2 and dim:
            dims.append({
                "dim": dim,
                "value_a": parts[0].strip(),
                "value_b": parts[1].strip(),
            })
    return dims


def backfill_comparisons():
    """一次性回填：把历史对比知识点的结构化维度解析进 comparison_dims。

    旧版导入时对比维度只压成字符串塞进 differential，结构丢失，导致对比网络显示 0。
    本函数扫描所有"像对比的知识点"（comparison_dims 无记录 + title 含 'vs'），
    从 title 提取概念 A/B，从 differential 解析维度，存进 comparison_dims。
    幂等：已有结构化记录的点跳过。
    """
    import re
    with _conn() as c:
        # 候选：comparison_dims 没有记录、title 像 'A vs B' 的知识点
        candidates = c.execute(
            """SELECT k.id, k.title, k.differential FROM knowledge_points k
               WHERE NOT EXISTS (
                   SELECT 1 FROM comparison_dims cd WHERE cd.point_id = k.id
               )
               AND (k.title LIKE '%vs%' OR k.differential LIKE '%vs%')"""
        ).fetchall()
        filled = 0
        for row in candidates:
            title = row["title"] or ""
            diff = row["differential"] or ""
            # 从 title 'A vs B 对比' 提取概念 A、B
            m = re.match(r"\s*(.+?)\s+vs\.?\s+(.+?)(?:\s*对比)?\s*$", title, re.IGNORECASE)
            if not m:
                continue
            concept_a = m.group(1).strip()
            concept_b = m.group(2).strip()
            dims = _parse_dimensions_from_differential(diff)
            if not dims:
                continue  # 解析不出维度，不勉强
            for d in dims:
                c.execute(
                    """INSERT INTO comparison_dims
                       (point_id, concept_a, concept_b, dim, value_a, value_b)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (row["id"], concept_a, concept_b,
                     d["dim"], d["value_a"], d["value_b"]),
                )
            filled += 1
    return filled


def get_comparison(point_id):
    """获取单个对比知识点的结构化维度。返回 {concept_a, concept_b, dimensions} 或 None。"""
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM comparison_dims WHERE point_id = ? ORDER BY id",
            (point_id,),
        ).fetchall()
    if not rows:
        return None
    r = rows[0]
    return {
        "concept_a": r["concept_a"],
        "concept_b": r["concept_b"],
        "dimensions": [
            {"dim": row["dim"], "value_a": row["value_a"], "value_b": row["value_b"]}
            for row in rows
        ],
    }


def get_comparisons(tag=None):
    """获取所有对比知识点（按 tag 筛选）+ 结构化维度。

    返回 [{point_id, title, tag, concept_a, concept_b, dimensions:[...]}]
    对比知识点 = comparison_dims 里有记录的 point。
    """
    with _conn() as c:
        if tag:
            pts = c.execute(
                """SELECT DISTINCT cd.point_id, k.title, k.tag, cd.concept_a, cd.concept_b
                   FROM comparison_dims cd
                   JOIN knowledge_points k ON k.id = cd.point_id
                   WHERE k.tag = ?
                   ORDER BY cd.point_id""",
                (tag,),
            ).fetchall()
        else:
            pts = c.execute(
                """SELECT DISTINCT cd.point_id, k.title, k.tag, cd.concept_a, cd.concept_b
                   FROM comparison_dims cd
                   JOIN knowledge_points k ON k.id = cd.point_id
                   ORDER BY cd.point_id"""
            ).fetchall()
        result = []
        for p in pts:
            dims = c.execute(
                "SELECT dim, value_a, value_b FROM comparison_dims WHERE point_id = ? ORDER BY id",
                (p["point_id"],),
            ).fetchall()
            result.append({
                "point_id": p["point_id"], "title": p["title"], "tag": p["tag"],
                "concept_a": p["concept_a"], "concept_b": p["concept_b"],
                "dimensions": [dict(d) for d in dims],
            })
    return result


# -------------------- 自定义连线（用户手动编辑）--------------------

def create_custom_edge(from_node, to_node, label=""):
    """新增用户手动连线。from_node/to_node 是 knowledge_nodes.id。"""
    with _conn() as c:
        cur = c.execute(
            "INSERT INTO custom_edges (from_node, to_node, label) VALUES (?, ?, ?)",
            (from_node, to_node, label),
        )
        return cur.lastrowid


def get_custom_edges():
    """获取所有自定义连线（带节点 label，供网络图渲染）。"""
    with _conn() as c:
        rows = c.execute(
            """SELECT e.id, e.from_node, e.to_node, e.label,
                      fl.label AS from_label, tl.label AS to_label
               FROM custom_edges e
               JOIN knowledge_nodes fl ON fl.id = e.from_node
               JOIN knowledge_nodes tl ON tl.id = e.to_node
               ORDER BY e.id"""
        ).fetchall()
    return [dict(r) for r in rows]


def delete_custom_edge(edge_id):
    with _conn() as c:
        c.execute("DELETE FROM custom_edges WHERE id = ?", (edge_id,))


# -------------------- 学科批量管理 --------------------

def delete_points_by_tag(tag):
    """删除某科目的所有知识点（cascade 自动清卡片/关联/节点/对比维度/复习）。"""
    with _conn() as c:
        cur = c.execute("DELETE FROM knowledge_points WHERE tag = ?", (tag,))
        return cur.rowcount


def retag_points(old_tag, new_tag):
    """把某科目的所有知识点改归到另一科目（合并）。"""
    with _conn() as c:
        cur = c.execute(
            "UPDATE knowledge_points SET tag = ? WHERE tag = ?", (new_tag, old_tag)
        )
        return cur.rowcount


# -------------------- 知识节点（层级网络）--------------------

def create_node(point_id, label, parent_id=None, level=0, detail="", link_to_point=None):
    """新增一个知识节点。

    level: 0=根节点(知识点本身), 1=子模块, 2=关键词
    parent_id: 父节点 id（根节点为 None）
    link_to_point: 该子节点语义指向的另一个知识点 id（用于跨知识点串联虚线）
    返回 node id。
    """
    with _conn() as c:
        cur = c.execute(
            """INSERT INTO knowledge_nodes (point_id, parent_id, level, label, detail, link_to_point)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (point_id, parent_id, level, label, detail, link_to_point),
        )
        return cur.lastrowid


def get_children(node_id):
    """获取一个节点的所有子节点（用于点击展开）。含 link_to_point 关联信息。"""
    with _conn() as c:
        rows = c.execute(
            """SELECT n.*, k.title AS point_title, k.tag AS point_tag,
                      (SELECT COUNT(*) FROM knowledge_nodes c WHERE c.parent_id = n.id) AS child_count
               FROM knowledge_nodes n
               JOIN knowledge_points k ON n.point_id = k.id
               WHERE n.parent_id = ?
               ORDER BY n.id ASC""",
            (node_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_root_nodes():
    """获取所有根节点（level=0，对应每个知识点）+ 是否有子节点。

    这是网络图初始加载时显示的全部内容。
    """
    with _conn() as c:
        rows = c.execute(
            """SELECT n.id, n.point_id, n.label, n.level,
                      k.tag AS point_tag, k.size AS size,
                      (SELECT COUNT(*) FROM knowledge_nodes ch WHERE ch.parent_id = n.id) AS child_count
               FROM knowledge_nodes n
               JOIN knowledge_points k ON n.point_id = k.id
               WHERE n.level = 0
               ORDER BY n.id ASC"""
        ).fetchall()
    return [dict(r) for r in rows]


def get_nodes_by_point(point_id):
    """获取一个知识点的所有节点（含层级结构）。"""
    with _conn() as c:
        rows = c.execute(
            """SELECT * FROM knowledge_nodes WHERE point_id = ? ORDER BY level, id""",
            (point_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_nodes_by_point(point_id):
    """删除一个知识点的所有节点。"""
    with _conn() as c:
        c.execute("DELETE FROM knowledge_nodes WHERE point_id = ?", (point_id,))


def delete_node(node_id):
    """删除单个节点（用户手动编辑模式用）。根节点(level=0)不可删（它代表知识点本身）。"""
    with _conn() as c:
        row = c.execute(
            "SELECT level FROM knowledge_nodes WHERE id = ?", (node_id,)
        ).fetchone()
        if row is None:
            raise KeyError(f"节点不存在: {node_id}")
        if row["level"] == 0:
            raise ValueError("根节点不可删除（它代表知识点本身），请删除整个知识点。")
        c.execute("DELETE FROM knowledge_nodes WHERE id = ?", (node_id,))


def update_node(node_id, label=None, detail=None):
    """编辑节点（用户手动编辑模式用）。"""
    sets, vals = [], []
    if label is not None:
        sets.append("label = ?")
        vals.append(label)
    if detail is not None:
        sets.append("detail = ?")
        vals.append(detail)
    if not sets:
        return False
    vals.append(node_id)
    with _conn() as c:
        c.execute(f"UPDATE knowledge_nodes SET {', '.join(sets)} WHERE id = ?", vals)
    return True


def batch_create_nodes(point_id, nodes_data):
    """批量为一个知识点创建层级节点。

    nodes_data: [{"label", "detail", "link_to"(目标知识点title,可选), "children":[...]}]
    支持递归子节点（多层级）。link_to 会被解析成目标知识点的 point_id。
    返回创建的节点数。
    """
    created = [0]
    # 预加载所有知识点 title→id 映射，用于解析 link_to
    title_to_pid = {}
    with _conn() as c:
        for row in c.execute("SELECT id, title FROM knowledge_points").fetchall():
            title_to_pid[row["title"]] = row["id"]

    def _resolve_link_to(link_to):
        """把 link_to（title）解析成 point_id。支持模糊匹配（包含关系）。"""
        if not link_to:
            return None
        # 精确匹配优先
        if link_to in title_to_pid:
            return title_to_pid[link_to]
        # 模糊匹配：title 包含 link_to，或 link_to 包含 title
        for title, pid in title_to_pid.items():
            if pid == point_id:
                continue  # 不关联到自己
            if link_to in title or title in link_to:
                return pid
        return None

    def _add(parent_id, level, item):
        link_pid = _resolve_link_to(item.get("link_to"))
        nid = create_node(
            point_id=point_id,
            label=item["label"],
            parent_id=parent_id,
            level=level,
            detail=item.get("detail", ""),
            link_to_point=link_pid,
        )
        created[0] += 1
        for child in item.get("children", []):
            _add(nid, level + 1, child)

    with _conn() as c:
        for item in nodes_data:
            _add(None, 0, item)
    return created[0]


# -------------------- 种子数据导入 --------------------

def seed_if_empty(seed_path, marker_path=None):
    """首次运行导入种子数据。

    用 marker_path 标记文件判断"是否初始化过"——而不是靠数据库是否为空。
    这样用户删除数据后重启，不会重新导入种子（避免删了又回来的 bug）。
    """
    # 标记文件存在 = 已经初始化过，不再导入
    if marker_path and os.path.exists(marker_path):
        return False
    # 兜底：数据库已有数据也不导入
    with _conn() as c:
        if c.execute("SELECT COUNT(*) AS n FROM knowledge_points").fetchone()["n"] > 0:
            # 数据库有数据但没标记文件，补建标记（说明是升级上来的旧库）
            if marker_path:
                _write_marker(marker_path)
            return False
    if not os.path.exists(seed_path):
        return False
    with open(seed_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    for p in data.get("points", []):
        point_fields = {k: p[k] for k in _POINT_COLUMNS if k in p}
        pid = create_point(**point_fields)
        for c in p.get("cards", []):
            create_card(
                point_id=pid,
                card_type=c["type"],
                question=c["question"],
                answer=c["answer"],
            )
    # 导入种子关联
    for rel in data.get("relations", []):
        # 用 title 查找 id（因为种子数据的 id 未知）
        from_row = None
        to_row = None
        with _conn() as c:
            from_row = c.execute(
                "SELECT id FROM knowledge_points WHERE title = ?",
                (rel["from_title"],),
            ).fetchone()
            to_row = c.execute(
                "SELECT id FROM knowledge_points WHERE title = ?",
                (rel["to_title"],),
            ).fetchone()
        if from_row and to_row:
            create_relation(
                from_id=from_row["id"],
                to_id=to_row["id"],
                rel_type=rel.get("type", "related"),
                note=rel.get("note", ""),
            )
    # 导入层级节点（每个知识点一棵小树）
    for p in data.get("points", []):
        title = p.get("title")
        nodes = p.get("nodes")
        if not title or not nodes:
            continue
        with _conn() as c:
            row = c.execute(
                "SELECT id FROM knowledge_points WHERE title = ?", (title,)
            ).fetchone()
        if row:
            # 根节点用知识点标题，子节点从 nodes 来
            root_data = {"label": title, "detail": "", "children": nodes}
            batch_create_nodes(row["id"], [root_data])
    # 导入成功，写标记文件（以后不再重复导入）
    if marker_path:
        _write_marker(marker_path)
    return True
