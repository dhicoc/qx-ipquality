/**
 * 节点 IP 质量检测 · Quantumult X（仅 IP）
 *
 * 正确用法（测指定节点）：
 *   在「节点」列表中 长按目标节点 → 选择本脚本
 *   此时 $environment.params = 节点 tag，请求会走该节点
 *
 * 备用法（测默认路由 / 写死策略）：
 *   工具页直接点运行，或 argument=policy=节点名&mask=0
 *
 * @Updated: 2026-07-19
 * @Reference: crossutility sample-fetch-opts-policy.js
 */

const VERSION = "2026-07-19.qx3-ip";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

// URL hash / argument 变量（官方 $environment.variables，兼容 $argument）
const envVars =
  typeof $environment !== "undefined" && $environment.variables
    ? $environment.variables
    : {};
const argRaw =
  typeof $argument !== "undefined" && $argument !== null ? String($argument) : "";
const args = Object.assign({}, envVars, parseArgument(argRaw));

// 长按节点时 QX 自动传入节点 tag；否则用 argument / 变量里的 policy|node
const UI_NODE =
  typeof $environment !== "undefined" && $environment.params
    ? clean(String($environment.params))
    : "";
const ARG_POLICY = clean(args.policy || args.node || "");
const BARE_POLICY =
  !ARG_POLICY && argRaw && argRaw.indexOf("=") < 0 ? clean(argRaw) : "";
const POLICY = UI_NODE || ARG_POLICY || BARE_POLICY;
const FROM_UI = !!UI_NODE;
const MASK_IP = isTruthy(args.mask, false);

const lines = [];
const warn = [];

(async () => {
  log(
    `start ${VERSION} policy=${POLICY || "(默认路由)"} fromUI=${FROM_UI}`
  );

  if (!POLICY) {
    warn.push(
      "未指定节点：测的是当前默认路由。请长按目标节点再运行本脚本，或在 argument 写 policy=完整节点名"
    );
  }

  const ip = await discoverIP();
  if (!ip) {
    fail(
      POLICY
        ? `无法经「${POLICY}」获取出口 IP（节点名是否完全一致？VPN 是否已开启？）`
        : "无法获取出口 IP（请检查网络 / 是否开启 Quantumult X Tunnel）"
    );
    return;
  }

  const [ipApi, ipapiIs] = await Promise.all([
    fetchJson(
      `http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,asname,mobile,proxy,hosting,query`,
      { direct: true }
    ).catch((e) => {
      warn.push(`ip-api: ${err(e)}`);
      return null;
    }),
    fetchJson(`https://api.ipapi.is/?q=${encodeURIComponent(ip)}`, {
      direct: true,
    }).catch((e) => {
      warn.push(`ipapi.is: ${err(e)}`);
      return null;
    }),
  ]);

  const basic = buildBasic(ip, ipApi, ipapiIs);
  const risks = buildRisks(ipApi, ipapiIs);

  lines.push(`IP  ${displayIP(basic.ip)}`);
  if (basic.nature) lines.push(`类型  ${basic.nature}`);
  if (basic.region) lines.push(`地区  ${basic.region}`);
  if (basic.city) lines.push(`城市  ${basic.city}`);
  if (basic.asn) lines.push(`ASN  ${basic.asn}`);
  if (basic.org) lines.push(`组织  ${basic.org}`);
  if (basic.timezone) lines.push(`时区  ${basic.timezone}`);

  if (FROM_UI && POLICY) {
    lines.push(`节点  ${POLICY}`);
  } else if (POLICY) {
    lines.push(`策略  ${POLICY}`);
  }

  if (risks.length) {
    lines.push("");
    lines.push("· 风险");
    risks.forEach((r) => lines.push(`  ${r}`));
  } else {
    lines.push("");
    lines.push("· 风险  本次无可用标记");
  }

  if (warn.length) {
    lines.push("");
    lines.push("· 提示");
    warn.slice(0, 5).forEach((w) => lines.push(`  ${w}`));
  }

  const title = "节点 IP 质量检测";
  const subtitle = FROM_UI
    ? POLICY
    : POLICY
      ? `策略 · ${POLICY}`
      : "默认路由";
  const body = lines.join("\n");

  // 长按节点时用面板展示；同时发通知便于复制
  if (FROM_UI) {
    const html =
      `<p style="text-align:left;font-family:-apple-system;font-size:14px;line-height:1.45;font-weight:normal;white-space:pre-wrap">` +
      escapeHtml(body) +
      `</p>`;
    $notify(title, subtitle, body);
    $done({ title, htmlMessage: html });
    return;
  }

  $notify(title, subtitle, body);
  $done();
})().catch((e) => {
  fail(`异常: ${err(e)}`);
});

// ── 出口 IP ──────────────────────────────────────────────

