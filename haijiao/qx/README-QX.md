# 海角解锁 · Quantumult X 重写版

## 先说边界：QX 能干什么、不能干什么

| 脚本功能 | 实现层 | QX 能否照搬 |
|---|---|---|
| 通行证取址改写（`POST /api/attachment` 换 `resource_id`） | HTTP 流量 | ✅ 100% 能，`script-request-body` 就是干这个的 |
| 广告接口 `/api/banner/*` 置空 | HTTP 流量 | ✅ 能，`script-response-body` 直接换 body |
| banner 图片换 1x1 | HTTP 流量 | ✅ 能，`reject-img` 一行搞定 |
| 30 秒试看门禁（DPlayer `timeupdate`/`seeking`/`ended`） | 页面 JS | ⚠️ 只能靠 **HTML 注入脚本**做，QX 光改流量永远干不掉它 |
| 广告位 `.containeradvertising` 隐藏 | DOM | ⚠️ 同上，注入 CSS/JS |

**关键结论**：光配第 1 条 rewrite，你能拿到完整视频地址，但播放器到 30 秒照样 `pause()` + 弹「请购买出售内容」——因为那是站点 app.js 里的闭包逻辑，跟网络无关。所以本方案是「2 条流量规则 + 1 条 HTML 注入」。

---

## 文件

| 文件 | 类型 | 作用 |
|---|---|---|
| `haijiao-qx.conf` | 配置片段 | `[rewrite_local]` + `[mitm]`，粘进你的配置 |
| `hj-pass.js` | `script-request-body` | 核心：探免费帖 → 改写 `resource_id` |
| `hj-banner.js` | `script-response-body` | 广告接口回空数据 |
| `hj-html.js` | `script-response-body` | HTML 注入：摘门禁 / 隐藏广告位 / 角标 |

---

## 安装（3 步）

### 1. 换域名

`haijiao-qx.conf` 里 `hj.example.com` 全部替换成你实际访问的域名（QX 的 MITM 不支持裸通配，必须写死）。一共 5 处：4 条 rewrite + `hostname`。

### 2. 放脚本

**本地（推荐，iOS 上直接文件 App 拖进去）**

把三个 `.js` 放进 `Quantumult X/Scripts/` 目录（iCloud Drive 里那个），rewrite 里写裸文件名就生效。

**远程（想多设备同步）**

传到自己的 GitHub 仓库，rewrite 改成 raw 地址：

```
^https?:\/\/你的域名\/api\/attachment url script-request-body https://raw.githubusercontent.com/你/仓库/main/hj-pass.js
```

注意 GitHub raw 有 ~5 分钟 CDN 缓存，改了脚本不会立刻生效。

### 3. MITM

```ini
[mitm]
hostname = %APPEND% 你的域名
```

然后 QX → 设置 → 证书 → 生成并安装 → **系统设置 → 通用 → 关于本机 → 证书信任设置** 里把这个根证书打开。少这一步，四条 rewrite 全部静默失效（QX 只能看到 SNI，改不了内容）。

---

## 验证是否生效

1. QX 主界面开「调试 → 日志」，访问站点，看有没有 `hj: 换址 xxxxx -> yyyyy` 这类输出。
2. 页面右下角出现深色小角标：`海角解锁 ✅ 门禁已解 N` 表示注入脚本跑起来了。
3. 打开一个金币视频，**能拖到 30 秒之后继续播** = 成功。
4. 角标显示 `⚠ 门禁未命中 · 点我重试` → 先点一下播放器再点角标，它会重扫 Vue 树。

排错排查顺序：

- 日志里完全没有 `[hj]` 任何东西 → MITM 没开 / hostname 没配对 / 域名写错。
- 有 `hj: 请求里没 token/uid` → 没登录，或者站点把认证放在别的头里，改 `pickToken()`。
- 有 `hj: 四个 node 都没探到免费帖` → `NODES` 数组里的 node id 在你站上不存在或没免费帖，换成首页热门版块的 node id。
- 视频还是 30 秒断 → 注入脚本没进去（页面 CSP、gzip 没解压、HTML 结构特殊），看角标在不在。

---

## 和浏览器扩展版的差别

| | 扩展版 | QX 版 |
|---|---|---|
| 取址改写时机 | 页面发请求前 | 请求出站时，更早更稳 |
| 登录态 | 读 `document.cookie` | 直接读请求头/cookie，天然带 |
| 门禁摘除时机 | `document_start`，最早 | `<head>` 注入，仍早于 app.js，基本等效 |
| 广告 DOM 隐藏 | 有 | 有 |
| 依赖 | Chrome ≥ 111 | QX + MITM 证书 |
| 桌面能不能用 | 能 | 不能（QX 是 iOS/macOS 的） |

两边可以同时用，互不冲突（扩展有 `__hjMainPatch` 守卫，注入版有 `__hjQXInject` 守卫，各管各的）。

---

## 已知假设 / 会失效的地方

QX 版没有比扩展版更「聪明」，同样依赖这些硬编码，站点一改版就断：

1. `NODES = ['888','900','972','300']` —— 免费帖来源，需要站点确实有 `money_type=0` 的公开帖。
2. `/api/topic/node/topics` 的响应结构 `{results:[{topicId, money_type}]}`。
3. `/api/attachment` 的请求体是**明文 JSON**（不是 `isEncrypted` 套娃）。如果是加密的，`hj-pass.js` 会直接放行不改，需要另外拿到加解密算法。
4. 30 秒门禁的回调源码里含字面量 `请购买出售内容`——站点换个文案，`GATE_SRC` 正则就失效。
5. Vue 2 的 `__vue__` + DPlayer 的 `events` 结构。

---

## 本地验证记录

三个脚本在 mock 的 QX 运行时（node vm 模拟 `$request`/`$task.fetch`/`$prefs`/`$done`）里跑过：

- `hj-pass.js`：冷启动查到免费帖 555 → 请求体 `resource_id 123456 → 555`、`resource_type → topic`；二次调用命中 `$prefs` 缓存，零请求直接改写。
- `hj-banner.js`：返回 `AD_EMPTY`，并剥掉 `Content-Length` / `Content-Encoding`（不剥的话 QX 会按旧长度截断）。
- `hj-html.js`：注入点落在 `<head>` 内、`app.js` 之前，CSP 头被摘除，注入的内联脚本单独 `node --check` 通过。

线上真实站点未验证（需要账号 + 实际域名），逻辑层没问题，剩下的是站点结构匹不匹配。
