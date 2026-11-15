/* 海角解锁 · QX 版 3/3 —— 页面注入（试看门禁摘除 + 广告 DOM 隐藏 + 状态角标）
 *
 * 匹配：站点页面（非 api / 非静态资源）
 * 类型：script-response-body
 *
 * 只处理 text/html；注入的 <script> 插在 <head> 最前面，早于站点 app.js，
 * 所以 EventTarget.prototype.addEventListener 的 hook 能抢在门禁绑定之前。
 * 顺带把 CSP 头摘掉，避免内联脚本被拦。
 */
var ct = '';
try {
    ct = String(($response.headers && ($response.headers['Content-Type'] || $response.headers['content-type'])) || '');
} catch (e) { }
if (ct && ct.toLowerCase().indexOf('text/html') < 0) { $done({}); }

var html = $response.body;
if (!html || typeof html !== 'string' || html.indexOf('hj-qx-inject') >= 0) { $done({}); }

var payload = '(' + function () {
    if (window.__hjQXInject) return;
    window.__hjQXInject = true;

    var GATE_SRC = /请购买出售内容|购买出售内容/;
    var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    var st = { killed: 0, resumes: 0, adDom: 0, adImg: 0 };
    var debounce = false;

    /* 1) 门禁监听：回调源码里内联了购买提示语，按特征整条丢弃 */
    try {
        var oAdd = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (type, fn, opts) {
            try {
                if (fn && typeof fn === 'function'
                    && GATE_SRC.test(Function.prototype.toString.call(fn))) {
                    st.killed++;
                    console.info('[hj] 拦截门禁监听 ' + type);
                    return;
                }
            } catch (e) { }
            return oAdd.apply(this, arguments);
        };
    } catch (e) { }

    /* 2) 购买提示 alert 吞掉（其它 alert 正常） */
    try {
        var oAlert = window.alert;
        window.alert = function (m) {
            try { if (GATE_SRC.test(String(m))) return; } catch (e) { }
            return oAlert.apply(window, arguments);
        };
    } catch (e) { }

    /* 3) DPlayer 实例 events 表里的同款回调摘掉（不走 EventTarget） */
    function killGate() {
        try {
            var app = document.querySelector('#app');
            var root = app && app.__vue__;
            if (!root) return 0;
            var n = 0, stack = [root], guard = 0;
            while (stack.length && guard++ < 4000) {
                var c = stack.pop();
                try {
                    var dps = [];
                    if (c.$data && c.$data.dPlayer) dps.push(c.$data.dPlayer);
                    if (c.dPlayer) dps.push(c.dPlayer);
                    for (var i = 0; i < dps.length; i++) {
                        var dp = dps[i];
                        if (!dp || !dp.events) continue;
                        var keys = ['timeupdate', 'seeking', 'ended'];
                        for (var j = 0; j < keys.length; j++) {
                            var arr = dp.events[keys[j]];
                            if (!arr || !arr.length) continue;
                            for (var m = arr.length - 1; m >= 0; m--) {
                                try {
                                    var fn = arr[m];
                                    if (fn && typeof fn === 'function'
                                        && GATE_SRC.test(Function.prototype.toString.call(fn))) {
                                        arr.splice(m, 1);
                                        n++;
                                    }
                                } catch (e2) { }
                            }
                        }
                    }
                    var kids = c.$children;
                    if (kids) for (var k = 0; k < kids.length; k++) stack.push(kids[k]);
                } catch (e) { }
            }
            if (n) { st.killed += n; console.info('[hj] 摘除 ' + n + ' 个 DPlayer 门禁回调'); badge(); }
            return n;
        } catch (e) { return 0; }
    }

    /* 4) 兜底：30 秒处被 pause 就续播 */
    function watchdog() {
        try {
            var v = document.querySelector('.video-div video') || document.querySelector('video');
            if (!v) return;
            if (v.paused && !v.ended && v.duration > 60 && v.currentTime > 29.5 && v.currentTime < 33) {
                v.play().catch(function () { });
                st.resumes++;
            }
        } catch (e) { }
    }

    /* 5) 广告：CSS + DOM + banner 图 */
    var CSS = '.containeradvertising{display:none!important}'
        + '.preview-title>div[data-id]:not(.video-div):not(.video-div-btn){display:none!important}';

    function injectCss() {
        try {
            if (document.getElementById('hj-ad-css')) return;
            var root = document.head || document.documentElement;
            if (!root) return;
            var s = document.createElement('style');
            s.id = 'hj-ad-css';
            s.textContent = CSS;
            root.appendChild(s);
        } catch (e) { }
    }

    function sweep() {
        if (document.hidden) return;
        injectCss();
        try {
            var els = document.querySelectorAll('.containeradvertising');
            for (var i = 0; i < els.length; i++) {
                if (els[i].getAttribute('data-hj-ad') === '1') continue;
                els[i].setAttribute('data-hj-ad', '1');
                els[i].style.setProperty('display', 'none', 'important');
                st.adDom++;
            }
            var imgs = document.querySelectorAll('img[src*="hjstore/system/banner/"]');
            for (var j = 0; j < imgs.length; j++) { imgs[j].src = BLANK; st.adImg++; }
        } catch (e) { }
    }

    function schedule() {
        if (debounce) return;
        debounce = true;
        setTimeout(function () { debounce = false; sweep(); }, 250);
    }

    /* 6) 角标 */
    var el = null, txt = '';

    function badge() {
        try {
            if (!document.body) return;
            var t = '海角解锁 ' + (st.killed > 0 ? '✅ 门禁已解 ' + st.killed : '⚠ 门禁未命中 · 点我重试');
            if (st.adDom + st.adImg > 0) t += '\n广告已拦 ' + (st.adDom + st.adImg) + ' 处';
            if (t === txt && el && el.isConnected) return;
            txt = t;
            if (!el || !el.isConnected) {
                if (!el) {
                    el = document.createElement('div');
                    el.id = 'hj-badge';
                    el.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;'
                        + 'background:rgba(20,22,28,.9);color:#eaeef5;font:12px/1.6 system-ui;'
                        + 'padding:8px 11px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);'
                        + 'cursor:pointer;user-select:none;max-width:260px;white-space:pre-line';
                    el.addEventListener('click', function () {
                        var n = killGate();
                        try {
                            var v = document.querySelector('.video-div video') || document.querySelector('video');
                            if (v) { if (v.ended) v.currentTime = Math.max(0, v.currentTime - 1); v.play().catch(function () { }); }
                        } catch (e) { }
                        txt = '';
                        badge();
                        console.info('[hj] 手动重扫门禁：' + n);
                    }, true);
                }
                document.body.appendChild(el);
            }
            el.textContent = t;
        } catch (e) { }
    }

    /* 启动 */
    injectCss();
    sweep();
    var t1 = setInterval(function () { sweep(); }, 250);
    setTimeout(function () { clearInterval(t1); badge(); }, 10000);

    var t2 = setInterval(function () { killGate(); watchdog(); }, 500);
    setTimeout(function () { clearInterval(t2); badge(); }, 120000);

    document.addEventListener('click', function () { if (st.killed === 0) killGate(); }, true);
    try { new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) { }
    document.addEventListener('DOMContentLoaded', function () { sweep(); badge(); }, { once: true });
    window.addEventListener('load', function () { sweep(); badge(); }, { once: true });
    if (document.body) badge();
}.toString() + ')();';

var tag = '<script id="hj-qx-inject">' + payload + '<' + '/script>';
var out;
if (/<head[^>]*>/i.test(html)) {
    out = html.replace(/<head[^>]*>/i, function (m) { return m + tag; });
} else if (/<html[^>]*>/i.test(html)) {
    out = html.replace(/<html[^>]*>/i, function (m) { return m + tag; });
} else {
    out = tag + html;
}

var h = {};
try {
    var src = $response.headers || {};
    for (var k in src) {
        if (/^content-security-policy/i.test(k)) continue;   // 去掉 CSP，否则内联脚本被拦
        if (/^content-length$/i.test(k)) continue;
        h[k] = src[k];
    }
} catch (e) { }

$done({ body: out, headers: h });
