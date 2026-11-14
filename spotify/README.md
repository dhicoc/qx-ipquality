# Spotify iOS 9.2.x 解锁 Premium · Quantumult X

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
- `spotify-capabilities.js` —— 可选：device-capabilities 伪装 premium/高音质，默认关闭

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
