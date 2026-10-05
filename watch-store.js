import "./watch-state.js";
import {
  GROUPS, WATCH_PREFIX, ORDER_KEY, validateId, validateRecord, validateOrder,
  validateVersion, configuration, createRecord, mergeRecord, mergeOrder,
  nextVersion, recordVersions, compareVersion, projectWatches, comparePrices, sameValue
} from "./watch-sync-model.js";

const RETRY_ALARM = "pt-sync-retry";
const LOCAL_KEYS = ["ptState", "watches", "ptSyncStatus"];
const encoder = new TextEncoder();
let queue = Promise.resolve();
let initialization;
let flushTimer;

function serial(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

function newState() {
  const device = crypto.randomUUID();
  return { schemaVersion: 1, device, clock: { time: 0, counter: 0, device }, records: {}, order: null, pendingKeys: [], retryAt: 0, retryCount: 0, migrated: false, legacyGroups: {}, legacyOrder: false };
}

function status(state, message = "") {
  return { state, message, updatedAt: Date.now() };
}

async function load() {
  const local = await chrome.storage.local.get(LOCAL_KEYS);
  const watches = local.watches || [];
  return { state: local.ptState || newState(), watches, savedWatches: structuredClone(watches), syncStatus: local.ptSyncStatus || status("pending") };
}

function stamp(state) {
  state.clock = nextVersion(state.clock, state.device);
  return state.clock;
}

function observe(state, version) {
  if (compareVersion(version, state.clock) > 0) state.clock = { ...version };
}

function pending(state, key) {
  if (!state.pendingKeys.includes(key)) state.pendingKeys.push(key);
}

function markChanged(ctx, key, group = null) {
  pending(ctx.state, key);
  if (key.startsWith(WATCH_PREFIX)) {
    const id = key.slice(WATCH_PREFIX.length);
    if (group) ctx.state.legacyGroups[id] = (ctx.state.legacyGroups[id] || []).filter(name => name !== group);
    else delete ctx.state.legacyGroups[id];
  }
  if (key === ORDER_KEY) ctx.state.legacyOrder = false;
  ctx.syncStatus = status("pending");
}

async function persist(ctx) {
  const projected = projectWatches(ctx.state.records, ctx.state.order, ctx.watches);
  const changes = { ptState: ctx.state, ptSyncStatus: ctx.syncStatus, priceOrderResetV1: true };
  // Status changes should not interrupt an in-progress text selection or drag.
  if (!sameValue(projected, ctx.savedWatches)) changes.watches = projected;
  ctx.watches = projected;
  await chrome.storage.local.set(changes);
  ctx.savedWatches = structuredClone(projected);
}

function decodeRemote(items) {
  const records = {};
  let order = null;
  for (const [key, value] of Object.entries(items)) {
    if (key === ORDER_KEY) { order = validateOrder(value); continue; }
    if (!key.startsWith(WATCH_PREFIX)) continue;
    const record = validateRecord(value);
    if (key !== WATCH_PREFIX + record.id) throw new Error("同步记录的商品 ID 不匹配");
    records[record.id] = record;
  }
  return { records, order };
}

function mergeRemote(ctx, remote) {
  for (const [id, record] of Object.entries(remote.records)) {
    for (const version of recordVersions(record)) observe(ctx.state, version);
    const local = ctx.state.records[id];
    const provisional = ctx.state.legacyGroups[id] || [];
    let merged = mergeRecord(local, record);
    if (!ctx.state.migrated && provisional.length && local && !local.deleted && !record.deleted) {
      merged = { ...merged, groups: { ...merged.groups } };
      for (const group of provisional) merged.groups[group] = record.groups[group];
    }
    ctx.state.records[id] = merged;
    delete ctx.state.legacyGroups[id];
    if (!sameValue(merged, record)) pending(ctx.state, WATCH_PREFIX + id);
  }
  if (remote.order) {
    observe(ctx.state, remote.order.version);
    ctx.state.order = !ctx.state.migrated && ctx.state.legacyOrder ? remote.order : mergeOrder(ctx.state.order, remote.order);
    ctx.state.legacyOrder = false;
    if (!sameValue(ctx.state.order, remote.order)) pending(ctx.state, ORDER_KEY);
  }
}

async function arrangeRetry(ctx) {
  if (!ctx.state.pendingKeys.length && ctx.syncStatus.state !== "error") {
    await chrome.alarms.clear(RETRY_ALARM);
    return;
  }
  await chrome.alarms.create(RETRY_ALARM, { when: Math.max(Date.now() + 60000, ctx.state.retryAt || 0) });
}

function requestFlush() {
  // The persisted queue and alarm survive suspension; this short timer only
  // coalesces nearby edits for faster delivery while the worker is awake.
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushSync().catch(reportError);
  }, 800);
}

