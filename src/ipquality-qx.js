/**
 * 节点 IP 质量检测 · Quantumult X
 *
 * 针对 event-interaction 约 20s 硬超时优化：
 * - 出口 IP 用纯文本 + 正则（避免 JSON 解析失败）
 * - 默认不做 check-host / Globalping（最耗时）
 * - 每路请求限时，总流程目标 < 12s 必 $done
 *
 * 长按节点运行。参数：mask=0&pure=1&block=0
 * block=1 仅做本机/节点连通对比；block=full 才开远端 TCP（慢）
 *
 * @Updated: 2026-07-20
 */

const VERSION = "2026-07-20.qx4.2";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1";
const IPPURE_URL = "https://my.ippure.com/v1/info";
const REQ_MS = 5000;
const HARD_MS = 14000;

const envVars =
  typeof $environment !== "undefined" && $environment.variables
    ? $environment.variables
    : {};
const argRaw =
  typeof $argument !== "undefined" && $argument != null ? String($argument) : "";
const args = Object.assign({}, envVars, parseArgument(argRaw));

const POLICY = resolvePolicy();
const FROM_UI = !!readUINode();
const MASK_IP = isTruthy(args.mask, false);
const PURE_ON = isTruthy(args.pure, true);
// block: 0/false 关闭；1/true 轻量连通；full 远端 TCP（易超时，不推荐）
const BLOCK_MODE = normalizeBlockMode(args.block);

const lines = [];
const warn = [];
let finished = false;

