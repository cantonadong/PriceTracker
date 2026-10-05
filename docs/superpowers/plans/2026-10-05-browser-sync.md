# 监控列表浏览器同步实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the user selects delegation. 按任务逐项执行，使用复选框记录进度。

**Goal:** 通过浏览器同步监控配置、标题、顺序和删除操作，保留离线使用和本机价格刷新。

**Architecture:** 后台统一处理写入，本地 watches 是配置与本机价格缓存合并后的投影。storage.sync 按商品保存带版本配置，独立保存顺序；本地持久队列负责重试，删除墓碑防止恢复旧监控。

**Tech Stack:** Chrome Manifest V3、原生 JavaScript ES modules、chrome.storage、chrome.alarms、PowerShell ZIP 打包，无新增运行时依赖。

**Spec:** ../specs/2026-10-05-browser-sync-design.md

## Global Constraints

- 直接在 main 工作，不创建分支或 worktree。
- 不运行自动或手工测试；仅检查差异、语法、包内容和 ID 计算，不宣称跨设备效果已经验证。
- 保持版本 1.1，未获新指令不推送、不创建 Release。
- 本机保留价格、币种、错误和通知触发状态；同步仅含用户配置和顺序。
- 不新增权限或云端服务，不清理墓碑、不截断数据以规避配额。
- 未知价格显示“—”，不能当作 0 判断到价。
- 在用户导出旧 ID 数据之前，不向正在使用的目录的 manifest 添加改变 ID 的 key。

## Review Focus

1. service worker 在编辑后立即退出：本地配置及待上传队列已经持久保存（任务 2）。
2. 远端部分变化和读取失败：不会用空列表清空本机数据（任务 2）。
3. 删除与离线编辑并发：同 ID 墓碑优先，重建监控使用新 ID（任务 1、2）。
4. 新设备没有价格缓存：列表、弹窗、目标价编辑和徽标均不会误报到价（任务 3、4）。
5. ID 改变或导入文件损坏：先备份，校验整份文件后才提交，无隐式数据丢失（任务 4、5）。

以上场景写入交付说明的用户验收步骤，代理不执行测试。

## 文件划分与数据接口

- `watch-sync-model.js`（新）：版本、校验、配置合并、顺序和投影的纯逻辑。
- `watch-store.js`（新）：本地状态、后台队列、同步事件、重试和导入导出。
- `watch-state.js`（新）：页面与后台共享的价格有效性及到价判断；通过普通 script 暴露命名空间，后台可 side-effect import。
- `background.js`：服务消息、抓价及提醒接入统一存储。
- `dashboard.js/html/css`、`popup.js/html`：页面命令、同步状态、未知价格、备份入口。
- `tools/package-sync.ps1`（新）：准备版和固定 ID 同步版打包。
- `extension-public-key.txt`（新）：固定公钥，便于打包，不含私钥。
- `manifest.json`：在数据导出确认前保留原 ID；交付同步版的 manifest 由打包步骤注入固定 key。
- `README.md`：迁移、同步前提、容量说明和验收步骤。

类型约定：`Version={time:number,counter:number,device:string}`；`Record={schemaVersion:1,id:string,createdAt:number,groups:{title:{version,value:{title,customTitle}},source:{version,value:{url,selector}},target:{version,value:number},notify:{version,value:boolean}},deleted?:Version}`；`Order={schemaVersion:1,ids:string[],version:Version}`。墓碑可仅含 schemaVersion、id、deleted。

本地 `ptState` 保存 device、clock、records、order、pendingKeys、retryAt、retryCount、migrated。同步键使用 `pt:watch:<id>` 和 `pt:order`。本地 `ptSyncStatus={state:"pending"|"written"|"error",message:string,updatedAt:number}` 供界面订阅。

## Task 1: 配置模型与未知价格

**Files:** 新建 watch-sync-model.js、watch-state.js。

