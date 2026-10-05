const list = document.querySelector("#list"), empty = document.querySelector("#empty"), refreshButton = document.querySelector("#refresh");
const modal = document.querySelector("#modal"), search = document.querySelector("#search"), autoSortButton = document.querySelector("#auto-sort");
const targetFilter = document.querySelector("#target-filter"), syncLabel = document.querySelector("#sync-status");
let editingId = null, allWatches = [], titleDraft = null, renderVersion = 0, ready;

async function command(type, details = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...details });
  if (!result?.ok) throw new Error(result?.error || "操作失败，请重新加载扩展后重试");
  return result;
}
function ensureReady() { return ready ??= command("WATCH_READY").catch(error => { ready = null; throw error; }); }
document.addEventListener("DOMContentLoaded", () => render().catch(showError));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.ptSyncStatus) {
    const change = changes.ptSyncStatus;
    showSyncStatus(change.newValue);
    if (change.newValue?.state === "error" && (change.oldValue?.state !== "error" || change.oldValue?.message !== change.newValue.message)) toast(`浏览器同步失败，列表仍保存在本机：${change.newValue.message || "请稍后重试"}`);
  }
  if (changes.watches) render().catch(showError);
});
search.oninput = draw;
targetFilter.onclick = () => { targetFilter.setAttribute("aria-pressed", String(targetFilter.getAttribute("aria-pressed") !== "true")); draw(); };
autoSortButton.onclick = async () => {
  autoSortButton.disabled = true;
  try { await ensureReady(); await command("WATCH_SORT"); await render(); toast("已按当前价格、目标价格升序排序"); }
  catch (error) { showError(error); }
  finally { autoSortButton.disabled = false; }
};
refreshButton.onclick = async () => {
  refreshButton.disabled = true; refreshButton.textContent = "正在刷新…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "REFRESH_ALL" });
    toast(result?.ok ? "全部价格已更新" : result?.error || `有 ${result?.failed || 1} 个商品更新失败，请查看商品提示`);
    await render();
  } catch (error) { showError(error); }
  finally { refreshButton.disabled = false; refreshButton.textContent = "↻ 全部刷新"; }
};
document.querySelector("#empty-add").onclick = () => alert("打开要跟踪的商品页面，点击浏览器工具栏中的价格跟踪图标，然后选择“添加价格跟踪”。");

