/*
 * Spotify 9.2.x —— device-capabilities 补丁（可选，默认不启用）
 * 作用: 让 App 认为设备有 Premium 许可，解锁 320kbps / 更高音质选项
 * 风险: 若服务端按真实许可拒绝发 key，可能造成播放失败；建议先用主脚本确认正常后再加这条
 */

(function () {
    var status = $response.status || $response.statusCode;
    if (status !== 200 || !$response.body) {
        $done({});
        return;
    }
    var obj;
    try {
        obj = JSON.parse($response.body);
    } catch (e) {
        $done({});
        return;
    }

    var before = obj.license;
    obj.license = 'premium';
    obj.effective_license = 'premium';
    obj.audio_quality = 'VERY_HIGH';
    obj.supported_audio_quality = 'HIFI';
    if (obj.supports_hifi && typeof obj.supports_hifi === 'object') {
        obj.supports_hifi.user_eligible = true;
        obj.supports_hifi.fully_supported = true;
    }

    console.log('[spotify-capabilities] license ' + before + ' -> premium');
    $done({ body: JSON.stringify(obj) });
})();
