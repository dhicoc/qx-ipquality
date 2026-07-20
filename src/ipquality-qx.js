/**
 * 节点 IP 质量检测 · Quantumult X  qx5
 *
 * A. 阻断诊断（对齐 RavelloH/block_check）
 *    节点代理 / 本机网络 / 远端 TCP(check-host) / 国内运营商(Globalping) / 结论
 * B. 扩展
 *    IPPure · ipinfo · ipwho.is · IPv4/IPv6 · DNS 出口一致性 · RTT 延迟
 *
 * 长按节点运行。
 * 参数：
 *   mask=0|1  pure=1|0  block=0|1|full  dns=1|0  rtt=1|0  v6=1|0
 *   verbose=0|1  默认 0 精简结果；1 显示完整明细
 *
 * @Updated: 2026-07-20
 * @Ref: https://gist.github.com/RavelloH/383354955aa3800e1d7e98666e11e16f
 */

const VERSION = "2026-07-20.qx5.1";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1";
const IPPURE_URL = "https://my.ippure.com/v1/info";
const CHECK_HOST = "https://check-host.net";
const GP_API = "https://api.globalping.io/v1/measurements";
const RTT_URL = "http://www.gstatic.com/generate_204";
const REQ_MS = 5000;
const HARD_MS = 18000;

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
const DNS_ON = isTruthy(args.dns, true);
const RTT_ON = isTruthy(args.rtt, true);
const V6_ON = isTruthy(args.v6, true);
const VERBOSE = isTruthy(args.verbose, false);
// 默认开启阻断链（对齐 block_check）；超时风险见 HARD_MS
const BLOCK_MODE = normalizeBlockMode(args.block, "1");

const lines = [];
const warn = [];
let finished = false;
const tStart = Date.now();

