/*
 * Spotify 9.2.x 去广告
 * 覆盖: POST /ads/v3/ads        → 空 pod（按请求的 slot 回空数组）
 *       POST /ad-logic/prefetch → 无广告决策（沿用服务端"无广告"时的返回结构）
 * 保留 /ad-logic/v3/config、/ad-logic/state/config 不动（配置，不是广告内容）
 */

(function () {
    var url = $request.url || '';
    var status = $response.status || $response.statusCode;
    var log = function (m) { console.log('[spotify-ads] ' + m); };

    if (status !== 200 || !$response.body) {
        $done({});
        return;
    }

    try {
        if (/\/ads\/v3\/ads/.test(url)) {
            var slots = [];
            var m = url.match(/[?&]slots=([^&]+)/);
            if (m) {
                slots = decodeURIComponent(m[1]).split(',').filter(Boolean);
            }
            var pod = {};
            if (slots.length) {
                for (var i = 0; i < slots.length; i++) pod[slots[i]] = [];
            }
            log('ads empty: ' + (slots.join(',') || 'all'));
            $done({ body: JSON.stringify({ pod: pod }) });
            return;
        }

        if (/\/ad-logic\/prefetch/.test(url)) {
            var orig = {};
            try { orig = JSON.parse($response.body) || {}; } catch (e) {}
            var out = {
                next_request: orig.next_request || '100',
                fallback_decision: { max_length_seconds: 5, max_ads: 0 },
                realtime_decision: { max_length_seconds: 5, max_ads: 0 },
                pod: {}
            };
            log('prefetch cleared, next=' + out.next_request);
            $done({ body: JSON.stringify(out) });
            return;
        }
    } catch (e) {
        log('err ' + (e && e.message ? e.message : e));
    }

    $done({});
})();
