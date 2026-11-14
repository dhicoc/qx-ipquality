/*
 * Spotify 9.2.x —— device-capabilities 补丁
 * 作用: 设备侧许可伪装成 premium，当前档位设 320k(VERY_HIGH)，并放开 HIFI(无损) 资格
 * 说明: Spotify 的档位 = DEFAULT/NORMAL/HIGH/VERY_HIGH/HIFI/HIFI_24
 *       免费账号服务端固定给 96 kbps，客户端按 license 选档
 * 风险: 若服务端拒绝 320k/HIFI 的 key，播放会失败 → 把 conf 里这条规则注释掉即可恢复
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

    var prev = obj.license + '/' + obj.audio_quality;
    obj.license = 'premium';
    obj.effective_license = 'premium';
    obj.audio_quality = 'VERY_HIGH';
    obj.supported_audio_quality = 'HIFI';
    if (obj.supports_hifi && typeof obj.supports_hifi === 'object') {
        obj.supports_hifi.user_eligible = true;
        obj.supports_hifi.fully_supported = true;
        obj.supports_hifi.device_supported = true;
    }
    if (obj.supports_playback_speed === false) obj.supports_playback_speed = true;

    console.log('[spotify-capabilities] ' + prev + ' -> premium/VERY_HIGH');
    $done({ body: JSON.stringify(obj) });
})();
