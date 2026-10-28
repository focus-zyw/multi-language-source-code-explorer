/* global chrome */
(() => {
  if (globalThis.CodeAtlasCopyUI) return;
  const uiStyle = `
    :host{all:initial;font:13px/1.5 system-ui,sans-serif;color:#302a26;color-scheme:light}
    *{box-sizing:border-box} button{font:inherit;cursor:pointer;padding:6px 10px;border:1px solid #b9aaa0;border-radius:6px;background:#faf8f5;color:#302a26}
    button:hover{background:#eee5dd} button:focus-visible{outline:2px solid #925c42;outline-offset:2px} button:disabled{opacity:.55;cursor:wait}
    .bar{display:flex;gap:8px;align-items:center;margin:8px 0}.panel{width:min(340px,calc(100vw - 32px));padding:14px;background:#faf8f5;border:1px solid #b9aaa0;border-radius:8px;box-shadow:0 4px 24px #0003}
    h2{font-size:15px;margin:0 0 8px} p{margin:8px 0;overflow-wrap:anywhere}.actions{display:flex;gap:8px;flex-wrap:wrap}.primary{background:#925c42;color:white;border-color:#925c42}
    ul{padding-left:18px;max-height:160px;overflow:auto;color:#86562e}.hint{font-size:12px;color:#75675e}
    @media(prefers-color-scheme:dark){:host{color:#eee5dd}.panel,button{background:#272320;color:#eee5dd;border-color:#746457}button:hover{background:#443931}.hint{color:#c1b2a6}ul{color:#e6b780}}
  `;
  const replyBars = new Map();
  let panel, panelRoot, outline, selected, hover, selectionMode = false, observer, timer, copying = false, lastUrl = location.href;
  const own = (event) => event.composedPath().some((part) => part instanceof Element && part.hasAttribute("data-code-atlas-copy-ui"));
  function host(kind) {
    const element = document.createElement("div"); element.setAttribute("data-code-atlas-copy-ui", kind);
    const shadow = element.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet(); sheet.replaceSync(uiStyle); shadow.adoptedStyleSheets = [sheet];
    return [element, shadow];
  }
  function button(label, action, primary = false) {
    const element = document.createElement("button"); element.type = "button"; element.textContent = label;
    if (primary) element.className = "primary";
    element.addEventListener("click", action); return element;
  }
  function status(text, warnings = []) {
    ensurePanel();
    panelRoot.querySelector("[role=status]").textContent = text;
    const list = panelRoot.querySelector("ul"); list.replaceChildren();
    for (const warning of warnings) { const item = document.createElement("li"); item.textContent = warning; list.append(item); }
    list.hidden = !warnings.length;
  }
  function ensurePanel() {
    if (panel?.isConnected) return;
    [panel, panelRoot] = host("panel");
    Object.assign(panel.style, { position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647" });
    const container = document.createElement("section"); container.className = "panel"; container.setAttribute("aria-label", "Code Atlas 增强复制工具");
    const heading = document.createElement("h2"); heading.textContent = "Code Atlas 增强复制";
    const text = document.createElement("p"); text.setAttribute("role", "status"); text.setAttribute("aria-live", "polite");
    const warnings = document.createElement("ul"); warnings.hidden = true;
    const actions = document.createElement("div"); actions.className = "actions";
    const copy = button("复制所选区域", () => copyRoot(selected), true); copy.dataset.action = "copy"; copy.hidden = true;
    const parent = button("扩大选区", () => {
      if (selected?.parentElement && !selected.parentElement.matches("html,body")) { selected = selected.parentElement; draw(selected); status("选区已扩大。确认边框范围后复制。"); }
    }); parent.dataset.action = "parent"; parent.hidden = true;
    actions.append(copy, parent, button("选择区域", startSelection), button("关闭", close));
    const hint = document.createElement("p"); hint.className = "hint"; hint.textContent = "粘贴到文件笔记后可继续编辑和保存。Esc 取消选区。";
    container.append(heading, text, warnings, actions, hint); panelRoot.append(container); document.body.append(panel);
  }
  function draw(element) {
    if (!outline) {
      outline = document.createElement("div"); outline.setAttribute("data-code-atlas-copy-ui", "outline");
      Object.assign(outline.style, { position: "fixed", pointerEvents: "none", border: "2px solid #b97750", background: "#b9775010", zIndex: "2147483646", boxSizing: "border-box" });
      document.body.append(outline);
    }
    const rect = element.getBoundingClientRect();
    Object.assign(outline.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  function stopSelection() {
    selectionMode = false; hover = null;
    document.removeEventListener("pointermove", onPointer, true); document.removeEventListener("click", onPick, true);
  }
  function onPointer(event) {
    if (own(event) || !(event.target instanceof Element)) return;
    const node = event.target.closest("p,pre,table,ul,ol,section,article,div") ?? event.target;
    if (node.matches("html,body") || node.closest("[data-code-atlas-copy-ui]")) return;
    hover = node; draw(node);
  }
  function onPick(event) {
    if (own(event)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!hover) return;
    selected = hover; stopSelection(); draw(selected);
    panelRoot.querySelector('[data-action="copy"]').hidden = false;
    panelRoot.querySelector('[data-action="parent"]').hidden = false;
    status("已选中边框内的区域。可扩大选区，然后复制。");
  }
  function startSelection() {
    if (copying) return;
    ensurePanel(); stopSelection(); selected = null; outline?.remove(); outline = null;
    panelRoot.querySelector('[data-action="copy"]').hidden = true;
    panelRoot.querySelector('[data-action="parent"]').hidden = true;
    selectionMode = true;
    document.addEventListener("pointermove", onPointer, true); document.addEventListener("click", onPick, true);
    status("移动鼠标查看边框，点击选择内容区域。Esc 取消。");
  }
  function onKey(event) {
    if (event.key !== "Escape" || !selectionMode) return;
    stopSelection(); outline?.remove(); outline = null; status("已取消区域选择。");
  }
  function updateOutline() { if (selected?.isConnected || hover?.isConnected) draw(selected ?? hover); }
  async function copyRoot(root) {
    if (copying) return;
    if (!root?.isConnected) { status("原内容已离开页面，请重新选择。"); return; }
    copying = true; status("正在准备复制内容…");
    panelRoot.querySelectorAll("button").forEach((item) => { item.disabled = true; });
    replyBars.forEach((bar) => { bar.shadowRoot.querySelector("button").disabled = true; });
    try {
      const message = root.closest('[data-message-author-role="assistant"]');
      const turn = message?.closest('article,[data-testid^="conversation-turn-"]') ?? message;
      if (turn?.querySelector('[data-is-streaming="true"],[aria-busy="true"]') || document.querySelector('[data-testid="stop-button"],button[aria-label="Stop streaming"],button[aria-label="停止流式传输"]')) throw new Error("回复仍在生成，请完成后再复制。");
      const result = globalThis.CodeAtlasCopy.capture(root);
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("当前网页无法写入富文本剪贴板，请在 HTTPS 网页使用。");
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([result.html], { type: "text/html" }),
        "text/plain": new Blob([result.plain], { type: "text/plain" }),
      })]);
      status(`已复制：${result.report.codeBlocks} 个代码块、${result.report.formulas} 个公式、${result.report.layouts} 个布局。请粘贴到文件笔记。`, result.report.warnings);
    } catch (error) { status(`复制失败：${error instanceof Error ? error.message : "请重试"}`); }
    finally {
      copying = false;
      panelRoot?.querySelectorAll("button").forEach((item) => { item.disabled = false; });
      replyBars.forEach((bar) => { bar.shadowRoot.querySelector("button").disabled = false; });
    }
  }
  function scanReplies() {
    for (const [root, bar] of replyBars) if (!root.isConnected || !bar.isConnected) { bar.remove(); replyBars.delete(root); }
    const roots = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).filter((node) => !node.parentElement?.closest('[data-message-author-role="assistant"]'));
    const active = new Set(roots.slice(-100));
    for (const [root, bar] of replyBars) if (!active.has(root)) { bar.remove(); replyBars.delete(root); }
    for (const root of active) {
      if (replyBars.has(root)) continue;
      const [bar, shadow] = host("reply");
      const actions = document.createElement("div"); actions.className = "bar";
      actions.append(button("增强复制", () => copyRoot(root)));
      shadow.append(actions); root.before(bar); replyBars.set(root, bar);
    }
    return roots.length;
  }
  function close() {
    if (copying) return;
    stopSelection(); observer?.disconnect(); observer = null; clearTimeout(timer);
    replyBars.forEach((bar) => bar.remove()); replyBars.clear();
    panel?.remove(); panel = null; panelRoot = null; outline?.remove(); outline = null; selected = null;
    document.removeEventListener("keydown", onKey, true); document.removeEventListener("scroll", updateOutline, true); window.removeEventListener("resize", updateOutline);
  }
  function activate(mode) {
    if (mode === "close") {
      if (copying) return { ok: false, error: "正在复制，请完成后再关闭工具。" };
      close(); return { ok: true, message: "本页工具已关闭。" };
    }
    ensurePanel();
    document.addEventListener("keydown", onKey, true); document.addEventListener("scroll", updateOutline, true); window.addEventListener("resize", updateOutline);
    if (mode === "select") { startSelection(); return { ok: true, message: "请在网页上点击选择区域。" }; }
    stopSelection(); outline?.remove(); outline = null; selected = null;
    panelRoot.querySelector('[data-action="copy"]').hidden = true; panelRoot.querySelector('[data-action="parent"]').hidden = true;
    const count = scanReplies();
    status(count ? `已启用 ${Math.min(count, 100)} 条已加载回复的增强复制。` : "尚未识别到回复。可使用“选择区域”，或加载回复后重试。");
    if (!observer) {
      observer = new MutationObserver((records) => {
        if (!records.some((record) => !(record.target instanceof Element) || !record.target.closest("[data-code-atlas-copy-ui]"))) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (location.href !== lastUrl) { lastUrl = location.href; stopSelection(); selected = null; outline?.remove(); outline = null; }
          scanReplies();
        }, 150);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    return { ok: true, message: count ? "已启用。关闭此窗口，点击回复旁的“增强复制”。" : "未识别到回复，请使用“选择页面区域”。" };
  }
  globalThis.CodeAtlasCopyUI = Object.freeze({ activate });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== "code-atlas-copy") return;
    if (!["replies", "select", "close"].includes(message.mode)) { respond({ ok: false, error: "不支持的操作" }); return; }
    try { respond(activate(message.mode)); } catch { respond({ ok: false, error: "无法启用，请刷新网页后重试。" }); }
  });
})();
