import assert from "node:assert/strict";

/** Creates and deletes only its own fixture project on the running local app. */
export async function checkLanguageImport(language, files, inspect) {
  const base = "http://localhost:3000";
  let projectId;
  try {
    const form = new FormData();
    form.set("mode", "folder");
    form.set("name", `${language} language integration fixture`);
    form.set("paths", JSON.stringify(files.map(([path]) => path)));
    for (const [path, content] of files) form.append("files", new Blob([content]), path.split("/").at(-1));
    const importedReply = await fetch(`${base}/api/projects`, { method: "POST", body: form });
    const imported = await importedReply.json();
    assert.equal(importedReply.status, 201, JSON.stringify(imported));
    projectId = imported.id;
    const root = `${base}/api/projects/${projectId}`;
    const treeReply = await fetch(`${root}/tree`);
    assert.equal(treeReply.status, 200);
    const tree = await treeReply.json();
    assert.ok(tree.files.some((file) => file.language === language));
    assert.ok(tree.symbols.length);
    const detail = async (symbol) => {
      const response = await fetch(`${root}/symbols/${symbol.id}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const analysis = async (symbol) => {
      const response = await fetch(`${root}/symbols/${symbol.id}/analysis`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.ok(body.flow?.nodes.length);
      return body;
    };
    await inspect({ tree, detail, analysis, root });
  } finally {
    if (projectId) assert.equal((await fetch(`${base}/api/projects/${projectId}`, { method: "DELETE" })).status, 200);
  }
}
