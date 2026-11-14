/*
 * Spotify 9.2.x 解锁 Premium —— 改写 /nebula/v1/configuration/attributes
 * 适配: Spotify iOS 9.x（产品状态由 nebula 接口下发，旧的 user-customization-service 已废弃）
 * 由 肥鲸 逆向 9.2.0.2054 抓包生成
 * 兼容: protobuf（App 实际使用, Accept: application/x-protobuf）与 JSON 两种响应
 */

const LOG = true;
const log = (...a) => LOG && console.log('[spotify-nebula]', ...a);

/* ---------------- 覆盖表 ---------------- */
const expire = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().split('.')[0] + 'Z';
})();

// 类型: b = bool, i = int64, s = string
const OVERRIDES = {
    // 账号类型 / UI
    'type': ['s', 'premium'],
    'catalogue': ['s', 'premium'],
    'name': ['s', 'Spotify Premium'],
    // 去广告
    'ads': ['b', false],
    // 功能解锁
    'on-demand': ['b', true],
    // 免费档的 "只能随机播放" 规则，必须清空，否则点播会被判定非法直接跳歌
    'streaming-rules': ['s', ''],
    'unrestricted': ['b', true],
    'shuffle': ['b', false],
    'pick-and-shuffle': ['b', false],
    'smart-shuffle': ['s', 'AVAILABLE'],
    'shuffle-algorithm': ['s', 'RANDOM'],
    'mixing-tools': ['s', 'EDIT'],
    'your-library-tags': ['b', true],
    // 社交 / 会话
    'social-session': ['b', true],
    'social-session-free-tier': ['b', false],
    'jam-social-session': ['s', 'EXPANDED'],
    // 订阅信息（客户端用来判断"会员还有效"）
    'financial-product': ['s', 'pr:premium,tc:0'],
    'payments-locked-state': ['b', false],
    'product-expiry': ['s', expire],
    'subscription-enddate': ['s', expire],
    // UI 清理
    'nft-disabled': ['s', '1'],
};

// 注意：player-license / high-bitrate / audio-quality / is-pigeon / loudness-levels
// 一律不要动。改了它们客户端会去请求 320k / 无损档文件，服务端按真实订阅回 403，
// 播放器拿不到 key 就跳下一首（实测，2026-11-14）。音质就停在免费档。