async function render() {
  const version = ++renderVersion;
  await ensureReady();
  const { watches = [], ptSyncStatus } = await chrome.storage.local.get(["watches", "ptSyncStatus"]);
  if (version !== renderVersion) return;
  allWatches = watches;
  document.querySelector("#subtitle").textContent = `共 ${allWatches.length} 个商品`;
  const newest = Math.max(0, ...allWatches.map(w => w.updatedAt || 0));
  document.querySelector("#updated").textContent = newest ? formatTime(newest) : "—";
  showSyncStatus(ptSyncStatus);
  if (!list.querySelector(".dragging")) draw();
}
function showSyncStatus(value) {
  const failed = value?.state === "error";
  syncLabel.closest(".sync-footer").hidden = !failed;
  syncLabel.textContent = failed ? `后台同步暂未完成，列表保留在本机：${value.message || "稍后自动重试"}` : "";
}
function draw() {
  const focused = document.activeElement, restoreFocus = focused?.classList.contains("title-input");
  const selection = restoreFocus ? [focused.selectionStart, focused.selectionEnd] : null;
  if (titleDraft && !allWatches.some(w => w.id === titleDraft.id)) titleDraft = null;
  const query = search.value.trim().toLowerCase(), onlyTriggered = targetFilter.getAttribute("aria-pressed") === "true";
  const sortingEnabled = !query && !onlyTriggered && !titleDraft;
  const watches = allWatches.filter(w => (!onlyTriggered || WatchState.isTriggered(w)) && `${w.title} ${safeDomain(w.url)}`.toLowerCase().includes(query));
  empty.hidden = !!allWatches.length || !!query || onlyTriggered; list.hidden = !watches.length;
  list.classList.toggle("sorting-disabled", !sortingEnabled);
  list.replaceChildren(...watches.map(w => card(w, sortingEnabled)));
  if (restoreFocus) { const input = list.querySelector(".title-input"); if (input && !input.disabled) { input.focus(); input.setSelectionRange(...selection); } }
}
function card(w, sortingEnabled) {
  const article = document.createElement("article"); article.className = "item"; article.dataset.id = w.id;
  article.innerHTML = `<button class="drag-handle" draggable="${sortingEnabled}" ${sortingEnabled ? 'title="拖动排序" aria-label="拖动商品排序"' : 'title="筛选或编辑时不能排序" aria-label="筛选或编辑时不能排序" disabled'}><span></span><span></span><span></span></button><a class="product" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer"><span class="product-icon"><img class="site-icon" src="${esc(favicon(w.url))}" alt="网站图标"></span><div class="product-text"><div class="title-row"><h3 title="${esc(displayTitle(w))}">${esc(displayTitle(w))}</h3></div>${w.status === "error" ? `<p class="error">更新失败：${esc(w.error || "未知错误")}</p>` : ""}</div></a><div class="current-wrap">${WatchState.isTriggered(w) ? '<span class="pill">已达目标</span>' : ""}<strong class="current">${esc(money(w))}</strong></div><label class="target-wrap"><input class="target-input" aria-label="目标价格" type="number" min="0" step="0.01" value="${Number(w.targetPrice)}"></label><div class="actions"><button class="icon-btn edit" title="重新选择价格区域" aria-label="重新选择价格区域"><img src="icon/price.png" alt=""></button><button class="icon-btn update" title="刷新" aria-label="刷新价格"><img src="icon/ref.png" alt=""></button><button class="icon-btn danger delete" title="删除" aria-label="删除商品"><img src="icon/del.png" alt=""></button></div>`;
  const siteIcon = article.querySelector(".site-icon");
  if (isWoolworths(w.url)) siteIcon.onerror = () => { siteIcon.onerror = null; siteIcon.src = browserFavicon(w.url); };
  const titleButton = document.createElement("button"); titleButton.type = "button"; titleButton.className = "icon-btn edit-title";
  titleButton.title = "修改产品标题"; titleButton.setAttribute("aria-label", titleButton.title);
  const titleIcon = document.createElement("img"); titleIcon.src = "icon/edit.png"; titleIcon.alt = "";
  titleButton.append(titleIcon); article.querySelector(".actions").prepend(titleButton);
  titleButton.onclick = () => { titleDraft = { id: w.id, value: displayTitle(w), saving: false }; draw(); const input = list.querySelector(".title-input"); input?.focus(); input?.select(); };
  if (titleDraft?.id === w.id) attachTitleEditor(article, w);
  const handle = article.querySelector(".drag-handle");
  if (sortingEnabled) {
    handle.ondragstart = e => { article.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(w.id)); e.dataTransfer.setDragImage(article, 20, article.offsetHeight / 2); };
    handle.ondragend = async () => { article.classList.remove("dragging"); list.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over")); try { await saveListOrder(); } catch (error) { showError(error); await render().catch(showError); } };
  }
  article.querySelector(".edit").onclick = async e => {
    const button = e.currentTarget; button.disabled = true;
    try { await command("EDIT_WATCH", { id: w.id }); } catch (error) { showError(error); } finally { button.disabled = false; }
  };
  article.querySelector(".target-input").onchange = async e => {
    const value = Number(e.target.value);
    if (!e.target.value.trim() || !Number.isFinite(value) || value < 0) { e.target.value = w.targetPrice; toast("请输入有效的目标价格"); return; }
    try { toast(await patch(w.id, { targetPrice: value }) ? "目标价格已保存" : "商品已删除，无法修改目标价格"); }
    catch (error) { e.target.value = w.targetPrice; showError(error); }
  };
  article.querySelector(".delete").onclick = () => removeWithConfirm(w).catch(showError);
  article.querySelector(".update").onclick = async e => {
    const button = e.currentTarget; button.disabled = true;
    try { const result = await chrome.runtime.sendMessage({ type: "REFRESH_ONE", id: w.id }); toast(result?.ok ? "价格已刷新" : result?.error || "更新失败，请查看商品提示"); await render(); }
    catch (error) { showError(error); } finally { button.disabled = false; }
  };
  return article;
}
list.ondragover = e => {
  const dragging = list.querySelector(".dragging"), target = e.target.closest(".item");
  if (!dragging || !target || target === dragging) return;
  e.preventDefault(); e.dataTransfer.dropEffect = "move";
  list.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over")); target.classList.add("drag-over");
  const before = e.clientY < target.getBoundingClientRect().top + target.offsetHeight / 2;
  list.insertBefore(dragging, before ? target : target.nextSibling);
};
list.ondrop = e => { if (list.querySelector(".dragging")) e.preventDefault(); };
async function saveListOrder() { await command("WATCH_ORDER", { ids: [...list.querySelectorAll(".item")].map(el => el.dataset.id) }); await render(); toast("商品顺序已保存"); }
async function patch(id, value) { return (await command("WATCH_PATCH", { id, patch: value })).saved; }