async function reportError(error) {
  console.error("监控列表存储：", error);
  try { await chrome.storage.local.set({ ptSyncStatus: status("error", error.message || String(error)) }); }
  catch (storageError) { console.error(storageError); }
}

export function initialize() {
  if (!initialization) {
    initialization = serial(async () => {
      const ctx = await load();
      const state = ctx.state;
      if (state.schemaVersion !== 1) throw new Error("不支持的本地同步数据版本");
      validateId(state.device);
      state.clock = validateVersion(state.clock);
      state.legacyGroups ||= Object.fromEntries((state.legacyIds || []).map(id => [id, [...GROUPS]]));
      delete state.legacyIds;
      // Canonicalize persistent records before touching any remote data.
      state.records = Object.fromEntries(Object.entries(state.records).map(([id, record]) => {
        const valid = validateRecord(record);
        if (valid.id !== id) throw new Error("本地同步记录的商品 ID 不匹配");
        return [id, valid];
      }));
      if (state.order) state.order = validateOrder(state.order);
      let remote = null, readError = null;
      try { remote = decodeRemote(await chrome.storage.sync.get(null)); }
      catch (error) { readError = error; }

      // Legacy snapshots have no revision. Prefer a remote same-ID record
      // (including its deletion) instead of assigning the snapshot a new edit.
      if (!state.migrated) {
        const legacyIds = [];
        for (const watch of ctx.watches) {
          validateId(watch.id);
          legacyIds.push(watch.id);
          if (state.records[watch.id] || remote?.records[watch.id]) continue;
          // A snapshot is a baseline, not an edit made at migration time.
          // Real edits always receive a higher clock than this zero baseline.
          state.records[watch.id] = createRecord({ ...watch, createdAt: watch.createdAt || Date.now() }, { time: 0, counter: 0, device: state.device });
          state.legacyGroups[watch.id] = [...GROUPS];
          pending(state, WATCH_PREFIX + watch.id);
        }
        if (!state.order && legacyIds.length && !remote?.order) {
          state.order = { schemaVersion: 1, ids: legacyIds, version: { time: 0, counter: 0, device: state.device } };
          state.legacyOrder = true;
          pending(state, ORDER_KEY);
        }
      }
      if (remote) mergeRemote(ctx, remote);
      // Only mark migration complete after remote same-ID records have had
      // a chance to supersede unversioned legacy snapshots from a failed read.
      if (!readError) {
        state.migrated = true;
        for (const [id, record] of Object.entries(state.records)) {
          if (!sameValue(record, remote.records[id])) pending(state, WATCH_PREFIX + id);
        }
        if (state.order && !sameValue(state.order, remote.order)) pending(state, ORDER_KEY);
      }
      ctx.syncStatus = readError ? status("error", readError.message) : status(state.pendingKeys.length ? "pending" : "written");
      await persist(ctx);
      await arrangeRetry(ctx);
      if (!readError && state.pendingKeys.length) requestFlush();
    }).catch(error => { initialization = null; throw error; });
  }
  return initialization;
}

async function transact(task) {
  await initialize();
  return serial(async () => {
    const ctx = await load();
    const result = await task(ctx);
    await persist(ctx);
    await arrangeRetry(ctx);
    if (ctx.state.pendingKeys.length) requestFlush();
    return result;
  });
}

export async function getWatches() {
  await initialize();
  return serial(async () => (await load()).watches);
}