/* ---------------- 工具 ---------------- */
function utf8enc(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else {
            i++;
            const c2 = str.charCodeAt(i);
            const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
            out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        }
    }
    return out;
}
function utf8dec(b) {
    let s = '';
    for (let i = 0; i < b.length;) {
        const c = b[i++];
        if (c < 0x80) s += String.fromCharCode(c);
        else if (c < 0xe0) s += String.fromCharCode(((c & 31) << 6) | (b[i++] & 63));
        else if (c < 0xf0) s += String.fromCharCode(((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63));
        else {
            const cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
            s += String.fromCodePoint(cp);
        }
    }
    return s;
}
function varint(n) {
    // n: 非负整数, 支持到 2^53
    const out = [];
    if (n < 0) n = 0;
    while (n >= 0x80) {
        out.push((n % 128) | 0x80);
        n = Math.floor(n / 128);
    }
    out.push(n);
    return out;
}
function readVarint(b, i) {
    let shift = 0, val = 0, byte;
    do {
        byte = b[i++];
        val += (byte & 0x7f) * Math.pow(2, shift);
        shift += 7;
    } while (byte & 0x80);
    return [val, i];
}

/* ---------------- protobuf 处理 ----------------
 * message GetAttributesResponse { map<string, Attribute> attributes = 1; }
 * map entry: field1 = key(string), field2 = Attribute
 * message Attribute { oneof value { bool bool_value = 2; int64 long_value = 3; string string_value = 4; } }
 */
function buildEntry(key, spec) {
    const k = utf8enc(key);
    const [type, val] = spec;
    let attr;
    if (type === 'b') attr = [0x10, val ? 1 : 0];
    else if (type === 'i') attr = [0x18].concat(varint(val));
    else {
        const s = utf8enc(String(val));
        attr = [0x22].concat(varint(s.length), s);
    }
    const entry = [0x0a].concat(varint(k.length), k, [0x12].concat(varint(attr.length), attr));
    return [0x0a].concat(varint(entry.length), entry);
}

function encodeEntryKey(entry) {
    // 从 map entry 里取 key
    let i = 0;
    while (i < entry.length) {
        const [tag, ni] = readVarint(entry, i);
        i = ni;
        const f = tag >> 3, w = tag & 7;
        if (w === 2) {
            const [len, n2] = readVarint(entry, i);
            i = n2;
            if (f === 1) return utf8dec(entry.slice(i, i + len));
            i += len;
        } else if (w === 0) {
            const [, n2] = readVarint(entry, i);
            i = n2;
        } else if (w === 5) i += 4;
        else if (w === 1) i += 8;
        else break;
    }
    return null;
}

function patchProto(bytes) {
    const out = [];
    let i = 0, patched = 0, kept = 0, seen = 0;
    while (i < bytes.length) {
        const start = i;
        const [tag, ni] = readVarint(bytes, i);
        i = ni;
        const f = tag >> 3, w = tag & 7;
        let end = i;
        if (w === 2) {
            const [len, n2] = readVarint(bytes, i);
            end = n2 + len;
        } else if (w === 0) {
            const [, n2] = readVarint(bytes, i);
            end = n2;
        } else if (w === 5) end = i + 4;
        else if (w === 1) end = i + 8;
        else break; // 不认识的 wire type, 放弃修改
        if (end > bytes.length) break;

        if (f === 1 && w === 2) {
            const [len, n2] = readVarint(bytes, i);
            const entry = bytes.slice(n2, n2 + len);
            const key = encodeEntryKey(entry);
            seen++;
            if (key !== null && Object.prototype.hasOwnProperty.call(OVERRIDES, key)) {
                patched++;
                // 丢弃旧值，稍后追加覆盖
            } else {
                for (let j = start; j < end; j++) out.push(bytes[j]);
                kept++;
            }
        } else {
            for (let j = start; j < end; j++) out.push(bytes[j]);
        }
        i = end;
    }
    if (i !== bytes.length) {
        log('protobuf 解析中断，回退原始 body');
        return null;
    }
    for (const key in OVERRIDES) {
        const e = buildEntry(key, OVERRIDES[key]);
        for (let j = 0; j < e.length; j++) out.push(e[j]);
    }
    log(`entries=${seen} replaced=${patched} kept=${kept} added=${Object.keys(OVERRIDES).length}`);
    console.log('[spotify-nebula] entries=' + seen + ' replaced=' + patched + ' kept=' + kept + ' added=' + Object.keys(OVERRIDES).length);
    try {
        $notification.post('Spotify 补丁',
            'nebula 已改写',
            `replaced=${patched} kept=${kept} added=${Object.keys(OVERRIDES).length}`);
    } catch (e) {}
    return out;
}

/* ---------------- JSON 处理 ---------------- */
function patchJson(txt) {
    const obj = JSON.parse(txt);
    const attrs = obj.attributes || (obj.attributes = {});
    let n = 0;
    for (const key in OVERRIDES) {
        const [type, val] = OVERRIDES[key];
        if (type === 'b') attrs[key] = { boolValue: !!val };
        else if (type === 'i') attrs[key] = { longValue: String(val) };
        else attrs[key] = { stringValue: String(val) };
        n++;
    }
    log('json patched', n);
    return JSON.stringify(obj);
}

/* ---------------- 入口 ---------------- */
(function main() {
    const url = $request.url;
    const status = $response.status || $response.statusCode;
    if (status !== 200) {
        log('status', status, '跳过');
        $done({});
        return;
    }

    let raw = $response.bodyBytes;
    if (raw == null) {
        // 纯文本情形
        const txt = $response.body || '';
        if (typeof txt === 'string' && txt.trim().startsWith('{')) {
            $done({ body: patchJson(txt) });
        } else {
            $done({});
        }
        return;
    }

    let bytes;
    if (raw instanceof Uint8Array) bytes = Array.from(raw);
    else if (raw instanceof ArrayBuffer) bytes = Array.from(new Uint8Array(raw));
    else if (Array.isArray(raw)) bytes = raw.slice();
    else bytes = Array.from(new Uint8Array(raw));

    // JSON 响应（首字节 '{'）
    if (bytes.length && bytes[0] === 0x7b) {
        const txt = utf8dec(bytes);
        $done({ body: patchJson(txt) });
        return;
    }

    try {
        const out = patchProto(bytes);
        if (!out) { $done({}); return; }
        $done({ bodyBytes: new Uint8Array(out).buffer });
    } catch (e) {
        log('异常', e && e.message ? e.message : e);
        $done({});
    }
})();
