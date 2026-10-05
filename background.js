import "./price-reader.js";
const ALARM = "price-watch-hourly";
const OFFSCREEN_URL = "offscreen.html";
let refreshQueue = Promise.resolve();

function queueRefresh(task) {
  const result = refreshQueue.then(task);
  refreshQueue = result.catch(() => {});
  return result;
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 60 });
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(ALARM, { periodInMinutes: 60 });
  await updateBadge();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) refreshAll();
});

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !/^https?:/i.test(tab.url || "")) return openDashboard();
  const { watches = [] } = await chrome.storage.local.get("watches");
  const alreadyWatched = watches.some(w => w.url === normalizeUrl(tab.url));
  const hasAlerts = watches.some(w => w.triggered);
  if (alreadyWatched || hasAlerts) return openDashboard();
  await startPicker(tab.id);
});

async function startPicker(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  try {
    await chrome.tabs.sendMessage(tabId, { type: "START_PICKER" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["price-reader.js", "content.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "START_PICKER" });
  }
}

chrome.notifications.onClicked.addListener(() => openDashboard());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.watches) updateBadge(changes.watches.newValue || []);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_PICKER_TAB") {
    startPicker(message.tabId).then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "EDIT_WATCH") {
    openWatchPicker(message.id).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "PICKER_READY" && sender.tab && sender.frameId === 0) {
    takePendingPicker(sender.tab.id).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (message.type === "SAVE_WATCH") {
    saveWatch(message.watch).then(sendResponse);
    return true;
  }
  if (message.type === "REFRESH_ALL") {
    refreshAll(true).then(sendResponse);
    return true;
  }
  if (message.type === "REFRESH_ONE") {
    refreshOne(message.id).then(sendResponse);
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`picker-${tabId}`);
});

async function openWatchPicker(id) {
  const { watches = [] } = await chrome.storage.local.get("watches");
  const watch = watches.find(w => w.id === id);
  if (!watch) throw new Error("商品已删除，请刷新列表");
  if (!/^https?:\/\//i.test(watch.url)) throw new Error("商品链接无效");
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  const key = `picker-${tab.id}`;
  try {
    await chrome.storage.session.set({ [key]: { watch, expiresAt: Date.now() + 10 * 60 * 1000 } });
    await chrome.tabs.update(tab.id, { url: watch.url });
    return { ok: true };
  } catch (error) {
    await chrome.storage.session.remove(key);
    throw error;
  }
}

async function takePendingPicker(tabId) {
  const key = `picker-${tabId}`;
  const pending = (await chrome.storage.session.get(key))[key];
  if (!pending) return null;
  await chrome.storage.session.remove(key);
  return pending.expiresAt > Date.now() ? pending.watch : null;
}

async function saveWatch(input) {
  const { watches = [] } = await chrome.storage.local.get("watches");
  const existingIndex = input.id ? watches.findIndex(w => w.id === input.id) : -1;
  const existing = existingIndex >= 0 ? watches[existingIndex] : null;
  const watch = {
    ...existing,
    id: existing?.id || crypto.randomUUID(),
    title: existing?.customTitle ? existing.title : input.title || "未命名商品",
    url: normalizeUrl(input.url),
    selector: input.selector,
    sample: input.sample || "",
    targetPrice: Number(input.targetPrice),
    currentPrice: Number(input.currentPrice),
    currency: input.currency || "",
    updatedAt: Date.now(),
    createdAt: existing?.createdAt || Date.now(),
    triggered: Number(input.currentPrice) <= Number(input.targetPrice),
    status: "ok",
    error: ""
  };
  watch.triggeredAt = watch.triggered
    ? (existing?.triggered ? existing.triggeredAt || existing.updatedAt || watch.updatedAt : watch.updatedAt)
    : null;
  if (existingIndex >= 0) watches.splice(existingIndex, 1, watch);
  else watches.unshift(watch);
  await chrome.storage.local.set({ watches });
  await updateBadge(watches);
  return { ok: true, watch };
}

function refreshAll(interactive = false) {
  return queueRefresh(async () => {
  const { watches = [] } = await chrome.storage.local.get("watches");
  const results = [];
  for (const watch of watches) results.push(await refreshWatch(watch.id, interactive));
  const failed = results.filter(result => !result.ok).length;
  return { ok: failed === 0, failed };
  });
}

function refreshOne(id) {
  return queueRefresh(() => refreshWatch(id, true));
}

async function refreshWatch(id, interactive) {
  const { watches = [] } = await chrome.storage.local.get("watches");
  const watch = watches.find(item => item.id === id);
  if (!watch) return { ok: false };
  // An installation alarm may run just after a successful manual refresh.
  if (!interactive && watch.status === "ok" && Date.now() - (watch.lastSuccessAt || 0) < 60000) {
    return { ok: true, watch };
  }
  const originalUrl = watch.url, originalSelector = watch.selector;
  const originalUpdatedAt = watch.updatedAt;
  await fetchPrice(watch, interactive);
  // Merge into current storage instead of restoring the pre-request list.
  const { watches: latest = [] } = await chrome.storage.local.get("watches");
  const current = latest.find(item => item.id === id);
  if (!current || current.url !== originalUrl || current.selector !== originalSelector || current.updatedAt !== originalUpdatedAt) {
    return { ok: false, error: "商品已修改，请重新刷新" };
  }
  for (const key of ["currentPrice", "sample", "currency", "updatedAt", "lastSuccessAt", "status", "error"]) {
    if (key in watch) current[key] = watch[key];
  }
  current.triggered = Number(current.currentPrice) <= Number(current.targetPrice);
  current.triggeredAt = current.triggered ? current.triggeredAt || watch.triggeredAt || Date.now() : null;
  await chrome.storage.local.set({ watches: latest });
  await updateBadge(latest);
  return { ok: watch.status !== "error", error: watch.error, watch };
}

async function fetchPrice(watch, interactive = false) {
  const wasTriggered = watch.triggered;
  try {
    const result = await readPrice(watch, interactive);
    if (!result?.ok || !Number.isFinite(result.price)) throw new Error(result?.error || "找不到价格元素");
    const previousTriggeredAt = watch.triggeredAt || watch.updatedAt || watch.createdAt;
    watch.currentPrice = result.price;
    watch.sample = result.text;
    watch.currency = detectCurrency(result.text) || watch.currency;
    watch.updatedAt = Date.now();
    watch.lastSuccessAt = watch.updatedAt;
    watch.status = "ok";
    watch.error = "";
    watch.triggered = result.price <= watch.targetPrice;
    watch.triggeredAt = watch.triggered
      ? (wasTriggered ? previousTriggeredAt || watch.updatedAt : watch.updatedAt)
      : null;
    if (watch.triggered && !wasTriggered && watch.notify !== false) notify(watch);
  } catch (error) {
    watch.status = "error";
    watch.error = String(error.message || error);
    watch.updatedAt = Date.now();
  }
}

async function readPrice(watch, interactive = false) {
  try {
    const response = await fetch(watch.url, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(response.status === 403
      ? "网站拒绝后台访问（HTTP 403），请打开商品页，完成登录或验证后再点击刷新"
      : `HTTP ${response.status}`);
    const html = await response.text();
    await ensureOffscreen();
    const result = await chrome.runtime.sendMessage({ type: "PARSE_OFFSCREEN", html, selector: watch.selector, url: watch.url });
    if (!result?.ok || !Number.isFinite(result.price)) throw new Error(result?.error || "找不到价格元素");
    return result;
  } catch (error) {
    if (interactive) return readPriceInBrowser(watch);
    // A normal product tab can contain prices unavailable to a background request.
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs.filter(tab => tab.id && normalizeUrl(tab.url) === normalizeUrl(watch.url))) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["price-reader.js"] });
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: readPagePrice,
          args: [watch.selector, normalizeUrl(watch.url)]
        });
        const result = results[0]?.result;
        if (result?.ok && Number.isFinite(result.price)) return result;
      } catch { /* The tab may have closed or navigated; try another matching tab. */ }
    }
    throw error;
  }
}

