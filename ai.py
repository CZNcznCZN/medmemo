"""DeepSeek AI 拆卡模块。

核心能力：把一段医学文本拆成结构化知识点，并为每个知识点生成：
- 机制解释（为什么，因果链）—— 服务"理解性记忆"
- 临床联系（用在哪）—— 服务"迁移"
- 记忆画面（一句文字场景描述，让用户脑内成像）—— 服务"持久记忆"
- 4 种问法卡（正向/反向/机制/应用）—— 多角度提取
- 易混概念对照卡 —— 对比辨析

调用 DeepSeek 的 OpenAI 兼容接口，用标准库 urllib，零 pip 依赖。
"""
import json
import os
import re
import urllib.request
import urllib.error

from config import load_config, has_api_key
from paths import USER_DATA_DIR


# 医学多学科 prompt 模板：不同学科，理解重点不同
SUBJECT_TEMPLATES = {
    "药理": "拆解要点：作用机制 → 药理作用 → 临床用途 → 不良反应 → 禁忌。机制因果链是灵魂（如：抑制XX酶→XX物质堆积→XX效应）。",
    "病理": "拆解要点：病因（病因学）→ 发病机制 → 病理变化（肉眼/镜下）→ 临床病理联系。",
    "生理": "拆解要点：概念 → 发生机制 → 调节因素 → 失衡后果（临床联系）。",
    "解剖": "拆解要点：位置 → 形态结构 → 毗邻关系 → 功能 → 体表标志/临床意义。",
    "内科": "拆解要点：典型临床表现 → 诊断标准 → 鉴别诊断 → 治疗原则。",
    "外科": "拆解要点：临床表现 → 诊断 → 手术适应证/禁忌证 → 术后并发症。",
    "微生物": "拆解要点：病原体特征 → 致病机制 → 所致疾病 → 防治。",
    "生化": "拆解要点：反应/通路 → 关键酶 → 调节 → 临床意义（代谢病等）。",
    "免疫": "拆解要点：免疫机制 → 介导物质 → 病理表现 → 临床联系。",
    "通用": "拆解要点：核心概念 → 关键机制 → 临床应用 → 易混辨析。",
}

SYSTEM_PROMPT = """你是一位资深医学教育专家和记忆法大师。你的任务是帮助医学生高效、深入、持久地记忆医学知识。

你的核心方法论：
1. 原子化：一个知识点只问一件事。绝不把多个要点塞进一张卡。
2. 理解优先：为每个知识点讲清「为什么」（机制因果链），而不是只给结论。
3. 多角度提取：每个知识点从「正向/反向/机制/应用」四个方向各出一张卡，从多方向强化记忆。
4. 记忆画面：用一句生动、夸张、有动作的画面描述，帮用户在脑海中成像（记忆宫殿式）。
5. 对比辨析：主动识别文本中或医学常识里的易混概念，生成对照卡。
6. 大小分级：区分「大知识点」和「小知识点」。
   - 大知识点（size=big）：需要理解因果链、有多角度展开价值的完整概念（如某药机制、某病病理过程）。生成机制/临床/记忆画面 + 4 种问法卡 + 层级节点。
   - 小知识点（size=small）：一句话能说清、无需展开因果链的孤立事实（如某正常值、某酶是某反应的限速酶、某结构的位置）。只生成 1 张 forward 卡，机制/临床/记忆画面/nodes 全部留空。
   判断标准：若这个事实只需死记一个结论、问不出「为什么」，就用 small；若能追问机制/应用，就用 big。
7. 去重：参考给出的「已有知识点清单」，如果新拆出的某个知识点与清单中已有的高度重复（同一事实/同一结论），在该点的 duplicate_of 字段填入命中的已有标题；否则留空字符串。重复的也照常输出（由用户决定是否入库），不要擅自跳过。

输出必须是严格的 JSON，不要任何额外文字、不要 markdown 代码块。"""


