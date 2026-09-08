const ALARM = "price-watch-hourly";
const OFFSCREEN_URL = "offscreen.html";

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
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "START_PICKER" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await chrome.tabs.sendMessage(tab.id, { type: "START_PICKER" });
  }
});

chrome.notifications.onClicked.addListener(() => openDashboard());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.watches) updateBadge(changes.watches.newValue || []);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SAVE_WATCH") {
    saveWatch(message.watch).then(sendResponse);
    return true;
  }
  if (message.type === "REFRESH_ALL") {
    refreshAll().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "REFRESH_ONE") {
    refreshOne(message.id).then(sendResponse);
    return true;
  }
});

async function saveWatch(input) {
  const { watches = [] } = await chrome.storage.local.get("watches");
  const existingIndex = input.id ? watches.findIndex(w => w.id === input.id) : -1;
  const existing = existingIndex >= 0 ? watches[existingIndex] : null;
  const watch = {
    ...existing,
    id: existing?.id || crypto.randomUUID(),
    title: input.title || "未命名商品",
    url: normalizeUrl(input.url),
    selector: input.selector,
    sample: input.sample || "",
    targetPrice: Number(input.targetPrice),
    currentPrice: Number(input.currentPrice),
    currency: input.currency || "",
    updatedAt: Date.now(),
    createdAt: existing?.createdAt || Date.now(),
    triggered: Number(input.currentPrice) <= Number(input.targetPrice),
    status: "ok"
  };
  if (existingIndex >= 0) watches.splice(existingIndex, 1, watch);
  else watches.unshift(watch);
  await chrome.storage.local.set({ watches });
  await updateBadge(watches);
  return { ok: true, watch };
}

async function refreshAll() {
  const { watches = [] } = await chrome.storage.local.get("watches");
  for (const watch of watches) await fetchPrice(watch);
  await chrome.storage.local.set({ watches });
  await updateBadge(watches);
}

async function refreshOne(id) {
  const { watches = [] } = await chrome.storage.local.get("watches");
  const watch = watches.find(item => item.id === id);
  if (!watch) return { ok: false };
  await fetchPrice(watch);
  await chrome.storage.local.set({ watches });
  await updateBadge(watches);
  return { ok: true, watch };
}

async function fetchPrice(watch) {
  const wasTriggered = watch.triggered;
  try {
    const response = await fetch(watch.url, { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    await ensureOffscreen();
    const result = await chrome.runtime.sendMessage({
      type: "PARSE_OFFSCREEN",
      html,
      selector: watch.selector
    });
    if (!result?.ok || !Number.isFinite(result.price)) throw new Error(result?.error || "找不到价格元素");
    watch.currentPrice = result.price;
    watch.sample = result.text;
    watch.currency = detectCurrency(result.text) || watch.currency;
    watch.updatedAt = Date.now();
    watch.status = "ok";
    watch.error = "";
    watch.triggered = result.price <= watch.targetPrice;
    if (watch.triggered && !wasTriggered) notify(watch);
  } catch (error) {
    watch.status = "error";
    watch.error = String(error.message || error);
    watch.updatedAt = Date.now();
  }
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
    iconUrl: "icon.svg",
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