async function readPriceInBrowser(watch) {
  if (!/^https?:\/\//i.test(watch.url)) throw new Error("商品链接无效");
  const tabs = await chrome.tabs.query({});
  let tab = tabs.find(tab => tab.id && normalizeUrl(tab.url) === normalizeUrl(watch.url));
  const created = !tab;
  if (!tab) tab = await chrome.tabs.create({ url: watch.url, active: false });
  else {
    // An existing tab may still show a promotion that has already ended.
    await chrome.tabs.reload(tab.id, { bypassCache: true });
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  let result;
  for (let attempt = 0; attempt < 20; attempt++) {
    let current;
    try { current = await chrome.tabs.get(tab.id); }
    catch { throw new Error("商品页面已关闭，请重新点击刷新"); }
    if (current.status === "complete" && /^https?:/i.test(current.url || "")) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["price-reader.js"] });
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, func: readPagePrice,
          args: [watch.selector, normalizeUrl(watch.url)]
        });
        result = results[0]?.result;
        if (result?.ok && Number.isFinite(result.price)) {
          // Only close a temporary tab if the user has not started using it.
          const latest = await chrome.tabs.get(tab.id);
          if (created && !latest.active && normalizeUrl(latest.url) === normalizeUrl(watch.url)) {
            await chrome.tabs.remove(tab.id).catch(() => {});
          }
          return result;
        }
      } catch { /* Wait for navigation or dynamic price rendering to finish. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("已尝试从商品页面读取价格但未成功。请查看已打开的商品页：如需登录或验证，请完成后刷新；若价格已正常显示，请点击修改重新选择价格区域");
}

function readPagePrice(selector, expectedUrl) {
  const url = new URL(location.href);
  url.hash = "";
  if (url.href !== expectedUrl) return { ok: false };
  try { return globalThis.readProductPrice(document, selector, expectedUrl); }
  catch (error) { return { ok: false, error: error.message }; }
}

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (!contexts.length) await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["DOM_PARSER"],
    justification: "解析商品网页中的价格元素"
  });
}

function notify(watch) {
  chrome.notifications.create(`price-${watch.id}`, {
    type: "basic",
    iconUrl: "icon.png",
    title: "价格已达到目标",
    message: `${watch.title} 现在是 ${watch.currency}${watch.currentPrice}`,
    priority: 2
  });
}

async function updateBadge(provided) {
  const watches = provided || (await chrome.storage.local.get("watches")).watches || [];
  const count = watches.filter(w => w.triggered).length;
  await chrome.action.setBadgeBackgroundColor({ color: "rgb(34, 197, 94)" });
  await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  await chrome.action.setBadgeText({ text: count ? String(count) : "" });
}

function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
}

function normalizeUrl(url) {
  try { const parsed = new URL(url); parsed.hash = ""; return parsed.href; } catch { return url; }
}

function detectCurrency(text = "") {
  return text.match(/NZ\$|AU\$|US\$|CNY|RMB|[$€£¥￥]/i)?.[0] || "";
}