async function discoverIP() {
  const probes = [
    {
      name: "ipify",
      run: () =>
        fetchJson("https://api4.ipify.org?format=json").then((j) => j && j.ip),
    },
    {
      name: "ip-api",
      run: () =>
        fetchJson("http://ip-api.com/json/?fields=status,query").then(
          (j) => j && j.status === "success" && j.query
        ),
    },
    {
      name: "icanhazip",
      run: () =>
        fetchText("https://ipv4.icanhazip.com/").then((t) => t && t.trim()),
    },
    {
      name: "ident.me",
      run: () => fetchText("https://v4.ident.me/").then((t) => t && t.trim()),
    },
  ];

  const results = await Promise.all(
    probes.map((p) =>
      p
        .run()
        .then((ip) => ({ name: p.name, ip: normalizeIP(ip) }))
        .catch((e) => {
          log(`probe ${p.name}: ${err(e)}`);
          return { name: p.name, ip: "" };
        })
    )
  );

  const valid = results.filter((r) => r.ip);
  if (!valid.length) return "";

  const counts = {};
  valid.forEach((r) => {
    counts[r.ip] = (counts[r.ip] || 0) + 1;
  });
  const ranked = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (ranked.length > 1) {
    warn.push(
      `出口不一致: ${valid.map((r) => `${r.name}=${r.ip}`).join(", ")}`
    );
  }
  return ranked[0];
}

// ── 基础 / 风险 ──────────────────────────────────────────

function buildBasic(ip, ipApi, ipapiIs) {
  const okApi = ipApi && ipApi.status === "success" ? ipApi : null;
  const loc = (ipapiIs && ipapiIs.location) || {};
  const asnObj = (ipapiIs && ipapiIs.asn) || {};

  const code = clean(okApi && okApi.countryCode) || clean(loc.country_code);
  const country = clean(okApi && okApi.country) || clean(loc.country);
  const cityParts = unique([
    clean(okApi && okApi.regionName) || clean(loc.state),
    clean(okApi && okApi.city) || clean(loc.city),
  ]);
  const asRaw = clean(okApi && okApi.as) || clean(asnObj.asn);
  const asn = asRaw ? (asRaw.startsWith("AS") ? asRaw : `AS${asRaw}`) : "";
  const org =
    clean(okApi && (okApi.asname || okApi.org || okApi.isp)) ||
    clean(asnObj.org) ||
    clean(ipapiIs && ipapiIs.company && ipapiIs.company.name);

  const nature = classifyNature(okApi, ipapiIs);

  return {
    ip,
    nature,
    region: code
      ? `${flag(code)} [${code.toUpperCase()}] ${country || ""}`.trim()
      : country,
    city: cityParts.join(" · "),
    asn,
    org,
    timezone: clean(okApi && okApi.timezone) || clean(loc.timezone),
  };
}

/**
 * 把库字段收成用户能看懂的一句话。
 * 说明：这是第三方库标记，不是官方「住宅认证」。
 */
function classifyNature(okApi, ipapiIs) {
  const hosting =
    !!(okApi && okApi.hosting) ||
    !!(ipapiIs && (ipapiIs.is_datacenter || ipapiIs.is_hosting));
  const mobile =
    !!(okApi && okApi.mobile) || !!(ipapiIs && ipapiIs.is_mobile);
  const proxyLike =
    !!(okApi && okApi.proxy) ||
    !!(ipapiIs && (ipapiIs.is_proxy || ipapiIs.is_vpn || ipapiIs.is_tor));

  const typeBits = [
    ipapiIs && ipapiIs.company && ipapiIs.company.type,
    ipapiIs && ipapiIs.asn && ipapiIs.asn.type,
    ipapiIs && ipapiIs.company && ipapiIs.company.abuser_score,
  ]
    .map((x) => clean(x).toLowerCase())
    .filter(Boolean)
    .join(" ");

  // 机房优先：最影响「能不能当家宽用」的判断
  if (hosting || /\b(hosting|data\s*center|datacenter|cdn)\b/.test(typeBits)) {
    return "机房 IP · 服务器/数据中心，一般不是家用宽带";
  }
  if (mobile || /\bmobile\b/.test(typeBits)) {
    return "移动 IP · 手机/蜂窝流量网络";
  }
  if (proxyLike) {
    return "代理特征 · 库标记像代理/VPN（仅供参考）";
  }
  if (/\b(isp|residential|education|government)\b/.test(typeBits)) {
    return "家宽倾向 · 更像宽带运营商线路（非机房）";
  }
  // 有查询结果、但没有机房/移动标记 → 多数情况是运营商线路
  if (okApi || ipapiIs) {
    return "家宽倾向 · 未检出机房/移动标记（不等于已认证住宅）";
  }
  return "";
}

