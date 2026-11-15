# 海角解锁 · 通行证取址 + 门禁摘除

两套实现，同一套逻辑：

- **浏览器扩展版**（Chrome / Edge ≥ 111）：`world:"MAIN"` + `document_start` 的 content script
- **Quantumult X 版**（iOS / macOS）：流量改写 + HTML 注入

---

## 它解决的两件事

站点把付费视频的地址跟「你买没买」绑在一起，`POST /api/attachment` 带 `resource_id` 去换播放地址，没买就只给 30 秒预览。同时在播放器上挂三个监听（`timeupdate` / `seeking` / `ended`），到 30 秒 `pause()` + 弹「请购买出售内容，观看完整视频」。

于是：

1. **换地址** —— 先找一个 `money_type=0` 的免费帖，把它当通行证；把 `/api/attachment` 请求体里的 `resource_id` 换成这个免费帖 id，`resource_type` 改成 `topic`。服务端按免费帖签发，返回的是完整索引。
2. **摘门禁** —— 那三个监听的回调源码里内联了字面量 `请购买出售内容`，按源码特征整条丢弃；DPlayer 实例 `events` 数组里的同款回调一起摘。

外加广告拦截（`/api/banner/*` 置空、banner 图换 1x1、`.containeradvertising` 隐藏）。

**注意**：只有第 1 步的话，能拿到完整地址，但 30 秒照样断——第 2 步是前端 JS，必须在页面里执行。

---

## 一、浏览器扩展（功能最全）

```
haijiao/
├── ext/
│   ├── manifest.json    # MV3，world:"MAIN"，document_start
│   └── patch.js         # 补丁本体
└── haijiao-unlock.user.js   # 油猴版（带 @grant none）
```

安装：

1. `chrome://extensions/` → 开发者模式 → 加载已解压的扩展程序 → 选 `ext/`
2. 打开站点，**先登录**（读 `token`、`uid` 两个 cookie）
3. 刷新页面再点视频

`manifest.json` 默认 `<all_urls>`，想收窄就把 `matches` 改成站点域名。

油猴版注意：`@grant` 必须是 `none`，否则脚本进沙箱，改的是 `XMLHttpRequest` 的副本，改写不生效。

右下角角标：

```
海角解锁 v3
通行证 123456
已换址 1 次 · 完整视频可用
✅ 试看门禁已解 3 个
```

`⚠ 门禁未命中 · 点这里重试` 就点一下角标，它重扫 Vue 树。

---

## 二、Quantumult X（iOS）

```
haijiao/qx/
├── haijiao-qx.conf         # 本地脚本版：[rewrite_local] + [mitm]
├── haijiao-qx-remote.conf  # 远程脚本版：已填好本仓库 raw 地址，只改域名就能用
├── hj-pass.js              # script-request-body  取址改写（核心）
├── hj-banner.js            # script-response-body 广告接口置空
└── hj-html.js              # script-response-body HTML 注入（门禁摘除）
```

省事的话直接用 `haijiao-qx-remote.conf`，四个脚本都指向本仓库，你只需要把域名换掉。

安装三步：

**1. 域名**

配置已按 `haijiao.com` 填好，直接粘。如果你的站是 `www.haijiao.com` / `m.haijiao.com`，给 4 条 rewrite 各复制一份换掉域名，`hostname` 写 `*.haijiao.com`。

**2. 放脚本**

三个 `.js` 丢进 `Quantumult X/Scripts/`，rewrite 里写裸文件名。或者用本仓库的 raw 地址：

```ini
[rewrite_local]
^https?:\/\/你的域名\/api\/attachment url script-request-body https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/haijiao/qx/hj-pass.js
^https?:\/\/你的域名\/api\/(?:banner|ad|advert)\/ url script-response-body https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/haijiao/qx/hj-banner.js
^https?:\/\/你的域名\/.*\/hjstore\/system\/banner\/[^\/?#]+\.(?:gif|jpe?g|png|webp|bmp)\.txt url reject-img
^https?:\/\/你的域名\/(?!api\/)(?!.*\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|m3u8|ts|json)(?:\?|$)).*$ url script-response-body https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/haijiao/qx/hj-html.js

[mitm]
hostname = %APPEND% 你的域名
```