setTimeout(function () {
  if (!finished) {
    failSoft("脚本即将被 QX 强制结束，已尽量返回已有结果");
  }
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
      " block=" +
      BLOCK_MODE
  );

  if (!POLICY) {
    warn.push("未指定节点：走默认路由。请长按目标节点");
  }

  // ── 阶段 1：出口 IP（文本探针，快）────────────────────
  const ip = await withTimeout(discoverIP(), 7000, "");
  const ipure =
    PURE_ON && ip
      ? await withTimeout(fetchIPPure(), REQ_MS, null)
      : PURE_ON && !ip
        ? await withTimeout(fetchIPPure(), REQ_MS, null)
        : null;

  const egressIP = ip || normalizeIP(ipure && ipure.ip) || "";

  if (!egressIP) {
    // 轻量连通信息（不跑远端）
    let directOk = null;
    if (BLOCK_MODE !== "0") {
      directOk = await withTimeout(
        checkDirectNet().then(function (r) {
          return r.ok;
        }),
        4000,
        null
      );
    }
    const block =
      BLOCK_MODE !== "0"
        ? {
            nodeOk: false,
            directOk: directOk,
            remoteOk: null,
            remoteItems: [],
            remoteError: "",
            nodeIp: "",
            nodeLoc: "",
            conclusion:
              directOk === false
                ? "⚠️ 本机网络异常"
                : "💤 节点代理不可达（未拿到出口 IP）",
          }
        : null;
    if (block) {
      renderPartialFail(block);
      return;
    }
    fail(
      POLICY
        ? "无法经「" + POLICY + "」获取出口 IP（检查节点/Tunnel；日志里 JSON 失败可忽略）"
        : "无法获取出口 IP"
    );
    return;
  }

  // ── 阶段 2：详情并行（各自限时）──────────────────────
  const jobs = [
    withTimeout(
      fetchJson(
        "http://ip-api.com/json/" +
          egressIP +
          "?lang=zh-CN&fields=status,message,country,countryCode,regionName,city,timezone,isp,org,as,asname,mobile,proxy,hosting,query",
        { mode: "direct" }
      ),
      REQ_MS,
      null
    ),
    withTimeout(
      fetchJson("https://api.ipapi.is/?q=" + encodeURIComponent(egressIP), {
        mode: "direct",
      }),
      REQ_MS,
      null
    ),
  ];

  if (PURE_ON && !ipure) {
    jobs.push(withTimeout(fetchIPPure(), REQ_MS, null));
  } else {
    jobs.push(Promise.resolve(ipure));
  }

  if (BLOCK_MODE !== "0") {
    jobs.push(
      withTimeout(
        checkDirectNet().then(function (r) {
          return r.ok;
        }),
        4000,
        null
      )
    );
  } else {
    jobs.push(Promise.resolve(null));
  }

  // full 才做远端（额外约 3s，可能顶满超时）
  if (BLOCK_MODE === "full" && POLICY) {
    jobs.push(
      withTimeout(
        getServerHostPort(POLICY).then(function (ep) {
          if (!ep) return { ok: false, error: "无节点地址", items: [] };
          return checkHostRemote(ep.host, ep.port);
        }),
        8000,
        { ok: false, error: "远端探测超时", items: [] }
      )
    );
  } else {
    jobs.push(Promise.resolve(null));
  }

  const pack = await Promise.all(jobs);
  const ipApi = pack[0];
  const ipapiIs = pack[1];
  const pureData = pack[2];
  const directOk = pack[3];
  const remote = pack[4];

  if (!ipApi) warn.push("ip-api 详情未返回");
  if (!ipapiIs) warn.push("ipapi.is 未返回");
  if (PURE_ON && !pureData) warn.push("IPPure 未返回");

  const basic = buildBasic(egressIP, ipApi, ipapiIs, pureData);
  const pure = buildPure(pureData);
  const risks = buildRisks(ipApi, ipapiIs, pureData);
  const block =
    BLOCK_MODE === "0"
      ? null
      : {
          nodeOk: true,
          directOk: directOk,
          remoteOk: remote == null ? null : !!remote.ok,
          remoteItems: (remote && remote.items) || [],
          remoteError: (remote && remote.error) || "",
          nodeIp: displayIP(egressIP),
          nodeLoc: basic.region || basic.city || "",
          conclusion: buildConclusion(true, directOk, remote),
        };

  renderAll(basic, risks, pure, block, resultTheme(basic, risks, pure));
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

function normalizeBlockMode(v) {
  if (v == null || v === "") return "0";
  const t = String(v).toLowerCase();
  if (t === "full" || t === "2") return "full";
  if (t === "1" || t === "true" || t === "yes" || t === "on") return "1";
  return "0";
}

// ── 出口探测（文本优先）──────────────────────────────────

async function discoverIP() {
  // 全部当文本处理，再用正则抠 IPv4（ipify 偶发非 JSON）
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
        fetchText(url, { mode: "node" }).then(function (body) {
          return extractIPv4(body);
        }),
        REQ_MS,
        ""
      ).catch(function () {
        return "";
      });
    })
  );

  const valid = results.filter(Boolean);
  if (!valid.length) {
    log("discoverIP: all probes empty");
    return "";
  }

  const counts = {};
  valid.forEach(function (ip) {
    counts[ip] = (counts[ip] || 0) + 1;
  });
  const ranked = Object.keys(counts).sort(function (a, b) {
    return counts[b] - counts[a];
  });
  if (ranked.length > 1) {
    warn.push("出口探针不一致: " + ranked.join(" / "));
  }
  log("discoverIP: " + ranked[0] + " (" + valid.length + " hits)");
  return ranked[0];
}

function extractIPv4(text) {
  if (text == null) return "";
  const s = String(text);
  // JSON query/ip 字段
  let m = s.match(/"query"\s*:\s*"(\d{1,3}(?:\.\d{1,3}){3})"/);
  if (m) return normalizeIP(m[1]);
  m = s.match(/"ip"\s*:\s*"(\d{1,3}(?:\.\d{1,3}){3})"/);
  if (m) return normalizeIP(m[1]);
  // 纯文本
  m = s.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m ? normalizeIP(m[1]) : "";
}

function fetchIPPure() {
  return fetchJson(IPPURE_URL, { mode: "node" }).then(function (data) {
    if (!data || typeof data !== "object") throw new Error("IPPure 空");
    return data;
  });
}

function checkDirectNet() {
  return fetchText("http://ip-api.com/json?lang=zh-CN&fields=status,query", {
    mode: "direct",
  })
    .then(function (body) {
      return { ok: /"status"\s*:\s*"success"/.test(body) || !!extractIPv4(body) };
    })
    .catch(function () {
      return { ok: false };
    });
}