def build_user_prompt(text, subject, existing_titles=None):
    """构造用户 prompt。

    existing_titles: 现有知识点标题清单 [{title, tag}, ...]，注入 prompt 供 AI 去重参考。
    """
    template = SUBJECT_TEMPLATES.get(subject, SUBJECT_TEMPLATES["通用"])

    # 构造已有知识点清单（供去重）。条目过多时截断，避免 prompt 爆炸。
    existing_block = ""
    if existing_titles:
        titles = [f"- [{t.get('tag', '')}] {t['title']}" for t in existing_titles if t.get("title")]
        if len(titles) > 200:
            titles = titles[:200] + [f"...（另有 {len(titles) - 200} 个未列出）"]
        existing_block = "\n\n【已有知识点清单（用于去重判断）】\n" + "\n".join(titles)

    return f"""请基于以下医学文本，按学科模板拆解并生成结构化学习卡。

【学科】{subject}
{template}

【医学文本】
{text}{existing_block}

【要求】
1. 把文本拆成若干「原子化知识点」。每点只问一个核心事实。
2. 对每个知识点判断大小（size 字段）：
   - big（大知识点）：需要理解因果链或多角度展开的完整概念。生成完整字段（mechanism/clinical/mnemonic 等，按学科模板填充）+ 4 种问法卡 + 层级节点 nodes。
   - small（小知识点）：一句话能说清、问不出「为什么」的孤立事实（如某正常值、某限速酶、某结构位置）。只生成 1 张 forward 卡，mechanism/clinical/mnemonic/diagnosis/treatment/differential/etiology/prevention 全部留空字符串，nodes 留空数组。
   判断标准：能追问「为什么/机制/应用」用 big，只能死记一个结论用 small。
3. 每个知识点（无论大小）都要带：
   - title：知识点名称（简短）
   - size："big" 或 "small"
   - duplicate_of：若与【已有知识点清单】中某条高度重复，填命中的已有标题；否则留空字符串 ""
4. big 知识点的可选字段（无则留空字符串）：diagnosis（诊断要点）、treatment（治疗方式）、differential（鉴别诊断）、etiology（病因）、prevention（预防）。
5. big 知识点 cards：4 张卡，type 为 forward（正向直问）、reverse（反向推导）、mechanism（问机制）、apply（问临床应用）；每张含 question 和 answer，answer 要简洁。small 知识点 cards：仅 1 张 forward 卡。
6. 识别文本涉及的易混概念对（若没有可省略），生成对照卡放入 comparisons，每条含 title、a（概念A）、b（概念B）、dimensions（对照维度数组，每项含 dim、value_a、value_b）。
7. 识别文本内知识点之间的关联，放入 relations，每条含 from（知识点A标题）、to（知识点B标题）、type（关系类型：cause/compare/upstream/downstream/related）、note（一句话说明为什么关联）。
8. 为每个 big 知识点生成「层级节点」放入 nodes（small 知识点 nodes 留空数组）。要求：有代表性、不过多（2-3 个一级子模块，每个子模块下 1-3 个关键词即可）。结构为树形：每个节点含 label（名称）、detail（一句话说明，可空）、children（子节点数组，可空）、link_to（可选）。一级子模块应覆盖该知识点的核心维度（如药理：作用机制/临床应用/不良反应；病理：病因/病变/临床联系）。【重要】当一个子节点（通常是治疗/药物/机制类）在语义上直接对应另一个独立知识点时，给它加 link_to 字段，值为目标知识点的 title（如左心衰治疗下的「地高辛」子节点 → link_to: "地高辛的作用机制"）。这样在知识网络中展开时，会用虚线把两个知识点串联起来，形成跨知识点的关联网。link_to 只在确实有明确对应关系时才加，不要滥加。

【输出格式】严格如下 JSON：
{{
  "points": [
    {{
      "title": "知识点名称",
      "size": "big",
      "duplicate_of": "",
      "mechanism": "机制因果链（small 留空）",
      "clinical": "临床联系（small 留空）",
      "mnemonic": "记忆画面描述（small 留空）",
      "diagnosis": "诊断要点（small 留空）",
      "treatment": "治疗方式（small 留空）",
      "differential": "鉴别诊断（small 留空）",
      "etiology": "病因（small 留空）",
      "prevention": "预防（small 留空）",
      "cards": [
        {{"type": "forward", "question": "...", "answer": "..."}},
        {{"type": "reverse", "question": "...", "answer": "..."}},
        {{"type": "mechanism", "question": "...", "answer": "..."}},
        {{"type": "apply", "question": "...", "answer": "..."}}
      ],
      "nodes": [
        {{"label": "一级子模块名", "detail": "一句话说明", "children": [
          {{"label": "关键词1", "detail": "", "link_to": "对应的其他知识点title（可选）"}},
          {{"label": "关键词2", "detail": ""}}
        ]}}
      ]
    }}
  ],
  "comparisons": [
    {{
      "title": "A vs B 对比",
      "a": "概念A",
      "b": "概念B",
      "dimensions": [
        {{"dim": "发病机制", "value_a": "...", "value_b": "..."}}
      ]
    }}
  ],
  "relations": [
    {{
      "from": "知识点A标题",
      "to": "知识点B标题",
      "type": "cause",
      "note": "为什么A和B有关联"
    }}
  ]
}}"""


