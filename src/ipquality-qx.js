/**
 * 节点 IP 质量检测 · Quantumult X
 *
 * 出口 IPv4/IPv6 · IPPure · 多库风险 · DNS 一致性 · RTT
 * 已去除 block_check（check-host / Globalping / 阻断诊断）
 *
 * 长按节点运行。
 * 参数：mask=0 pure=1 dns=1 rtt=1 v6=1
 *
 * @Updated: 2026-07-20
 */

const VERSION = "2026-07-20.qx6.1";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1";
const IPPURE_URL = "https://my.ippure.com/v1/info";
const RTT_URL = "http://www.gstatic.com/generate_204";
const REQ_MS = 5500;
const HARD_MS = 15000;

const envVars =
  typeof $environment !== "undefined" && $environment.variables
    ? $environment.variables
    : {};
const argRaw =
  typeof $argument !== "undefined" && $argument != null ? String($argument) : "";
const args = Object.assign({}, envVars, parseArgument(argRaw));

const POLICY = resolvePolicy();
const MASK_IP = isTruthy(args.mask, false);
const PURE_ON = isTruthy(args.pure, true);
const DNS_ON = isTruthy(args.dns, true);
const RTT_ON = isTruthy(args.rtt, true);
const V6_ON = isTruthy(args.v6, true);

const lines = [];
const warn = [];
let finished = false;
const tStart = Date.now();

setTimeout(function () {
  if (!finished) failSoft("接近时限，已返回已采集数据");
}, HARD_MS);

main().catch(function (e) {
  fail("异常: " + err(e));
});

async function main() {
  log(
    "start " +
      VERSION +
      " policy=" +
      (POLICY || "(默认)") +
      " pure=" +
      PURE_ON +
      " dns=" +
      DNS_ON +
      " rtt=" +
      RTT_ON +
      " v6=" +
      V6_ON
  );
  if (!POLICY) warn.push("未指定节点：走默认路由。请长按目标节点");

  // 阶段 1：出口 / 纯净 / 延迟 / DNS
  const p1 = await Promise.all([
    withTimeout(discoverIPv4(), 6500, ""),
    V6_ON ? withTimeout(discoverIPv6(), 6500, "") : Promise.resolve(""),
    PURE_ON ? withTimeout(fetchIPPure(), REQ_MS, null) : Promise.resolve(null),
    RTT_ON ? withTimeout(measureRTT(), 4000, null) : Promise.resolve(null),
    DNS_ON ? withTimeout(probeDnsExit(), 5000, null) : Promise.resolve(null),
  ]);

  let v4 = p1[0] || "";
  const v6 = p1[1] || "";
  let ipure = p1[2];
  const rtt = p1[3];
  const dnsInfo = p1[4];

  if (!v4 && ipure) v4 = normalizeIP(ipure.ip) || "";
  if (!v4 && !v6) {
    fail(
      POLICY
        ? "无法经「" + POLICY + "」获取出口 IP（检查节点名 / Tunnel）"
        : "无法获取出口 IP"
    );
    return;
  }

  const targetIP = v4 || "";

  // 阶段 2：多库地理 / 风险
  const libs = await Promise.all([
    targetIP
      ? withTimeout(fetchIpApiDetail(targetIP), REQ_MS, null)
      : Promise.resolve(null),
    targetIP
      ? withTimeout(fetchIpapiIsDetail(targetIP), REQ_MS, null)
      : Promise.resolve(null),
    targetIP
      ? withTimeout(fetchIpinfo(targetIP), REQ_MS, null)
      : Promise.resolve(null),
    targetIP
      ? withTimeout(fetchIpwho(targetIP), REQ_MS, null)
      : Promise.resolve(null),
    PURE_ON && !ipure
      ? withTimeout(fetchIPPure(), REQ_MS, null)
      : Promise.resolve(ipure),
  ]);

  const ipApi = libs[0];
  const ipapiIs = libs[1];
  const ipinfo = libs[2];
  const ipwho = libs[3];
  ipure = libs[4] || ipure;

  if (!ipApi) log("ip-api miss");
  if (!ipapiIs) log("ipapi.is miss");
  if (!ipinfo) log("ipinfo miss");
  if (!ipwho) log("ipwho miss");
  if (PURE_ON && !ipure) warn.push("IPPure 未返回");
  if (!ipApi && !ipapiIs && !ipinfo && !ipwho && !ipure) {
    warn.push("地理库均未返回，仅展示出口 IP");
  }

  const basic = buildBasic(v4, v6, ipApi, ipapiIs, ipure, ipinfo, ipwho);
  const pure = buildPure(ipure);
  const risks = buildRisks(ipApi, ipapiIs, ipure, ipinfo, ipwho);
  const dnsReport = buildDnsReport(v4, v6, dnsInfo);
  const theme = resultTheme(basic, pure);

  renderAll(basic, risks, pure, rtt, dnsReport, theme);
}

