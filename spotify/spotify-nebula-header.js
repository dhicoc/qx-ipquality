/*
 * Spotify 9.2.x —— 删除 If-None-Match / If-Modified-Since
 * 目的: App 启动时 nebula 会带 ETag 条件请求，服务端回 304，App 继续用本地缓存的
 *       free 产品状态，导致响应体脚本根本不执行。删掉条件头强制 200 拿全量。
 * 适用: /nebula/v1/configuration/attributes
 */

var headers = $request.headers || {};
var changed = false;

for (var key in headers) {
    var lk = key.toLowerCase();
    if (lk === 'if-none-match' || lk === 'if-modified-since') {
        delete headers[key];
        changed = true;
    }
}

console.log('[spotify-nebula-header] stripped=' + changed);
$done({ headers: headers });
