"""仅运行自建临时源码，验证真实插件不会混入另一个类的同名方法。"""
import importlib.util
import os
import pathlib
import sys
import tempfile

plugin_path = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory(prefix="atlas-plugin-test-") as temp:
    target = pathlib.Path(temp) / "fixture.py"
    target.write_text("class A:\n    def run(self):\n        return 'A'\nclass B:\n    def run(self):\n        return 'B'\n", encoding="utf-8")
    os.environ.update(ATLAS_TRACE_FILE=str(target), ATLAS_TRACE_FUNC="run", ATLAS_TRACE_START_LINE="2", ATLAS_TRACE_END_LINE="3")
    spec = importlib.util.spec_from_file_location("trace_plugin", plugin_path)
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    namespace = {}
    exec(compile(target.read_text(encoding="utf-8"), str(target), "exec"), namespace)
    plugin.pytest_sessionstart(None)
    try:
        namespace["A"]().run()
        namespace["B"]().run()
    finally:
        plugin.pytest_sessionfinish(None, 0)
    assert plugin.STATE["calls"] == 1, plugin.STATE
    assert plugin.STATE["roots"][0]["ret"] == "'A'", plugin.STATE
print("plugin identity OK")
