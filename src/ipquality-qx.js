/**
 * 节点 IP 质量检测 · Quantumult X 最小版（仅 IP）
 *
 * - 探测当前策略出口 IPv4
 * - 基础信息：国家 / 城市 / ASN / ISP
 * - 风险标记：proxy / hosting / datacenter / vpn / tor（有则显示）
 * - 结果以 $notify 文本输出
 *
 * argument 示例：
 *   policy=节点或策略组名&mask=0
 *
 * @Updated: 2026-07-19
 */

const VERSION = "2026-07-19.qx2-ip";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

const args = parseArgument(typeof $argument !== "undefined" ? $argument : "");
const POLICY = clean(args.policy || args.node || "");
const MASK_IP = isTruthy(args.mask, false);

const lines = [];
const warn = [];

(async () => {
  log(`start ${VERSION} policy=${POLICY || "(默认路由)"}`);

  const ip = await discoverIP();
  if (!ip) {
    fail("无法获取出口 IP（请检查网络/策略名是否正确）");
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
  if (POLICY) lines.push(`策略  ${POLICY}`);

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
    warn.slice(0, 4).forEach((w) => lines.push(`  ${w}`));
  }

  lines.push("");
  lines.push(`v${VERSION} · 仅 IP`);

  $notify("节点 IP 质量检测", displayIP(basic.ip), lines.join("\n"));
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

  let nature = "";
  if (okApi && okApi.hosting) nature = "机房/托管";
  else if (ipapiIs && (ipapiIs.is_datacenter || ipapiIs.is_hosting))
    nature = "机房/托管";
  else if (okApi && okApi.mobile) nature = "移动网络";
  else if (okApi || ipapiIs) nature = "普通出口";

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

// ── HTTP（Quantumult X $task.fetch）──────────────────────

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

  // 出口探测绑策略；库查询不绑（IP 在 URL 内）
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

function err(e) {
  return e && e.message ? e.message : String(e);
}

function log(msg) {
  console.log(`[ipquality-qx] ${msg}`);
}

function fail(message) {
  $notify("节点 IP 质量检测", "失败", message);
  $done();
}