**Interfaces:** 导出 `compareVersion(a,b):number`、`nextVersion(clock,device,now):Version`、`mergeRecord(a,b):Record`、`mergeOrder(a,b):Order`、`validateRecord(value):Record`、`projectWatches(records,order,cached):Watch[]`。共享 `WatchState.hasPrice(w):boolean`、`WatchState.isTriggered(w):boolean`。

- [x] 定义严格字段校验：schemaVersion=1；ID 和标题为非空字符串；URL 仅 http/https；selector 为非空字符串；目标价有限且不小于 0；版本的时间与计数为非负安全整数；创建时间有限；拒绝危险对象键。
- [x] 实现混合逻辑时间与配置组确定性合并；墓碑优先；以设备 UUID 作为并列版本排序依据。
- [x] 实现顺序合并与本机投影，缓存只在 ID、URL 和 selector 相同时复用；未排序商品按 createdAt、ID 排列。
- [x] 将价格有效性定义为非 null、非空字符串且数值有限；新投影无缓存时 currentPrice=null、triggered=false、status="pending"。
- [x] 阅读代码核对上面的冲突和未知价格场景；通过 `git diff --check` 后提交相关文件，不运行测试。

## Task 2: 持久同步存储与重试

**Files:** 新建 watch-store.js。

**Interfaces:** 导出 `initialize():Promise<void>`、`getWatches():Promise<Watch[]>`、`getRefreshSnapshot(id):Promise<{watch,expected}|null>`、`saveWatch(input):Promise<Watch>`、`patchWatch(id,patch):Promise<boolean>`、`deleteWatch(id):Promise<boolean>`、`setOrder(ids):Promise<void>`、`sortByPrice():Promise<void>`、`commitPrice(id,expected,result):Promise<boolean>`、`flushSync():Promise<void>`、`exportBackup():Promise<Backup>`、`importBackup(value):Promise<{imported:number}>`。模块注册 sync 变化和命名为 `pt-sync-retry` 的 alarm 监听。

- [x] 注册事件后启动单次初始化 Promise；加载 ptState、本地 watches、同步配置并校验。读取失败保留本地列表及错误状态，不标记迁移完成。
- [x] 首次迁移只为无远端版本的本机商品建配置；以远端版本和墓碑为准。将 priceOrderResetV1 标记为 true，保留同步顺序。
- [x] 所有提交在共享串行队列完成；先保存 ptState、watches、ptSyncStatus，再响应消息。保存失败向调用方返回错误，不显示成功 toast。
- [x] 配置只记录发生变化的组；现有 customTitle 不被 picker 的旧标题覆盖。删除写墓碑，排序生成单独版本，抓价只合并本机缓存。
- [x] 上传前重新读取同步值并合并，按 UTF-8 键和 JSON 字节数检查 8192 单项、102400 总量及 512 键；API 错误保留本地队列。
- [x] 每次写入只上传持久记录中 pendingKeys 的当前值；合并本批编辑为一次写入，不因价格缓存变化上传。
- [x] 写入后持久清理成功的键；失败安排 alarm，退避 1、2、4、8、16、30 分钟。启动、编辑和 alarm 触发重试；不依赖长时间内存 timer。
- [x] sync onChanged 合并变化并重建投影，非本扩展键忽略；仅当合并值不同于远端时加入待上传，避免回声循环。
- [x] 导入上限 5 MB，先校验完整 JSON 格式 `{schemaVersion:1,watches:[],order:[]}` 后提交；保留 ID，既有墓碑不恢复，新导入配置作为明确用户修改；价格快照只用于原来没有缓存的新商品。
- [x] 逐项阅读核对 worker 退出、读取失败、墓碑、配额和导入校验行为；执行差异检查后提交，不运行测试。

## Task 3: 后台统一入口

**Files:** 修改 background.js。

**Interfaces:** runtime 消息 `WATCH_PATCH{id,patch}`、`WATCH_DELETE{id}`、`WATCH_ORDER{ids}`、`WATCH_SORT`、`WATCH_EXPORT`、`WATCH_IMPORT{backup}`、`WATCH_READY`，统一返回 `{ok:true,...}` 或 `{ok:false,error}`。SAVE_WATCH 保留已有调用协议。

