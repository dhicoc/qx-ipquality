/* 海角解锁 · QX 版 1/3 —— POST /api/attachment 取址改写
 *
 * 匹配：^https?://<你的域名>/api/attachment
 * 类型：script-request-body
 *
 * 逻辑：查 node 列表里 money_type=0 的免费帖 → 把请求体 resource_id 换成它
 *       → 服务端按免费帖签发，返回完整索引而不是 30 秒预览。
 * 缓存：$prefs 24 小时，避免每个视频都探一次。
 */
var CACHE_KEY = 'hj_pass_topic_v1';
var TTL = 86400000;
var HOLD_MS = 4000;
var NODES = ['888', '900', '972', '300'];
var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64dec(s) {
    s = String(s || '').replace(/[^A-Za-z0-9+/=]/g, '');
    var out = '', buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '=') break;
        var v = B64C.indexOf(c);
        if (v < 0) continue;
        buf = ((buf << 6) | v) & 0xffff;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += String.fromCharCode((buf >> bits) & 0xff);
            buf &= (1 << bits) - 1;
        }
    }
    return out;
}

function u8dec(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) out += String.fromCharCode(c);
        else if (c >= 0xc0 && c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (s.charCodeAt(++i) & 0x3f));
        else if (c >= 0xe0 && c < 0xf0) out += String.fromCharCode(((c & 0x0f) << 12) | ((s.charCodeAt(++i) & 0x3f) << 6) | (s.charCodeAt(++i) & 0x3f));
        else if (c >= 0xf0) {
            var cp = ((c & 0x07) << 18) | ((s.charCodeAt(++i) & 0x3f) << 12) | ((s.charCodeAt(++i) & 0x3f) << 6) | (s.charCodeAt(++i) & 0x3f);
            var h = 0xd800 + ((cp - 0x10000) >> 10), l = 0xdc00 + ((cp - 0x10000) & 0x3ff);
            out += String.fromCharCode(h, l);
        }
    }
    return out;
}

function unb64(s) {
    var c = String(s == null ? '' : s).trim();
    for (var i = 0; i < 6; i++) {
        if (!/^[A-Za-z0-9+/=\s]+$/.test(c)) return c;
        var t = u8dec(b64dec(c));
        if (!t || t === c) return c;
        c = t;
    }
    return c;
}

function decodeBody(txt) {
    var j = JSON.parse(txt);
    var g = 0;
    while (j && typeof j === 'object' && j.isEncrypted && typeof j.data === 'string' && g++ < 6) {
        j = JSON.parse(unb64(j.data));
    }
    return j;
}

/* ---------- 主流程 ---------- */

var body = typeof $request.body === 'string' ? $request.body : '';
var hdrs = $request.headers || {};
var finished = false;

function fin(nb) {
    if (finished) return;
    finished = true;
    try { $done(nb === undefined || nb === null ? {} : { body: nb }); } catch (e) { }
}

setTimeout(function () { fin(); }, HOLD_MS);   // 兜底：超时原样放行，别把页面卡死

var obj = null;
try { obj = JSON.parse(body); } catch (e) { }

if (!obj || Number(obj.resource_id) <= 0
    || (obj.resource_type !== 'topic' && obj.resource_type !== 'video_center')) {
    fin();
} else {
    run(obj);
}

function run(o) {
    var cached = getCache();
    if (cached > 0) { fin(rewrite(o, cached)); return; }
    var tk = pickToken();
    if (!tk.token || !tk.uid) { console.log('hj: 请求里没 token/uid —— 先登录站点'); fin(); return; }
    probe(o, tk, 0);
}

function rewrite(o, id) {
    id = Number(id);
    if (!(id > 0)) return null;
    if (Number(o.resource_id) === id) return null;
    var old = o.resource_id;
    o.resource_id = id;
    o.resource_type = 'topic';
    console.log('hj: 换址 ' + old + ' -> ' + id);
    return JSON.stringify(o);
}

function pickToken() {
    var t = hdrs['X-User-Token'] || hdrs['x-user-token'] || '';
    var u = hdrs['X-User-Id'] || hdrs['x-user-id'] || '';
    if (!t || !u) {
        var ck = hdrs['Cookie'] || hdrs['cookie'] || '';
        var mt = /(?:^|;\s*)token=([^;]*)/.exec(ck);
        var mu = /(?:^|;\s*)uid=([^;]*)/.exec(ck);
        if (mt) t = mt[1];
        if (mu) u = mu[1];
    }
    try { t = decodeURIComponent(t); } catch (e) { }
    try { u = decodeURIComponent(u); } catch (e) { }
    return { token: String(t || '').trim(), uid: String(u || '').trim() };
}

function probe(o, tk, i) {
    if (i >= NODES.length) { console.log('hj: 四个 node 都没探到免费帖'); fin(); return; }
    var m = /^(https?:\/\/[^\/]+)/.exec(String($request.url || ''));
    var origin = m ? m[1] : '';
    if (!origin) { fin(); return; }
    var u = origin + '/api/topic/node/topics?node_id=' + NODES[i] + '&page=1&limit=20';
    $task.fetch({
        url: u,
        headers: {
            'X-User-Token': tk.token,
            'X-User-Id': tk.uid,
            'pcVer': '2',
            'Accept': 'application/json'
        }
    }).then(function (r) {
        var j = null;
        try { j = decodeBody(r.body || ''); } catch (e) { }
        var list = (j && j.results) || [];
        for (var k = 0; k < list.length; k++) {
            var t = list[k];
            if (Number(t.money_type) !== 0) continue;
            var id = Number(t.topicId || t.id || 0);
            if (id > 0) {
                setCache(id);
                console.log('hj: 通行证帖 ' + id + '（node ' + NODES[i] + '）');
                fin(rewrite(o, id));
                return;
            }
        }
        probe(o, tk, i + 1);
    }, function () { probe(o, tk, i + 1); });
}

function getCache() {
    try {
        var s = $prefs.valueForKey(CACHE_KEY);
        if (!s) return 0;
        var o = JSON.parse(s);
        if (o && Number(o.id) > 0 && Date.now() - Number(o.t || 0) < TTL) return Number(o.id);
    } catch (e) { }
    return 0;
}

function setCache(id) {
    try { $prefs.setValueForKey(JSON.stringify({ id: Number(id), t: Date.now() }), CACHE_KEY); } catch (e) { }
}
