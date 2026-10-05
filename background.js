import "./price-reader.js";
import "./watch-state.js";
import * as watchStore from "./watch-store.js";
const ALARM = "price-watch-hourly";
const OFFSCREEN_URL = "offscreen.html";
let refreshQueue = Promise.resolve();
const pendingBackgroundRefreshes = new Set();
watchStore.initialize().catch(reportBackgroundError);

function reportBackgroundError(error) {
  console.error("价格守望：", error);
}

function queueRefresh(task) {
  const result = refreshQueue.then(task);
  refreshQueue = result.catch(() => {});
  return result;
}

async function restoreBackground(firstInstall = false) {
  await chrome.alarms.create(ALARM, { ...(firstInstall ? { delayInMinutes: 1 } : {}), periodInMinutes: 60 });
  await watchStore.initialize();
  await watchStore.flushSync();
  await updateBadge();
}
chrome.runtime.onInstalled.addListener(() => restoreBackground(true).catch(reportBackgroundError));
chrome.runtime.onStartup.addListener(() => restoreBackground().catch(reportBackgroundError));

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) refreshAll().catch(reportBackgroundError);
});

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !/^https?:/i.test(tab.url || "")) return openDashboard();
  const watches = await watchStore.getWatches();
  const alreadyWatched = watches.some(w => w.url === normalizeUrl(tab.url));
  const hasAlerts = watches.some(w => WatchState.isTriggered(w));
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
  if (area !== "local" || !changes.watches) return;
  const watches = changes.watches.newValue || [];
  updateBadge(watches).catch(reportBackgroundError);
  // Synced rows acquire this device's price without asking the user to refresh.
  for (const watch of watches) {
    if (watch.status !== "pending" || WatchState.hasPrice(watch) || pendingBackgroundRefreshes.has(watch.id)) continue;
    pendingBackgroundRefreshes.add(watch.id);
    queueRefresh(async () => {
      try { return await refreshWatch(watch.id, false); }
      finally { pendingBackgroundRefreshes.delete(watch.id); }
    }).catch(reportBackgroundError);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // All persistent configuration edits go through the worker's serial store.
  const storeMessages = {
    WATCH_READY: () => watchStore.initialize().then(() => ({ ok: true })),
    WATCH_PATCH: () => watchStore.patchWatch(message.id, message.patch).then(saved => ({ ok: true, saved })),
    WATCH_DELETE: () => watchStore.deleteWatch(message.id).then(removed => ({ ok: true, removed })),
    WATCH_ORDER: () => watchStore.setOrder(message.ids).then(() => ({ ok: true })),
    WATCH_SORT: () => watchStore.sortByPrice().then(() => ({ ok: true }))
  };
  if (Object.hasOwn(storeMessages, message.type)) {
    Promise.resolve().then(storeMessages[message.type]).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
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
    saveWatch(message.watch).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "REFRESH_ALL") {
    refreshAll(true).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "REFRESH_ONE") {
    refreshOne(message.id).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`picker-${tabId}`);
});

async function openWatchPicker(id) {
  const watches = await watchStore.getWatches();
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
  const watch = await watchStore.saveWatch(input);
  await updateBadge();
  return { ok: true, watch };
}

function refreshAll(interactive = false) {
  return queueRefresh(async () => {
  const watches = await watchStore.getWatches();
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
  const snapshot = await watchStore.getRefreshSnapshot(id);
  if (!snapshot) return { ok: false, error: "商品已删除" };
  const { watch, expected } = snapshot;
  // An installation alarm may run just after a successful manual refresh.
  if (!interactive && watch.status === "ok" && Date.now() - (watch.lastSuccessAt || 0) < 60000) {
    return { ok: true, watch };
  }
  await fetchPrice(watch, interactive);
  const committed = await watchStore.commitPrice(id, expected, watch);
  if (!committed) {
    return { ok: false, error: "商品已修改，请重新刷新" };
  }
  if (committed.notify) notify(committed.watch);
  await updateBadge();
  return { ok: watch.status !== "error", error: watch.error, watch: committed.watch };
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
  const watches = provided || await watchStore.getWatches();
  const count = watches.filter(w => WatchState.isTriggered(w)).length;
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
