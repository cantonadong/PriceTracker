chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "PARSE_OFFSCREEN") return;
  try {
    const doc = new DOMParser().parseFromString(message.html, "text/html");
    const element = doc.querySelector(message.selector);
    if (!element) throw new Error("页面结构已变化，请重新选择价格");
    const text = element.textContent.trim();
    const price = parsePrice(text);
    if (!Number.isFinite(price)) throw new Error("无法从所选元素解析价格");
    sendResponse({ ok: true, price, text });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
});

function parsePrice(text) {
  const found = String(text).replace(/\s/g, "").match(/-?\d[\d.,]*/);
  if (!found) return NaN;
  let value = found[0];
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  if (comma > dot) value = value.replace(/\./g, "").replace(",", ".");
  else value = value.replace(/,/g, "");
  return Number(value);
}