function buildRisks(ipApi, ipapiIs) {
  const out = [];
  const okApi = ipApi && ipApi.status === "success" ? ipApi : null;

  if (okApi) {
    const flags = [];
    if (okApi.proxy) flags.push("代理");
    if (okApi.hosting) flags.push("托管");
    if (okApi.mobile) flags.push("移动");
    out.push(
      flags.length
        ? `ip-api  命中 ${flags.join("、")}`
        : "ip-api  未命中 proxy/hosting"
    );
  }

  if (ipapiIs && typeof ipapiIs === "object") {
    const flags = [];
    if (ipapiIs.is_proxy) flags.push("代理");
    if (ipapiIs.is_vpn) flags.push("VPN");
    if (ipapiIs.is_tor) flags.push("Tor");
    if (ipapiIs.is_datacenter) flags.push("机房");
    if (ipapiIs.is_abuser) flags.push("滥用");
    if (ipapiIs.is_crawler) flags.push("爬虫");
    const score = ipapiIs.company && ipapiIs.company.abuser_score;
    const scoreText = clean(score) ? `评分 ${score}` : "";
    if (flags.length || scoreText) {
      out.push(
        `ipapi.is  ${[
          flags.length ? `命中 ${flags.join("、")}` : "无风险标记",
          scoreText,
        ]
          .filter(Boolean)
          .join(" · ")}`
      );
    } else {
      out.push("ipapi.is  无风险标记");
    }
  }

  return out;
}

// ── HTTP ─────────────────────────────────────────────────

function fetchJson(url, options) {
  return fetchRaw(url, options).then((r) => {
    try {
      return JSON.parse(r.body || "");
    } catch (_) {
      throw new Error("JSON 解析失败");
    }
  });
}

function fetchText(url, options) {
  return fetchRaw(url, options).then((r) => String(r.body || ""));
}

function fetchRaw(url, options) {
  const opt = options || {};
  const req = {
    url,
    method: (opt.method || "GET").toUpperCase(),
    headers: opt.headers || { "User-Agent": UA },
  };
  if (typeof opt.body !== "undefined") req.body = opt.body;

  // 官方：opts.policy 可为节点 tag 或策略名；长按节点时传入该节点
  // 库查询不绑策略（IP 已在 URL）
  if (!opt.direct && POLICY) {
    req.opts = { policy: POLICY };
  }

  return $task.fetch(req).then(
    (resp) => {
      const statusCode = Number(resp.statusCode);
      if (
        !opt.allowError &&
        (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300)
      ) {
        throw new Error(`HTTP ${statusCode || "?"}`);
      }
      return {
        statusCode,
        body: String(resp.body || ""),
        headers: resp.headers || {},
      };
    },
    (reason) => {
      throw new Error(String(reason && reason.error ? reason.error : reason));
    }
  );
}

// ── 工具 ─────────────────────────────────────────────────

function parseArgument(raw) {
  const out = {};
  String(raw || "")
    .split("&")
    .forEach((pair) => {
      if (!pair) return;
      const i = pair.indexOf("=");
      if (i < 0) {
        out[decodeURIComponent(pair)] = "1";
        return;
      }
      const k = decodeURIComponent(pair.slice(0, i).trim());
      const v = decodeURIComponent(pair.slice(i + 1).trim());
      if (k) out[k] = v;
    });
  return out;
}

function isTruthy(value, defaultValue) {
  if (value === null || typeof value === "undefined" || value === "") {
    return defaultValue;
  }
  const t = String(value).toLowerCase();
  if (["0", "false", "no", "off"].indexOf(t) >= 0) return false;
  if (["1", "true", "yes", "on"].indexOf(t) >= 0) return true;
  return defaultValue;
}

function normalizeIP(value) {
  const text = String(value || "").trim();
  const parts = text.split(".");
  if (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
  ) {
    return text;
  }
  return "";
}

function displayIP(ip) {
  if (!MASK_IP) return ip;
  const parts = String(ip).split(".");
  if (parts.length !== 4) return ip;
  return `${parts[0]}.${parts[1]}.*.*`;
}

function flag(code) {
  const v = String(code || "").toUpperCase();
  if (v.length !== 2) return "";
  return String.fromCodePoint(
    v.charCodeAt(0) + 127397,
    v.charCodeAt(1) + 127397
  );
}

function unique(arr) {
  const out = [];
  arr.forEach((x) => {
    const v = clean(x);
    if (v && out.indexOf(v) < 0) out.push(v);
  });
  return out;
}

function clean(value) {
  if (value === null || typeof value === "undefined") return "";
  const text = String(value).trim();
  if (!text || /^(null|undefined|n\/a|unknown|-)$/i.test(text)) return "";
  return text;
}

function escapeHtml(value) {
  return String(value === null || typeof value === "undefined" ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function err(e) {
  return e && e.message ? e.message : String(e);
}

function log(msg) {
  console.log(`[ipquality-qx] ${msg}`);
}

function fail(message) {
  const title = "节点 IP 质量检测";
  $notify(title, "失败", message);
  if (FROM_UI) {
    const html =
      `<p style="text-align:center;font-family:-apple-system;font-size:large">` +
      escapeHtml(message) +
      `</p>`;
    $done({ title, htmlMessage: html });
    return;
  }
  $done();
}