function getServerHostPort(tag) {
  return new Promise(function (resolve) {
    if (
      !tag ||
      typeof $configuration === "undefined" ||
      typeof $configuration.sendMessage !== "function"
    ) {
      resolve(null);
      return;
    }
    try {
      const ret = $configuration.sendMessage({
        action: "get_server_description",
        content: tag,
      });
      const finish = function (msg) {
        resolve(parseHostPort(msg, tag));
      };
      if (ret && typeof ret.then === "function") {
        ret.then(finish, function () {
          resolve(null);
        });
      } else {
        finish(ret);
      }
    } catch (e) {
      resolve(null);
    }
  });
}

function parseHostPort(msg, tag) {
  try {
    if (!msg) return null;
    const desc =
      msg.ret && msg.ret[tag]
        ? String(msg.ret[tag])
        : typeof msg === "string"
          ? msg
          : "";
    if (!desc) return null;
    const eq = desc.indexOf("=");
    if (eq < 0) return null;
    const after = desc.substring(eq + 1);
    const comma = after.indexOf(",");
    const hp = (comma < 0 ? after : after.substring(0, comma)).trim();
    // 支持 [ipv6]:port 与 host:port
    let host = "";
    let port = "";
    if (hp.charAt(0) === "[") {
      const end = hp.indexOf("]");
      if (end < 0) return null;
      host = hp.substring(1, end);
      if (hp.charAt(end + 1) === ":") port = hp.substring(end + 2);
    } else {
      const colon = hp.lastIndexOf(":");
      if (colon < 0) return null;
      host = hp.substring(0, colon).trim();
      port = hp.substring(colon + 1).trim();
    }
    if (!host || !/^\d+$/.test(port)) return null;
    return { host: host, port: port };
  } catch (e) {
    return null;
  }
}

async function checkHostRemote(host, port) {
  const target = host + ":" + port;
  const submit = await fetchJson(
    "https://check-host.net/check-tcp?host=" +
      encodeURIComponent(target) +
      "&max_nodes=5",
    { mode: "direct" }
  );
  if (!submit || !submit.ok || !submit.request_id) {
    return { ok: false, error: "提交失败", items: [] };
  }
  await sleep(2800);
  const res = await fetchJson(
    "https://check-host.net/check-result/" + submit.request_id,
    { mode: "direct" }
  );
  const nodeList = submit.nodes || {};
  const names = Object.keys(nodeList);
  let reachable = false;
  const items = [];
  names.forEach(function (n) {
    const info = nodeList[n];
    const cc = info && info.length ? info[0] : "";
    const flag = cc ? flagsEmoji(cc) || "🌍" : "🌍";
    const nr = res && res[n];
    let ms = "--ms";
    if (nr && nr.length && nr[0] && nr[0].time !== undefined) {
      reachable = true;
      ms = Math.round(nr[0].time * 1000) + "ms";
    }
    items.push({ flag: flag, ms: ms });
  });
  return {
    ok: reachable,
    items: items,
    error: reachable ? "" : "远端不可达",
  };
}

function buildConclusion(nodeOk, directOk, remote) {
  if (directOk === false) return "⚠️ 本机网络异常";
  if (nodeOk && remote == null) return "✅ 节点代理可达";
  if (nodeOk && remote && remote.ok) return "✅ 节点正常";
  if (nodeOk && remote && !remote.ok) {
    return "⚠️ 代理可达，服务端口远端探测失败";
  }
  if (!nodeOk && remote && remote.ok) return "🚫 疑似被运营商/GFW 阻断";
  if (!nodeOk) return "💤 节点离线";
  return "❓ 数据不完整";
}

// ── 组装 ─────────────────────────────────────────────────