function attachTitleEditor(article, w) {
  const input = document.createElement("input"); input.className = "title-input"; input.type = "text"; input.value = titleDraft.value; input.disabled = titleDraft.saving;
  input.setAttribute("aria-label", "产品标题"); article.querySelector("h3").replaceWith(input);
  const product = article.querySelector(".product"); product.removeAttribute("href"); product.draggable = false; product.ondragstart = e => e.preventDefault();
  input.oninput = () => { titleDraft.value = input.value; };
  input.onkeydown = async e => {
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); titleDraft = null; draw(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault(); e.stopPropagation(); const title = input.value.trim();
    if (!title) { toast("产品标题不能为空"); input.focus(); return; }
    const draft = titleDraft; if (draft.saving) return;
    draft.saving = true; input.disabled = true;
    try { const saved = await patch(w.id, { title, customTitle: true }); if (titleDraft === draft) titleDraft = null; await render(); toast(saved ? "产品标题已保存" : "商品已删除，无法保存标题"); }
    catch (error) { draft.saving = false; draw(); list.querySelector(".title-input")?.focus(); showError(error); }
  };
}
function closeEdit() { modal.hidden = true; editingId = null; }
document.querySelectorAll(".close,.backdrop").forEach(el => el.onclick = closeEdit);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeEdit(); });
document.querySelector("#edit-form").onsubmit = async e => {
  e.preventDefault();
  try { const saved = await patch(editingId, { title: document.querySelector("#edit-title").value.trim(), customTitle: true, url: document.querySelector("#edit-url").value, targetPrice: Number(document.querySelector("#edit-target").value), notify: document.querySelector("#edit-notify").checked }); closeEdit(); toast(saved ? "商品信息已保存" : "商品已删除"); }
  catch (error) { showError(error); }
};
document.querySelector("#modal-delete").onclick = async () => { const w = allWatches.find(x => x.id === editingId); try { if (w && await removeWithConfirm(w)) closeEdit(); } catch (error) { showError(error); } };
async function removeWithConfirm(w) { if (!confirm(`删除“${w.title}”的跟踪？`)) return false; const result = await command("WATCH_DELETE", { id: w.id }); toast(result.removed ? "商品已删除" : "商品已被删除"); return true; }

function displayTitle(w) { return w.customTitle ? w.title : productTitle(w.title); }
function money(w) { return WatchState.hasPrice(w) ? Number(w.currentPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"; }
function safeDomain(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }
function formatTime(time) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(time); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function showError(error) { toast(error.message || "操作失败，请重新加载扩展后重试"); }
function toast(message) { const el = document.querySelector("#toast"); el.textContent = message; el.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => el.hidden = true, 4000); }
function isWoolworths(pageUrl) { const host = new URL(pageUrl).hostname; return host === "woolworths.co.nz" || host === "www.woolworths.co.nz"; }
function browserFavicon(pageUrl) { const url = new URL(chrome.runtime.getURL("/_favicon/")); url.searchParams.set("pageUrl", pageUrl); url.searchParams.set("size", "32"); return url.href; }
function favicon(pageUrl) { const site = new URL(pageUrl); if (isWoolworths(pageUrl)) return "https://www.woolworths.co.nz/favicon.ico"; if (site.hostname === "m1oils.co.nz" || site.hostname === "www.m1oils.co.nz") return "https://www.m1oils.co.nz/cdn/shop/files/Mobil_Lubricants_Logo_2024.png?v=1705440713&width=96"; return browserFavicon(pageUrl); }
function productTitle(title) { return String(title ?? "").replace(/\s+[-\u2013\u2014|]\s*pak\s*[\u0027\u2019]?\s*n\s*[\u0027\u2019]?\s*save?\s*$/i, "").trim(); }
