/* global chrome */
const status = document.querySelector("#status");
const buttons = Array.from(document.querySelectorAll("button"));
for (const button of buttons) button.addEventListener("click", async () => {
  buttons.forEach((item) => { item.disabled = true; });
  status.textContent = "正在连接当前网页…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//i.test(tab.url ?? "")) throw new Error("请在普通网页使用，浏览器设置页和本地文件不支持。");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["capture.js", "content.js"] });
    const result = await chrome.tabs.sendMessage(tab.id, { type: "code-atlas-copy", mode: button.id });
    if (!result?.ok) throw new Error(result?.error || "无法启用，请刷新网页后重试。");
    status.textContent = result.message;
    if (button.id === "select") window.close();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "连接失败，请刷新网页后重试。";
  } finally { buttons.forEach((item) => { item.disabled = false; }); }
});
