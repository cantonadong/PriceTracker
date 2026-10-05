import "./watch-state.js";

export const GROUPS = ["title", "source", "target", "notify"];
export const WATCH_PREFIX = "pt:watch:";
export const ORDER_KEY = "pt:order";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateId(value) {
  requireValue(typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value), "监控 ID 无效");
  return value;
}

export function validateVersion(value) {
  requireValue(value && Number.isSafeInteger(value.time) && value.time >= 0 && Number.isSafeInteger(value.counter) && value.counter >= 0, "同步版本无效");
  return { time: value.time, counter: value.counter, device: validateId(value.device) };
}

export function compareVersion(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  return a.time - b.time || a.counter - b.counter || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0);
}

export function nextVersion(clock, device, now = Date.now()) {
  const time = Math.max(now, clock?.time || 0);
  return { time, counter: time === clock?.time ? clock.counter + 1 : 0, device };
}

export function normalizeSource(value) {
  requireValue(value && typeof value.url === "string", "商品链接无效");
  let url;
  try { url = new URL(value.url); } catch { throw new Error("商品链接无效"); }
  requireValue(["http:", "https:"].includes(url.protocol) && !url.username && !url.password, "商品链接必须是 HTTP 或 HTTPS 地址，且不能包含登录凭据");
  requireValue(typeof value.selector === "string" && value.selector.trim().length > 0, "价格选择区域无效");
  url.hash = "";
  return { url: url.href, selector: value.selector };
}

function normalizeGroup(name, value) {
  if (name === "title") {
    requireValue(value && typeof value.title === "string" && value.title.trim().length > 0 && typeof value.customTitle === "boolean", "产品标题无效");
    return { title: value.title.trim(), customTitle: value.customTitle };
  }
  if (name === "source") return normalizeSource(value);
  if (name === "target") {
    requireValue(typeof value === "number" && Number.isFinite(value) && value >= 0, "目标价格无效");
    return value;
  }
  requireValue(typeof value === "boolean", "通知设置无效");
  return value;
}

export function validateRecord(value) {
  requireValue(value?.schemaVersion === 1, "不支持的同步数据版本");
  const record = { schemaVersion: 1, id: validateId(value.id) };
  if (value.deleted) return { ...record, deleted: validateVersion(value.deleted) };
  requireValue(typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && value.createdAt >= 0, "商品创建时间无效");
  record.createdAt = value.createdAt;
  record.groups = {};
  for (const name of GROUPS) {
    const group = value.groups?.[name];
    requireValue(group, "商品配置不完整");
    record.groups[name] = { version: validateVersion(group.version), value: normalizeGroup(name, group.value) };
  }
  return record;
}

export function validateOrder(value) {
  requireValue(value?.schemaVersion === 1 && Array.isArray(value.ids), "列表顺序无效");
  const ids = value.ids.map(validateId);
  requireValue(new Set(ids).size === ids.length, "列表顺序包含重复 ID");
  return { schemaVersion: 1, ids, version: validateVersion(value.version) };
}

export function configuration(watch) {
  requireValue(watch.customTitle === undefined || typeof watch.customTitle === "boolean", "自定义标题标记必须是布尔值");
  requireValue(watch.notify === undefined || typeof watch.notify === "boolean", "通知设置必须是布尔值");
  return {
    title: normalizeGroup("title", { title: watch.title, customTitle: watch.customTitle === true }),
    source: normalizeSource(watch),
    target: normalizeGroup("target", watch.targetPrice),
    notify: normalizeGroup("notify", watch.notify !== false)
  };
}

export function createRecord(watch, version) {
  const values = configuration(watch);
  return validateRecord({ schemaVersion: 1, id: watch.id, createdAt: watch.createdAt, groups: Object.fromEntries(GROUPS.map(name => [name, { version, value: values[name] }])) });
}

export function mergeRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  requireValue(a.id === b.id, "不能合并不同商品");
  if (a.deleted || b.deleted) {
    if (!a.deleted) return b;
    if (!b.deleted) return a;
    return compareVersion(a.deleted, b.deleted) >= 0 ? a : b;
  }
  return {
    schemaVersion: 1, id: a.id, createdAt: Math.min(a.createdAt, b.createdAt),
    groups: Object.fromEntries(GROUPS.map(name => [name, compareVersion(a.groups[name].version, b.groups[name].version) >= 0 ? a.groups[name] : b.groups[name]]))
  };
}

export function mergeOrder(a, b) {
  if (!a) return b;
  if (!b) return a;
  return compareVersion(a.version, b.version) >= 0 ? a : b;
}

export function recordVersions(record) {
  return record.deleted ? [record.deleted] : GROUPS.map(name => record.groups[name].version);
}

export function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function projectWatches(records, order, cached = []) {
  const cache = new Map(cached.map(watch => [watch.id, watch]));
  const watches = new Map();
  for (const record of Object.values(records)) {
    if (record.deleted) continue;
    const groups = record.groups;
    const old = cache.get(record.id);
    const source = groups.source.value;
    const reusable = old && old.url === source.url && old.selector === source.selector;
    const watch = {
      ...(reusable ? old : { currentPrice: null, currency: "", sample: "", updatedAt: 0, status: "pending", error: "", triggeredAt: null }),
      id: record.id, createdAt: record.createdAt,
      ...groups.title.value, ...source,
      targetPrice: groups.target.value, notify: groups.notify.value
    };
    watch.triggered = WatchState.isTriggered(watch);
    watch.triggeredAt = watch.triggered ? old?.triggeredAt || old?.updatedAt || null : null;
    watches.set(watch.id, watch);
  }
  const result = [];
  for (const id of order?.ids || []) {
    if (watches.has(id)) { result.push(watches.get(id)); watches.delete(id); }
  }
  result.push(...[...watches.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  return result;
}

export function comparePrices(a, b) {
  for (const key of ["currentPrice", "targetPrice"]) {
    const number = value => value == null || String(value).trim() === "" || !Number.isFinite(Number(value)) ? Infinity : Number(value);
    const left = number(a[key]), right = number(b[key]);
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
