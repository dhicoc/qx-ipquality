/* 海角解锁 · QX 版 2/3 —— 广告接口置空
 *
 * 匹配：^https?://<你的域名>/api/(banner|ad|advert)/
 * 类型：script-response-body
 *
 * 站点响应是 {isEncrypted:true, data:base64} 套娃，data 解出来是 []。
 * 这里原样回一个「加密壳 + data=[]」，前端 decodeBody 之后拿到空数组，不会崩。
 */
var AD_EMPTY = '{"isEncrypted":true,"errorCode":0,"message":"","success":true,"data":"VnpFd1BRPT0="}';

var h = {};
var src = $response.headers || {};
for (var k in src) {
    if (!/^content-(length|encoding)$/i.test(k)) h[k] = src[k];
}
h['Content-Type'] = 'application/json;charset=utf-8';

$done({ body: AD_EMPTY, headers: h });
