# 节点 IP 质量检测 · Quantumult X

轻量脚本：长按节点查看出口 IP、类型、纯净度、多源风险、DNS 一致性与延迟。

> 已**去除** [block_check](https://gist.github.com/RavelloH/383354955aa3800e1d7e98666e11e16f) 阻断诊断（check-host / Globalping），结果更短、更稳。

## 安装

```ini
[task_local]
event-interaction https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js?v=20260720-60, tag=节点IP质量检测, img-url=shield.lefthalf.filled.system, enabled=true
```

1. 保存配置，开启 **Tunnel**  
2. **长按节点** → 节点IP质量检测  
3. 日志应含 `qx6`

## 结果示例（适中详细）

```text
IPv4  118.163.170.1
类型  住宅 IP
地区  🇨🇳 [CN] 中国台湾
城市  Taipei
网络  AS3462 · Chunghwa Telecom
节点  台湾TURN-…
延迟  86 ms

纯净度
  住宅 · 欺诈值 12（低风险）

DNS
  HTTP  118.163.170.1
  DNS   118.163.170.1
  ✅ DNS 与 HTTP 出口一致

风险
  🟢 IPPure 12 · 低
  🟢 ip-api 清洁
  🟢 ipinfo 清洁
```

## 参数（写在任务行 `argument=`）

| 参数 | 默认 | 说明 |
|------|------|------|
| `pure` | `1` | IPPure 纯净度 |
| `dns` | `1` | DNS 出口对比 |
| `rtt` | `1` | HTTP 延迟 |
| `v6` | `1` | IPv6 探测 |
| `mask` | `0` | 遮盖 IP |

```ini
# 关 IPv6 和 DNS
argument=v6=0&dns=0
```

## 数据源

ipify / icanhazip · IPPure · ip-api · ipapi.is · ipinfo · ipwho.is · Cloudflare DoH  

会向上述服务提交出口 IP，介意隐私时请勿使用。

## 致谢

- IPPure / ipinfo / ipwho / ip-api  
- Quantumult X UIAction  
- 曾参考 block_check，当前版本已不再包含其阻断逻辑  
