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
  const theme = resultTheme(basic, risks);

  // 文本通知：行首 emoji 图标
  lines.push(`🌐 IP　${displayIP(basic.ip)}`);
  if (basic.nature) lines.push(`${theme.natureEmoji} 类型　${basic.nature}`);
  if (basic.region) lines.push(`📍 地区　${basic.region}`);
  if (basic.city) lines.push(`🏙️ 城市　${basic.city}`);
  if (basic.asn) lines.push(`🔢 ASN　${basic.asn}`);
  if (basic.org) lines.push(`🏢 组织　${basic.org}`);
  if (basic.timezone) lines.push(`🕐 时区　${basic.timezone}`);
  if (FROM_UI && POLICY) lines.push(`📡 节点　${POLICY}`);
  else if (POLICY) lines.push(`📡 策略　${POLICY}`);

  if (risks.length) {
    lines.push("");
    lines.push("🛡️ 风险");
    risks.forEach((r) => lines.push(`　${r.icon} ${r.text}`));
  } else {
    lines.push("");
    lines.push("🛡️ 风险　⚪ 本次无可用标记");
  }

  if (warn.length) {
    lines.push("");
    lines.push("💡 提示");
    warn.slice(0, 5).forEach((w) => lines.push(`　⚠️ ${w}`));
  }

  const title = `${theme.titleEmoji} 节点 IP 质量检测`;
  const subtitle = FROM_UI
    ? POLICY
    : POLICY
      ? `策略 · ${POLICY}`
      : "默认路由";
  const body = lines.join("\n");
  const html = buildResultHtml(basic, risks, warn, theme, POLICY, FROM_UI);

  // 长按节点：HTML 面板 + SF Symbol 配图；同时通知
  if (FROM_UI) {
    $notify(title, subtitle, body);
    $done({
      title,
      htmlMessage: html,
      icon: theme.sfSymbol,
      "icon-color": theme.color,
    });
    return;
  }

  $notify(title, subtitle, body);
  $done({
    title,
    htmlMessage: html,
    icon: theme.sfSymbol,
    "icon-color": theme.color,
  });
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

  const rawCode = clean(okApi && okApi.countryCode) || clean(loc.country_code);
  const rawCountry = clean(okApi && okApi.country) || clean(loc.country);
  // 台湾地区：旗帜强制用中国国旗（系统对 TW 旗帜常显示异常/缺字形）
  const code = normalizeRegionCode(rawCode, rawCountry);
  const country = normalizeRegionName(rawCountry, rawCode);
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
        ? riskItem("warn", `ip-api　命中 ${flags.join("、")}`)
        : riskItem("ok", "ip-api　未命中 proxy/hosting")
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
    const bad =
      flags.length > 0 ||
      (scoreText && /high|very high|elevated/i.test(String(score)));
    if (flags.length || scoreText) {
      out.push(
        riskItem(
          bad ? "warn" : "ok",
          `ipapi.is　${[
            flags.length ? `命中 ${flags.join("、")}` : "无风险标记",
            scoreText,
          ]
            .filter(Boolean)
            .join(" · ")}`
        )
      );
    } else {
      out.push(riskItem("ok", "ipapi.is　无风险标记"));
    }
  }

  return out;
}

function riskItem(level, text) {
  return {
    level,
    text,
    icon: level === "warn" ? "🟠" : level === "bad" ? "🔴" : "🟢",
  };
}

/** 结果主题：emoji + SF Symbol + 色值，用于面板配图 */
function resultTheme(basic, risks) {
  const nature = basic && basic.nature ? basic.nature : "";
  const hasWarn = (risks || []).some((r) => r.level === "warn" || r.level === "bad");

  if (nature.indexOf("机房") >= 0) {
    return {
      key: "hosting",
      titleEmoji: "🖥️",
      natureEmoji: "🖥️",
      sfSymbol: "server.rack",
      color: "#FF9F0A",
      badge: "机房",
    };
  }
  if (nature.indexOf("移动") >= 0) {
    return {
      key: "mobile",
      titleEmoji: "📱",
      natureEmoji: "📱",
      sfSymbol: "antenna.radiowaves.left.and.right",
      color: "#0A84FF",
      badge: "移动",
    };
  }
  if (nature.indexOf("代理") >= 0 || hasWarn) {
    return {
      key: "proxy",
      titleEmoji: "🛡️",
      natureEmoji: nature.indexOf("代理") >= 0 ? "🕵️" : "🏠",
      sfSymbol: "network.badge.shield.half.filled",
      color: hasWarn ? "#FF9F0A" : "#BF5AF2",
      badge: nature.indexOf("代理") >= 0 ? "代理" : "关注",
    };
  }
  if (nature.indexOf("家宽") >= 0) {
    return {
      key: "residential",
      titleEmoji: "🏠",
      natureEmoji: "🏠",
      sfSymbol: "house.fill",
      color: "#30D158",
      badge: "家宽倾向",
    };
  }
  return {
    key: "default",
    titleEmoji: "🌐",
    natureEmoji: "🏷️",
    sfSymbol: "shield.lefthalf.filled",
    color: "#0A84FF",
    badge: "检测完成",
  };
}

