// Self-contained so the same reader can also be injected into product tabs.
function readProductPrice(doc, selector, pageUrl) {
  function parse(text) {
    const found = String(text).replace(/\s/g, "").match(/-?\d[\d.,]*/);
    if (!found) return NaN;
    let value = found[0];
    value = value.lastIndexOf(",") > value.lastIndexOf(".")
      ? value.replace(/\./g, "").replace(",", ".") : value.replace(/,/g, "");
    return Number(value);
  }
  let element;
  const url = new URL(pageUrl);
  if (/(^|\.)thewarehouse\.co\.nz$/i.test(url.hostname) && /^\/p\//.test(url.pathname)) {
    // Promotion markup changes the saved CSS path. Read the main product's
    // price, never recommendation cards or delivery charges.
    element = doc.querySelector('[data-test-id="price-lockup"] [data-test-id="price"][data-price]');
  }
  if (!element) element = typeof selector === "string" ? doc.querySelector(selector) : selector;
  if (!element) throw new Error("页面结构已变化，请重新选择价格");
  const lockup = element.closest("[data-price]");
  let text = lockup?.getAttribute("data-price") || element.textContent.trim();
  let price = parse(text);
  if (!lockup) {
    const container = element.closest(".price") || element;
    const dollars = container.querySelector(".price__dollars");
    const cents = container.querySelector(".price__cents");
    if (dollars && cents && /^\d+$/.test(dollars.textContent.trim()) && /^\d{2}$/.test(cents.textContent.trim())) {
      text = `${container.querySelector(".price__currency")?.textContent.trim() || ""}${dollars.textContent.trim()}.${cents.textContent.trim()}`;
      price = parse(text);
    }
  }
  if (!Number.isFinite(price)) throw new Error("无法从所选元素解析价格");
  return { ok: true, price, text };
}
globalThis.readProductPrice = readProductPrice;