function patchRecord(ctx, id, patch) {
  validateId(id);
  const record = ctx.state.records[id];
  if (!record || record.deleted) return false;
  const projected = projectWatches({ [id]: record }, null)[0];
  const allowed = ["title", "customTitle", "url", "selector", "targetPrice", "notify"];
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => !allowed.includes(key))) throw new Error("商品修改字段无效");
  const values = configuration({ ...projected, ...patch });
  const touched = {
    title: Object.hasOwn(patch, "title") || Object.hasOwn(patch, "customTitle"),
    source: Object.hasOwn(patch, "url") || Object.hasOwn(patch, "selector"),
    target: Object.hasOwn(patch, "targetPrice"), notify: Object.hasOwn(patch, "notify")
  };
  for (const group of GROUPS) {
    const explicitLegacyEdit = touched[group] && (ctx.state.legacyGroups[id] || []).includes(group);
    if (sameValue(record.groups[group].value, values[group]) && !explicitLegacyEdit) continue;
    record.groups[group] = { version: stamp(ctx.state), value: values[group] };
    markChanged(ctx, WATCH_PREFIX + id, group);
  }
  return true;
}

export function patchWatch(id, patch) {
  return transact(ctx => patchRecord(ctx, id, patch));
}

function setOrderInContext(ctx, ids) {
  if (!Array.isArray(ids)) throw new Error("列表顺序无效");
  ids.forEach(validateId);
  if (new Set(ids).size !== ids.length) throw new Error("列表顺序包含重复商品");
  const active = projectWatches(ctx.state.records, ctx.state.order, ctx.watches);
  const known = new Set(active.map(watch => watch.id));
  const requested = ids.filter(id => known.has(id));
  const seen = new Set(requested);
  requested.push(...active.map(watch => watch.id).filter(id => !seen.has(id)));
  if (sameValue(ctx.state.order?.ids, requested)) return;
  const order = { schemaVersion: 1, ids: requested, version: stamp(ctx.state) };
  if (encodedSize(ORDER_KEY, order) > 8192) throw new Error("商品数量过多，列表顺序超出浏览器同步单项容量；原顺序已保留");
  ctx.state.order = order;
  markChanged(ctx, ORDER_KEY);
}

export function setOrder(ids) {
  return transact(ctx => setOrderInContext(ctx, ids));
}

export function sortByPrice() {
  return transact(ctx => setOrderInContext(ctx, projectWatches(ctx.state.records, ctx.state.order, ctx.watches).sort(comparePrices).map(watch => watch.id)));
}

export function saveWatch(input) {
  return transact(ctx => {
    if (!input || typeof input !== "object") throw new Error("商品数据无效");
    const id = input.id || crypto.randomUUID();
    validateId(id);
    const existing = ctx.state.records[id];
    if (existing?.deleted) throw new Error("商品已删除，请重新添加监控");
    const values = {
      title: existing?.groups.title.value.customTitle ? existing.groups.title.value.title : input.title || "未命名商品",
      customTitle: existing?.groups.title.value.customTitle || false,
      url: input.url, selector: input.selector, targetPrice: input.targetPrice,
      notify: existing?.groups.notify.value ?? true
    };
    if (existing) patchRecord(ctx, id, values);
    else {
      ctx.state.records[id] = createRecord({ ...values, id, createdAt: Date.now() }, stamp(ctx.state));
      markChanged(ctx, WATCH_PREFIX + id);
      setOrderInContext(ctx, [id, ...ctx.watches.map(watch => watch.id)]);
    }
    const watch = projectWatches(ctx.state.records, ctx.state.order, ctx.watches).find(w => w.id === id);
    const previous = ctx.watches.find(w => w.id === id);
    if (WatchState.hasPrice(input)) {
      Object.assign(watch, { currentPrice: Number(input.currentPrice), currency: typeof input.currency === "string" ? input.currency : "", sample: typeof input.sample === "string" ? input.sample : "", updatedAt: Date.now(), status: "ok", error: "" });
      watch.triggered = WatchState.isTriggered(watch);
      watch.triggeredAt = watch.triggered ? (previous?.triggered ? previous.triggeredAt || watch.updatedAt : watch.updatedAt) : null;
    }
    ctx.watches = ctx.watches.filter(w => w.id !== id);
    ctx.watches.push(watch);
    return watch;
  });
}