def call_deepseek(messages, timeout=None):
    """调用 DeepSeek（OpenAI 兼容格式）chat completions。

    用标准库 urllib，无需 pip。
    返回 assistant 的文本内容。
    """
    if not has_api_key():
        raise RuntimeError("未配置 deepseek_api_key，请在 config.json 填入你的 API key。")

    cfg = load_config()
    url = cfg["deepseek_base_url"].rstrip("/") + "/v1/chat/completions"
    payload = {
        "model": cfg["deepseek_model"],
        "messages": messages,
        "temperature": 0.5,
        "max_tokens": int(cfg.get("deepseek_max_tokens", 8192)),
        "response_format": {"type": "json_object"},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg['deepseek_api_key']}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return body["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"DeepSeek API 错误 {e.code}: {err}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"网络错误：{e.reason}") from None


AI_JSON_KEYS = (
    "points", "comparisons", "relations", "title", "size", "duplicate_of",
    "mechanism", "clinical", "mnemonic", "diagnosis", "treatment",
    "differential", "etiology", "prevention", "cards", "type", "question",
    "answer", "nodes", "label", "detail", "children", "link_to", "a", "b",
    "dimensions", "dim", "value_a", "value_b", "from", "to", "from_title",
    "to_title", "note", "comparison", "mappings", "small_id", "big_id",
    "unmatched",
)


def _write_ai_json_debug(candidate, repaired, error):
    try:
        os.makedirs(USER_DATA_DIR, exist_ok=True)
        with open(os.path.join(USER_DATA_DIR, "last-ai-json-raw.txt"), "w", encoding="utf-8") as f:
            f.write(candidate)
        with open(os.path.join(USER_DATA_DIR, "last-ai-json-repaired.txt"), "w", encoding="utf-8") as f:
            f.write(repaired)
        with open(os.path.join(USER_DATA_DIR, "last-ai-json-error.txt"), "w", encoding="utf-8") as f:
            f.write(str(error))
    except OSError:
        pass


def _close_unclosed_json_containers(candidate):
    stack = []
    in_string = False
    escaped = False

    for ch in candidate:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
        elif ch == "{":
            stack.append("}")
        elif ch == "[":
            stack.append("]")
        elif ch in "}]":
            if stack and stack[-1] == ch:
                stack.pop()

    suffix = '"' if in_string else ""
    if stack:
        suffix += "\n" + "".join(reversed(stack))
    return candidate + suffix


