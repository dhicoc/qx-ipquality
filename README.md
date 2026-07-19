# 节点 IP 质量检测 · Quantumult X（仅 IP）

只检测出口 IP、地理/ASN 与基础风险标记，**不含流媒体/AI**。

## 文件

- `src/ipquality-qx.js` — 脚本
- `conf/ipquality-qx.conf` — 任务配置片段

## 安装

```ini
[task_local]
event-interaction https://你的地址/ipquality-qx.js, tag=节点IP质量检测, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Available.png, enabled=true
```

指定策略：

```ini
event-interaction https://你的地址/ipquality-qx.js, tag=IP检测·香港, enabled=true, argument=policy=香港&mask=0
```

**风车 → 工具 → 节点IP质量检测** 运行，看通知。

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `policy` | 空 | 出口探测走该策略组/节点；空则默认路由 |
| `mask` | `0` | `1` 时 IP 显示为 `x.x.*.*` |

## 通知示例

```text
IP  1.2.3.4
类型  普通出口
地区  🇺🇸 [US] United States
城市  California · Los Angeles
ASN  AS13335
组织  Cloudflare
时区  America/Los_Angeles

· 风险
  ip-api  未命中 proxy/hosting
  ipapi.is  无风险标记
```

## 说明

- 数据源：出口探针 + ip-api + ipapi.is  
- 无 HTML 弹窗、无节点页一键、无流媒体  
- 仅 IPv4  