export function deleteWatch(id) {
  return transact(ctx => {
    validateId(id);
    if (!ctx.state.records[id] || ctx.state.records[id].deleted) return false;
    ctx.state.records[id] = { schemaVersion: 1, id, deleted: stamp(ctx.state) };
    markChanged(ctx, WATCH_PREFIX + id);
    return true;
  });
}

export function commitPrice(id, expected, result) {
  return transact(ctx => {
    const watch = ctx.watches.find(w => w.id === id);
    const record = ctx.state.records[id];
    if (!watch || !record || record.deleted || watch.url !== expected.url || watch.selector !== expected.selector || watch.updatedAt !== expected.updatedAt || !sameValue(record.groups.source.version, expected.sourceVersion)) return false;
    for (const key of ["currentPrice", "sample", "currency", "updatedAt", "lastSuccessAt", "status", "error"]) {
      if (Object.hasOwn(result, key)) watch[key] = result[key];
    }
    const wasTriggered = watch.triggered;
    watch.triggered = WatchState.isTriggered(watch);
    watch.triggeredAt = watch.triggered ? (wasTriggered ? watch.triggeredAt || watch.updatedAt : watch.updatedAt) : null;
    return { watch: structuredClone(watch), notify: watch.triggered && !wasTriggered && watch.notify !== false && result.status === "ok" };
  });
}

export async function getRefreshSnapshot(id) {
  await initialize();
  return serial(async () => {
    const ctx = await load();
    const watch = ctx.watches.find(w => w.id === id), record = ctx.state.records[id];
    if (!watch || !record || record.deleted) return null;
    return { watch, expected: { url: watch.url, selector: watch.selector, updatedAt: watch.updatedAt, sourceVersion: record.groups.source.version } };
  });
}

function encodedSize(key, value) {
  return encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length;
}

function checkQuota(items) {
  const entries = Object.entries(items);
  if (entries.length > 512) throw new Error("超出浏览器同步键数量上限（512）；更改已保存在本机");
  let total = 0;
  for (const [key, value] of entries) {
    const bytes = encodedSize(key, value);
    if (bytes > 8192) throw new Error("某项商品或排序超出同步单项容量（8 KB）；更改已保存在本机");
    total += bytes;
  }
  if (total > 102400) throw new Error("监控列表超出浏览器同步总容量（100 KB）；更改已保存在本机");
}

export async function flushSync() {
  await initialize();
  return serial(async () => {
    const ctx = await load();
    if (ctx.state.retryAt > Date.now()) { await arrangeRetry(ctx); return; }
    try {
      const allRemote = await chrome.storage.sync.get(null);
      const remote = decodeRemote(allRemote);
      mergeRemote(ctx, remote);
      // Entries absent from sync remain local, never infer deletions from absence.
      for (const [id, record] of Object.entries(ctx.state.records)) {
        if (!sameValue(record, remote.records[id])) pending(ctx.state, WATCH_PREFIX + id);
      }
      if (ctx.state.order && !sameValue(ctx.state.order, remote.order)) pending(ctx.state, ORDER_KEY);
      const payload = {};
      for (const key of ctx.state.pendingKeys) {
        if (key === ORDER_KEY) { if (ctx.state.order) payload[key] = ctx.state.order; }
        else if (key.startsWith(WATCH_PREFIX)) {
          const record = ctx.state.records[key.slice(WATCH_PREFIX.length)];
          if (record) payload[key] = record;
        }
      }
      // Persist the merge and queue before issuing the network-backed write.
      ctx.syncStatus = status(Object.keys(payload).length ? "pending" : "written");
      await persist(ctx);
      if (Object.keys(payload).length) {
        checkQuota({ ...allRemote, ...payload });
        await chrome.storage.sync.set(payload);
      }
      ctx.state.pendingKeys = [];
      ctx.state.retryAt = 0;
      ctx.state.retryCount = 0;
      ctx.state.migrated = true;
      ctx.syncStatus = status("written");
    } catch (error) {
      ctx.state.retryCount = (ctx.state.retryCount || 0) + 1;
      ctx.state.retryAt = Date.now() + Math.min(30, 2 ** Math.min(5, ctx.state.retryCount - 1)) * 60000;
      ctx.syncStatus = status("error", error.message || String(error));
    }
    await persist(ctx);
    await arrangeRetry(ctx);
  });
}

