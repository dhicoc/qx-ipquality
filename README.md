# 节点 IP 质量检测 · Quantumult X

[![Version](https://img.shields.io/badge/Script-qx5-blue?style=flat-square)](#功能)

长按节点一次查看：**双栈出口**、**多库风险/纯净度**、**DNS 一致性**、**RTT**、**连通/阻断诊断**。

| 项目 | 链接 |
|------|------|
| 脚本（防缓存） | https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js?v=20260720-50 |
| 配置片段 | [`conf/ipquality-qx.conf`](./conf/ipquality-qx.conf) |

---

## 功能

### A. 阻断诊断（对齐 [RavelloH/block_check](https://gist.github.com/RavelloH/383354955aa3800e1d7e98666e11e16f)）

| 检测 | 说明 |
|------|------|
| 节点代理 | 经节点能否拿到公网 IP |
| 本机网络 | `direct` 是否正常 |
| 远端探测 | check-host 对节点 `host:port` 的 TCP |
| 国内定位 | 仅当「本机正常 + 远端可达 + 节点代理失败」时 Globalping 区分 GFW / 运营商 |
| 诊断结论 | 正常 / 离线 / 疑似阻断 / 本机异常 等 |

### B. 质量与扩展

| 模块 | 说明 |
|------|------|
| **IPv4 / IPv6** | 双栈分别探测，面板分行展示 |
| **IPPure** | 住宅/机房、广播、欺诈值 |
| **ip-api / ipapi.is / ipinfo / ipwho.is** | 多源地理与风险标记（节点优先拉取） |
| **DNS 出口** | Cloudflare DoH whoami，对比 HTTP 出口是否一致 |
| **延迟 RTT** | 经节点访问固定 URL 的 HTTP 往返时延 |

---

## 安装

```ini
[task_local]
event-interaction https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js?v=20260720-50, tag=节点IP质量检测, img-url=shield.lefthalf.filled.system, enabled=true
```

1. 保存配置并 **开启 Tunnel**  
2. **长按节点** → 节点IP质量检测  
3. 日志应含 `start ... qx5`

---

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `block` | `1` | `0` 关阻断；`1`/`full` 开 check-host（慢） |
| `pure` | `1` | IPPure |
| `dns` | `1` | DNS 出口对比 |
| `rtt` | `1` | HTTP RTT |
| `v6` | `1` | IPv6 探测 |
| `mask` | `0` | 遮盖 IP |

示例：

```ini
# 快速（约 5～10s）：不要远端 TCP
argument=block=0

# 全开但关 IPv6
argument=block=1&v6=0
```

---

## 耗时与超时

- QX `event-interaction` 约 **20s** 硬限制  
- 脚本 **18s** 软超时，尽量返回已有数据  
- `block=1` 含 check-host 等待 ≈ 3s，总耗时常见 **10～18s**  
- 若经常超时：用 `argument=block=0`

---

## 隐私说明

检测会将出口 IP / 节点地址提交给：IPPure、ip-api、ipapi.is、ipinfo、ipwho.is、check-host、Globalping、Cloudflare DNS 等。介意时请勿使用或关闭对应模块（`pure=0` / `block=0` / `dns=0`）。

---

## 致谢

- [RavelloH/block_check](https://gist.github.com/RavelloH/383354955aa3800e1d7e98666e11e16f)  
- [ddgksf2013 / IPPure](https://ippure.com/)  
- [crossutility/Quantumult-X](https://github.com/crossutility/Quantumult-X)  
- [I-am-R-E GeoLocationChecker](https://github.com/I-am-R-E/Functional-Store-Hub)  
- [MaYIHEI/paperclip](https://github.com/MaYIHEI/paperclip)  

---

## 许可

MIT