function buildBasic(ip, ipApi, ipapiIs, ipure) {
  const okApi = ipApi && ipApi.status === "success" ? ipApi : null;
  const loc = (ipapiIs && ipapiIs.location) || {};
  const asnObj = (ipapiIs && ipapiIs.asn) || {};

  const rawCode =
    clean(ipure && ipure.countryCode) ||
    clean(okApi && okApi.countryCode) ||
    clean(loc.country_code);
  const rawCountry =
    clean(ipure && ipure.country) ||
    clean(okApi && okApi.country) ||
    clean(loc.country);
  const taiwan = isTaiwanRegion(rawCode, rawCountry);
  const code = taiwan ? "CN" : clean(rawCode).toUpperCase();
  const country = taiwan ? "中国台湾" : clean(rawCountry);
  const flagEmoji = flagsEmoji(taiwan ? "TW" : rawCode);

  const cityParts = unique([
    clean(ipure && ipure.region) ||
      clean(okApi && okApi.regionName) ||
      clean(loc.state),
    clean(ipure && ipure.city) || clean(okApi && okApi.city) || clean(loc.city),
  ]);

  let asRaw =
    ipure && ipure.asn != null && ipure.asn !== ""
      ? String(ipure.asn)
      : clean(okApi && okApi.as) || clean(asnObj.asn);
  asRaw = String(asRaw || "").replace(/^AS/i, "");
  const asn = asRaw ? "AS" + asRaw : "";
  const org =
    clean(ipure && ipure.asOrganization) ||
    clean(okApi && (okApi.asname || okApi.org || okApi.isp)) ||
    clean(asnObj.org) ||
    clean(ipapiIs && ipapiIs.company && ipapiIs.company.name);

  return {
    ip: ip,
    nature: classifyNature(okApi, ipapiIs, ipure),
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
      clean(loc.timezone),
  };
}

function classifyNature(okApi, ipapiIs, ipure) {
  if (ipure && typeof ipure.isResidential === "boolean") {
    if (ipure.isResidential) {
      return ipure.isBroadcast
        ? "住宅 IP · 广播（非原生），IPPure"
        : "住宅 IP · 原生倾向，IPPure";
    }
    return "机房 IP · 数据中心，IPPure";
  }
  if ((okApi && okApi.hosting) || (ipapiIs && (ipapiIs.is_datacenter || ipapiIs.is_hosting))) {
    return "机房 IP · 服务器/数据中心";
  }
  if ((okApi && okApi.mobile) || (ipapiIs && ipapiIs.is_mobile)) {
    return "移动 IP · 蜂窝网络";
  }
  if (
    (okApi && okApi.proxy) ||
    (ipapiIs && (ipapiIs.is_proxy || ipapiIs.is_vpn || ipapiIs.is_tor))
  ) {
    return "代理特征 · 库标记像代理/VPN";
  }
  if (okApi || ipapiIs) return "家宽倾向 · 未检出机房/移动标记";
  return "";
}

function buildPure(ipure) {
  if (!ipure) return null;
  const score = numberOrNull(ipure.fraudScore);
  let level = "未知";
  let levelKey = "unknown";
  if (score !== null) {
    if (score <= 25) {
      level = "低风险";
      levelKey = "low";
    } else if (score <= 50) {
      level = "中风险";
      levelKey = "mid";
    } else if (score <= 75) {
      level = "高风险";
      levelKey = "high";
    } else {
      level = "极高风险";
      levelKey = "critical";
    }
  }
  let type = "未知";
  if (typeof ipure.isResidential === "boolean") {
    type = ipure.isResidential
      ? ipure.isBroadcast
        ? "住宅 · 广播"
        : "住宅 · 原生倾向"
      : "数据中心";
  }
  return {
    score: score,
    level: level,
    levelKey: levelKey,
    type: type,
    isResidential: ipure.isResidential,
    isBroadcast: ipure.isBroadcast,
  };
}