- [x] 顶层初始化存储，所有操作先 await initialize；为失败路径返回明确错误，避免未处理 Promise。
- [x] 将 SAVE_WATCH、打开 picker 和刷新读取改用存储接口；页面持久配置写入全部由后台执行。
- [x] 保留抓价网络队列；抓价前记录 URL、selector 和 updatedAt；网络完成后使用 commitPrice 重新核对当前记录，提交价格缓存、到价和触发时间。
- [x] 徽标和提醒使用 WatchState；价格未知不触发通知。首次成功取得价格后的到价通知按现有功能处理。
- [x] local onChanged 仅用于更新徽标，不反向上传整个 watches 数组；启动和安装恢复 alarm 与待上传队列。
- [x] 阅读配置与抓价并发路径，差异检查后提交，不运行测试。

## Task 4: 页面修改、同步提示与备份

**Files:** 修改 dashboard.js/html/css、popup.js/html。

**Interfaces:** 使用任务 3 消息；读取本地 watches、ptSyncStatus；导入导出 schema 采用任务 2 格式。

- [x] 自动排序、拖动顺序、改标题、目标价、删除和隐藏编辑表单改用后台消息；清除页面直接写 watches 的路径，删除 resetInitialOrder 写入逻辑，初始化改为 WATCH_READY。
- [x] storage.onChanged 限定 local watches 和 ptSyncStatus；后者只更新提示，不重建列表，保留当前标题编辑及选择范围。
- [x] footer 增加同步状态、“导出列表”“导入列表”按钮及隐藏 JSON 文件输入。状态文案按设计，不声称云端已完成。
- [x] 导出用 Blob、object URL 和用户点击下载，不增加 downloads 权限；导入先检查文件字节数，再解析并发送 WATCH_IMPORT；保存失败显示原因。
- [x] 页面 money()、已达目标筛选和弹窗统一使用 WatchState；popup 保留自定义标题完整文本。
- [x] 标题编辑继续禁用链接原生拖拽，Enter 保存、Esc 取消，失败保留输入；导入或远端删除正在编辑的商品时安全退出。
- [x] 阅读所有配置写入入口及未知价格路径，差异检查后提交，不运行测试。

## Task 5: 固定 ID、打包和交付

**Files:** 新建 extension-public-key.txt、tools/package-sync.ps1；修改 README.md。准备 ZIP 写入临时目录，不进仓库。

- [x] 检查是否已有可复用发行公钥；没有则使用本机加密 API 生成 RSA 2048 公钥（SPKI DER，Base64 单行）；只保存公钥，销毁临时私钥材料。
- [x] 打包脚本从显式允许列表复制运行文件和图标，排除 .git、文档设计和工具。迁移准备版 manifest 无 key，同步版注入固定公钥，二者使用同一版本 1.1。
- [x] 固定 ID 按公钥 SHA-256 前 16 字节映射 a–p 计算并输出到交付说明。核对两个 ZIP 的 manifest、脚本依赖和图标均存在。
- [x] 更新 README：旧版先在原目录加载准备版并导出，另目录安装固定 ID 同步版导入；确认后停用旧版。相同浏览器账号、同步开启、同 ID、另一电脑手动安装；说明 100 KB 配额和跨 Chrome/Edge 不互通。
- [x] 保持当前工作目录 manifest 无 key，避免在导出前使旧 ID 数据不可读；源目录切换固定 key 的动作留到用户确认完成导出后。提供固定 ID 同步版 ZIP 即可跨电脑安装使用，不以源目录未切 key 为由延后交付。
- [x] 最终检查 git diff、工作区状态、ZIP 内容和公钥 ID；提交最终代码，报告两个 ZIP 路径、迁移步骤和未运行测试。不要自动 push 或发布 Release。

## 实施方法

建议本会话由主代理逐项实施，接口较紧密，可避免交接重复阅读。用户选择委派时才改为 subagent-driven-development；默认不启动子代理。

写入设计和计划不代表用户已经导出数据，也不允许自动改变正在使用的扩展 ID。跨设备验收由用户按设计文档执行。