def _loads_ai_json(candidate):
    """Parse model JSON, repairing small formatting slips that LLMs commonly make."""
    try:
        return json.loads(candidate)
    except json.JSONDecodeError as first_error:
        repaired = candidate
        for _ in range(3):
            before = repaired
            # Missing comma before the next object property:
            # {"a": "x" "b": "y"} -> {"a": "x", "b": "y"}
            repaired = re.sub(
                r'(?<=[0-9}\]"])\s*(?="(?:[^"\\]|\\.)*"\s*:)',
                ", ",
                repaired,
            )
            # Object property written with a comma instead of a colon:
            # {"title", "A"} -> {"title": "A"}
            for key in AI_JSON_KEYS:
                repaired = re.sub(
                    rf'(?P<prefix>[{{,]\s*)"{re.escape(key)}"\s*,\s*(?=["{{\[\-0-9]|true|false|null)',
                    rf'\g<prefix>"{key}": ',
                    repaired,
                )
            # Missing comma between adjacent array/object values:
            # [{"a":1} {"b":2}] -> [{"a":1}, {"b":2}]
            repaired = re.sub(r'(?<=[}\]"])\s*(?=[{\[])', ", ", repaired)
            # Trailing comma before a closing object/array.
            repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
            repaired = _close_unclosed_json_containers(repaired)
            if repaired == before:
                break

        try:
            return json.loads(repaired)
        except json.JSONDecodeError as repaired_error:
            _write_ai_json_debug(candidate, repaired, repaired_error)
            raise first_error


def _strip_markdown_fence(text):
    text = text.strip()
    if not text.startswith("```"):
        return text
    lines = text.split("\n")
    start = 1
    end = len(lines)
    for i in range(1, len(lines)):
        if lines[i].strip().startswith("```"):
            end = i
            break
    return "\n".join(lines[start:end]).strip()


def _iter_json_candidates(text):
    cleaned = _strip_markdown_fence(text)
    seen = set()

    def add(candidate):
        candidate = candidate.strip()
        if candidate and candidate not in seen:
            seen.add(candidate)
            return candidate
        return None

    candidate = add(cleaned)
    if candidate:
        yield candidate

    first = cleaned.find("{")
    last = cleaned.rfind("}")
    if first != -1 and last != -1 and last > first:
        candidate = add(cleaned[first:last + 1])
        if candidate:
            yield candidate
    if first != -1:
        candidate = add(cleaned[first:])
        if candidate:
            yield candidate


def _extract_complete_objects_from_array(text, key):
    marker = re.search(rf'"{re.escape(key)}"\s*:\s*\[', text)
    if not marker:
        return []

    items = []
    start = marker.end()
    depth = 0
    object_start = None
    in_string = False
    escaped = False

    for idx in range(start, len(text)):
        ch = text[idx]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
        elif ch == "{":
            if depth == 0:
                object_start = idx
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and object_start is not None:
                    raw_object = text[object_start:idx + 1]
                    try:
                        items.append(_loads_ai_json(raw_object))
                    except (json.JSONDecodeError, ValueError):
                        pass
                    object_start = None
        elif ch == "]" and depth == 0:
            break
    return items


def _salvage_ai_result(text):
    cleaned = _strip_markdown_fence(text)
    first = cleaned.find("{")
    if first != -1:
        cleaned = cleaned[first:]
    points = _extract_complete_objects_from_array(cleaned, "points")
    comparisons = _extract_complete_objects_from_array(cleaned, "comparisons")
    relations = _extract_complete_objects_from_array(cleaned, "relations")
    if not points and not comparisons and not relations:
        return None
    return {
        "points": points,
        "comparisons": comparisons,
        "relations": relations,
        "_repair_warnings": ["AI 返回的 JSON 不完整，已尽量保留可解析的完整条目。"],
    }


def _normalize_ai_result(data):
    if not isinstance(data, dict):
        raise ValueError("AI 返回的 JSON 顶层不是对象。")
    data.setdefault("points", [])
    data.setdefault("comparisons", [])
    data.setdefault("relations", [])
    return data


