# Execution ledger — plan: 2026-10-05-browser-sync.md

- Base: ac3a980; native execution on main.
- Ruling: 用户“yes”按推荐的本会话执行理解；不委派实施任务。
- Ruling: 用户明确禁止运行测试，覆盖技能的 TDD 与测试命令要求；使用代码审阅、语法和打包检查，真实跨设备同步留给用户验证。
- Ruling: 当前目录的 manifest 保留无 key；固定 ID 仅写入交付同步包，避免用户导出前失去旧 ID 数据。确认导出后才切换源目录。
- Pre-flight: 模型导出与存储使用一致；后台消息与页面使用一致；准备包不依赖 key，固定 ID 包由打包脚本注入。
- Ruling: 五个任务的模型、后台和 UI 接口相互依赖，统一提交完整可加载版本，避免中间提交使用不存在的消息或模块。
- Task 1: complete; shared model and price guards inspected, node --check passed. No tests executed.
- Task 2: complete; durable queue, merge, migration and import inspected, node --check passed. No tests executed.
- Task 3: complete; worker edits and price commits routed through store, syntax checked. No tests executed.
- Task 4: complete; UI sync status and backup controls added, syntax checked. No tests executed.
- Task 5: complete; both packages rebuilt after review fixes. All 23 packaged files match current source, script dependencies/icons are present, version is 1.1, fixed sync ID is mfngjojagjpjdkgchlmgaghdpongbohp, migration and source manifests have no key.
- Final review: independent read-only agent review; no tests run.
- Final: fixed Important migration issue using per-group provisional provenance and zero-version baselines, so target edits cannot publish stale titles as newer changes. Verified by code inspection and syntax only, not runtime tests.
- Final: Ruling: malformed backup coercion reclassified Important because it can alter notification and custom-title settings; strict present-field validation added, missing optional fields retain documented defaults. Actual import behavior remains for user verification.
- Final: Ruling: reviewer declined runtime cloud delivery, worker lifecycle, real quota failures and browser interactions because tests are forbidden; these remain explicitly unverified. ZIP manifests and generated identity are checked statically.
- Final verification: node --check on every root JavaScript file and git diff --check passed; no tests executed. No push or release requested for this change.

## 用户要求修正：无主动操作的后台同步

- 用户明确拒绝导入导出迁移流程，要求自动后台同步，优先于原计划。
- 当前 CentBrowser 的 Secure Preferences 中，安装路径为 D:\Dev\PriceTracker，ID 为 ljbffjpoegfcdkmacohmgagkbijmhoel，无 key。
- 对照 Chromium 的 GenerateIdForPath 与 ParsePEMKeyBytes：固定路径 UTF-16LE 字节作为 manifest key，计算结果与已安装 ID 完全一致；不修改浏览器配置和 storage。
- 取消随机 RSA 身份、更换 ID 的双包方案和导入导出 UI/API；正常隐藏同步提示，失败时显示。本机旧列表仍由 initialize 自动接入同步。
- 新收到的未知价格商品自动后台抓价；保持原本每小时刷新任务。
- 单一更新包覆盖原 sync.zip，避免旧链接继续指向错误身份。没有运行测试，仍需用户核实跨设备同步。
