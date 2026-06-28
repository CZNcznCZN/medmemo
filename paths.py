"""统一路径管理 —— 兼容开发态和 PyInstaller 打包态。

两个核心概念：
- BUNDLE_DIR：程序自身文件所在（static/、data/、seed.json）。PyInstaller 单文件模式下是 sys._MEIPASS（临时解压目录），只读。
- USER_DATA_DIR：用户数据（flashcards.db、config.json）。放 APPDATA 或程序旁，可写。

为什么分开：
PyInstaller --onefile 打包后，exe 解压到临时目录运行，该目录只读。
数据库和配置必须写到用户可写目录，否则首次运行就因写不进而崩溃。
"""
import os
import sys


def _bundle_dir():
    """程序自身文件所在目录。兼容 PyInstaller。"""
    if getattr(sys, "frozen", False):
        # PyInstaller 单文件模式：资源在临时解压目录
        return sys._MEIPASS
    # 开发态：脚本所在目录
    return os.path.dirname(os.path.abspath(__file__))


def _user_data_dir():
    """用户数据目录（可写）。优先 APPDATA，回退程序旁。"""
    if getattr(sys, "frozen", False):
        # 打包态：用 APPDATA/项目名，保证可写
        base = os.environ.get("APPDATA") or os.environ.get("HOME") or os.path.expanduser("~")
        d = os.path.join(base, "MedMemo")
    else:
        # 开发态：就在程序目录（保持原来的行为，db 在项目里方便调试）
        d = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(d, exist_ok=True)
    return d


BUNDLE_DIR = _bundle_dir()
USER_DATA_DIR = _user_data_dir()

# 静态资源（只读，跟随程序）
STATIC_DIR = os.path.join(BUNDLE_DIR, "static")
SEED_PATH = os.path.join(BUNDLE_DIR, "data", "seed.json")

# 用户数据（可写）
DB_PATH = os.path.join(USER_DATA_DIR, "flashcards.db")
CONFIG_PATH = os.path.join(USER_DATA_DIR, "config.json")
SEED_MARKER = os.path.join(USER_DATA_DIR, ".seeded")  # 种子初始化标记
