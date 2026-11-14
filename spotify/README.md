# Spotify iOS 9.2.x 解锁 Premium · Quantumult X

## 一键导入

重写模块地址（Quantumult X → 重写 → 引用 → 添加）：

```
https://raw.githubusercontent.com/dhicoc/qx-ipquality/master/spotify/spotify.conf
```

导入后确认 MitM 主机名含 `spclient.wg.spotify.com`、`*spclient.spotify.com`，证书已信任，
然后从后台彻底杀掉 Spotify 再打开。

仓库内另有 `spotify-local.conf`，用本地脚本（放 QX 的 Scripts 目录）而不是远程拉取，
适合 raw.githubusercontent.com 直连不通的情况。

## 结论（为什么会失效）

Spotify 9.x 把「账号产品状态」的接口整个换了：

| | 8.x 及更早 | 9.x（9.2.0.2054 实测） |
|---|---|---|
| 产品状态 | `POST /bootstrap/v1/bootstrap`<br>`POST /user-customization-service/v1/customize` | `GET /nebula/v1/configuration/attributes` |
| 编码 | protobuf（`BootstrapResponse` / `UcsResponseWrapper`） | protobuf（`Nebula.GetAttributesResponse`），服务端也支持 JSON |
| 缓存 | ETag → 304 | ETag → **304，用本地缓存状态** |
| 歌手/专辑 | `artistview` / `album-entity-view` + `platform=ipad` | Pathfinder，老规则无效 |

旧脚本的 3 条规则在 9.2.0 上一个都匹配不到，所以完全不生效。

抓包里 9.2.0 只请求一次 nebula（启动时），返回 71 个属性：
`type=free`、`catalogue=free`、`ads=true`、`on-demand=false`、
`player-license=mft`、`name=Spotify Free`、`financial-product=pr:free,tc:0` …

把它改写成 premium 的一组值即可。

## 协议（逆向出来的）

```proto
message GetAttributesResponse {
  map<string, Attribute> attributes = 1;
}
message Attribute {
  oneof value {
    bool   bool_value   = 2;
    int64  long_value   = 3;
    string string_value = 4;
  }
}
```
map entry: `field 1 = key(string)`, `field 2 = Attribute`。

脚本做法：解析顶层所有 field 1 的 map entry，丢掉被覆盖的 key，
其余原样保留（连未知字段一起），最后追加新值。不重编码未改动的条目，
不用 protobuf 库，纯手写 varint。

## 文件

- `spotify.conf` —— QX 重写模块（规则）
- `spotify-nebula.js` —— 响应体改写：free → premium（protobuf + JSON 双支持）
- `spotify-nebula-header.js` —— 删 `If-None-Match`，强制 200（关键，不然一直 304）
- `spotify-ads.js` —— 去广告：`/ads/v3/ads` 回空 pod，`/ad-logic/prefetch` 回无广告决策
- `spotify-capabilities.js` —— 可选：device-capabilities 伪装 premium/高音质，默认关闭

## 去广告原理

9.2.0 的广告只有两个入口：

| 接口 | 作用 | 处理 |
|---|---|---|
| `POST /ads/v3/ads?slots=...` | 拉取 marquee/embedded 等展示类广告 | 按请求的 slot 回空数组 `{"pod":{"slot":[]}}` |
| `POST /ad-logic/prefetch` | 音频流广告（preroll/midroll）预取，返回 pod 里真实广告 | 回服务端"无广告"时的标准结构，`pod:{}`、`max_ads:0` |

`/ad-logic/v3/config`、`/ad-logic/state/config` 是广告配置，不动。

另外 nebula 属性里 `ads=false` 也会让客户端不再主动请求广告，两层叠加。

## 音质：别碰，会直接把播放搞坏

实测证据（2026-11-14 抓包）：客户端按 320k/无损档去要文件时，

```
GET  /storage-resolve/v2/files/audio/interactive/2/<file_id>   → 200（文件能下）
POST /playplay/v1/key/<file_id>                                → 403（密钥被拒）
```

拿不到密钥 → 播放器播几秒或直接跳到下一首 → 循环。

所以 `player-license`、`high-bitrate`、`audio-quality`、`is-pigeon`、`loudness-levels`
**一个都不要改**，保持服务端下发的免费档值。改了会让客户端误判自己有权播高码率。

真正会导致跳歌的判定链：

| 属性 | 免费值 | 改成 premium 后 |
|---|---|---|
| `player-license` | `mft` | 客户端去要 320k 文件 → key 403 |
| `high-bitrate` | `false` | 同上 |
| `audio-quality` | 缺省 | 同上 |
| `is-pigeon` | 缺省 | 会去试无损档 → 更容易 403 |

音质就停在免费档（96 kbps）。要真 320k 只能靠真实订阅。

## 安装

1. 三个 `.js` 存到 **我的 iPhone → Quantumult X → Scripts**
2. `spotify.conf` 导入为重写模块（或把规则贴进 `[rewrite_local]`）
3. MitM 主机名包含 `spclient.wg.spotify.com`、`*-spclient.spotify.com`，证书已信任
4. 后台彻底杀掉 Spotify 再打开

## 验证

QX 日志里应出现：

```
[spotify-nebula] entries=71 replaced=17 kept=54 added=40
```

`replaced` 是替换掉的旧 free 字段，`added` 是新增字段。
如果只有 `[spotify-nebula-header] stripped=true` 而没有下一条，
说明响应体脚本没匹配上或 App 没重新拉数据。

## 注意

- 产品状态在启动时拉取一次；装完重启 App 才生效
- Spotify 把状态写进本地 `product-state.txt`，正常情况 200 回来会覆盖
- 高音质（320k/HIFI）仍可能被服务端拒绝发 key，`spotify-capabilities.js` 单独开单独试
- 老版本（8.x）把 conf 里最后三条注释打开即可继续用 app2smile 的原脚本
