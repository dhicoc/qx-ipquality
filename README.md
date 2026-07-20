# 节点 IP 质量检测 · Quantumult X

[![Platform](https://img.shields.io/badge/Platform-Quantumult%20X-blue?style=flat-square)](https://github.com/crossutility/Quantumult-X)
[![Version](https://img.shields.io/badge/Script-qx4-green?style=flat-square)](#功能)

长按节点，一次查看：**出口 IP**、**IPPure 纯净度**、**连通 / 阻断诊断**。

| 项目 | 链接 |
|------|------|
| 脚本 Raw | https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js |
| 配置片段 | [`conf/ipquality-qx.conf`](./conf/ipquality-qx.conf) |

---

## 功能

### 1. 出口与地理
- 多探针获取 IPv4，展示地区 / 城市 / ASN / 组织 / 时区
- 通俗类型说明（住宅 / 机房 / 移动 / 家宽倾向）
- 台湾地区旗帜显示为中国国旗（emoji + 图片兜底）

### 2. IPPure 纯净度
整合 [IPPure MyIP API](https://my.ippure.com/v1/info)（思路对齐 ddgksf2013 `server-info-pure`）：

- 住宅 / 数据中心
- 是否广播（非原生）
- 欺诈值与风险档位（低 / 中 / 高 / 极高）

### 3. 连通与阻断
整合 [RavelloH/block_check](https://gist.github.com/RavelloH/383354955aa3800e1d7e98666e11e16f) 思路：

| 检测项 | 含义 |
|--------|------|
| 节点代理 | 经该节点能否拿到公网 IP |
| 本机网络 | 直连是否正常 |
| 远端探测 | check-host 对节点 `host:port` 的 TCP 探测 |
| 国内定位 | 仅当「本机正常 + 远端可达 + 节点代理失败」时，用 Globalping 区分 GFW / 运营商拦截 |
| 诊断结论 | 正常 / 离线 / 疑似阻断 / 本机异常 等 |

### 4. 展示
- 长按面板 HTML + 通知正文
- 按类型 / 风险切换 SF Symbol 与主题色

---

## 安装

```ini
[task_local]
event-interaction https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js, tag=节点IP质量检测, img-url=shield.lefthalf.filled.system, enabled=true
```

1. 保存配置  
2. 打开 **Tunnel（VPN）**  
3. **长按节点** → 选「节点IP质量检测」  

完整片段见 [`conf/ipquality-qx.conf`](./conf/ipquality-qx.conf)。

---

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| （长按节点） | — | 自动使用该节点 tag |
| `policy` / `node` | 空 | 写死节点或策略组名 |
| `mask` | `0` | `1` 隐藏 IP 后两段 |
| `pure` | `1` | `0` 关闭 IPPure |
| `block` | `0` | `1` 开启阻断/远端探测（更慢） |

示例：

```ini
# 只要 IP + 纯净度，不要远端 TCP（更快）
argument=policy=🇭🇰 香港&block=0

# 遮 IP + 全开
argument=mask=1&pure=1&block=1
```

---

## 结果结构（示意）

```text
🌐 IP　203.0.113.10
🏠 类型　住宅 IP · 原生倾向，IPPure
📍 地区　🇨🇳 [CN] 中国台湾
🔢 ASN　AS3462
🏢 组织　…

✨ IPPure 纯净度
　类型　住宅 · 原生倾向
　欺诈值　12 · 低风险

🛡️ 风险
　🟢 IPPure　欺诈值 12 · 低风险
　🟢 ip-api　未命中 proxy/hosting

🔗 连通 / 阻断
　节点代理　✅ 正常
　本机网络　✅ 正常
　远端探测　✅ 可达
　🇺🇸 42.1ms  🇯🇵 88.0ms  …
　结论　✅ 节点正常
```

---

## 耗时说明

| 模式 | 大约耗时 |
|------|----------|
| 默认（`block=0`） | 约 3～8 秒（推荐） |
| `block=1` 且节点正常 | 约 8～15 秒 |
| 节点失败 + Globalping | 约 15～18 秒（脚本 18s 硬超时） |

若面板提示「无有效内容」：请更新到最新脚本，确认 Tunnel 已开并 **长按节点** 运行；仍失败时用 `argument=block=0`。

---

## 数据源

| 用途 | 来源 |
|------|------|
| 出口 IP | ipify / ip-api / icanhazip |
| 地理与标记 | ip-api、ipapi.is |
| 纯净度 | my.ippure.com |
| 远端 TCP | check-host.net |
| 国内运营商 | api.globalping.io |

会向上述服务提交出口 IP 或节点地址；介意隐私时请勿使用。

---

## 常见问题

**Q：测到的一直是当前连接？**  
请 **长按目标节点** 再运行，不要只在工具页点一下。

**Q：远端探测显示「无节点地址」？**  
需 QX 支持 `$configuration.sendMessage` 读取节点描述；部分订阅格式可能解析不到 `host:port`。

**Q：和 Loon 全量 ipquality 一样吗？**  
不一样。本脚本面向 QX 长按场景，聚焦 **IP + 纯净度 + 阻断**，不做完整流媒体矩阵。

---

## 致谢

- [ddgksf2013 server-info-pure](https://ddgksf2013.top/scripts/server-info-pure.js) / [IPPure](https://ippure.com/) — 纯净度
- [RavelloH/block_check](https://gist.github.com/RavelloH/383354955aa3800e1d7e98666e11e16f) — 阻断诊断
- [crossutility/Quantumult-X](https://github.com/crossutility/Quantumult-X) — UIAction / opts.policy
- [I-am-R-E GeoLocationChecker](https://github.com/I-am-R-E/Functional-Store-Hub) — 旗帜逻辑
- [MaYIHEI/paperclip](https://github.com/MaYIHEI/paperclip) — Loon IP 质量检测思路

---

## 许可

MIT。请遵守各第三方 API 服务条款。
