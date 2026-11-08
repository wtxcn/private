# Monarch 定时刷新

[安装 MonarchAutoRefresher.user.js](https://raw.githubusercontent.com/wtxcn/private/main/MonarchAutoRefresher.user.js)

Tampermonkey 脚本：复用当前 Monarch 登录状态，在账户列表页自动点击原生 `Refresh all` 按钮。

## 时间

固定时区为 **America/Chicago**，自动处理夏令时。每天 **05:00、08:00、11:00、14:00、17:00、20:00、23:00** 执行，不含凌晨 02:00。

每 15 秒检查一次。后台标签可能受到浏览器节流；每个时点后不足 10 分钟仍可执行，超过则跳过，不补刷积压的时点。电脑锁屏不需要鼠标点击，但电脑必须保持唤醒、浏览器和标签必须保持运行。

## 安装与检查

1. 安装并启用 Tampermonkey，打开上方安装链接并安装脚本。
2. 按 Tampermonkey 提示允许用户脚本运行。
3. 打开或重新加载 [Monarch 账户列表](https://app.monarch.com/accounts?chartType=performance&timeframe=month)，保持已登录。
4. 在 Tampermonkey 菜单中选择“查看计划 / 检查按钮（不执行刷新）”，确认账户列表页和按钮均已识别。

建议在 Chrome 的“内存节省程序”中把 `app.monarch.com` 加到“始终保持这些网站活跃”，避免标签被丢弃。浏览器关闭、标签冻结或电脑睡眠时无法执行；脚本不负责唤醒电脑。仅在 `/accounts` 列表页运行，离开此页面会暂停。

## 去重与结果

同一浏览器配置中的 Monarch 标签通过 Web Locks 和站点本地记录去重，每个时点最多尝试一次。不同浏览器、配置、无痕窗口和电脑之间不共享记录。清除站点存储会清除脚本去重记录。

按钮缺失、不唯一、禁用、离线或有模态弹窗时不会点击；会在当次窗口内继续检查。点击前记录已尝试；服务器报错或限流时不反复重试，也不绕过银行或 Monarch 的限制。用户手动刷新不在脚本的去重范围内。

“已点击”不代表所有银行同步成功，请以 Monarch 的同步结果为准。

## 隐私

脚本不读取或保存密码、令牌、余额、账户号码或交易，不调用银行或 Monarch 私有 API。站点存储只保存计划时点、尝试时间和点击状态；不会上传到 GitHub。没有远程依赖。Tampermonkey 可从此仓库下载代码更新。

## 停用或修改

在 Tampermonkey 中关闭脚本后，重新加载已经打开的 Monarch 标签以停止原计时器。

修改脚本顶部的 `TIME_ZONE` 和 `HOURS` 后保存并重新加载页面。若希望全天每 3 小时一次，包含 02:00，可使用：

```js
const HOURS = [2, 5, 8, 11, 14, 17, 20, 23];
```

## 验证

已在当前 Monarch 页面核实原生按钮，并兼容按钮中的图标字体字符。58 项合成测试覆盖冬夏时区、固定时点、宽限期、跨标签与重载去重、缺失及禁用按钮、弹窗、离线和存储异常，不包含真实账户数据。

```sh
node --check MonarchAutoRefresher.user.js
node tests/monarch-auto-refresh.test.cjs
```

安装后的真实定时执行仍需在浏览器中确认。页面根元素的 `data-monarch-auto-refresh-version` 和 `data-monarch-auto-refresh-status` 属性仅包含版本及通用运行状态，可用于诊断是否已加载。
