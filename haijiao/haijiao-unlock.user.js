// ==UserScript==
// @name         海角解锁补丁
// @namespace    hj.unlock
// @version      3.0.0
// @description  通行证取址改写 + 广告拦截 + 30 秒试看门禁摘除（必须在页面世界运行）
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// ==/UserScript==
/* 海角解锁 · MAIN world 补丁
 *
 * 直接跑在页面世界（manifest content_scripts 的 world:"MAIN"），
 * document_start 注入，早于站点自身脚本，所以能可靠 hook XHR/fetch。
 * 不依赖 Tampermonkey，也不依赖 chrome.userScripts。
 *
 * 两件事：
 *   1) 把 POST /api/attachment 的 resource_id 换成免费通行证帖 → 拿到完整索引而非 30 秒预览
 *   2) 拦 /api/banner/* 与 banner 图片，收起 .containeradvertising
 *
 * 注意：广告守卫必须防自激 —— 角标写文字会触发 subtree observer，
 * 所以 badge() 只在文本变化时落笔，且 observer 回调统一 250ms 去抖。
 */
(function () {
    'use strict';

    if (window.__hjMainPatch) return;
    window.__hjMainPatch = true;

    var CACHE_KEY = 'hj_main_pass_topic_v1';
    var CACHE_TTL = 24 * 3600 * 1000;
    var HOLD_MS = 4000;
    var SWEEP_DEBOUNCE = 250;
    var HJ_VER = 'v3';

    // 三次标准 base64 的 '[]'
    var AD_EMPTY = '{"isEncrypted":true,"errorCode":0,"message":"","success":true,"data":"VnpFd1BRPT0="}';
    // 1x1 透明 GIF
    var BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    var st = window.__hjMainPatchState = {
        token: false,
        passTopic: 0,
        hits: 0,
        held: 0,
        adApi: 0,
        adDom: 0,
        adImg: 0,
        gateKilled: 0,
        cssDone: false,
        sweeps: 0,
        seen: [],
        err: []
    };

    /* ---------- 30 秒试看门禁（最先安装，必须早于站点脚本） ----------
     * 站点在 app.js 里给 video 挂了三个监听：
     *   timeupdate: 0<o && currentTime>o && (pause(), alert('请购买出售内容，观看完整视频'))
     *   seeking:    同上，并把 currentTime 拽回 o
     *   ended:      同上
     * o 是闭包里的 30，改不到；但那句提示语是**字面量内联在回调源码里**的，
     * 所以按源码特征把这三个监听器丢掉即可，比每次 pause 后再 play 干净得多。
     */
    var GATE_SRC = /请购买出售内容|购买出售内容/;

    try {
        var oAdd = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (type, fn, opts) {
            try {
                if (fn && typeof fn === 'function' && GATE_SRC.test(Function.prototype.toString.call(fn))) {
                    st.gateKilled++;
                    console.info('[海角解锁] 已拦截购买门禁监听：' + type);
                    return;
                }
            } catch (e) { }
            return oAdd.apply(this, arguments);
        };
    } catch (e) { st.err.push('addEventListener-hook'); }

    /* 站点的门禁回调是挂在 DPlayer 实例的 events 表里（dPlayer.addEventListener），
     * 不走 EventTarget，所以再到 Vue 树里把带特征串的回调从 events 数组中摘掉。
     * 只删命中特征的那一条，DPlayer 自己的进度条回调不动。
     */
    function killDPlayerGate() {
        try {
            var app = document.querySelector('#app');
            var root = app && app.__vue__;
            if (!root) return 0;
            var killed = 0, stack = [root], guard = 0;
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
                                        killed++;
                                    }
                                } catch (e2) { }
                            }
                        }
                    }
                    var kids = c.$children;
                    if (kids) for (var k = 0; k < kids.length; k++) stack.push(kids[k]);
                } catch (e) { }
            }
            if (killed) {
                st.gateKilled += killed;
                console.info('[海角解锁] 已摘除 ' + killed + ' 个试看门禁回调（DPlayer events）');
                badge();
            }
            return killed;
        } catch (e) { return 0; }
    }

    /* 兜底看门狗：万一还有漏网的回调在 30 秒处 pause，就把它续播回去。
     * ponytail: 只在 29.5–33 秒窗口内自动续播，用户在这个极窄区间手动暂停会被顶回播放。
     */
    var gateResumes = 0;

    function gateWatchdog() {
        try {
            var v = document.querySelector('.video-div video') || document.querySelector('video');
            if (!v) return;
            if (v.paused && !v.ended && v.duration > 60
                && v.currentTime > 29.5 && v.currentTime < 33) {
                v.play().catch(function () { });
                gateResumes++;
                st.gateKilled = Math.max(st.gateKilled, 1);
            }
        } catch (e) { }
    }

    /* ---------- 工具 ---------- */

    function unb64(s) {
        var c = String(s == null ? '' : s).trim();
        for (var i = 0; i < 6; i++) {
            if (!/^[A-Za-z0-9+/=\s]+$/.test(c)) return c;
            var t;
            try { t = decodeURIComponent(escape(atob(c.replace(/\s+/g, '')))); } catch (e) { return c; }
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

    function ck(n) {
        // about:blank / chrome:// 等文档访问 cookie 会抛 SecurityError
        try {
            var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)'));
            return m ? m[1] : '';
        } catch (e) { return ''; }
    }

    /* ---------- 通行证帖 ---------- */

    try {
        var raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
            var o = JSON.parse(raw);
            if (o && Number(o.id) > 0 && Date.now() - Number(o.t || 0) < CACHE_TTL) {
                st.passTopic = Number(o.id);
            }
        }
    } catch (e) { }

    function savePassTopic(id) {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ id: id, t: Date.now() })); } catch (e) { }
    }

    var waiters = [];

    function flushWaiters() {
        while (waiters.length && st.passTopic > 0) {
            var w = waiters.shift();
            try { w(st.passTopic); } catch (e) { }
        }
    }

    function holdUntilPassTopic(cb) {
        if (st.passTopic > 0) { cb(st.passTopic); return; }
        var w = function (id) { cb(id); };
        waiters.push(w);
        setTimeout(function () {
            var i = waiters.indexOf(w);
            if (i >= 0) {
                waiters.splice(i, 1);
                try { cb(0); } catch (e) { }
            }
        }, HOLD_MS);
    }

    window.__hjFeedPassTopic = function (id) {
        var n = Number(id);
        if (n > 0 && st.passTopic !== n) {
            st.passTopic = n;
            savePassTopic(n);
            flushWaiters();
            badge();
        }
    };

    function pickPassTopic() {
        var token = ck('token');
        var uid = ck('uid');
        // 未登录也照探：/api/topic/node/topics 是公开接口（实测 200，无需 token）
        if (!token || !uid) st.err.push('no-auth');
        st.token = true;
        if (st.passTopic > 0) { badge(); return; }
        var nodes = ['888', '900', '972', '300'];
        (function loop(idx) {
            if (idx >= nodes.length || st.passTopic > 0) {
                if (st.passTopic <= 0) console.info('[海角解锁] 未选到免费帖：' + JSON.stringify(st.err));
                badge();
                return;
            }
            var n = nodes[idx];
            var hdr = { 'pcVer': '2' };
            if (token) hdr['X-User-Token'] = token;
            if (uid) hdr['X-User-Id'] = String(uid);
            fetch('/api/topic/node/topics?node_id=' + n + '&page=1&limit=20', {
                headers: hdr
            }).then(function (r) { return r.text(); }).then(function (txt) {
                var j = decodeBody(txt);
                var list = (j && j.results) || [];
                st.err.push(n + ':' + list.length);
                for (var i = 0; i < list.length; i++) {
                    var t = list[i];
                    if (Number(t.money_type) !== 0) continue;
                    var id = Number(t.topicId || t.id || 0);
                    if (id > 0) {
                        st.passTopic = id;
                        savePassTopic(id);
                        flushWaiters();
                        console.info('[海角解锁] 通行证帖就绪：' + id);
                        badge();
                        return;
                    }
                }
                loop(idx + 1);
            }).catch(function () {
                st.err.push(n + ' EXC');
                loop(idx + 1);
            });
        })(0);
    }

    function rewrite(body) {
        try {
            if (!body || typeof body !== 'string') return body;
            if (body.indexOf('resource_id') < 0 || st.passTopic <= 0) return body;
            var o = JSON.parse(body);
            if (!o || Number(o.resource_id) <= 0) return body;
            if (o.resource_type !== 'topic' && o.resource_type !== 'video_center') return body;
            if (Number(o.resource_id) === st.passTopic) return body;
            var old = o.resource_id;
            o.resource_id = st.passTopic;
            o.resource_type = 'topic';
            st.hits++;
            console.info('[海角解锁] 取址换址：' + old + ' → ' + st.passTopic);
            badge();
            return JSON.stringify(o);
        } catch (e) { return body; }
    }

    /* ---------- 广告 ---------- */

    function isAdApi(u) {
        return /\/api\/banner\//i.test(u) || /\/api\/ad(?:vert)?\//i.test(u);
    }

    function isAdImg(u) {
        return /\/hjstore\/system\/banner\/[^/?#]+\.(?:gif|jpe?g|png|webp|bmp)\.txt(?:[?#]|$)/i.test(u);
    }

    // 隐藏「出售内容包含…以下是预览30秒视频」提示条（保留 .video-div 与 .video-div-btn）
    var AD_CSS = '.containeradvertising{display:none!important}'
        + '.preview-title>div[data-id]:not(.video-div):not(.video-div-btn){display:none!important}';

    function injectAdCss() {
        try {
            if (st.cssDone) return true;
            var root = document.head || document.documentElement;
            if (!root) return false;
            if (document.getElementById('hj-ad-css')) { st.cssDone = true; return true; }
            var s = document.createElement('style');
            s.id = 'hj-ad-css';
            s.textContent = AD_CSS;
            root.appendChild(s);
            st.cssDone = true;
            return true;
        } catch (e) { return false; }
    }

    function sweepAds() {
        if (document.hidden) return;
        st.sweeps++;
        try {
            var els = document.querySelectorAll('.containeradvertising');
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (el.getAttribute('data-hj-ad') === '1') continue;
                el.setAttribute('data-hj-ad', '1');
                el.style.setProperty('display', 'none', 'important');
                st.adDom++;
            }
            // 只挑 banner 图，不要全量扫 img（搜索页缩略图几百张，全量扫就是卡顿源）
            var imgs = document.querySelectorAll('img[src*="hjstore/system/banner/"]');
            for (var j = 0; j < imgs.length; j++) {
                imgs[j].src = BLANK_IMG;
                st.adImg++;
            }
        } catch (e) { }
        injectAdCss();
    }

    var scheduled = false;

    function scheduleSweep() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(function () { scheduled = false; sweepAds(); badge(); }, SWEEP_DEBOUNCE);
    }

    function startAdGuard() {
        injectAdCss();
        sweepAds();
        var tries = 0;
        var t = setInterval(function () {
            sweepAds();
            if (++tries > 40) { clearInterval(t); badge(); }
        }, 250);
        try {
            new MutationObserver(scheduleSweep)
                .observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) { }
        try { document.addEventListener('DOMContentLoaded', scheduleSweep, { once: true }); } catch (e) { }
        window.addEventListener('load', scheduleSweep, { once: true });
    }

    /* 状态角标（只在文本变化时写，避免自激）。可点击 = 手动重扫门禁。 */
    var badgeEl = null;
    var badgeTxt = '';

    function badge() {
        try {
            if (!document.body) return;
            var lines = [];
            lines.push('海角解锁 ' + HJ_VER);
            if (!st.token) {
                lines.push('未登录');
            } else if (st.passTopic > 0) {
                lines.push('通行证 ' + st.passTopic);
                lines.push(st.hits > 0 ? '已换址 ' + st.hits + ' 次 · 完整视频可用' : '等待取址请求…');
            } else {
                lines.push('正在找免费帖…');
            }
            if (st.adApi + st.adDom > 0) lines.push('广告已拦 ' + (st.adApi + st.adDom) + ' 处');
            lines.push(st.gateKilled > 0 ? '✅ 试看门禁已解 ' + st.gateKilled + ' 个' : '⚠ 门禁未命中 · 点这里重试');
            var txt = lines.join('\n');
            if (txt === badgeTxt && badgeEl && badgeEl.isConnected) return;
            badgeTxt = txt;
            if (!badgeEl || !badgeEl.isConnected) {
                if (!badgeEl) {
                    badgeEl = document.createElement('div');
                    badgeEl.id = 'hj-unlock-badge';
                    // 角标必须点得到（原来 pointer-events:none 让手动补救无从下手）
                    badgeEl.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;'
                        + 'background:rgba(20,22,28,.9);color:#eaeef5;font:12px/1.6 system-ui,"Microsoft YaHei";'
                        + 'padding:8px 11px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);'
                        + 'pointer-events:auto;cursor:pointer;user-select:none;max-width:270px;white-space:pre-line';
                    badgeEl.title = '点击 = 重新摘除试看门禁';
                    badgeEl.addEventListener('click', manualKill, true);
                }
                document.body.appendChild(badgeEl);
            }
            badgeEl.textContent = txt;
        } catch (e) { }
    }

    function manualKill() {
        var n = killDPlayerGate();
        try {
            var v = document.querySelector('.video-div video') || document.querySelector('video');
            if (v) {
                if (v.ended) v.currentTime = Math.max(0, v.currentTime - 1);
                v.play().catch(function () { });
            }
        } catch (e) { }
        badgeTxt = '';
        badge();
        console.info('[海角解锁] 手动重扫门禁：摘除 ' + n + ' 个回调');
        if (n === 0) {
            console.info('[海角解锁] 未命中 —— 播放器可能还没创建，先点一下播放再点角标');
        }
    }

    /* ---------- 安装 hook ---------- */

    function stubXhr(xhr, body, ct) {
        var def = function (k, v) {
            try { Object.defineProperty(xhr, k, { configurable: true, value: v }); } catch (e) { }
        };
        var type = '';
        try { type = xhr.responseType || ''; } catch (e) { }
        def('readyState', 4);
        def('status', 200);
        def('statusText', 'OK');
        def('responseURL', '');
        if (type === '' || type === 'text') {
            def('responseText', body);
            def('response', body);
        } else {
            def('response', body);
        }
        try { xhr.getAllResponseHeaders = function () { return 'content-type: ' + ct + '\r\n'; }; } catch (e) { }
        try { xhr.getResponseHeader = function (h) { return /^content-type$/i.test(String(h)) ? ct : null; }; } catch (e) { }
        def('responseXML', null);
        try { xhr.dispatchEvent(new Event('readystatechange')); } catch (e) { }
        try { xhr.dispatchEvent(new Event('load')); } catch (e) { }
        try { xhr.dispatchEvent(new Event('loadend')); } catch (e) { }
        st.adApi++;
        badge();
    }

    try {
        var oOpen = XMLHttpRequest.prototype.open;
        var oSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) {
            try { this.__hjU = String(u || ''); } catch (e) { }
            return oOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (b) {
            var self = this;
            try {
                var u = this.__hjU || '';
                if (isAdApi(u)) { stubXhr(this, AD_EMPTY, 'application/json;charset=utf-8'); return; }
                if (isAdImg(u)) { stubXhr(this, BLANK_IMG, 'text/plain;charset=utf-8'); return; }
                if (u.indexOf('/api/attachment') >= 0 && b) {
                    if (st.seen.length < 20) st.seen.push(String(b).slice(0, 140));
                    if (st.passTopic > 0) {
                        b = rewrite(b);
                    } else {
                        st.held++;
                        holdUntilPassTopic(function (pid) {
                            oSend.call(self, pid > 0 ? rewrite(b) : b);
                        });
                        return;
                    }
                }
            } catch (e) { }
            return oSend.call(this, b);
        };
    } catch (e) { }

    try {
        var oF = window.fetch;
        window.fetch = function (i, ini) {
            var self = this;
            var args = arguments;
            try {
                var u = typeof i === 'string' ? i : (i && i.url) || '';
                if (isAdApi(u)) {
                    st.adApi++;
                    badge();
                    return Promise.resolve(new Response(AD_EMPTY, {
                        status: 200,
                        headers: { 'Content-Type': 'application/json;charset=utf-8' }
                    }));
                }
                if (isAdImg(u)) {
                    st.adImg++;
                    badge();
                    return Promise.resolve(new Response(BLANK_IMG, {
                        status: 200,
                        headers: { 'Content-Type': 'text/plain;charset=utf-8' }
                    }));
                }
                if (u.indexOf('/api/attachment') >= 0 && ini && typeof ini.body === 'string') {
                    if (st.seen.length < 20) st.seen.push('fetch:' + ini.body.slice(0, 140));
                    if (st.passTopic > 0) {
                        var nb = rewrite(ini.body);
                        if (nb !== ini.body) ini = Object.assign({}, ini, { body: nb });
                    } else {
                        st.held++;
                        var rawBody = ini.body;
                        var rawInit = ini;
                        return new Promise(function (resolve, reject) {
                            holdUntilPassTopic(function (pid) {
                                var out = rawInit;
                                if (pid > 0) {
                                    var b2 = rewrite(rawBody);
                                    if (b2 !== rawBody) out = Object.assign({}, rawInit, { body: b2 });
                                }
                                oF.call(self, i, out).then(resolve, reject);
                            });
                        });
                    }
                }
            } catch (e) { }
            return oF.apply(this, args);
        };
    } catch (e) { }

    /* ---------- 启动 ---------- */

    startAdGuard();
    pickPassTopic();
    try { window.addEventListener('hj-auth-changed', pickPassTopic); } catch (e) { }

    // 门禁摘除：播放器是异步创建的，前 90 秒高频扫，之后低频兜底
    var gateTicks = 0;
    var gateTimer = setInterval(function () {
        killDPlayerGate();
        gateWatchdog();
        if (++gateTicks > 180) clearInterval(gateTimer);
    }, 500);
    // 用户点播放 / 切线路后播放器可能才创建，补一次扫描
    document.addEventListener('click', function () {
        if (st.gateKilled === 0) killDPlayerGate();
    }, true);
    try {
        new MutationObserver(scheduleSweep).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { }

    try { document.addEventListener('DOMContentLoaded', badge, { once: true }); } catch (e) { }
    window.addEventListener('load', badge, { once: true });

    console.info('[海角解锁] 补丁已装载（MAIN world / document_start）');
})();