function buildRisks(ipApi, ipapiIs, ipure) {
  const out = [];
  if (ipure && numberOrNull(ipure.fraudScore) !== null) {
    const s = numberOrNull(ipure.fraudScore);
    out.push({
      level: s > 75 ? "bad" : s > 50 ? "warn" : "ok",
      icon: s > 75 ? "🔴" : s > 50 ? "🟠" : "🟢",
      text:
        "IPPure　欺诈值 " +
        s +
        " · " +
        (s <= 25 ? "低" : s <= 50 ? "中" : s <= 75 ? "高" : "极高") +
        "风险",
    });
  }
  if (ipApi && ipApi.status === "success") {
    const flags = [];
    if (ipApi.proxy) flags.push("代理");
    if (ipApi.hosting) flags.push("托管");
    if (ipApi.mobile) flags.push("移动");
    out.push({
      level: flags.length ? "warn" : "ok",
      icon: flags.length ? "🟠" : "🟢",
      text: flags.length
        ? "ip-api　命中 " + flags.join("、")
        : "ip-api　未命中 proxy/hosting",
    });
  }
  if (ipapiIs && typeof ipapiIs === "object") {
    const flags = [];
    if (ipapiIs.is_proxy) flags.push("代理");
    if (ipapiIs.is_vpn) flags.push("VPN");
    if (ipapiIs.is_tor) flags.push("Tor");
    if (ipapiIs.is_datacenter) flags.push("机房");
    if (ipapiIs.is_abuser) flags.push("滥用");
    out.push({
      level: flags.length ? "warn" : "ok",
      icon: flags.length ? "🟠" : "🟢",
      text: flags.length
        ? "ipapi.is　命中 " + flags.join("、")
        : "ipapi.is　无风险标记",
    });
  }
  return out;
}

// ── 渲染 ─────────────────────────────────────────────────

function renderAll(basic, risks, pure, block, theme) {
  lines.push("🌐 IP　" + displayIP(basic.ip));
  if (basic.nature) lines.push(theme.natureEmoji + " 类型　" + basic.nature);
  if (basic.region) lines.push("📍 地区　" + basic.region);
  if (basic.city) lines.push("🏙️ 城市　" + basic.city);
  if (basic.asn) lines.push("🔢 ASN　" + basic.asn);
  if (basic.org) lines.push("🏢 组织　" + basic.org);
  if (basic.timezone) lines.push("🕐 时区　" + basic.timezone);
  if (POLICY) lines.push("📡 节点　" + POLICY);

  if (pure) {
    lines.push("");
    lines.push("✨ IPPure 纯净度");
    lines.push("　类型　" + pure.type);
    if (pure.score !== null) {
      lines.push("　欺诈值　" + pure.score + " · " + pure.level);
    }
  }

  if (risks.length) {
    lines.push("");
    lines.push("🛡️ 风险");
    risks.forEach(function (r) {
      lines.push("　" + r.icon + " " + r.text);
    });
  }

  if (block) {
    lines.push("");
    lines.push("🔗 连通");
    lines.push("　节点代理　" + (block.nodeOk ? "✅ 正常" : "❌ 不可达"));
    if (block.directOk !== null && block.directOk !== undefined) {
      lines.push(
        "　本机网络　" + (block.directOk ? "✅ 正常" : "❌ 异常")
      );
    }
    if (block.remoteOk !== null && block.remoteOk !== undefined) {
      lines.push(
        "　远端探测　" + (block.remoteOk ? "✅ 可达" : "❌ 不可达")
      );
    }
    lines.push("　结论　" + block.conclusion);
  }

  if (warn.length) {
    lines.push("");
    lines.push("💡 提示");
    warn.slice(0, 4).forEach(function (w) {
      lines.push("　⚠️ " + w);
    });
  }

  lines.push("");
  lines.push("v" + VERSION);

  doneOK(
    theme.titleEmoji + " 节点 IP 质量检测",
    POLICY || "默认路由",
    lines.join("\n"),
    buildHtml(basic, risks, pure, block, theme),
    theme
  );
}

function renderPartialFail(block) {
  lines.push("🔗 连通");
  lines.push("　节点代理　❌ 不可达");
  if (block.directOk !== null) {
    lines.push("　本机网络　" + (block.directOk ? "✅ 正常" : "❌ 异常"));
  }
  lines.push("　结论　" + block.conclusion);
  if (POLICY) lines.push("📡 节点　" + POLICY);
  lines.push("");
  lines.push("v" + VERSION);
  doneOK(
    "🌐 节点 IP 质量检测",
    POLICY || "失败",
    lines.join("\n"),
    '<div style="font-family:-apple-system;font-size:14px;padding:8px;line-height:1.5">' +
      escapeHtml(lines.join("\n")).replace(/\n/g, "<br/>") +
      "</div>",
    { sfSymbol: "exclamationmark.triangle.fill", color: "#FF453A" }
  );
}