// ── Policy ───────────────────────────────────────────────

function resolvePolicy() {
  const ui = readUINode();
  if (ui) return ui;
  const p = clean(args.policy || args.node || "");
  if (p) return p;
  if (argRaw && argRaw.indexOf("=") < 0) return clean(argRaw);
  return "";
}

function readUINode() {
  try {
    if (typeof $environment === "undefined" || $environment.params == null) {
      return "";
    }
    const p = $environment.params;
    if (typeof p === "string") return clean(p);
    if (typeof p === "object") {
      return clean(p.node || p.policy || p.name || p.tag || "");
    }
    return clean(String(p));
  } catch (e) {
    return "";
  }
}

// ── 出口 IP ──────────────────────────────────────────────

async function discoverIPv4() {
  const urls = [
    "https://api4.ipify.org",
    "https://api.ipify.org",
    "https://ipv4.icanhazip.com/",
    "https://v4.ident.me/",
    "http://ip-api.com/json?lang=zh-CN&fields=query,status",
  ];
  const results = await Promise.all(
    urls.map(function (url) {
      return withTimeout(
        fetchText(url, { mode: "node" }).then(extractIPv4),
        REQ_MS,
        ""
      );
    })
  );
  return voteIP(
    results.filter(Boolean),
    "v4"
  );
}

async function discoverIPv6() {
  const urls = [
    "https://api6.ipify.org",
    "https://v6.ident.me/",
    "https://ipv6.icanhazip.com/",
  ];
  const results = await Promise.all(
    urls.map(function (url) {
      return withTimeout(
        fetchText(url, { mode: "node" }).then(extractIPv6),
        REQ_MS,
        ""
      );
    })
  );
  return voteIP(
    results.filter(function (x) {
      return x && x.indexOf(":") >= 0;
    }),
    "v6"
  );
}

function voteIP(list, tag) {
  if (!list.length) return "";
  const counts = {};
  list.forEach(function (ip) {
    counts[ip] = (counts[ip] || 0) + 1;
  });
  const ranked = Object.keys(counts).sort(function (a, b) {
    return counts[b] - counts[a];
  });
  log("discover " + tag + ": " + ranked[0] + " (" + list.length + " hits)");
  return ranked[0];
}

function extractIPv4(text) {
  if (text == null) return "";
  const s = String(text);
  let m = s.match(/"query"\s*:\s*"(\d{1,3}(?:\.\d{1,3}){3})"/);
  if (m) return normalizeIP(m[1]);
  m = s.match(/"ip"\s*:\s*"(\d{1,3}(?:\.\d{1,3}){3})"/);
  if (m) return normalizeIP(m[1]);
  m = s.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m ? normalizeIP(m[1]) : "";
}