**3. 证书**

QX 生成证书 → 安装 → **系统设置 → 通用 → 关于本机 → 证书信任设置**里打开信任。少这一步四条规则全部静默失效。

日志里出现 `hj: 换址 123456 -> 555` = 核心链路通了。

---

## 原理速查

| 环节 | 位置 | 做法 |
|---|---|---|
| 找通行证帖 | `pickPassTopic` / `probe` | 查 `node_id=888/900/972/300` 的列表，挑第一个 `money_type===0`，缓存 24h |
| 改请求体 | `rewrite` | `resource_id → 通行证 id`，`resource_type → topic` |
| 解密响应 | `decodeBody` | `{isEncrypted:true, data:"base64"}` 最多剥 6 层 |
| 门禁摘除 | `addEventListener` hook + `killDPlayerGate` | 按回调源码里的字面量匹配，整条丢弃 |
| 兜底续播 | `gateWatchdog` | 29.5–33s 窗口内被 pause 就 `play()` 回来 |
| 广告 | `sweepAds` / `stubXhr` | API 置空 + 图片替换 + CSS 隐藏 |

---

## 实测记录（2026-11-15，haijiao.com）

| 验证项 | 结果 |
|---|---|
| `GET /api/topic/node/topics?node_id=888&page=1&limit=3` | `200`，无需登录，`total=10016` |
| 响应结构 | `{isEncrypted:true}` + **三层** base64，剥开是 `{page:{...},results:[...]}` |
| `results[].money_type` | 存在；`money_type=0` 的有 `24710`（管理员公告）、`1839442`（认证须知） |
| `POST /api/attachment` | 端点存在，空参数返回 `{"isEncrypted":false,"message":"请求错误"}` |
| 首页 `/` | 先返回 `welcome` JS 挑战页（混淆脚本），过挑战后才出真正的 SPA |
| 根路径 HEAD | `404` + 挑战页（用 GET 才正常） |

两点据此改过的逻辑：

- **探测不再要求登录**：`/api/topic/node/topics` 公开可读，没 `token`/`uid` 也照探（有就带上）。扩展版和 QX 版都改了。
- **注入加了应用页判断**：只有 HTML 里出现 `id="app"` / `__vue__` / `dplayer` / `video-div` 才注入，避开 `welcome` 挑战页，免得干扰它的 JS。

还剩一处没法离线验证：`POST /api/attachment` 的**真实请求体字段**（无参时报「请求错误」）。`resource_id` / `resource_type` 是照原脚本写的，第一次跑的时候看扩展角标的 `__hjMainPatchState.seen`，或 QX 日志，能直接看到原始 body。

## 失效点（站点一改版就断的地方）

1. `NODES = ['888','900','972','300']` —— 免费帖来源，站点没这些 node 或没免费帖就探不到
2. `/api/topic/node/topics` 的响应结构 `{results:[{topicId, money_type}]}`
3. `/api/attachment` 请求体必须是**明文 JSON**（`isEncrypted` 套娃就改写不了）
4. 门禁回调里的文案 `请购买出售内容` —— 改一个字正则就失效，改 `GATE_SRC` 即可
5. Vue 2 的 `__vue__` + DPlayer 的 `events` 结构

## 排错

| 现象 | 原因 |
|---|---|
| 角标不出现 | 扩展没加载 / 域名不在 matches / CSP 拦了注入 |
| 「未登录」/ `no auth` | `token`、`uid` cookie 缺一个 |
| 「正在找免费帖…」卡住 | node id 不存在或没免费帖 |
| 只有 30 秒但没弹窗 | 取址没换成功，看 `hits` / 日志有没有「换址」 |
| 30 秒断 | 门禁没摘到，点角标重扫；或 `GATE_SRC` 文案不符 |
