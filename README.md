# 节点 IP 质量检测 · Quantumult X（仅 IP）

检测出口 IP、地理/ASN 与基础风险。**不含流媒体。**

## 重要：如何测「指定节点」

Quantumult X **不会**像 Loon 那样读取你在列表里「点一下」的节点。

| 操作 | 测到的是 |
|------|----------|
| **长按某个节点 → 选本脚本** | ✅ 该节点出口（推荐） |
| 工具页直接点运行 | 当前默认路由 / 当前连接 |
| `argument=policy=完整节点名` | 写死的那个节点/策略 |

这是 QX 官方 UIAction 机制：长按时会把节点 tag 放进 `$environment.params`，脚本用 `opts.policy` 走该节点。

## 仓库

- https://github.com/dhicoc/qx-ipquality
- 脚本：https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js

## 安装

```ini
[task_local]
event-interaction https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js, tag=节点IP质量检测, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Available.png, enabled=true
```

1. 保存配置，确保 **Quantumult X Tunnel（VPN）已开启**  
2. 打开 **节点** 列表  
3. **长按** 要测的节点  
4. 在弹出菜单里点 **「节点IP质量检测」**  
5. 看面板 / 通知结果  

节点名须与配置里 tag **完全一致**（含 emoji、空格）。

### 可选：工具页写死策略

```ini
event-interaction https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/src/ipquality-qx.js, tag=IP·香港, enabled=true, argument=policy=🇭🇰 香港 01
```

也支持 URL hash 变量：

```text
.../ipquality-qx.js#policy=节点名&mask=0
```

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| （长按节点） | — | 自动使用该节点，无需 argument |
| `policy` / `node` | 空 | 节点 tag 或策略组名 |
| `mask` | `0` | `1` 时 IP 显示为 `x.x.*.*` |

策略组名 = 该组**当前选中**的出口；要指定某一台机器，请用**完整节点名**或长按该节点。

## 数据源

- 出口探针：ipify / ip-api / icanhazip / ident.me（走目标节点）  
- 库查询：ip-api、ipapi.is（按 IP 查详情）  

## 说明

- 仅 IPv4  
- Tunnel 未开启时，长按节点任务可能失败  
- 无法 1:1 复刻 Loon 节点页 generic 体验；长按节点是 QX 侧等价做法  
