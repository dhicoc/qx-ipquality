# 节点 IP 质量检测 · Quantumult X

轻量脚本：长按节点查看出口 IP、类型、纯净度、多源风险与延迟。

> 已去除：block_check 阻断诊断、DNS/DoH 出口对比。

## 安装

```ini
[task_local]
event-interaction https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js, tag=节点IP质量检测, img-url=shield.lefthalf.filled.system, enabled=true
```

1. 保存配置，开启 **Tunnel**  
2. **长按节点** → 节点IP质量检测  
3. 日志应含 `qx6.2`

## 结果示例

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

风险
  🟢 IPPure 12 · 低
  🟢 ip-api 清洁
  🟢 ipinfo 清洁
```

## 参数（任务行 `argument=`）

| 参数 | 默认 | 说明 |
|------|------|------|
| `pure` | `1` | IPPure 纯净度 |
| `rtt` | `1` | HTTP 延迟 |
| `v6` | `1` | IPv6 探测 |
| `mask` | `0` | 遮盖 IP |

```ini
argument=v6=0&rtt=0
```

## 数据源

ipify / icanhazip · IPPure · ip-api · ipapi.is · ipinfo · ipwho.is  

会向上述服务提交出口 IP，介意隐私时请勿使用。
