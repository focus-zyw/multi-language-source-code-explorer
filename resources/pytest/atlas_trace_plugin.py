"""pytest 插件：测试运行期间记录指定符号的调用，产出带真实状态的调用日志。

由 Code Atlas 注入，不需要修改被测项目：通过 PYTHONPATH 提供本文件，
再用 `-p atlas_trace_plugin` 加载。结果写入 ATLAS_TRACE_OUT 指定的 JSON。

环境变量：
  ATLAS_TRACE_FILE      目标文件（相对项目根，或绝对路径）
  ATLAS_TRACE_FUNC      目标函数名；留空表示整个文件
  ATLAS_TRACE_OUT       结果 JSON 路径
  ATLAS_TRACE_MAX_NODES 最多记录的调用数，默认 300
  ATLAS_TRACE_MAX_DEPTH 最大嵌套深度，默认 20
"""

import json
import ast
import os
import sys

MAX_NODES = int(os.environ.get("ATLAS_TRACE_MAX_NODES", "300"))
MAX_DEPTH = int(os.environ.get("ATLAS_TRACE_MAX_DEPTH", "20"))
MAX_REPR = 90
MAX_ARGS = 8

STATE = {"nodes": 0, "calls": 0, "truncated": False, "roots": [], "stack": []}
CACHE = {}
TARGET_FILE = None
TARGET_FUNC = os.environ.get("ATLAS_TRACE_FUNC", "")
TARGET_LINE = None


def _norm(path):
    return os.path.normcase(os.path.abspath(path))


def _short(value):
    try:
        text = repr(value)
    except BaseException:
        text = "<无法显示>"
    return text if len(text) <= MAX_REPR else text[:MAX_REPR] + "…"


def _capture(frame):
    return [{"name": key, "value": _short(value)} for key, value in list(frame.f_locals.items())[:MAX_ARGS]]


def _profile(frame, event, arg):
    code = frame.f_code
    hit = CACHE.get(code)
    if hit is None:
        hit = code.co_name == TARGET_FUNC and code.co_firstlineno == TARGET_LINE and _norm(code.co_filename) == TARGET_FILE
        CACHE[code] = hit
    if not hit:
        return
    if event == "call":
        if STATE["nodes"] >= MAX_NODES or len(STATE["stack"]) >= MAX_DEPTH:
            STATE["truncated"] = True
            return
        STATE["nodes"] += 1
        STATE["calls"] += 1
        node = {"id": STATE["nodes"], "func": code.co_name, "args": _capture(frame), "ret": None,
                "line": frame.f_lineno, "depth": len(STATE["stack"]), "children": []}
        if STATE["stack"]:
            STATE["stack"][-1][1]["children"].append(node)
        else:
            STATE["roots"].append(node)
        STATE["stack"].append((frame, node))
    elif event == "return":
        if STATE["stack"] and STATE["stack"][-1][0] is frame:
            STATE["stack"].pop()[1]["ret"] = _short(arg)


def pytest_sessionstart(session):
    global TARGET_FILE, TARGET_LINE
    raw = os.environ.get("ATLAS_TRACE_FILE", "")
    TARGET_FILE = _norm(raw) if raw else None
    start = int(os.environ["ATLAS_TRACE_START_LINE"])
    end = int(os.environ["ATLAS_TRACE_END_LINE"])
    # 装饰器属于 code.co_firstlineno；静态符号的起点可能是装饰器，也可能是 def。
    with open(TARGET_FILE, encoding="utf-8-sig") as handle:
        tree = ast.parse(handle.read())
    candidates = [node for node in ast.walk(tree)
                  if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                  and node.name == TARGET_FUNC
                  and min([node.lineno] + [d.lineno for d in node.decorator_list]) <= start <= node.lineno <= end]
    if len(candidates) != 1:
        raise RuntimeError("追踪方法无法唯一定位，请重新扫描")
    node = candidates[0]
    TARGET_LINE = min([node.lineno] + [d.lineno for d in node.decorator_list])
    STATE.update(nodes=0, calls=0, truncated=False, roots=[], stack=[])
    CACHE.clear()
    sys.setprofile(_profile)


def pytest_sessionfinish(session, exitstatus):
    sys.setprofile(None)
    out = os.environ.get("ATLAS_TRACE_OUT")
    if not out:
        return
    payload = {
        "target": {"file": TARGET_FILE, "func": TARGET_FUNC},
        "calls": STATE["calls"],
        "nodeCount": STATE["nodes"],
        "truncated": STATE["truncated"],
        "roots": STATE["roots"],
        "exitstatus": int(exitstatus),
    }
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