export function exportBackup() {
  return transact(ctx => ({ schemaVersion: 1, exportedAt: Date.now(), watches: structuredClone(ctx.watches), order: ctx.watches.map(watch => watch.id) }));
}

function validateBackup(value) {
  if (encodedSize("", value) > 5 * 1024 * 1024) throw new Error("导入文件不能超过 5 MB");
  if (value?.schemaVersion !== 1 || !Array.isArray(value.watches) || !Array.isArray(value.order)) throw new Error("不是有效的监控列表备份");
  const ids = new Set();
  const watches = value.watches.map(watch => {
    const id = validateId(watch?.id);
    if (ids.has(id)) throw new Error("备份包含重复商品 ID");
    ids.add(id);
    const config = configuration(watch);
    if (!Number.isFinite(watch.createdAt) || watch.createdAt < 0) throw new Error("备份的商品创建时间无效");
    if (watch.currentPrice != null && (typeof watch.currentPrice !== "number" || !Number.isFinite(watch.currentPrice))) throw new Error("备份的当前价格必须是有效数字或 null");
    if (watch.updatedAt !== undefined && (typeof watch.updatedAt !== "number" || !Number.isFinite(watch.updatedAt) || watch.updatedAt < 0)) throw new Error("备份的价格更新时间无效");
    for (const key of ["currency", "sample"]) {
      if (watch[key] !== undefined && typeof watch[key] !== "string") throw new Error("备份的价格文本字段无效");
    }
    return { id, createdAt: watch.createdAt, ...config.title, ...config.source, targetPrice: config.target, notify: config.notify,
      currentPrice: WatchState.hasPrice(watch) ? Number(watch.currentPrice) : null,
      currency: typeof watch.currency === "string" ? watch.currency : "", sample: typeof watch.sample === "string" ? watch.sample : "",
      updatedAt: Number.isFinite(watch.updatedAt) && watch.updatedAt >= 0 ? watch.updatedAt : 0, status: WatchState.hasPrice(watch) ? "ok" : "pending", error: "" };
  });
  const order = value.order.map(validateId);
  if (new Set(order).size !== order.length || order.some(id => !ids.has(id))) throw new Error("备份的排序与商品不匹配");
  return { watches, order };
}

export function importBackup(value) {
  // Validate the entire file before any mutation; a bad row cannot half-import.
  const backup = validateBackup(value);
  return transact(ctx => {
    let imported = 0;
    for (const watch of backup.watches) {
      const existing = ctx.state.records[watch.id];
      if (existing?.deleted) continue;
      if (existing) patchRecord(ctx, watch.id, { title: watch.title, customTitle: watch.customTitle, url: watch.url, selector: watch.selector, targetPrice: watch.targetPrice, notify: watch.notify });
      else {
        ctx.state.records[watch.id] = createRecord(watch, stamp(ctx.state));
        ctx.watches.push(watch);
        markChanged(ctx, WATCH_PREFIX + watch.id);
      }
      imported++;
    }
    setOrderInContext(ctx, backup.order);
    return { imported };
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !Object.keys(changes).some(key => key === ORDER_KEY || key.startsWith(WATCH_PREFIX))) return;
  initialize().then(() => serial(async () => {
    const ctx = await load();
    const items = Object.fromEntries(Object.entries(changes).filter(([, change]) => change.newValue !== undefined).map(([key, change]) => [key, change.newValue]));
    try {
      mergeRemote(ctx, decodeRemote(items));
      // External clears do not erase local records, including deletion markers.
      for (const [key, change] of Object.entries(changes)) {
        if (change.newValue === undefined && (key === ORDER_KEY || key.startsWith(WATCH_PREFIX))) pending(ctx.state, key);
      }
      if (ctx.state.pendingKeys.length && ctx.syncStatus.state !== "error") ctx.syncStatus = status("pending");
    } catch (error) { ctx.syncStatus = status("error", error.message); }
    await persist(ctx);
    await arrangeRetry(ctx);
    if (ctx.state.pendingKeys.length) requestFlush();
  })).catch(reportError);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RETRY_ALARM) flushSync().catch(reportError);
});