function resultTheme(basic, risks, pure) {
  if (pure && pure.isResidential === true) {
    return {
      titleEmoji: "🏠",
      natureEmoji: "🏠",
      sfSymbol: "house.fill",
      color: "#30D158",
      badge: "住宅",
    };
  }
  if (
    (pure && pure.isResidential === false) ||
    (basic.nature && basic.nature.indexOf("机房") >= 0)
  ) {
    return {
      titleEmoji: "🖥️",
      natureEmoji: "🖥️",
      sfSymbol: "server.rack",
      color: "#FF9F0A",
      badge: "机房",
    };
  }
  return {
    titleEmoji: "🌐",
    natureEmoji: "🏷️",
    sfSymbol: "shield.lefthalf.filled",
    color: "#0A84FF",
    badge: "检测完成",
  };
}

function buildHtml(basic, risks, pure, block, theme) {
  const rows = [];
  rows.push(
    '<div style="margin:0 0 12px;padding:12px;border-radius:12px;background:linear-gradient(135deg,' +
      theme.color +
      "22," +
      theme.color +
      '08)">' +
      '<div style="font-size:11px;color:' +
      theme.color +
      ';font-weight:700">' +
      escapeHtml(theme.titleEmoji + " " + theme.badge) +
      "</div>" +
      '<div style="margin-top:4px;font-size:22px;font-weight:800">' +
      escapeHtml(displayIP(basic.ip)) +
      "</div></div>"
  );

  function row(em, lab, val, color) {
    if (!val) return;
    rows.push(
      '<div style="margin:0 0 9px"><div style="font-size:11px;color:#8e8e93">' +
        escapeHtml(em + " " + lab) +
        '</div><div style="margin-top:2px;font-size:14px;font-weight:600;color:' +
        (color || "#1c1c1e") +
        ';word-break:break-word">' +
        escapeHtml(val) +
        "</div></div>"
    );
  }

  row("🏷️", "类型", basic.nature, theme.color);
  if (basic.region) {
    const img = basic.flagImg
      ? '<img src="' +
        escapeHtml(basic.flagImg) +
        '" width="20" height="14" style="vertical-align:-2px;margin-right:5px;border-radius:2px"/>'
      : "";
    const text = String(basic.region || "")
      .replace(/^(?:\uD83C[\uDDE6-\uDDFF]){2}\s*/g, "")
      .trim();
    rows.push(
      '<div style="margin:0 0 9px"><div style="font-size:11px;color:#8e8e93">📍 地区</div>' +
        '<div style="margin-top:2px;font-size:14px;font-weight:600">' +
        img +
        escapeHtml((basic.flagEmoji ? basic.flagEmoji + " " : "") + text) +
        "</div></div>"
    );
  }
  row("🏙️", "城市", basic.city);
  row("🔢", "ASN", basic.asn);
  row("🏢", "组织", basic.org);
  row("🕐", "时区", basic.timezone);
  if (POLICY) row("📡", "节点", POLICY);

  if (pure) {
    rows.push(sec("✨ IPPure 纯净度"));
    row("🏠", "网络类型", pure.type);
    if (pure.score !== null) {
      row("📊", "欺诈值", pure.score + " 分 · " + pure.level);
    }
  }

  rows.push(sec("🛡️ 风险"));
  if (risks.length) {
    risks.forEach(function (r) {
      const c =
        r.level === "bad" ? "#FF453A" : r.level === "warn" ? "#FF9F0A" : "#30D158";
      rows.push(
        '<div style="margin:0 0 7px;font-size:13px"><span style="color:' +
          c +
          '">' +
          escapeHtml(r.icon) +
          "</span> <b>" +
          escapeHtml(r.text) +
          "</b></div>"
      );
    });
  } else {
    rows.push(
      '<div style="color:#8e8e93;font-size:12px;margin-bottom:8px">⚪ 本次无可用标记</div>'
    );
  }

  if (block) {
    rows.push(sec("🔗 连通"));
    row("节点", "代理", block.nodeOk ? "✅ 正常" : "❌ 不可达");
    if (block.directOk !== null && block.directOk !== undefined) {
      row("本机", "网络", block.directOk ? "✅ 正常" : "❌ 异常");
    }
    if (block.remoteOk !== null && block.remoteOk !== undefined) {
      row("远端", "探测", block.remoteOk ? "✅ 可达" : "❌ 不可达");
    }
    rows.push(
      '<div style="margin-top:8px;padding:10px;border-radius:10px;background:#f2f2f7;font-weight:700">' +
        escapeHtml(block.conclusion) +
        "</div>"
    );
  }

  if (warn.length) {
    rows.push(sec("💡 提示"));
    warn.slice(0, 4).forEach(function (w) {
      rows.push(
        '<div style="color:#8e8e93;font-size:12px;margin:0 0 6px">⚠️ ' +
          escapeHtml(w) +
          "</div>"
      );
    });
  }

  return (
    '<div style="font-family:-apple-system;font-size:14px;line-height:1.45;text-align:left">' +
    rows.join("") +
    "</div>"
  );
}

