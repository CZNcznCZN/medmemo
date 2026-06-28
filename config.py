"""读取 config.json 配置。无配置文件时使用默认值。

配置文件在 USER_DATA_DIR（打包后是 APPDATA/MedMemo，可写）。
"""
import json
import os
import shutil

from paths import CONFIG_PATH, BUNDLE_DIR

DEFAULTS = {
    "deepseek_api_key": "",
    "deepseek_base_url": "https://api.deepseek.com",
    "deepseek_model": "deepseek-chat",
    "deepseek_max_tokens": 8192,
    "host": "localhost",
    "port": 8000,
    "new_cards_per_day": 0,
    "auto_backup_keep": 7,
}


def _ensure_config_exists():
    """确保用户数据目录有 config.json。

    打包态下首次运行：USER_DATA_DIR 里没有 config.json，
    从程序包内的 config.json 模板复制一份过去。
    """
    if os.path.exists(CONFIG_PATH):
        return
    # 尝试从 bundle 内复制模板（打包时带进去的默认 config）
    template = os.path.join(BUNDLE_DIR, "config.json")
    if os.path.exists(template):
        try:
            shutil.copy(template, CONFIG_PATH)
            return
        except OSError:
            pass
    # 没有模板就用默认值生成一个
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(DEFAULTS, f, ensure_ascii=False, indent=2)
    except OSError:
        pass  # 写不进去也无妨，load_config 会用默认值兜底


def load_config():
    """加载配置，与默认值合并。"""
    _ensure_config_exists()
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
        except (json.JSONDecodeError, OSError):
            pass
    return cfg


def has_api_key():
    return bool(load_config().get("deepseek_api_key", "").strip())
