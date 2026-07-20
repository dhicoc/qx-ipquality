# 节点 IP 质量检测 · Quantumult X

[![Platform](https://img.shields.io/badge/Platform-Quantumult%20X-blue?style=flat-square)](https://github.com/crossutility/Quantumult-X)
[![Scope](https://img.shields.io/badge/Scope-IP%20Only-green?style=flat-square)](#功能)
[![License](https://img.shields.io/badge/License-MIT-lightgrey?style=flat-square)](#许可)

轻量 **event-interaction** 脚本：查看节点出口 IPv4、地区 / ASN、基础风险标记。  
**不含流媒体 / AI 解锁检测。**

| 项目 | 说明 |
|------|------|
| 脚本 | [`src/ipquality-qx.js`](./src/ipquality-qx.js) |
| 配置片段 | [`conf/ipquality-qx.conf`](./conf/ipquality-qx.conf) |
| Raw | https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js |

---

## 功能

- 探测出口 **IPv4**（多探针投票，降低单源误差）
- 展示 **地区、城市、ASN、组织、时区**
- 通俗 **类型说明**（机房 / 移动 / 家宽倾向 / 代理特征）
- 基础 **风险标记**（proxy / hosting / VPN / Tor 等，多源并列）
- 长按节点：**HTML 结果面板** + 通知；主题图标随类型变色
- 台湾地区：旗帜按常见 QX 习惯显示为 **中国国旗**（emoji + 国旗图兜底）

---

## 安装

将下列片段并入 Quantumult X 配置的 `[task_local]` 段：

```ini
[task_local]
event-interaction https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js, tag=节点IP质量检测, img-url=shield.lefthalf.filled.system, enabled=true
```

或直接参考仓库内 [`conf/ipquality-qx.conf`](./conf/ipquality-qx.conf)。

保存配置后，确认 **Quantumult X Tunnel（VPN）已开启**。

---

## 使用方法

### 推荐：长按节点测指定出口

> Quantumult X **不会**像 Loon 那样读取你在列表里「点一下」的节点。  
> 正确方式是 **长按节点**（官方 UIAction），脚本通过 `$environment.params` 拿到节点 tag。

1. 打开 **节点** 列表  
2. **长按** 要检测的节点  
3. 选择 **「节点IP质量检测」**  
4. 查看结果面板与通知  

节点名称须与配置中的 tag **完全一致**（含 emoji、空格）。

### 其它方式

| 操作 | 实际测到的出口 |
|------|----------------|
| 长按节点 → 本脚本 | 该节点 |
| 工具页直接点运行 | 当前默认路由 / 当前连接 |
| `argument=policy=完整节点名` | 写死的节点或策略组 |

#### 工具页写死策略 / 节点

```ini
event-interaction https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js, tag=IP·香港, img-url=shield.lefthalf.filled.system, enabled=true, argument=policy=🇭🇰 香港 01&mask=0
```

#### URL Hash 变量（可选）

```text
https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js#policy=节点名&mask=0
```

---

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| （长按节点） | — | 自动绑定该节点，无需 argument |
| `policy` / `node` | 空 | 节点 tag 或策略组名 |
| `mask` | `0` | `1` 时 IP 显示为 `x.x.*.*` |

**策略组名** = 该组当前选中的出口。要测某一台机器，请用 **完整节点名**，或直接长按该节点。

---

## 结果示例

```text
🌐 IP　203.0.113.10
🏠 类型　家宽倾向 · 未检出机房/移动标记（不等于已认证住宅）
📍 地区　🇨🇳 [CN] 中国台湾
🏙️ 城市　Taipei
🔢 ASN　AS3462
🏢 组织　Chunghwa Telecom
🕐 时区　Asia/Taipei
📡 节点　台湾 01

🛡️ 风险
　🟢 ip-api　未命中 proxy/hosting
　🟢 ipapi.is　无风险标记
```

类型文案含义简表：

| 文案 | 含义 |
|------|------|
| 机房 IP | 数据中心 / 服务器，一般不是家用宽带 |
| 移动 IP | 手机 / 蜂窝网络 |
| 家宽倾向 | 未检出机房等标记，更像运营商线路（**≠ 住宅认证**） |
| 代理特征 | 库标记像代理 / VPN，仅供参考 |

---

## 数据源

| 环节 | 来源 | 路由 |
|------|------|------|
| 出口探测 | ipify、ip-api、icanhazip、ident.me | 目标节点 / 指定策略 |
| 详情与风险 | ip-api（`lang=zh-CN`）、ipapi.is | 按 IP 查询（不绑策略） |

第三方库口径、更新频率与限流各不相同；**未返回 ≠ 低风险**。

---

## 目录结构

```text
qx-ipquality/
├── README.md
├── conf/
│   └── ipquality-qx.conf    # 可复制的任务配置
└── src/
    └── ipquality-qx.js      # 脚本本体
```

---

## 常见问题

**Q：为什么测到的一直是当前连接的 IP？**  
A：若从工具页直接运行，走的是默认路由。请 **长按目标节点** 再选本脚本。

**Q：长按菜单里没有本脚本？**  
A：确认 `event-interaction` 已写入配置且 `enabled=true`，保存后刷新；并保持 Tunnel 开启。

**Q：写了 `policy=` 仍失败？**  
A：名称须与节点 / 策略组 tag **逐字一致**。策略组只代表组内当前选中项。

**Q：和 Loon 原版 ipquality 的关系？**  
A：思路参考 [MaYIHEI/paperclip Loon ipquality](https://github.com/MaYIHEI/paperclip/tree/main/loon/ipquality)，本仓库为 **QX 最小可用版（仅 IP）**，无 HTML 全量多库矩阵与流媒体套件。

**Q：台湾节点旗帜？**  
A：按 QX 社区常见写法，台湾地区显示中国国旗；长按面板另有国旗图片兜底。旗帜逻辑参考 [I-am-R-E GeoLocationChecker](https://github.com/I-am-R-E/Functional-Store-Hub)。

---

## 已知限制

- 仅 **IPv4**
- 依赖 Tunnel 运行；未开启时检测可能失败
- 类型与风险均为第三方库字段，**不是**官方住宅 / 解锁认证
- 无法 1:1 复刻 Loon 节点页 generic 交互

---

## 致谢

- [crossutility/Quantumult-X](https://github.com/crossutility/Quantumult-X) — `$task.fetch` / UIAction / `opts.policy`
- [MaYIHEI/paperclip](https://github.com/MaYIHEI/paperclip) — Loon 节点 IP 质量检测思路
- [I-am-R-E/Functional-Store-Hub](https://github.com/I-am-R-E/Functional-Store-Hub) — 地区旗帜显示参考
- [xykt/IPQuality](https://github.com/xykt/IPQuality) — 多源 IP 质量展示口径

---

## 许可

MIT — 可自由使用与修改；使用第三方 API 时请自行遵守其服务条款。检测会向上述服务提交出口 IP，介意隐私时请勿使用。