function extractIPv6(text) {
  if (text == null) return "";
  const s = String(text).trim();
  const m = s.match(
    /(([0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{0,4}|::([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})/
  );
  if (!m) return "";
  return m[1].indexOf(":") >= 0 ? m[1] : "";
}

// ── RTT / DoH 探测 ───────────────────────────────────────
// 说明：
//   「HTTP 落地」= 经节点访问 ipify 等看到的公网 IP（节点落地 IP）
//   「DoH 探测」= 经同一节点访问 DoH whoami 看到的 IP
//   两者都走代理 HTTP(S)，不是手机系统 DNS 泄漏检测；
//   一致=代理出口稳定；DoH 失败=whoami 接口不可用（常见）。

function measureRTT() {
  const t0 = Date.now();
  return fetchRaw(RTT_URL, { mode: "node", allowError: true }).then(function () {
    return { ms: Date.now() - t0 };
  });
}

function probeDnsExit() {
  // 多后端竞速：Google whoami 比 CF whoami 更常返回真实 IP
  return firstSuccess([
    probeGoogleMyAddr(),
    probeCfWhoamiDoh(),
    probeOpenDnsMyIp(),
  ]).then(function (hit) {
    return hit || { ip: "", source: "" };
  });
}

/** Google: o-o.myaddr.l.google.com TXT */
function probeGoogleMyAddr() {
  const url =
    "https://dns.google/resolve?name=o-o.myaddr.l.google.com&type=TXT";
  return fetchJson(url, {
    mode: "node",
    headers: { Accept: "application/json", "User-Agent": UA },
  }).then(function (j) {
    const ip = pickIpFromDnsAnswers(j && j.Answer);
    if (!ip || ip === "0.0.0.0") throw new Error("google whoami empty");
    return { ip: ip, source: "google-doh" };
  });
}

/** Cloudflare DoH whoami（部分环境会 0.0.0.0） */
function probeCfWhoamiDoh() {
  const url =
    "https://cloudflare-dns.com/dns-query?name=whoami.cloudflare&type=TXT";
  return fetchJson(url, {
    mode: "node",
    headers: { Accept: "application/dns-json", "User-Agent": UA },
  }).then(function (j) {
    const ip = pickIpFromDnsAnswers(j && j.Answer);
    if (!ip || ip === "0.0.0.0") throw new Error("cf whoami empty");
    return { ip: ip, source: "cf-doh" };
  });
}

/** OpenDNS myip（A 记录） */
function probeOpenDnsMyIp() {
  const url = "https://dns.google/resolve?name=myip.opendns.com&type=A";
  // 注意：经 Google 解析 OpenDNS 主机名，得到的是该域名 A 记录，不一定是客户端 IP
  // 改用 Cloudflare trace 作最后兜底（本质 HTTP 落地，仅作备用展示）
  return fetchText("https://cloudflare.com/cdn-cgi/trace", { mode: "node" }).then(
    function (body) {
      const m = String(body).match(/^ip=([^\r\n]+)/m);
      const ip = m ? String(m[1]).trim() : "";
      if (!ip || ip === "0.0.0.0") throw new Error("trace empty");
      // 标记为 http-trace，展示时说明与 HTTP 同源
      return { ip: ip, source: "http-trace" };
    }
  );
}

function pickIpFromDnsAnswers(answers) {
  const ans = answers || [];
  for (let i = 0; i < ans.length; i++) {
    let data = String(ans[i].data || "");
    // "\"1.2.3.4\"" 或 "1.2.3.4"
    data = data.replace(/\\/g, "").replace(/"/g, "").trim();
    // 有的带前缀 edns0-client-subnet=...
    const parts = data.split(/\s+/);
    for (let j = 0; j < parts.length; j++) {
      const v4 = normalizeIP(parts[j]);
      if (v4 && v4 !== "0.0.0.0") return v4;
      if (parts[j].indexOf(":") >= 0) {
        const v6 = extractIPv6(parts[j]);
        if (v6) return v6;
      }
    }
    const v4b = extractIPv4(data);
    if (v4b && v4b !== "0.0.0.0") return v4b;
  }
  return "";
}

function buildDnsReport(v4, v6, dnsInfo) {
  if (!dnsInfo) return null;
  const probeIP = clean(dnsInfo.ip);
  const httpIP = v4 || v6 || "";
  const source = dnsInfo.source || "";

  if (!probeIP) {
    return {
      httpIP: displayIP(httpIP),
      dnsIP: "",
      source: "",
      text: "DoH 未测到（不影响 HTTP 落地 IP）",
      level: "unknown",
    };
  }

  // http-trace 与 HTTP 落地同源，不算真正的 DNS 旁路对比
  if (source === "http-trace") {
    const sameTrace = probeIP === v4 || probeIP === v6;
    return {
      httpIP: displayIP(httpIP),
      dnsIP: displayIP(probeIP),
      source: source,
      text: sameTrace
        ? "备用探测成功（HTTP trace，与落地同源）"
        : "备用探测 IP 与落地不同",
      level: sameTrace ? "ok" : "warn",
    };
  }

  const same = probeIP === v4 || probeIP === v6 || probeIP === httpIP;
  return {
    httpIP: displayIP(httpIP),
    dnsIP: displayIP(probeIP),
    source: source,
    text: same
      ? "DoH 与 HTTP 落地一致"
      : "DoH 与 HTTP 落地不一致（出口不稳定或分流）",
    level: same ? "ok" : "warn",
  };
}

// ── 多库 ─────────────────────────────────────────────────

function fetchIPPure() {
  return fetchJson(IPPURE_URL, { mode: "node" }).then(function (data) {
    if (!data || typeof data !== "object") throw new Error("IPPure 空");
    return data;
  });
}

function fetchIpApiDetail(ip) {
  const url =
    "http://ip-api.com/json/" +
    encodeURIComponent(ip) +
    "?lang=zh-CN&fields=status,message,country,countryCode,regionName,city,timezone,isp,org,as,asname,mobile,proxy,hosting,query";
  return firstSuccess([
    POLICY ? fetchJson(url, { mode: "node" }) : null,
    fetchJson(url, { mode: "direct" }),
    fetchJson(url, { mode: "auto" }),
  ]).then(function (j) {
    if (j && (j.status === "success" || j.country || j.query)) return j;
    return null;
  });
}

function fetchIpapiIsDetail(ip) {
  const url = "https://api.ipapi.is/?q=" + encodeURIComponent(ip);
  return firstSuccess([
    POLICY ? fetchJson(url, { mode: "node" }) : null,
    fetchJson(url, { mode: "direct" }),
    fetchJson(url, { mode: "auto" }),
  ]);
}

function fetchIpinfo(ip) {
  const url = "https://ipinfo.io/widget/demo/" + encodeURIComponent(ip);
  return firstSuccess([
    POLICY ? fetchJson(url, { mode: "node" }) : null,
    fetchJson(url, { mode: "direct" }),
    fetchJson(url, { mode: "auto" }),
  ]).then(function (j) {
    if (!j) return null;
    if (j.data && typeof j.data === "object") return j;
    if (j.ip || j.country) return { data: j };
    return j;
  });
}

function fetchIpwho(ip) {
  const url = "https://ipwho.is/" + encodeURIComponent(ip);
  return firstSuccess([
    POLICY ? fetchJson(url, { mode: "node" }) : null,
    fetchJson(url, { mode: "direct" }),
    fetchJson(url, { mode: "auto" }),
  ]).then(function (j) {
    if (j && j.success === false) return null;
    return j;
  });
}

function firstSuccess(promises) {
  const list = (promises || []).filter(function (p) {
    return p != null;
  });
  if (!list.length) return Promise.resolve(null);
  return new Promise(function (resolve) {
    let left = list.length;
    let done = false;
    list.forEach(function (p) {
      Promise.resolve(p).then(
        function (v) {
          if (done) return;
          if (v != null && v !== false) {
            done = true;
            resolve(v);
            return;
          }
          left -= 1;
          if (left <= 0) resolve(null);
        },
        function () {
          if (done) return;
          left -= 1;
          if (left <= 0) resolve(null);
        }
      );
    });
  });
}

// ── 组装 ─────────────────────────────────────────────────

function buildBasic(v4, v6, ipApi, ipapiIs, ipure, ipinfo, ipwho) {
  const okApi =
    ipApi && (ipApi.status === "success" || ipApi.country) ? ipApi : null;
  const loc = (ipapiIs && ipapiIs.location) || {};
  const asnObj = (ipapiIs && ipapiIs.asn) || {};
  const info = ipinfo && ipinfo.data ? ipinfo.data : ipinfo || {};
  const who = ipwho && ipwho.success !== false ? ipwho : {};

  const rawCode =
    clean(ipure && ipure.countryCode) ||
    clean(okApi && okApi.countryCode) ||
    clean(info.country) ||
    clean(who.country_code) ||
    clean(loc.country_code);
  const rawCountry =
    clean(ipure && ipure.country) ||
    clean(okApi && okApi.country) ||
    clean(info.country_name) ||
    clean(who.country) ||
    clean(loc.country);
  const taiwan = isTaiwanRegion(rawCode, rawCountry);
  const code = taiwan ? "CN" : clean(rawCode).toUpperCase();
  const country = taiwan ? "中国台湾" : clean(rawCountry);
  const flagEmoji = flagsEmoji(taiwan ? "TW" : rawCode);

  const cityParts = unique([
    clean(ipure && ipure.region) ||
      clean(okApi && okApi.regionName) ||
      clean(info.region) ||
      clean(who.region) ||
      clean(loc.state),
    clean(ipure && ipure.city) ||
      clean(okApi && okApi.city) ||
      clean(info.city) ||
      clean(who.city) ||
      clean(loc.city),
  ]);

  let asRaw =
    ipure && ipure.asn != null && ipure.asn !== ""
      ? String(ipure.asn)
      : clean(okApi && okApi.as) ||
        clean(info.asn && (info.asn.asn || info.asn)) ||
        clean(who.connection && who.connection.asn) ||
        clean(asnObj.asn);
  asRaw = String(asRaw || "").replace(/^AS/i, "");
  const asn = asRaw ? "AS" + asRaw : "";
  const org =
    clean(ipure && ipure.asOrganization) ||
    clean(okApi && (okApi.asname || okApi.org || okApi.isp)) ||
    clean(info.asn && info.asn.name) ||
    clean(info.org) ||
    clean(who.connection && (who.connection.org || who.connection.isp)) ||
    clean(asnObj.org);

  return {
    v4: v4 || "",
    v6: v6 || "",
    nature: classifyNature(okApi, ipapiIs, ipure, info, who),
    region: code
      ? (flagEmoji + " [" + code + "] " + (country || "")).trim()
      : (flagEmoji + " " + (country || "")).trim(),
    flagEmoji: flagEmoji,
    flagImg: flagImageUrl(taiwan ? "CN" : code),
    city: cityParts.join(" · "),
    asn: asn,
    org: org,
    timezone:
      clean(ipure && ipure.timezone) ||
      clean(okApi && okApi.timezone) ||
      clean(info.timezone) ||
      clean(who.timezone && (who.timezone.id || who.timezone)) ||
      clean(loc.timezone),
  };
}

function classifyNature(okApi, ipapiIs, ipure, info, who) {
  if (ipure && typeof ipure.isResidential === "boolean") {
    if (ipure.isResidential) {
      return ipure.isBroadcast ? "住宅 IP（广播）" : "住宅 IP";
    }
    return "机房 IP";
  }
  const hosting =
    !!(okApi && okApi.hosting) ||
    !!(ipapiIs && (ipapiIs.is_datacenter || ipapiIs.is_hosting)) ||
    !!(info && info.privacy && info.privacy.hosting);
  const mobile =
    !!(okApi && okApi.mobile) || !!(ipapiIs && ipapiIs.is_mobile);
  const proxyLike =
    !!(okApi && okApi.proxy) ||
    !!(ipapiIs && (ipapiIs.is_proxy || ipapiIs.is_vpn || ipapiIs.is_tor)) ||
    !!(
      info &&
      info.privacy &&
      (info.privacy.proxy || info.privacy.vpn || info.privacy.tor)
    );
  if (hosting) return "机房 IP";
  if (mobile) return "移动 IP";
  if (proxyLike) return "代理特征";
  if (okApi || ipapiIs || info || who) return "家宽倾向";
  return "";
}

function buildPure(ipure) {
  if (!ipure) return null;
  const score = numberOrNull(ipure.fraudScore);
  let level = "未知";
  if (score !== null) {
    if (score <= 25) level = "低风险";
    else if (score <= 50) level = "中风险";
    else if (score <= 75) level = "高风险";
    else level = "极高风险";
  }
  let type = "未知";
  if (typeof ipure.isResidential === "boolean") {
    type = ipure.isResidential
      ? ipure.isBroadcast
        ? "住宅（广播）"
        : "住宅"
      : "数据中心";
  }
  return {
    score: score,
    level: level,
    type: type,
    isResidential: ipure.isResidential,
  };
}

function buildRisks(ipApi, ipapiIs, ipure, ipinfo, ipwho) {
  const out = [];
  if (ipure && numberOrNull(ipure.fraudScore) !== null) {
    const s = numberOrNull(ipure.fraudScore);
    out.push({
      level: s > 75 ? "bad" : s > 50 ? "warn" : "ok",
      icon: s > 75 ? "🔴" : s > 50 ? "🟠" : "🟢",
      text: "IPPure " + s + " · " + (s <= 25 ? "低" : s <= 50 ? "中" : s <= 75 ? "高" : "极高"),
    });
  }
  if (ipApi && (ipApi.status === "success" || ipApi.country)) {
    const f = [];
    if (ipApi.proxy) f.push("代理");
    if (ipApi.hosting) f.push("托管");
    if (ipApi.mobile) f.push("移动");
    out.push({
      level: f.length ? "warn" : "ok",
      icon: f.length ? "🟠" : "🟢",
      text: f.length ? "ip-api " + f.join("/") : "ip-api 清洁",
    });
  }
  if (ipapiIs && typeof ipapiIs === "object") {
    const f = [];
    if (ipapiIs.is_proxy) f.push("代理");
    if (ipapiIs.is_vpn) f.push("VPN");
    if (ipapiIs.is_tor) f.push("Tor");
    if (ipapiIs.is_datacenter) f.push("机房");
    if (ipapiIs.is_abuser) f.push("滥用");
    out.push({
      level: f.length ? "warn" : "ok",
      icon: f.length ? "🟠" : "🟢",
      text: f.length ? "ipapi " + f.join("/") : "ipapi 清洁",
    });
  }
  const info = ipinfo && ipinfo.data ? ipinfo.data : ipinfo;
  if (info && info.privacy) {
    const p = info.privacy;
    const f = [];
    if (p.vpn) f.push("VPN");
    if (p.proxy) f.push("代理");
    if (p.tor) f.push("Tor");
    if (p.hosting) f.push("机房");
    out.push({
      level: f.length ? "warn" : "ok",
      icon: f.length ? "🟠" : "🟢",
      text: f.length ? "ipinfo " + f.join("/") : "ipinfo 清洁",
    });
  }
  if (ipwho && ipwho.success !== false && ipwho.security) {
    const s = ipwho.security;
    const f = [];
    if (s.vpn) f.push("VPN");
    if (s.proxy) f.push("代理");
    if (s.tor) f.push("Tor");
    out.push({
      level: f.length ? "warn" : "ok",
      icon: f.length ? "🟠" : "🟢",
      text: f.length ? "ipwho " + f.join("/") : "ipwho 清洁",
    });
  }
  return out;
}

// ── 渲染（适中详细，非极简）──────────────────────────────

function renderAll(basic, risks, pure, rtt, dns, theme) {
  // IP
  if (basic.v4) lines.push("IPv4  " + displayIP(basic.v4));
  if (basic.v6) lines.push("IPv6  " + displayIP(basic.v6));
  if (!basic.v4 && !basic.v6) lines.push("IP  未获取");

  // 基础信息
  if (basic.nature) lines.push("类型  " + basic.nature);
  if (basic.region) lines.push("地区  " + basic.region);
  if (basic.city) lines.push("城市  " + basic.city);
  if (basic.asn || basic.org) {
    lines.push(
      "网络  " + [basic.asn, basic.org].filter(Boolean).join(" · ")
    );
  }
  if (basic.timezone) lines.push("时区  " + basic.timezone);
  if (POLICY) lines.push("节点  " + POLICY);
  if (rtt && rtt.ms != null) lines.push("延迟  " + rtt.ms + " ms");

  // 纯净度
  if (pure) {
    lines.push("");
    lines.push("纯净度");
    lines.push("  " + pure.type + (pure.score !== null ? " · 欺诈值 " + pure.score + "（" + pure.level + "）" : ""));
  }

  // HTTP 落地 vs DoH 探测
  if (dns) {
    lines.push("");
    lines.push("出口对比");
    if (dns.httpIP) lines.push("  HTTP落地  " + dns.httpIP + "（经节点）");
    if (dns.dnsIP) {
      lines.push(
        "  DoH探测   " +
          dns.dnsIP +
          (dns.source ? "（" + shortDnsSource(dns.source) + "）" : "")
      );
    } else {
      lines.push("  DoH探测   未测到");
    }
    lines.push(
      "  " +
        (dns.level === "ok" ? "✅" : dns.level === "warn" ? "🟠" : "⚪") +
        " " +
        dns.text
    );
  }

  // 风险
  if (risks && risks.length) {
    lines.push("");
    lines.push("风险");
    risks.forEach(function (r) {
      lines.push("  " + r.icon + " " + r.text);
    });
  }

  if (warn.length) {
    lines.push("");
    lines.push("提示  " + warn.slice(0, 2).join("；"));
  }

  const body = lines.join("\n");
  doneOK(
    theme.titleEmoji + " 节点 IP 检测",
    POLICY || "完成",
    body,
    buildHtml(basic, risks, pure, rtt, dns, theme),
    theme
  );
}

function resultTheme(basic, pure) {
  if (pure && pure.isResidential === true) {
    return {
      titleEmoji: "🏠",
      sfSymbol: "house.fill",
      color: "#30D158",
      badge: "住宅",
    };
  }
  if (
    (pure && pure.isResidential === false) ||
    (basic && basic.nature && basic.nature.indexOf("机房") >= 0)
  ) {
    return {
      titleEmoji: "🖥️",
      sfSymbol: "server.rack",
      color: "#FF9F0A",
      badge: "机房",
    };
  }
  return {
    titleEmoji: "🌐",
    sfSymbol: "shield.lefthalf.filled",
    color: "#0A84FF",
    badge: "检测完成",
  };
}

function buildHtml(basic, risks, pure, rtt, dns, theme) {
  const rows = [];
  const ipShow =
    (basic.v4 ? displayIP(basic.v4) : "") +
    (basic.v4 && basic.v6 ? "\n" : "") +
    (basic.v6 ? displayIP(basic.v6) : "");

  rows.push(
    '<div style="padding:12px 14px;border-radius:12px;background:linear-gradient(135deg,' +
      theme.color +
      "22," +
      theme.color +
      '08)">' +
      '<div style="font-size:11px;color:' +
      theme.color +
      ';font-weight:700">' +
      escapeHtml(theme.titleEmoji + " " + theme.badge) +
      "</div>" +
      '<div style="margin-top:4px;font-size:20px;font-weight:800;white-space:pre-line;line-height:1.25">' +
      escapeHtml(ipShow || "—") +
      "</div></div>"
  );

  function row(lab, val) {
    if (val == null || val === "") return;
    rows.push(
      '<div style="margin:10px 0 0;font-size:13px;line-height:1.4">' +
        '<span style="color:#8e8e93">' +
        escapeHtml(lab) +
        '</span>　<span style="font-weight:600">' +
        escapeHtml(String(val)) +
        "</span></div>"
    );
  }

  row("类型", basic.nature);
  row("地区", basic.region);
  row("城市", basic.city);
  row("网络", [basic.asn, basic.org].filter(Boolean).join(" · "));
  row("时区", basic.timezone);
  row("节点", POLICY);
  if (rtt && rtt.ms != null) row("延迟", rtt.ms + " ms");

  if (pure) {
    rows.push(sec("纯净度"));
    row(
      "结果",
      pure.type +
        (pure.score !== null
          ? " · 欺诈值 " + pure.score + "（" + pure.level + "）"
          : "")
    );
  }

  if (dns) {
    rows.push(sec("出口对比"));
    row("HTTP落地", dns.httpIP ? dns.httpIP + "（经节点）" : "");
    row(
      "DoH探测",
      dns.dnsIP
        ? dns.dnsIP + (dns.source ? "（" + shortDnsSource(dns.source) + "）" : "")
        : "未测到"
    );
    row("结论", dns.text);
  }

  if (risks && risks.length) {
    rows.push(sec("风险"));
    risks.forEach(function (r) {
      const c =
        r.level === "bad" ? "#FF453A" : r.level === "warn" ? "#FF9F0A" : "#30D158";
      rows.push(
        '<div style="margin:6px 0 0;font-size:13px"><span style="color:' +
          c +
          '">' +
          escapeHtml(r.icon) +
          "</span> " +
          escapeHtml(r.text) +
          "</div>"
      );
    });
  }

  if (warn.length) {
    rows.push(
      '<div style="margin-top:12px;font-size:12px;color:#8e8e93">⚠️ ' +
        escapeHtml(warn.slice(0, 2).join("；")) +
        "</div>"
    );
  }

  return (
    '<div style="font-family:-apple-system;font-size:14px;line-height:1.45;text-align:left">' +
    rows.join("") +
    "</div>"
  );
}

function sec(t) {
  return (
    '<div style="margin:14px 0 4px;padding-top:10px;border-top:1px solid #e5e5ea;font-size:12px;font-weight:700;color:#8e8e93">' +
    escapeHtml(t) +
    "</div>"
  );
}

function shortDnsSource(s) {
  if (s === "google-doh") return "Google DoH";
  if (s === "cf-doh") return "CF DoH";
  if (s === "http-trace") return "HTTP备用";
  return s || "";
}

// ── HTTP ─────────────────────────────────────────────────

function fetchJson(url, options) {
  return fetchRaw(url, options).then(function (r) {
    const body = String(r.body || "").trim();
    if (!body) throw new Error("空响应");
    try {
      return JSON.parse(body);
    } catch (e) {
      const m = body.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch (e2) {}
      }
      throw new Error("JSON 解析失败");
    }
  });
}

function fetchText(url, options) {
  return fetchRaw(url, options).then(function (r) {
    return String(r.body || "");
  });
}

function fetchRaw(url, options) {
  const opt = options || {};
  const mode = opt.mode || "node";

  function once(policy) {
    return new Promise(function (resolve, reject) {
      const req = {
        url: url,
        method: String(opt.method || "GET").toUpperCase(),
        headers: opt.headers || {
          "User-Agent": UA,
          Accept: "application/json,text/plain,*/*",
        },
      };
      if (opt.body != null) req.body = opt.body;
      if (policy) req.opts = { policy: policy };

      $task.fetch(req).then(
        function (resp) {
          const code = Number(resp.statusCode);
          const body = String(resp.body == null ? "" : resp.body);
          if (
            !opt.allowError &&
            (!isFinite(code) || code < 200 || code >= 400) &&
            !body
          ) {
            reject(new Error("HTTP " + (code || "?")));
            return;
          }
          resolve({ statusCode: code, body: body });
        },
        function (reason) {
          reject(
            new Error(String(reason && reason.error ? reason.error : reason))
          );
        }
      );
    });
  }

  if (mode === "node") return POLICY ? once(POLICY) : once(null);
  if (mode === "direct") {
    return once("direct").catch(function () {
      return once(null);
    });
  }
  return once(null);
}

// ── 工具 ─────────────────────────────────────────────────

function withTimeout(promise, ms, fallback) {
  return new Promise(function (resolve) {
    let done = false;
    const t = setTimeout(function () {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, ms);
    Promise.resolve(promise).then(
      function (v) {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(v);
        }
      },
      function () {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(fallback);
        }
      }
    );
  });
}

function parseArgument(raw) {
  const out = {};
  String(raw || "")
    .split("&")
    .forEach(function (pair) {
      if (!pair) return;
      const i = pair.indexOf("=");
      if (i < 0) {
        out[safeDecode(pair)] = "1";
        return;
      }
      out[safeDecode(pair.slice(0, i).trim())] = safeDecode(
        pair.slice(i + 1).trim()
      );
    });
  return out;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

function isTruthy(value, defaultValue) {
  if (value == null || value === "") return defaultValue;
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
    parts.every(function (p) {
      return /^\d{1,3}$/.test(p) && +p >= 0 && +p <= 255;
    })
  ) {
    return text;
  }
  return "";
}

function displayIP(ip) {
  if (!ip) return "";
  if (!MASK_IP) return ip;
  if (ip.indexOf(":") >= 0) {
    const parts = ip.split(":");
    if (parts.length > 3) return parts.slice(0, 2).join(":") + ":****";
    return ip;
  }
  const p = String(ip).split(".");
  if (p.length !== 4) return ip;
  return p[0] + "." + p[1] + ".*.*";
}

function numberOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function isTaiwanRegion(code, country) {
  const c = String(code || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (c === "TW" || c === "TWN") return true;
  return /taiwan|twn|台灣|台湾|臺湾|中华民国|中華民國|taipei|台北|臺北/i.test(
    String(country || "")
  );
}

function flagsEmoji(countryCode) {
  const code = String(countryCode || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (code.length !== 2) return "";
  if (code === "TW" || code === "CN") return "🇨🇳";
  try {
    const emoji = String.fromCodePoint(
      code.charCodeAt(0) + 0x1f1a5,
      code.charCodeAt(1) + 0x1f1a5
    );
    return emoji === "🇹🇼" ? "🇨🇳" : emoji;
  } catch (e) {
    return "";
  }
}

function flagImageUrl(code) {
  const c = String(code || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (c.length !== 2) return "";
  return "https://flagcdn.com/w40/" + (c === "tw" ? "cn" : c) + ".png";
}

function unique(arr) {
  const out = [];
  (arr || []).forEach(function (x) {
    const v = clean(x);
    if (v && out.indexOf(v) < 0) out.push(v);
  });
  return out;
}

function clean(value) {
  if (value == null) return "";
  const text = String(value).trim();
  if (!text || /^(null|undefined|n\/a|unknown|-)$/i.test(text)) return "";
  return text;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
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
  console.log("[ipquality-qx] " + msg);
}

function doneOK(title, subtitle, body, html, theme) {
  if (finished) return;
  finished = true;
  try {
    $notify(title || "节点 IP 检测", subtitle || "", body || "");
  } catch (e) {}
  const payload = {
    title: title || "节点 IP 检测",
    htmlMessage:
      html ||
      '<div style="font-family:-apple-system;padding:10px;white-space:pre-wrap">' +
        escapeHtml(body || "") +
        "</div>",
  };
  if (theme && theme.sfSymbol) payload.icon = theme.sfSymbol;
  if (theme && theme.color) payload["icon-color"] = theme.color;
  $done(payload);
}

function failSoft(message) {
  if (finished) return;
  if (lines.length) {
    lines.push("");
    lines.push("⚠️ " + message);
    doneOK(
      "🌐 节点 IP 检测",
      POLICY || "超时",
      lines.join("\n"),
      '<div style="font-family:-apple-system;padding:10px;white-space:pre-wrap">' +
        escapeHtml(lines.join("\n")) +
        "</div>",
      { sfSymbol: "clock", color: "#FF9F0A" }
    );
    return;
  }
  fail(message);
}

function fail(message) {
  if (finished) return;
  finished = true;
  const msg = String(message || "未知错误");
  try {
    $notify("⚠️ 节点 IP 检测", "失败", msg);
  } catch (e) {}
  $done({
    title: "⚠️ 节点 IP 检测",
    htmlMessage:
      '<div style="font-family:-apple-system;text-align:center;padding:12px">' +
      '<div style="font-size:28px">⚠️</div>' +
      '<div style="margin-top:10px;font-size:15px;font-weight:600;color:#FF453A">' +
      escapeHtml(msg) +
      "</div>" +
      '<div style="margin-top:10px;font-size:12px;color:#8e8e93">长按节点 · 开启 Tunnel · 脚本 qx6</div>' +
      "</div>",
    icon: "exclamationmark.triangle.fill",
    "icon-color": "#FF453A",
  });
}