setTimeout(function () {
  if (!finished) failSoft("接近 QX 时限，已返回已采集数据");
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
      " block=" +
      BLOCK_MODE +
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

  // ═══════════════════════════════════════════════════════
  // 阶段 1：并行采集（出口 / 纯净 / 延迟 / DNS / 阻断前置）
  // ═══════════════════════════════════════════════════════
  const p1 = await Promise.all([
    withTimeout(discoverIPv4(), 6500, ""),
    V6_ON ? withTimeout(discoverIPv6(), 6500, "") : Promise.resolve(""),
    PURE_ON ? withTimeout(fetchIPPure(), REQ_MS, null) : Promise.resolve(null),
    RTT_ON ? withTimeout(measureRTT(), 4000, null) : Promise.resolve(null),
    DNS_ON ? withTimeout(probeDnsExit(), 5000, null) : Promise.resolve(null),
    BLOCK_MODE !== "0"
      ? withTimeout(checkDirectNet(), 4000, { ok: false })
      : Promise.resolve({ ok: null }),
    BLOCK_MODE !== "0" && POLICY
      ? withTimeout(getServerHostPort(POLICY), 2500, null)
      : Promise.resolve(null),
  ]);

  let v4 = p1[0] || "";
  const v6 = p1[1] || "";
  let ipure = p1[2];
  const rtt = p1[3];
  const dnsInfo = p1[4];
  const direct = p1[5] || { ok: null };
  const serverEP = p1[6];

  if (!v4 && ipure) v4 = normalizeIP(ipure.ip) || "";
  const nodeOk = !!(v4 || v6);
  const targetIP = v4 || "";

  // ═══════════════════════════════════════════════════════
  // 阶段 2：地理库 ∥ 远端 TCP（并行压缩耗时）
  // ═══════════════════════════════════════════════════════
  const phase2 = [];
  // 0-4 地理
  phase2.push(
    targetIP
      ? withTimeout(fetchIpApiDetail(targetIP), REQ_MS, null)
      : Promise.resolve(null)
  );
  phase2.push(
    targetIP
      ? withTimeout(fetchIpapiIsDetail(targetIP), REQ_MS, null)
      : Promise.resolve(null)
  );
  phase2.push(
    targetIP
      ? withTimeout(fetchIpinfo(targetIP), REQ_MS, null)
      : Promise.resolve(null)
  );
  phase2.push(
    targetIP
      ? withTimeout(fetchIpwho(targetIP), REQ_MS, null)
      : Promise.resolve(null)
  );
  phase2.push(
    PURE_ON && !ipure
      ? withTimeout(fetchIPPure(), REQ_MS, null)
      : Promise.resolve(ipure)
  );
  // 5 remote
  if (BLOCK_MODE !== "0" && serverEP) {
    phase2.push(
      withTimeout(checkHostRemote(serverEP.host, serverEP.port), 7000, {
        ok: false,
        error: "远端超时",
        items: [],
      })
    );
  } else if (BLOCK_MODE !== "0") {
    phase2.push(
      Promise.resolve({ ok: false, error: "无节点地址", items: [] })
    );
  } else {
    phase2.push(Promise.resolve(null));
  }

  const p2 = await Promise.all(phase2);
  const ipApi = p2[0];
  const ipapiIs = p2[1];
  const ipinfo = p2[2];
  const ipwho = p2[3];
  ipure = p2[4] || ipure;
  let remote = p2[5];
  let gp = null;

  // 节点代理失败 + 本机正常 + 远端可达 → Globalping 国内定位
  if (
    BLOCK_MODE !== "0" &&
    !nodeOk &&
    direct.ok &&
    remote &&
    remote.ok &&
    serverEP
  ) {
    gp = await withTimeout(
      runGlobalping(serverEP.host, serverEP.port),
      9000,
      null
    );
  }

  if (!ipApi) log("ip-api miss");
  if (!ipapiIs) log("ipapi.is miss");
  if (!ipinfo) log("ipinfo miss");
  if (!ipwho) log("ipwho miss");
  if (PURE_ON && !ipure) warn.push("IPPure 未返回");
  if (nodeOk && !ipApi && !ipapiIs && !ipinfo && !ipwho && !ipure) {
    warn.push("地理库均未返回，仅展示出口 IP");
  }

  const basic = buildBasic(v4, v6, ipApi, ipapiIs, ipure, ipinfo, ipwho);
  const pure = buildPure(ipure);
  const risks = buildRisks(ipApi, ipapiIs, ipure, ipinfo, ipwho);
  const libSummary = summarizeLibs(ipApi, ipapiIs, ipinfo, ipwho, ipure);
  const block =
    BLOCK_MODE === "0"
      ? null
      : buildBlockReport({
          nodeOk: nodeOk,
          directOk: direct.ok,
          remote: remote,
          gp: gp,
          nodeIp: displayIP(v4 || v6),
          nodeLoc: basic.region || basic.city || "",
        });
  const dnsReport = buildDnsReport(v4, v6, dnsInfo, basic);

  renderAll(
    basic,
    risks,
    pure,
    block,
    rtt,
    dnsReport,
    libSummary,
    resultTheme(basic, risks, pure)
  );
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

function normalizeBlockMode(v, def) {
  if (v == null || v === "") return def || "0";
  const t = String(v).toLowerCase();
  if (t === "0" || t === "false" || t === "off" || t === "no") return "0";
  if (t === "full" || t === "2") return "full";
  return "1";
}

// ── 出口 IPv4 / IPv6 ─────────────────────────────────────

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
  return voteIP(results.filter(Boolean), "v4");
}

async function discoverIPv6() {
  const urls = [
    "https://api6.ipify.org",
    "https://v6.ident.me/",
    "https://ipv6.icanhazip.com/",
    "https://api64.ipify.org",
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
  // api64 可能返回 v4，过滤
  const only6 = results.filter(function (x) {
    return x && x.indexOf(":") >= 0;
  });
  return voteIP(only6, "v6");
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
  if (ranked.length > 1) {
    log(tag + " probes differ: " + ranked.join(" / "));
  }
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
  // 简单 IPv6（含压缩）
  const m = s.match(
    /(([0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{0,4}|::([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})/
  );
  if (!m) return "";
  const ip = m[1];
  if (ip.indexOf(":") < 0) return "";
  // 排除 IPv4-mapped 误判优先返回纯 v6
  return ip;
}

// ── 延迟 / DNS ───────────────────────────────────────────

function measureRTT() {
  const t0 = Date.now();
  return fetchRaw(RTT_URL, { mode: "node", allowError: true }).then(function () {
    return { ms: Date.now() - t0, url: RTT_URL };
  });
}

/**
 * DNS 出口：Cloudflare whoami（DoH JSON）
 * 返回 DNS 解析路径上的客户端 IP（可能与 HTTP 出口不同 → 分流/泄漏感）
 */
function probeDnsExit() {
  // dns-json
  const url =
    "https://cloudflare-dns.com/dns-query?name=whoami.cloudflare&type=TXT";
  return fetchRaw(url, {
    mode: "node",
    headers: {
      Accept: "application/dns-json",
      "User-Agent": UA,
    },
  })
    .then(function (r) {
      let j = null;
      try {
        j = JSON.parse(r.body);
      } catch (e) {
        const m = String(r.body || "").match(/\{[\s\S]*\}/);
        if (m) j = JSON.parse(m[0]);
      }
      const ans = j && j.Answer ? j.Answer : [];
      let ip = "";
      for (let i = 0; i < ans.length; i++) {
        const data = String(ans[i].data || "").replace(/"/g, "");
        const v4 = extractIPv4(data);
        if (v4) {
          ip = v4;
          break;
        }
        const v6 = extractIPv6(data);
        if (v6) {
          ip = v6;
          break;
        }
      }
      return { ip: ip, source: "cloudflare-doh" };
    })
    .catch(function () {
      // 备用：trace 仅反映 HTTP 出口，DNS 意义较弱
      return fetchText("https://1.1.1.1/cdn-cgi/trace", { mode: "node" }).then(
        function (body) {
          const m = String(body).match(/^ip=([^\r\n]+)/m);
          return {
            ip: m ? String(m[1]).trim() : "",
            source: "cf-trace-fallback",
          };
        }
      );
    });
}

function buildDnsReport(v4, v6, dnsInfo, basic) {
  if (!dnsInfo) return null;
  const dnsIP = clean(dnsInfo.ip);
  if (!dnsIP) {
    return {
      ok: null,
      dnsIP: "",
      httpIP: v4 || v6 || "",
      text: "DNS 出口未测到",
      level: "unknown",
    };
  }
  const httpIP = v4 || v6 || "";
  const same =
    dnsIP === v4 ||
    dnsIP === v6 ||
    dnsIP === httpIP ||
    (v4 && dnsIP.indexOf(v4) >= 0);
  let text;
  let level;
  if (same) {
    text = "一致 · DNS 与 HTTP 出口相同";
    level = "ok";
  } else {
    text = "不一致 · 可能分流 / DNS 未走代理";
    level = "warn";
  }
  return {
    ok: same,
    dnsIP: displayIP(dnsIP),
    httpIP: displayIP(httpIP),
    text: text,
    level: level,
    source: dnsInfo.source || "",
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

/** ipinfo widget（公开 demo 接口，注意限流） */
function fetchIpinfo(ip) {
  const url = "https://ipinfo.io/widget/demo/" + encodeURIComponent(ip);
  return firstSuccess([
    POLICY ? fetchJson(url, { mode: "node" }) : null,
    fetchJson(url, { mode: "direct" }),
    fetchJson(url, { mode: "auto" }),
  ]).then(function (j) {
    // widget 可能包在 data 里
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

// ── 阻断（block_check）───────────────────────────────────

function checkDirectNet() {
  return fetchText("http://ip-api.com/json?lang=zh-CN&fields=status,query", {
    mode: "direct",
  })
    .then(function (body) {
      return {
        ok: /"status"\s*:\s*"success"/.test(body) || !!extractIPv4(body),
      };
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
    CHECK_HOST +
      "/check-tcp?host=" +
      encodeURIComponent(target) +
      "&max_nodes=8",
    {
      mode: "direct",
      headers: { Accept: "application/json", "User-Agent": UA },
    }
  );
  if (!submit || !submit.ok || !submit.request_id) {
    return { ok: false, error: "提交失败", items: [] };
  }
  await sleep(3000);
  const res = await fetchJson(
    CHECK_HOST + "/check-result/" + submit.request_id,
    {
      mode: "direct",
      headers: { Accept: "application/json", "User-Agent": UA },
    }
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
      ms = formatMs(nr[0].time * 1000);
    }
    items.push({ flag: flag, ms: ms, ok: ms !== "--ms" });
  });
  return {
    ok: reachable,
    items: items,
    error: reachable ? "" : "远端不可达",
  };
}

async function runGlobalping(host, port) {
  const created = await fetchJson(GP_API, {
    method: "POST",
    mode: "direct",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({
      type: "ping",
      target: host,
      measurementOptions: { port: parseInt(port, 10), protocol: "TCP" },
      locations: [{ country: "CN", tags: ["eyeball-network"] }],
      limit: 10,
    }),
  });
  if (!created || !created.id) return null;
  await sleep(5500);
  return fetchJson(GP_API + "/" + created.id, {
    mode: "direct",
    headers: { Accept: "application/json", "User-Agent": UA },
  });
}

function buildBlockReport(ctx) {
  const nodeOk = !!ctx.nodeOk;
  const directOk = ctx.directOk;
  const remote = ctx.remote;
  const rOk = remote && remote.ok;
  let conclusion = "❓ 数据不完整";
  let gpAnalysis = null;

  if (directOk === false) {
    conclusion = "⚠️ 本机网络异常";
  } else if (nodeOk && rOk) {
    conclusion = "✅ 节点正常";
  } else if (nodeOk && remote == null) {
    conclusion = "✅ 节点代理可达（未做远端 TCP）";
  } else if (nodeOk && !rOk) {
    conclusion =
      "⚠️ 节点可代理，但服务端口远端探测失败" +
      (remote && remote.error ? "（" + remote.error + "）" : "");
  } else if (!nodeOk && rOk && directOk) {
    if (ctx.gp && ctx.gp.results) {
      gpAnalysis = analyzeBlockSource(ctx.gp);
      conclusion = gpAnalysis.conclusion;
    } else {
      conclusion = "🚫 疑似被运营商/GFW 阻断";
    }
  } else if (!nodeOk && !rOk && directOk) {
    conclusion = "💤 节点离线";
  }

  return {
    nodeOk: nodeOk,
    directOk: directOk,
    remoteOk: remote == null ? null : !!rOk,
    remoteError: (remote && remote.error) || "",
    remoteItems: (remote && remote.items) || [],
    nodeIp: ctx.nodeIp || "",
    nodeLoc: ctx.nodeLoc || "",
    conclusion: conclusion,
    gpAnalysis: gpAnalysis,
  };
}

function analyzeBlockSource(gpData) {
  const results = gpData.results || [];
  const ispGroups = {};
  results.forEach(function (r) {
    const isp = classifyISP(r.probe && r.probe.network);
    if (!isp) return;
    if (!ispGroups[isp]) ispGroups[isp] = { probes: [], reachable: false };
    const res = r.result || {};
    const stats = res.stats;
    let ok = false;
    let ms = "--ms";
    if (res.status === "finished" && stats) {
      ok = stats.rcv > 0;
      ms = ok ? formatMs(stats.avg || 0) : "--ms";
    }
    if (ok) ispGroups[isp].reachable = true;
    ispGroups[isp].probes.push({
      city: cnCity(r.probe && r.probe.city),
      ok: ok,
      ms: ms,
    });
  });
  const reachableIsps = [];
  const blockedIsps = [];
  Object.keys(ispGroups).forEach(function (k) {
    if (!ispGroups[k].probes.length) return;
    if (ispGroups[k].reachable) reachableIsps.push(k);
    else blockedIsps.push(k);
  });
  let conclusion;
  if (!reachableIsps.length) {
    conclusion = "🚫 GFW 全局阻断 — 国内三大运营商均无法访问";
  } else if (blockedIsps.length) {
    conclusion =
      "🚫 运营商级拦截 — " +
      blockedIsps.join("、") +
      " 不可达，" +
      reachableIsps.join("、") +
      " 正常";
  } else {
    conclusion = "✅ 国内三大运营商全部可达，请检查客户端配置";
  }
  return { ispGroups: ispGroups, conclusion: conclusion };
}

function classifyISP(network) {
  const n = String(network || "").toLowerCase();
  if (n.indexOf("unicom") >= 0 || n.indexOf("china unicom") >= 0) {
    return "中国联通";
  }
  if (
    n.indexOf("chinanet") >= 0 ||
    n.indexOf("telecom") >= 0 ||
    n.indexOf("china telecom") >= 0
  ) {
    return "中国电信";
  }
  if (n.indexOf("mobile") >= 0 || n.indexOf("china mobile") >= 0) {
    return "中国移动";
  }
  return null;
}

function cnCity(en) {
  const map = {
    Beijing: "北京",
    Shanghai: "上海",
    Guangzhou: "广州",
    Shenzhen: "深圳",
    Chengdu: "成都",
    Hangzhou: "杭州",
    Wuhan: "武汉",
    Nanjing: "南京",
    Tianjin: "天津",
    "Xi'an": "西安",
    Changsha: "长沙",
    Zhengzhou: "郑州",
    Jinan: "济南",
    Qingdao: "青岛",
    Dalian: "大连",
    Xiamen: "厦门",
    Fuzhou: "福州",
    Harbin: "哈市",
    Shenyang: "沈阳",
    Foshan: "佛山",
    Dongguan: "东莞",
  };
  return map[en] || en || "";
}

// ── 基础 / 风险 ──────────────────────────────────────────

function buildBasic(v4, v6, ipApi, ipapiIs, ipure, ipinfo, ipwho) {
  const okApi = ipApi && (ipApi.status === "success" || ipApi.country) ? ipApi : null;
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
      return ipure.isBroadcast
        ? "住宅 IP · 广播（非原生），IPPure"
        : "住宅 IP · 原生倾向，IPPure";
    }
    return "机房 IP · 数据中心，IPPure";
  }
  const hosting =
    !!(okApi && okApi.hosting) ||
    !!(ipapiIs && (ipapiIs.is_datacenter || ipapiIs.is_hosting)) ||
    !!(info && info.privacy && info.privacy.hosting) ||
    !!(who && who.type && /hosting|business/i.test(who.type));
  const mobile =
    !!(okApi && okApi.mobile) ||
    !!(ipapiIs && ipapiIs.is_mobile) ||
    !!(who && /mobile/i.test(who.type || ""));
  const proxyLike =
    !!(okApi && okApi.proxy) ||
    !!(ipapiIs && (ipapiIs.is_proxy || ipapiIs.is_vpn || ipapiIs.is_tor)) ||
    !!(info && info.privacy && (info.privacy.proxy || info.privacy.vpn || info.privacy.tor));
  if (hosting) return "机房 IP · 服务器/数据中心";
  if (mobile) return "移动 IP · 蜂窝网络";
  if (proxyLike) return "代理特征 · 库标记像代理/VPN";
  if (okApi || ipapiIs || info || who) return "家宽倾向 · 未检出机房/移动标记";
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

function buildRisks(ipApi, ipapiIs, ipure, ipinfo, ipwho) {
  const out = [];
  if (ipure && numberOrNull(ipure.fraudScore) !== null) {
    const s = numberOrNull(ipure.fraudScore);
    out.push(riskLine(s > 75 ? "bad" : s > 50 ? "warn" : "ok", "IPPure　欺诈值 " + s));
  }
  if (ipApi && (ipApi.status === "success" || ipApi.country)) {
    const flags = [];
    if (ipApi.proxy) flags.push("代理");
    if (ipApi.hosting) flags.push("托管");
    if (ipApi.mobile) flags.push("移动");
    out.push(
      riskLine(
        flags.length ? "warn" : "ok",
        flags.length ? "ip-api　" + flags.join("、") : "ip-api　清洁"
      )
    );
  }
  if (ipapiIs && typeof ipapiIs === "object") {
    const flags = [];
    if (ipapiIs.is_proxy) flags.push("代理");
    if (ipapiIs.is_vpn) flags.push("VPN");
    if (ipapiIs.is_tor) flags.push("Tor");
    if (ipapiIs.is_datacenter) flags.push("机房");
    if (ipapiIs.is_abuser) flags.push("滥用");
    out.push(
      riskLine(
        flags.length ? "warn" : "ok",
        flags.length ? "ipapi.is　" + flags.join("、") : "ipapi.is　清洁"
      )
    );
  }
  const info = ipinfo && ipinfo.data ? ipinfo.data : ipinfo;
  if (info && info.privacy) {
    const p = info.privacy;
    const flags = [];
    if (p.vpn) flags.push("VPN");
    if (p.proxy) flags.push("代理");
    if (p.tor) flags.push("Tor");
    if (p.relay) flags.push("中继");
    if (p.hosting) flags.push("机房");
    out.push(
      riskLine(
        flags.length ? "warn" : "ok",
        flags.length ? "ipinfo　" + flags.join("、") : "ipinfo　清洁"
      )
    );
  }
  if (ipwho && ipwho.success !== false && ipwho.security) {
    const s = ipwho.security;
    const flags = [];
    if (s.vpn) flags.push("VPN");
    if (s.proxy) flags.push("代理");
    if (s.tor) flags.push("Tor");
    if (s.anonymous) flags.push("匿名");
    out.push(
      riskLine(
        flags.length ? "warn" : "ok",
        flags.length ? "ipwho　" + flags.join("、") : "ipwho　清洁"
      )
    );
  }
  return out;
}

function riskLine(level, text) {
  return {
    level: level,
    text: text,
    icon: level === "bad" ? "🔴" : level === "warn" ? "🟠" : "🟢",
  };
}

function summarizeLibs(ipApi, ipapiIs, ipinfo, ipwho, ipure) {
  const ok = [];
  const miss = [];
  (ipApi ? ok : miss).push("ip-api");
  (ipapiIs ? ok : miss).push("ipapi.is");
  (ipinfo ? ok : miss).push("ipinfo");
  (ipwho ? ok : miss).push("ipwho");
  if (ipure) ok.push("IPPure");
  else miss.push("IPPure");
  return { ok: ok, miss: miss };
}

// ── 渲染（默认精简；verbose=1 展开）──────────────────────

function shortNature(s) {
  const t = String(s || "");
  if (!t) return "";
  // 去掉「· 后解释」和来源尾巴，只留关键词
  return t
    .replace(/，.*$/, "")
    .replace(/·\s*(服务器|一般|未检出|原生倾向|广播|IPPure|数据中心).*$/i, "")
    .replace(/\s*·\s*$/, "")
    .trim() || t.split("·")[0].trim();
}

function shortRegion(region) {
  return String(region || "")
    .replace(/^(?:\uD83C[\uDDE6-\uDDFF]){2}\s*/g, "")
    .replace(/^\[CN\]\s*中国台湾/, "中国台湾")
    .replace(/^\[([A-Z]{2})\]\s*/, "")
    .trim();
}

function compactRisks(risks) {
  const list = risks || [];
  const hits = list.filter(function (r) {
    return r.level === "warn" || r.level === "bad";
  });
  if (!hits.length) return "🟢 清洁";
  return hits
    .slice(0, 3)
    .map(function (r) {
      return r.icon + " " + r.text.replace(/　/g, " ");
    })
    .join(" · ");
}

function renderAll(basic, risks, pure, block, rtt, dns, libs, theme) {
  if (VERBOSE) {
    renderVerbose(basic, risks, pure, block, rtt, dns, libs, theme);
  } else {
    renderCompact(basic, risks, pure, block, rtt, dns, theme);
  }
}

/** 默认：尽量一屏看完 */
function renderCompact(basic, risks, pure, block, rtt, dns, theme) {
  const ipLine =
    basic.v4 || basic.v6
      ? (basic.v4 ? displayIP(basic.v4) : "") +
        (basic.v4 && basic.v6 ? " / " : "") +
        (basic.v6 ? "v6 " + displayIP(basic.v6) : "")
      : "未获取";
  lines.push(theme.titleEmoji + " " + ipLine);

  const locBits = [];
  if (basic.flagEmoji) locBits.push(basic.flagEmoji);
  const reg = shortRegion(basic.region);
  if (reg) locBits.push(reg);
  if (basic.city) locBits.push(basic.city);
  if (locBits.length) lines.push(locBits.join(" · "));

  const meta = [];
  const nat = shortNature(basic.nature);
  if (nat) meta.push(nat);
  if (basic.asn) meta.push(basic.asn);
  if (basic.org) meta.push(truncate(basic.org, 22));
  if (meta.length) lines.push(meta.join(" · "));

  const pureBits = [];
  if (pure) {
    pureBits.push(pure.type || "IPPure");
    if (pure.score !== null) pureBits.push("欺诈" + pure.score);
  }
  if (rtt && rtt.ms != null) pureBits.push(rtt.ms + "ms");
  if (dns) {
    pureBits.push(
      dns.level === "ok" ? "DNS✓" : dns.level === "warn" ? "DNS≠" : "DNS?"
    );
  }
  if (pureBits.length) lines.push(pureBits.join(" · "));

  // 风险：一行摘要
  if (risks && risks.length) lines.push(compactRisks(risks));

  if (block) {
    const b = [];
    b.push(block.nodeOk ? "节点✓" : "节点✗");
    if (block.directOk !== null && block.directOk !== undefined) {
      b.push(block.directOk ? "本机✓" : "本机✗");
    }
    if (block.remoteOk !== null && block.remoteOk !== undefined) {
      b.push(block.remoteOk ? "远端✓" : "远端✗");
    }
    lines.push(b.join(" ") + " · " + shortConclusion(block.conclusion));
  }

  if (POLICY) lines.push("📡 " + truncate(POLICY, 28));
  if (warn.length) {
    lines.push("⚠️ " + truncate(warn[0], 36));
  }

  const body = lines.join("\n");
  doneOK(
    theme.titleEmoji + " IP检测",
    POLICY ? truncate(POLICY, 20) : "完成",
    body,
    buildHtmlCompact(basic, risks, pure, block, rtt, dns, theme),
    theme
  );
}

function shortConclusion(c) {
  const t = String(c || "");
  if (t.indexOf("节点正常") >= 0) return "正常";
  if (t.indexOf("离线") >= 0) return "离线";
  if (t.indexOf("本机网络异常") >= 0) return "本机异常";
  if (t.indexOf("GFW") >= 0) return "疑似GFW";
  if (t.indexOf("运营商") >= 0) return "疑似运营商拦截";
  if (t.indexOf("可代理") >= 0) return "代理通·端口异常";
  if (t.indexOf("代理可达") >= 0) return "代理可达";
  return truncate(t.replace(/[✅❌⚠️🚫💤❓]/g, "").trim(), 18);
}

function truncate(s, n) {
  const t = String(s || "");
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
}

function renderVerbose(basic, risks, pure, block, rtt, dns, libs, theme) {
  if (basic.v4) lines.push("🌐 IPv4　" + displayIP(basic.v4));
  if (basic.v6) lines.push("🧬 IPv6　" + displayIP(basic.v6));
  if (!basic.v4 && !basic.v6) lines.push("🌐 IP　未获取");
  if (basic.nature) lines.push(theme.natureEmoji + " 类型　" + basic.nature);
  if (basic.region) lines.push("📍 地区　" + basic.region);
  if (basic.city) lines.push("🏙️ 城市　" + basic.city);
  if (basic.asn) lines.push("🔢 ASN　" + basic.asn);
  if (basic.org) lines.push("🏢 组织　" + basic.org);
  if (basic.timezone) lines.push("🕐 时区　" + basic.timezone);
  if (POLICY) lines.push("📡 节点　" + POLICY);
  if (rtt && rtt.ms != null) lines.push("⚡ 延迟　" + rtt.ms + " ms");
  if (dns) {
    lines.push("🧭 DNS　" + (dns.dnsIP || "?") + " / HTTP　" + (dns.httpIP || "?"));
    lines.push(
      "　" +
        (dns.level === "ok" ? "✅" : "🟠") +
        " " +
        dns.text
    );
  }
  if (pure) {
    lines.push(
      "✨ " +
        pure.type +
        (pure.score !== null ? " · 欺诈" + pure.score + pure.level : "")
    );
  }
  if (risks && risks.length) {
    risks.forEach(function (r) {
      lines.push(r.icon + " " + r.text);
    });
  }
  if (block) {
    lines.push(
      "🔗 " +
        (block.nodeOk ? "节点✓" : "节点✗") +
        " " +
        (block.directOk ? "本机✓" : block.directOk === false ? "本机✗" : "") +
        " " +
        (block.remoteOk ? "远端✓" : block.remoteOk === false ? "远端✗" : "")
    );
    lines.push("　" + block.conclusion);
    if (block.remoteItems && block.remoteItems.length) {
      lines.push(
        "　" +
          block.remoteItems
            .slice(0, 4)
            .map(function (it) {
              return it.flag + it.ms;
            })
            .join(" ")
      );
    }
  }
  if (warn.length) lines.push("⚠️ " + warn.slice(0, 2).join("；"));

  doneOK(
    theme.titleEmoji + " IP检测",
    POLICY || "完成",
    lines.join("\n"),
    buildHtmlCompact(basic, risks, pure, block, rtt, dns, theme),
    theme
  );
}

function buildHtmlCompact(basic, risks, pure, block, rtt, dns, theme) {
  const ipShow =
    (basic.v4 ? displayIP(basic.v4) : "") +
    (basic.v4 && basic.v6 ? "\n" : "") +
    (basic.v6 ? displayIP(basic.v6) : "");

  const bits = [];
  const nat = shortNature(basic.nature);
  const reg = shortRegion(basic.region);
  if (reg) bits.push((basic.flagEmoji ? basic.flagEmoji + " " : "") + reg);
  if (basic.city) bits.push(basic.city);
  if (nat) bits.push(nat);
  if (basic.asn) bits.push(basic.asn);
  if (basic.org) bits.push(truncate(basic.org, 28));

  const status = [];
  if (pure) {
    status.push(
      pure.type + (pure.score !== null ? " · 欺诈" + pure.score : "")
    );
  }
  if (rtt && rtt.ms != null) status.push(rtt.ms + " ms");
  if (dns) {
    status.push(
      dns.level === "ok" ? "DNS 一致" : dns.level === "warn" ? "DNS 不一致" : "DNS ?"
    );
  }
  if (risks && risks.length) status.push(compactRisks(risks));

  let blockLine = "";
  if (block) {
    const b = [];
    b.push(block.nodeOk ? "节点✓" : "节点✗");
    if (block.directOk !== null && block.directOk !== undefined) {
      b.push(block.directOk ? "本机✓" : "本机✗");
    }
    if (block.remoteOk !== null && block.remoteOk !== undefined) {
      b.push(block.remoteOk ? "远端✓" : "远端✗");
    }
    blockLine =
      '<div style="margin-top:10px;padding:10px 12px;border-radius:10px;background:#f2f2f7;font-size:13px;font-weight:600;line-height:1.4">' +
      escapeHtml(b.join("  ") + " · " + shortConclusion(block.conclusion)) +
      "</div>";
  }

  let warnLine = "";
  if (warn.length) {
    warnLine =
      '<div style="margin-top:8px;font-size:12px;color:#8e8e93">⚠️ ' +
      escapeHtml(truncate(warn[0], 40)) +
      "</div>";
  }

  let nodeLine = POLICY
    ? '<div style="margin-top:8px;font-size:12px;color:#8e8e93">📡 ' +
      escapeHtml(truncate(POLICY, 32)) +
      "</div>"
    : "";

  return (
    '<div style="font-family:-apple-system;font-size:14px;line-height:1.4;text-align:left">' +
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
    '<div style="margin-top:4px;font-size:20px;font-weight:800;white-space:pre-line;line-height:1.2">' +
    escapeHtml(ipShow || "—") +
    "</div></div>" +
    (bits.length
      ? '<div style="margin-top:12px;font-size:14px;font-weight:600;line-height:1.45">' +
        escapeHtml(bits.join(" · ")) +
        "</div>"
      : "") +
    (status.length
      ? '<div style="margin-top:8px;font-size:13px;color:#3a3a3c;line-height:1.45">' +
        escapeHtml(status.join(" · ")) +
        "</div>"
      : "") +
    blockLine +
    nodeLine +
    warnLine +
    "</div>"
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
    (basic && basic.nature && basic.nature.indexOf("机房") >= 0)
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
  if (!ip) return "";
  if (!MASK_IP) return ip;
  if (ip.indexOf(":") >= 0) {
    // IPv6 简单遮罩
    const parts = ip.split(":");
    if (parts.length > 3) {
      return parts.slice(0, 2).join(":") + ":****:****";
    }
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

function formatMs(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return "0ms";
  if (n >= 100) return Math.round(n) + "ms";
  return n.toFixed(1) + "ms";
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
      '<div style="margin-top:10px;font-size:12px;color:#8e8e93">长按节点 · Tunnel 开启 · 脚本 qx5<br/>超时可 argument=block=0</div>' +
      "</div>",
    icon: "exclamationmark.triangle.fill",
    "icon-color": "#FF453A",
  });
}