def extract_json(text):
    """Extract and repair the JSON object returned by the model."""
    last_error = None
    cleaned = _strip_markdown_fence(text)
    for candidate in _iter_json_candidates(text):
        try:
            data = _normalize_ai_result(_loads_ai_json(candidate))
            idx = cleaned.find(candidate)
            tail = cleaned[idx + len(candidate):].strip() if idx != -1 else ""
            if tail and re.search(r'[{}\[\]":]', tail):
                data.setdefault("_repair_warnings", []).append(
                    "AI 返回的 JSON 尾部不完整，已保留前面可解析的内容。"
                )
            return data
        except (json.JSONDecodeError, ValueError) as e:
            last_error = e

    salvaged = _salvage_ai_result(text)
    if salvaged:
        return salvaged

    _write_ai_json_debug(cleaned, cleaned, last_error or "No parseable JSON found")
    raise ValueError(f"AI returned unparseable JSON: {last_error or 'no JSON object found'}")


def generate_cards(text, subject, existing_titles=None):
    """完整流程：文本 + 学科 → 结构化知识点 JSON。

    existing_titles: 现有知识点清单，注入 prompt 供 AI 去重。
    返回 dict: {"points": [...], "comparisons": [...]}
    """
    if not text.strip():
        raise ValueError("文本不能为空。")

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_user_prompt(text, subject, existing_titles)},
    ]
    raw = call_deepseek(messages)
    return extract_json(raw)


def attach_small_points(big_points, small_points):
    """用 AI 把小知识点分配到同学科最相关的大知识点。

    big_points: [{id, title, tag}]
    small_points: [{id, title, tag}]
    返回 [{small_id, big_id}] —— 每个 small 分配给一个 big。
    匹配不上的（找不到合适大点）不返回。
    """
    if not big_points or not small_points:
        return []

    # 构造大点清单（按学科分组），供 AI 参考
    big_by_tag = {}
    for b in big_points:
        big_by_tag.setdefault(b["tag"] or "", []).append(b)

    prompt = """你是一位医学教育专家。请把下面的小知识点（孤立事实）分配到同学科最相关的大知识点下。

规则：
1. 每个小知识点必须分配给【同 tag 学科】的大知识点。
2. 选择语义上最相关的大知识点（如「XX的定义」这类小点，应归到「XX」相关的大点下）。
3. 如果该学科没有合适的大知识点，把 small_id 放到 unmatched 数组里，不要硬塞。
4. 输出严格 JSON，不要额外文字。

【大知识点清单（按学科）】
"""
    for tag, bps in big_by_tag.items():
        prompt += f"\n[{tag}]\n"
        for b in bps:
            prompt += f"  - {b['id']}|{b['title']}\n"

    prompt += "\n【待分配的小知识点】\n"
    for s in small_points:
        prompt += f"  - {s['id']}|{s['tag'] or ''}|{s['title']}\n"

    prompt += """
【输出格式】
{
  "mappings": [{"small_id": 123, "big_id": 456}],
  "unmatched": [小知识点id数组]
}"""

    messages = [
        {"role": "system", "content": "你是医学教育专家，擅长知识归类。只输出 JSON。"},
        {"role": "user", "content": prompt},
    ]
    raw = call_deepseek(messages)
    data = extract_json(raw)
    # 校验 big_id 确实属于 small 的同学科
    big_id_set = {b["id"] for b in big_points}
    small_id_set = {s["id"] for s in small_points}
    tag_of_big = {b["id"]: (b["tag"] or "") for b in big_points}
    tag_of_small = {s["id"]: (s["tag"] or "") for s in small_points}
    result = []
    for m in data.get("mappings", []):
        sid, bid = m.get("small_id"), m.get("big_id")
        if sid in small_id_set and bid in big_id_set:
            # 同学科才接受
            if tag_of_small.get(sid) == tag_of_big.get(bid):
                result.append({"small_id": sid, "big_id": bid})
    return result
