# TASK_LOG

## 2026-07-19

- 目标：把 Loon `ipquality` 做成 Quantumult X 最小可用版。
- 决策：
  - 入口用 `event-interaction` + `$notify`，不模拟 HTML 弹窗。
  - 出口探测走 `argument.policy` 或默认路由；库查询不绑策略。
  - 数据源压到 ip-api + ipapi.is。
- 产出：
  - `src/ipquality-qx.js`
  - `conf/ipquality-qx.conf`
  - `README.md`

### 仅 IP

- 用户要求「只测 IP」：删除 Netflix/ChatGPT/YouTube 与 `media` 参数。
- 版本：`2026-07-19.qx2-ip`。

### 推送 GitHub

- 账号：`dhicoc`
- 仓库：https://github.com/dhicoc/qx-ipquality（public）
- 分支：`master`

### qx3：长按节点测指定出口

- 用户反馈：只能测当前连接，不能测手动选择的节点。
- 原因：QX 不会读「列表点选」；应使用 UIAction：`$environment.params` = 长按节点 tag。
- 修复：优先 `opts.policy = $environment.params`；长按用 htmlMessage 面板；文档改成长按用法。
- 版本：`2026-07-19.qx3-ip`。

### README 优化

- 重写仓库 README：结构分层、安装/用法/参数/示例/FAQ/致谢/限制，与当前脚本能力对齐。