function sec(t) {
  return (
    '<div style="margin:12px 0 8px;padding-top:10px;border-top:1px solid #e5e5ea;font-size:12px;font-weight:700;color:#8e8e93">' +
    escapeHtml(t) +
    "</div>"
  );
}

// ── HTTP ─────────────────────────────────────────────────

function fetchJson(url, options) {
  return fetchRaw(url, options).then(function (r) {
    const body = String(r.body || "").trim();
    if (!body) throw new Error("空响应");
    try {
      return JSON.parse(body);
    } catch (e) {
      // 有时带 BOM / 前后杂质
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
          Accept: "*/*",
        },
      };
      if (opt.body != null) req.body = opt.body;
      if (policy) req.opts = { policy: policy };

      $task.fetch(req).then(
        function (resp) {
          const code = Number(resp.statusCode);
          if (
            !opt.allowError &&
            (!isFinite(code) || code < 200 || code >= 400)
          ) {
            // 3xx 也当失败；允许 200-399 较宽松
            if (!isFinite(code) || code < 200 || code >= 400) {
              reject(new Error("HTTP " + (code || "?")));
              return;
            }
          }
          resolve({
            statusCode: code,
            body: String(resp.body == null ? "" : resp.body),
          });
        },
        function (reason) {
          reject(
            new Error(String(reason && reason.error ? reason.error : reason))
          );
        }
      );
    });
  }

  if (mode === "node") {
    return POLICY ? once(POLICY) : once(null);
  }
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

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
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
  if (!MASK_IP) return ip;
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
    $notify(title || "节点 IP 质量检测", subtitle || "", body || "");
  } catch (e) {}
  const payload = {
    title: title || "节点 IP 质量检测",
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
  // 超时软失败：若已有 lines 则带上
  if (finished) return;
  if (lines.length) {
    lines.push("");
    lines.push("⚠️ " + message);
    doneOK(
      "🌐 节点 IP 质量检测",
      POLICY || "超时",
      lines.join("\n"),
      '<div style="font-family:-apple-system;padding:10px;white-space:pre-wrap">' +
        escapeHtml(lines.join("\n")) +
        "</div>",
      { sfSymbol: "clock.badge.exclamationmark", color: "#FF9F0A" }
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
    $notify("⚠️ 节点 IP 质量检测", "失败", msg);
  } catch (e) {}
  $done({
    title: "⚠️ 节点 IP 质量检测",
    htmlMessage:
      '<div style="font-family:-apple-system;text-align:center;padding:12px">' +
      '<div style="font-size:30px">⚠️</div>' +
      '<div style="margin-top:10px;font-size:15px;font-weight:600;color:#FF453A">' +
      escapeHtml(msg) +
      "</div>" +
      '<div style="margin-top:10px;font-size:12px;color:#8e8e93;line-height:1.45">请确认：长按节点 · Tunnel 已开 · 脚本为 qx4.2<br/>配置勿写 block=1 除非必要</div>' +
      "</div>",
    icon: "exclamationmark.triangle.fill",
    "icon-color": "#FF453A",
  });
}
