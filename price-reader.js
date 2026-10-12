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
  if (/(^|\.)repco\.co\.nz$/i.test(url.hostname) && /\/p\/[^/]+\/?$/.test(url.pathname) && typeof selector === "string") {
    const code = url.pathname.match(/\/p\/([^/]+)\/?$/)[1];
    // Match the requested product, not related products or a site's price range.
    function productPrice(value) {
      if (!value || typeof value !== "object") return null;
      if (Array.isArray(value)) {
        for (const item of value) { const result = productPrice(item); if (result) return result; }
        return null;
      }
      const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
      let sameProduct = String(value.sku || value.productID || "") === code;
      try { sameProduct ||= new URL(value.url || value["@id"], url).pathname.replace(/\/$/, "") === url.pathname.replace(/\/$/, ""); } catch { /* No product URL. */ }
      if (types.includes("Product") && sameProduct) {
        const offers = Array.isArray(value.offers) ? value.offers : [value.offers];
        for (const offer of offers) {
          const raw = offer?.price;
          if ((typeof raw !== "string" && typeof raw !== "number") || String(raw).trim() === "") continue;
          const price = Number(String(raw).replace(/,/g, ""));
          if (Number.isFinite(price) && price >= 0 && (!offer.priceCurrency || offer.priceCurrency === "NZD")) {
            return { ok: true, price, text: `NZ$${price}` };
          }
        }
      }
      return productPrice(value["@graph"]);
    }
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { const result = productPrice(JSON.parse(script.textContent)); if (result) return result; }
      catch { /* Invalid structured data must not prevent the saved selector fallback. */ }
    }
  }
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