function buildResultHtml(basic, risks, warnings, theme, policy, fromUI) {
  const rows = [];
  rows.push(htmlHero(displayIP(basic.ip), theme));
  if (basic.nature) rows.push(htmlRow("🏷️", "类型", basic.nature, theme.color));
  if (basic.region) rows.push(htmlRow("📍", "地区", basic.region));
  if (basic.city) rows.push(htmlRow("🏙️", "城市", basic.city));
  if (basic.asn) rows.push(htmlRow("🔢", "ASN", basic.asn));
  if (basic.org) rows.push(htmlRow("🏢", "组织", basic.org));
  if (basic.timezone) rows.push(htmlRow("🕐", "时区", basic.timezone));
  if (policy) {
    rows.push(htmlRow("📡", fromUI ? "节点" : "策略", policy));
  }

  rows.push(htmlSection("🛡️ 风险"));
  if (risks && risks.length) {
    risks.forEach((r) => {
      rows.push(htmlRiskLine(r));
    });
  } else {
    rows.push(htmlMuted("⚪ 本次无可用标记"));
  }

  if (warnings && warnings.length) {
    rows.push(htmlSection("💡 提示"));
    warnings.slice(0, 5).forEach((w) => {
      rows.push(htmlMuted(`⚠️ ${w}`));
    });
  }

  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica;font-size:14px;line-height:1.45;text-align:left;color:#1c1c1e">` +
    rows.join("") +
    `</div>`
  );
}

function htmlHero(ip, theme) {
  return (
    `<div style="margin:0 0 14px 0;padding:12px 14px;border-radius:12px;background:linear-gradient(135deg,${theme.color}22,${theme.color}08);border:1px solid ${theme.color}33">` +
    `<div style="font-size:11px;color:${theme.color};font-weight:700;letter-spacing:0.4px">${escapeHtml(theme.titleEmoji + " " + theme.badge)}</div>` +
    `<div style="margin-top:4px;font-size:22px;font-weight:800;letter-spacing:0.3px;line-height:1.2">${escapeHtml(ip)}</div>` +
    `</div>`
  );
}

function htmlRow(emoji, label, value, accent) {
  const valueColor = accent || "#1c1c1e";
  return (
    `<div style="margin:0 0 10px 0">` +
    `<div style="font-size:11px;color:#8e8e93">${escapeHtml(emoji + " " + label)}</div>` +
    `<div style="margin-top:2px;font-size:14px;font-weight:600;color:${valueColor};word-break:break-word">${escapeHtml(value)}</div>` +
    `</div>`
  );
}

function htmlSection(title) {
  return (
    `<div style="margin:14px 0 8px 0;padding-top:10px;border-top:1px solid #e5e5ea;font-size:12px;font-weight:700;color:#8e8e93">` +
    escapeHtml(title) +
    `</div>`
  );
}

function htmlRiskLine(risk) {
  const color =
    risk.level === "bad" ? "#FF453A" : risk.level === "warn" ? "#FF9F0A" : "#30D158";
  return (
    `<div style="margin:0 0 8px 0;font-size:13px;line-height:1.4">` +
    `<span style="color:${color}">${escapeHtml(risk.icon)}</span> ` +
    `<span style="font-weight:600">${escapeHtml(risk.text)}</span>` +
    `</div>`
  );
}

function htmlMuted(text) {
  return (
    `<div style="margin:0 0 8px 0;font-size:12px;color:#8e8e93;line-height:1.4">${escapeHtml(text)}</div>`
  );
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

function isTaiwanRegion(code, country) {
  const c = String(code || "").toUpperCase();
  const n = String(country || "").toLowerCase();
  if (c === "TW" || c === "TWN") return true;
  return /taiwan|台灣|台湾|taipei/.test(n);
}

/** 地区码展示归一：台湾强制 CN，旗帜用中国国旗 */
function normalizeRegionCode(code, country) {
  if (isTaiwanRegion(code, country)) return "CN";
  return clean(code).toUpperCase();
}

function normalizeRegionName(country, code) {
  if (isTaiwanRegion(code, country)) {
    // 保留城市级信息场景下的地区名可读性
    return "中国台湾";
  }
  return clean(country);
}

function flag(code) {
  let v = String(code || "").toUpperCase();
  // 台湾地区强制中国国旗
  if (v === "TW" || v === "TWN") v = "CN";
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
  const title = "⚠️ 节点 IP 质量检测";
  $notify(title, "失败", message);
  const html =
    `<div style="font-family:-apple-system;text-align:center;padding:8px 4px">` +
    `<div style="font-size:36px;line-height:1.2">⚠️</div>` +
    `<div style="margin-top:10px;font-size:15px;font-weight:600;color:#FF453A;line-height:1.4">${escapeHtml(message)}</div>` +
    `</div>`;
  $done({
    title,
    htmlMessage: html,
    icon: "exclamationmark.triangle.fill",
    "icon-color": "#FF453A",
  });
}
