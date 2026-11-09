# Monarch 自动 Refresh all

[安装 MonarchAutoRefresher.user.js](https://raw.githubusercontent.com/wtxcn/private/main/MonarchAutoRefresher.user.js)

Tampermonkey 用户脚本，v1.0.6。使用 Monarch 页面现有的 `Refresh all` 按钮，复用当前登录状态。

## 安装

1. 在 Chrome 中安装并启用 Tampermonkey。
2. 打开上方安装链接并安装脚本；也可以新建用户脚本，将本目录的 `MonarchAutoRefresher.user.js` 全文粘贴到编辑器，保存并启用。更新已有脚本后，重新加载 Monarch 标签。
3. 保留一个已登录的 Monarch 标签即可。如果当前在 Transactions、预算等页面，计划时间到时脚本会进入 [Accounts](https://app.monarch.com/accounts?chartType=performance&timeframe=month) 再刷新。若已有可执行的 Accounts 标签，该标签会负责刷新，其他页面不会切换。
4. 页面右下角默认显示小 ↻ 图标。点击展开状态和最近 10 条刷新日志，再点击收起；拖动可移动，位置保存在本浏览器。Tampermonkey 菜单中的“查看计划 / 检查按钮（不执行刷新）”也可查看诊断。

如果未出现状态按钮或脚本菜单，检查 Tampermonkey 是否启用，并按扩展提示允许用户脚本运行，再重新加载 Monarch。

## 计划与运行条件

- 时区固定为 **America/Chicago**，随夏令时自动调整。
- 每天 **05:00、08:00、11:00、14:00、17:00、20:00、23:00**；不包含凌晨02:00，次日05:00重新开始。
- 每15秒检查一次，只在每个计划时点后的前10分钟内尝试；**错过不补刷**。
- 电脑需保持唤醒，浏览器和至少一个 Monarch 标签需保持打开，Monarch需保持登录。后台标签可能被节流，标签冻结、丢弃或Mac睡眠时无法保证执行。
- 电脑锁屏不需要鼠标点击，但浏览器和标签仍需保持运行；脚本不负责唤醒电脑。
- 如 Chrome 的“内存节省程序”会休眠此标签，可将 `app.monarch.com` 加入“始终保持活跃的网站”。
- 非 Accounts 页面在计划窗口内自动进入 Accounts；如正在编辑或有弹窗，会暂缓切页以避免丢失内容。

## 状态与去重

右下角默认只有一个小 ↻ 图标；点击后显示本页状态、最近脚本尝试、下次计划时间和最近 10 条日志。展开或拖动图标均不执行刷新。

脚本仅定位名称精确为 `Refresh all` 的唯一可见且可用按钮；按钮未就绪、页面有模态弹窗或网络离线时，会在当次10分钟窗口内继续检查。每个计划时点最多尝试一次，脚本尝试之间至少间隔170分钟。

最近脚本尝试存放在站点本地存储中，只包含计划时点、尝试时间和点击状态。`attempted` 表示已记录点击尝试，`clicked` 表示已调用页面按钮；**它们都不表示 Monarch 或银行已成功同步**，同步结果以 Monarch 页面为准。用户手动点击刷新不会写入这条记录，脚本也不绕过 Monarch 或银行的限制。

日志状态“Monarch 显示同步完成”表示脚本在本次点击后观察到了页面的 `Sync complete / All accounts are up to date` 提示；它不保证每家银行都产生了新数据。若 10 分钟内未观察到提示，显示“已点击，未确认完成”，不推断刷新失败。页面重载后仍会处理未确认记录；旧版点击若没有完成证据，也会标为未确认。

同一浏览器配置中的多个 Monarch 标签通过 Web Locks 和站点本地记录协调；已有可用 Accounts 标签时优先由它执行，否则仅一个标签进入 Accounts。不同浏览器、浏览器配置、无痕窗口及其他电脑之间不共享。清除站点存储会清除去重记录。点击前即记录尝试，服务器报错或限流时不会反复重试。

## 隐私

脚本不读取或保存密码、令牌、余额、账户号码或交易，不调用银行或 Monarch 私有 API。站点存储保存最多 30 条刷新状态、图标位置及短期跨标签协调时间戳；不会上传到 GitHub。没有远程依赖。Tampermonkey 可从此仓库下载代码更新。

## 停用与修改

在 Tampermonkey 中关闭脚本，并重新加载已打开的 Monarch 标签，停止旧标签中已启动的计时器。

如需更改时区或计划，可修改脚本顶部的 `TIME_ZONE`、`HOURS` 后保存，再重新加载 Monarch。全天每3小时一次、包含02:00的计划为：

```js
const HOURS = [2, 5, 8, 11, 14, 17, 20, 23];
```

## 本地验证

已在 Monarch 账户列表页面核实原生按钮，并兼容按钮中的图标字体字符。合成测试不包含真实账户数据，覆盖冬夏时区、固定时点、宽限期、其他页面进入 Accounts、跨标签与重载去重、编辑与弹窗、离线、同步提示确认、超时未确认、旧提示排除及图标位置保存。

```sh
node --check MonarchAutoRefresher.user.js
node tests/monarch-auto-refresh.test.cjs
```

本地模拟检查不能证明浏览器实际后台定时触发或银行同步成功；安装后的真实定时执行仍需在浏览器中确认。页面根元素的 `data-monarch-auto-refresh-version` 和 `data-monarch-auto-refresh-status` 属性仅包含版本及通用运行状态，可用于诊断是否已加载。v1.0.6 还公开以下诊断属性，不包含账户信息：

- `data-monarch-auto-refresh-last-check`：最近一次脚本检查时间。
- `data-monarch-auto-refresh-page`：当前页面类型。
- `data-monarch-auto-refresh-page-status`：本页是否可执行及原因。
- `data-monarch-auto-refresh-last-attempt`：最近脚本尝试记录。
- `data-monarch-auto-refresh-next-schedule`：下次计划时间。
- `data-monarch-auto-refresh-outcome`：最近一次脚本刷新状态（clicked / confirmed / unconfirmed）。
