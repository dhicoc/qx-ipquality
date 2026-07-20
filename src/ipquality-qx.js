/**
 * 节点 IP 质量检测 · Quantumult X
 *
 * 功能：出口 IP + IPPure 纯净度 + 可选连通/阻断诊断
 * 用法：长按节点 → 本脚本
 * 参数：mask=0&pure=1&block=1
 *
 * 若曾出现「无有效内容」：多为脚本超时未 $done 或配置 API 挂起。
 * 本版强制总超时收尾，并给配置读取加超时。
 *
 * @Updated: 2026-07-20
 */

const VERSION = "2026-07-20.qx4.1";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1";
const IPPURE_URL = "https://my.ippure.com/v1/info";
const IP_API_BASE = "http://ip-api.com/json";
const CHECK_HOST = "https://check-host.net";
const GP_API = "https://api.globalping.io/v1/measurements";
const HARD_LIMIT_MS = 18000;

const envVars =
  typeof $environment !== "undefined" && $environment.variables
    ? $environment.variables
    : {};
const argRaw =
  typeof $argument !== "undefined" && $argument != null ? String($argument) : "";
const args = Object.assign({}, envVars, parseArgument(argRaw));

const UI_NODE = readUINode();
const ARG_POLICY = clean(args.policy || args.node || "");
const BARE_POLICY =
  !ARG_POLICY && argRaw && argRaw.indexOf("=") < 0 ? clean(argRaw) : "";
const POLICY = UI_NODE || ARG_POLICY || BARE_POLICY;
const FROM_UI = !!UI_NODE;
const MASK_IP = isTruthy(args.mask, false);
const PURE_ON = isTruthy(args.pure, true);
// 默认关闭远端 TCP（最易超时）；需要时 argument=block=1
const BLOCK_ON = isTruthy(args.block, false);

const lines = [];
const warn = [];
let finished = false;

// 总超时：保证一定有返回
setTimeout(function () {
  if (!finished) {
    fail("检测超时（可改 argument=block=0 或检查 Tunnel/节点名）");
  }
}, HARD_LIMIT_MS);

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
      BLOCK_ON
  );

  if (!POLICY) {
    warn.push("未指定节点：走默认路由。请长按目标节点再运行");
  }

  // ① 核心：出口 + 纯净度（必须在数秒内出结果）
  const core = await Promise.all([
    safe(discoverIP(), ""),
    PURE_ON ? safe(fetchIPPure(), null) : Promise.resolve(null),
    BLOCK_ON ? safe(checkDirectNet(), { ok: null }) : Promise.resolve({ ok: null }),
    BLOCK_ON && POLICY
      ? safe(withTimeout(getServerHostPort(POLICY), 2500, null), null)
      : Promise.resolve(null),
  ]);

  const ip = core[0];
  const ipure = core[1];
  const direct = core[2] || { ok: null };
  const serverEP = core[3];

  const egressIP = ip || normalizeIP(ipure && ipure.ip) || "";

  if (!egressIP) {
    if (BLOCK_ON && POLICY) {
      const remote = serverEP
        ? await safe(checkHostRemote(serverEP.host, serverEP.port), {
            ok: false,
            error: "远端探测失败",
            items: [],
          })
        : { ok: false, error: "无节点地址", items: [] };
      let gp = null;
      if (direct.ok && remote.ok && serverEP) {
        gp = await safe(runGlobalping(serverEP.host, serverEP.port), null);
      }
      const block = buildBlockReport({
        nodeOk: false,
        directOk: direct.ok === true,
        remote: remote,
        gp: gp,
        nodeIp: "",
        nodeLoc: "",
      });
      renderFailureWithBlock(block);
      return;
    }
    fail(
      POLICY
        ? "无法经「" + POLICY + "」获取出口 IP（检查节点名 / Tunnel）"
        : "无法获取出口 IP（检查网络 / Tunnel）"
    );
    return;
  }

  // ② 详情库（直连查 IP，失败不影响出结果）
  const detail = await Promise.all([
    safe(
      fetchJson(
        IP_API_BASE +
          "/" +
          egressIP +
          "?lang=zh-CN&fields=status,message,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,asname,mobile,proxy,hosting,query",
        { mode: "direct" }
      ),
      null
    ),
    safe(
      fetchJson("https://api.ipapi.is/?q=" + encodeURIComponent(egressIP), {
        mode: "direct",
      }),
      null
    ),
    BLOCK_ON && serverEP
      ? safe(checkHostRemote(serverEP.host, serverEP.port), {
          ok: false,
          error: "远端探测失败",
          items: [],
        })
      : Promise.resolve(null),
  ]);

  const ipApi = detail[0];
  const ipapiIs = detail[1];
  const remote = detail[2];

  if (!ipApi) warn.push("ip-api 详情未返回");
  if (!ipapiIs) warn.push("ipapi.is 未返回");
  if (PURE_ON && !ipure) warn.push("IPPure 未返回");

  const basic = buildBasic(egressIP, ipApi, ipapiIs, ipure);
  const pure = buildPure(ipure);
  const risks = buildRisks(ipApi, ipapiIs, ipure);
  const block = BLOCK_ON
    ? buildBlockReport({
        nodeOk: true,
        directOk: direct.ok === null ? null : !!direct.ok,
        remote: remote,
        gp: null,
        nodeIp: displayIP(egressIP),
        nodeLoc: basic.region || basic.city || "",
      })
    : null;

  const theme = resultTheme(basic, risks, pure);
  renderAll(basic, risks, pure, block, theme);
}

// ── 读取长按节点 ─────────────────────────────────────────

function readUINode() {
  try {
    if (typeof $environment === "undefined" || $environment.params == null) {
      return "";
    }
    const p = $environment.params;
    if (typeof p === "string") return clean(p);
    if (typeof p === "object") {
      // 兼容偶发对象形态
      return clean(p.node || p.policy || p.name || p.tag || "");
    }
    return clean(String(p));
  } catch (e) {
    return "";
  }
}

// ── 出口 / 纯净 / 阻断 ───────────────────────────────────

async function discoverIP() {
  const probes = [
    function () {
      return fetchJson("https://api4.ipify.org?format=json", {
        mode: "node",
      }).then(function (j) {
        return j && j.ip;
      });
    },
    function () {
      return fetchJson(IP_API_BASE + "?lang=zh-CN&fields=status,query", {
        mode: "node",
      }).then(function (j) {
        return j && j.status === "success" && j.query;
      });
    },
    function () {
      return fetchText("https://ipv4.icanhazip.com/", { mode: "node" }).then(
        function (t) {
          return t && String(t).trim();
        }
      );
    },
  ];

  const settled = await Promise.all(
    probes.map(function (run, idx) {
      return run()
        .then(function (v) {
          return { name: "p" + idx, ip: normalizeIP(v) };
        })
        .catch(function (e) {
          log("probe " + idx + ": " + err(e));
          return { name: "p" + idx, ip: "" };
        });
    })
  );

  const valid = settled.filter(function (r) {
    return r.ip;
  });
  if (!valid.length) return "";

  const counts = {};
  valid.forEach(function (r) {
    counts[r.ip] = (counts[r.ip] || 0) + 1;
  });
  const ranked = Object.keys(counts).sort(function (a, b) {
    return counts[b] - counts[a];
  });
  if (ranked.length > 1) {
    warn.push(
      "出口不一致: " +
        valid
          .map(function (r) {
            return r.name + "=" + r.ip;
          })
          .join(", ")
    );
  }
  return ranked[0];
}

function fetchIPPure() {
  return fetchJson(IPPURE_URL, { mode: "node" }).then(function (data) {
    if (!data || typeof data !== "object") throw new Error("IPPure 空响应");
    return data;
  });
}

function checkDirectNet() {
  return fetchJson(IP_API_BASE + "?lang=zh-CN&fields=status,query", {
    mode: "direct",
  })
    .then(function (j) {
      return { ok: !!(j && j.status === "success") };
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
      // 兼容 Promise / 同步返回
      if (ret && typeof ret.then === "function") {
        ret.then(
          function (msg) {
            resolve(parseHostPort(msg, tag));
          },
          function () {
            resolve(null);
          }
        );
      } else {
        resolve(parseHostPort(ret, tag));
      }
    } catch (e) {
      log("getServerHostPort: " + err(e));
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
    const hp = comma < 0 ? after : after.substring(0, comma);
    const colon = hp.lastIndexOf(":");
    if (colon < 0) return null;
    const host = hp.substring(0, colon).trim();
    const port = hp.substring(colon + 1).trim();
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
      "&max_nodes=6",
    { mode: "direct" }
  );
  if (!submit || !submit.ok || !submit.request_id) {
    return { ok: false, error: "提交失败", items: [] };
  }
  await sleep(3000);
  const res = await fetchJson(CHECK_HOST + "/check-result/" + submit.request_id, {
    mode: "direct",
  });
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
    items.push({ flag: flag, ms: ms });
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
      limit: 8,
    }),
  });
  if (!created || !created.id) return null;
  await sleep(5000);
  return fetchJson(GP_API + "/" + created.id, {
    mode: "direct",
    headers: { Accept: "application/json", "User-Agent": UA },
  });
}

// ── 数据组装 ─────────────────────────────────────────────

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
  const hosting =
    !!(okApi && okApi.hosting) ||
    !!(ipapiIs && (ipapiIs.is_datacenter || ipapiIs.is_hosting));
  const mobile = !!(okApi && okApi.mobile) || !!(ipapiIs && ipapiIs.is_mobile);
  const proxyLike =
    !!(okApi && okApi.proxy) ||
    !!(ipapiIs && (ipapiIs.is_proxy || ipapiIs.is_vpn || ipapiIs.is_tor));
  if (hosting) return "机房 IP · 服务器/数据中心，一般不是家用宽带";
  if (mobile) return "移动 IP · 手机/蜂窝流量网络";
  if (proxyLike) return "代理特征 · 库标记像代理/VPN（仅供参考）";
  if (okApi || ipapiIs) {
    return "家宽倾向 · 未检出机房/移动标记（不等于已认证住宅）";
  }
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
    out.push(
      riskItem(
        s > 75 ? "bad" : s > 50 ? "warn" : "ok",
        "IPPure　欺诈值 " +
          s +
          " · " +
          (s <= 25 ? "低" : s <= 50 ? "中" : s <= 75 ? "高" : "极高") +
          "风险"
      )
    );
  }
  const okApi = ipApi && ipApi.status === "success" ? ipApi : null;
  if (okApi) {
    const flags = [];
    if (okApi.proxy) flags.push("代理");
    if (okApi.hosting) flags.push("托管");
    if (okApi.mobile) flags.push("移动");
    out.push(
      flags.length
        ? riskItem("warn", "ip-api　命中 " + flags.join("、"))
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
    out.push(
      flags.length
        ? riskItem("warn", "ipapi.is　命中 " + flags.join("、"))
        : riskItem("ok", "ipapi.is　无风险标记")
    );
  }
  return out;
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
  } else if (nodeOk && (rOk || remote == null)) {
    conclusion = rOk === false
      ? "⚠️ 节点可代理，但服务端口远端探测失败"
      : "✅ 节点正常";
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
      city: cnCity(r.probe.city),
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
  if (n.indexOf("unicom") >= 0) return "中国联通";
  if (n.indexOf("chinanet") >= 0 || n.indexOf("telecom") >= 0) return "中国电信";
  if (n.indexOf("mobile") >= 0) return "中国移动";
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
  };
  return map[en] || en || "";
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
    lines.push("🔗 连通 / 阻断");
    lines.push("　节点代理　" + (block.nodeOk ? "✅ 正常" : "❌ 不可达"));
    if (block.directOk !== null) {
      lines.push("　本机网络　" + (block.directOk ? "✅ 正常" : "❌ 异常"));
    }
    if (block.remoteOk !== null) {
      lines.push("　远端探测　" + (block.remoteOk ? "✅ 可达" : "❌ 不可达"));
      if (block.remoteItems.length) {
        lines.push(
          "　" +
            block.remoteItems
              .slice(0, 6)
              .map(function (it) {
                return it.flag + " " + it.ms;
              })
              .join("  ")
        );
      } else if (block.remoteError) {
        lines.push("　" + block.remoteError);
      }
    }
    lines.push("　结论　" + block.conclusion);
  }

  if (warn.length) {
    lines.push("");
    lines.push("💡 提示");
    warn.slice(0, 5).forEach(function (w) {
      lines.push("　⚠️ " + w);
    });
  }

  const title = theme.titleEmoji + " 节点 IP 质量检测";
  const subtitle = POLICY || "默认路由";
  const body = lines.join("\n");
  const html = buildResultHtml(basic, risks, pure, block, warn, theme);
  doneOK(title, subtitle, body, html, theme);
}

function renderFailureWithBlock(block) {
  lines.push("🔗 连通 / 阻断");
  lines.push("　节点代理　❌ 不可达");
  if (block.directOk !== null) {
    lines.push("　本机网络　" + (block.directOk ? "✅ 正常" : "❌ 异常"));
  }
  if (block.remoteOk !== null) {
    lines.push("　远端探测　" + (block.remoteOk ? "✅ 可达" : "❌ 不可达"));
  }
  lines.push("　结论　" + block.conclusion);
  if (POLICY) lines.push("📡 节点　" + POLICY);

  const title = "🌐 节点 IP 质量检测";
  const body = lines.join("\n");
  const html =
    '<div style="font-family:-apple-system;font-size:14px;line-height:1.45;text-align:left">' +
    htmlSection("🔗 连通 / 阻断") +
    htmlBlockSection(block) +
    (POLICY ? htmlRow("📡", "节点", POLICY) : "") +
    "</div>";
  doneOK(title, POLICY || "失败", body, html, {
    sfSymbol: "exclamationmark.triangle.fill",
    color: "#FF453A",
  });
}

function riskItem(level, text) {
  return {
    level: level,
    text: text,
    icon: level === "bad" ? "🔴" : level === "warn" ? "🟠" : "🟢",
  };
}

function resultTheme(basic, risks, pure) {
  const nature = (basic && basic.nature) || "";
  const hasWarn = (risks || []).some(function (r) {
    return r.level === "warn" || r.level === "bad";
  });
  if (pure && pure.levelKey === "critical") {
    return {
      titleEmoji: "‼️",
      natureEmoji: "🖥️",
      sfSymbol: "xmark.shield.fill",
      color: "#FF453A",
      badge: "极高风险",
    };
  }
  if (pure && pure.isResidential === true) {
    return {
      titleEmoji: "🏠",
      natureEmoji: "🏠",
      sfSymbol: "house.fill",
      color: "#30D158",
      badge: pure.isBroadcast ? "住宅·广播" : "住宅",
    };
  }
  if (pure && pure.isResidential === false) {
    return {
      titleEmoji: "🖥️",
      natureEmoji: "🖥️",
      sfSymbol: "server.rack",
      color: "#FF9F0A",
      badge: "机房",
    };
  }
  if (nature.indexOf("机房") >= 0) {
    return {
      titleEmoji: "🖥️",
      natureEmoji: "🖥️",
      sfSymbol: "server.rack",
      color: "#FF9F0A",
      badge: "机房",
    };
  }
  if (nature.indexOf("家宽") >= 0 || nature.indexOf("住宅") >= 0) {
    return {
      titleEmoji: "🏠",
      natureEmoji: "🏠",
      sfSymbol: "house.fill",
      color: "#30D158",
      badge: "家宽倾向",
    };
  }
  if (hasWarn) {
    return {
      titleEmoji: "🛡️",
      natureEmoji: "🕵️",
      sfSymbol: "network.badge.shield.half.filled",
      color: "#FF9F0A",
      badge: "关注",
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

function buildResultHtml(basic, risks, pure, block, warnings, theme) {
  const rows = [];
  rows.push(htmlHero(displayIP(basic.ip), theme));
  if (basic.nature) rows.push(htmlRow("🏷️", "类型", basic.nature, theme.color));
  if (basic.region) rows.push(htmlRegionRow(basic));
  if (basic.city) rows.push(htmlRow("🏙️", "城市", basic.city));
  if (basic.asn) rows.push(htmlRow("🔢", "ASN", basic.asn));
  if (basic.org) rows.push(htmlRow("🏢", "组织", basic.org));
  if (basic.timezone) rows.push(htmlRow("🕐", "时区", basic.timezone));
  if (POLICY) rows.push(htmlRow("📡", FROM_UI ? "节点" : "策略", POLICY));

  if (pure) {
    rows.push(htmlSection("✨ IPPure 纯净度"));
    rows.push(htmlRow("🏠", "网络类型", pure.type));
    if (pure.score !== null) {
      const c =
        pure.levelKey === "low"
          ? "#30D158"
          : pure.levelKey === "mid"
            ? "#FFD60A"
            : pure.levelKey === "high"
              ? "#FF9F0A"
              : "#FF453A";
      rows.push(
        htmlRow("📊", "欺诈值", pure.score + " 分 · " + pure.level, c)
      );
    }
  }

  rows.push(htmlSection("🛡️ 风险"));
  if (risks && risks.length) {
    risks.forEach(function (r) {
      rows.push(htmlRiskLine(r));
    });
  } else {
    rows.push(htmlMuted("⚪ 本次无可用标记"));
  }

  if (block) {
    rows.push(htmlSection("🔗 连通 / 阻断"));
    rows.push(htmlBlockSection(block));
  }

  if (warnings && warnings.length) {
    rows.push(htmlSection("💡 提示"));
    warnings.slice(0, 5).forEach(function (w) {
      rows.push(htmlMuted("⚠️ " + w));
    });
  }

  return (
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica;font-size:14px;line-height:1.45;text-align:left;color:#1c1c1e">' +
    rows.join("") +
    "</div>"
  );
}

function htmlBlockSection(block) {
  const parts = [];
  parts.push(
    htmlKV(
      "节点代理",
      block.nodeOk ? "✅ 正常" : "❌ 不可达",
      block.nodeOk ? "#30D158" : "#FF453A"
    )
  );
  if (block.nodeOk && block.nodeIp) {
    parts.push(
      htmlMuted(
        "IP " +
          block.nodeIp +
          (block.nodeLoc ? " · " + block.nodeLoc : "")
      )
    );
  }
  if (block.directOk !== null) {
    parts.push(
      htmlKV(
        "本机网络",
        block.directOk ? "✅ 正常" : "❌ 异常",
        block.directOk ? "#30D158" : "#FF453A"
      )
    );
  }
  if (block.remoteOk !== null) {
    parts.push(
      htmlKV(
        "远端探测",
        block.remoteOk ? "✅ 可达" : "❌ 不可达",
        block.remoteOk ? "#30D158" : "#FF453A"
      )
    );
    if (block.remoteItems && block.remoteItems.length) {
      let grid = "";
      for (let i = 0; i < Math.min(block.remoteItems.length, 8); i += 2) {
        const a = block.remoteItems[i];
        const b = block.remoteItems[i + 1];
        grid +=
          '<div style="font-size:12px;font-family:Menlo,monospace;margin:2px 0">' +
          escapeHtml(a.flag + " " + a.ms);
        if (b) grid += "&emsp;" + escapeHtml(b.flag + " " + b.ms);
        grid += "</div>";
      }
      parts.push(grid);
    } else if (block.remoteError) {
      parts.push(htmlMuted(block.remoteError));
    }
  }
  parts.push(
    '<div style="margin-top:10px;padding:10px 12px;border-radius:10px;background:#f2f2f7;font-weight:700;line-height:1.4">' +
      escapeHtml(block.conclusion) +
      "</div>"
  );
  return parts.join("");
}

function htmlHero(ip, theme) {
  return (
    '<div style="margin:0 0 14px 0;padding:12px 14px;border-radius:12px;background:linear-gradient(135deg,' +
    theme.color +
    "22," +
    theme.color +
    "08);border:1px solid " +
    theme.color +
    '33">' +
    '<div style="font-size:11px;color:' +
    theme.color +
    ';font-weight:700">' +
    escapeHtml((theme.titleEmoji || "🌐") + " " + (theme.badge || "")) +
    "</div>" +
    '<div style="margin-top:4px;font-size:22px;font-weight:800;line-height:1.2">' +
    escapeHtml(ip) +
    "</div></div>"
  );
}

function htmlRow(emoji, label, value, accent) {
  const valueColor = accent || "#1c1c1e";
  return (
    '<div style="margin:0 0 10px 0">' +
    '<div style="font-size:11px;color:#8e8e93">' +
    escapeHtml(emoji + " " + label) +
    "</div>" +
    '<div style="margin-top:2px;font-size:14px;font-weight:600;color:' +
    valueColor +
    ';word-break:break-word">' +
    escapeHtml(value) +
    "</div></div>"
  );
}

function htmlKV(label, value, color) {
  return (
    '<div style="margin:0 0 8px 0;font-size:13px">' +
    '<span style="color:#8e8e93;font-weight:600">' +
    escapeHtml(label) +
    "</span>　" +
    '<span style="font-weight:700;color:' +
    (color || "#1c1c1e") +
    '">' +
    escapeHtml(value) +
    "</span></div>"
  );
}

function htmlSection(title) {
  return (
    '<div style="margin:14px 0 8px 0;padding-top:10px;border-top:1px solid #e5e5ea;font-size:12px;font-weight:700;color:#8e8e93">' +
    escapeHtml(title) +
    "</div>"
  );
}

function htmlRiskLine(risk) {
  const color =
    risk.level === "bad"
      ? "#FF453A"
      : risk.level === "warn"
        ? "#FF9F0A"
        : "#30D158";
  return (
    '<div style="margin:0 0 8px 0;font-size:13px;line-height:1.4">' +
    '<span style="color:' +
    color +
    '">' +
    escapeHtml(risk.icon) +
    "</span> " +
    '<span style="font-weight:600">' +
    escapeHtml(risk.text) +
    "</span></div>"
  );
}

function htmlMuted(text) {
  return (
    '<div style="margin:0 0 8px 0;font-size:12px;color:#8e8e93;line-height:1.4">' +
    escapeHtml(text) +
    "</div>"
  );
}

function htmlRegionRow(basic) {
  const img = basic.flagImg
    ? '<img src="' +
      escapeHtml(basic.flagImg) +
      '" width="22" height="16" alt="" style="vertical-align:-2px;margin-right:6px;border-radius:2px" />'
    : "";
  const emoji = basic.flagEmoji ? escapeHtml(basic.flagEmoji) + " " : "";
  const text = String(basic.region || "")
    .replace(/^(?:\uD83C[\uDDE6-\uDDFF]){2}\s*/g, "")
    .trim();
  return (
    '<div style="margin:0 0 10px 0">' +
    '<div style="font-size:11px;color:#8e8e93">📍 地区</div>' +
    '<div style="margin-top:2px;font-size:14px;font-weight:600;line-height:1.35">' +
    img +
    emoji +
    escapeHtml(text) +
    "</div></div>"
  );
}

// ── HTTP（兼容 QX）──────────────────────────────────────

function fetchJson(url, options) {
  return fetchRaw(url, options).then(function (r) {
    try {
      return JSON.parse(r.body || "");
    } catch (e) {
      throw new Error("JSON 解析失败");
    }
  });
}

function fetchText(url, options) {
  return fetchRaw(url, options).then(function (r) {
    return String(r.body || "");
  });
}

/**
 * mode:
 *   "node"   → 绑 POLICY（长按节点）
 *   "direct" → 尝试 direct；失败则不带 policy 重试
 *   "auto"   → 不绑策略
 */
function fetchRaw(url, options) {
  const opt = options || {};
  const mode = opt.mode || "node";

  function once(usePolicy) {
    return new Promise(function (resolve, reject) {
      const req = {
        url: url,
        method: String(opt.method || "GET").toUpperCase(),
        headers: opt.headers || { "User-Agent": UA },
      };
      if (opt.body != null) req.body = opt.body;
      if (usePolicy) req.opts = { policy: usePolicy };

      $task.fetch(req).then(
        function (resp) {
          const statusCode = Number(resp.statusCode);
          if (
            !opt.allowError &&
            (!isFinite(statusCode) || statusCode < 200 || statusCode >= 300)
          ) {
            reject(new Error("HTTP " + (statusCode || "?")));
            return;
          }
          resolve({
            statusCode: statusCode,
            body: String(resp.body || ""),
            headers: resp.headers || {},
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
    if (POLICY) return once(POLICY);
    return once(null);
  }
  if (mode === "direct") {
    // 部分版本 policy:direct 异常，失败则无 policy 重试
    return once("direct").catch(function () {
      return once(null);
    });
  }
  return once(null);
}

// ── 工具 ─────────────────────────────────────────────────

function safe(promise, fallback) {
  return Promise.resolve(promise).catch(function (e) {
    log("safe: " + err(e));
    return fallback;
  });
}

function withTimeout(promise, ms, fallback) {
  return new Promise(function (resolve) {
    let done = false;
    const timer = setTimeout(function () {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, ms);
    Promise.resolve(promise).then(
      function (v) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      function () {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      }
    );
  });
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
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
        try {
          out[decodeURIComponent(pair)] = "1";
        } catch (e) {
          out[pair] = "1";
        }
        return;
      }
      let k = pair.slice(0, i).trim();
      let v = pair.slice(i + 1).trim();
      try {
        k = decodeURIComponent(k);
        v = decodeURIComponent(v);
      } catch (e) {}
      if (k) out[k] = v;
    });
  return out;
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
      return /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255;
    })
  ) {
    return text;
  }
  return "";
}

function displayIP(ip) {
  if (!MASK_IP) return ip;
  const parts = String(ip).split(".");
  if (parts.length !== 4) return ip;
  return parts[0] + "." + parts[1] + ".*.*";
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
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
  const n = String(country || "");
  if (c === "TW" || c === "TWN") return true;
  return /taiwan|twn|台灣|台湾|臺湾|中华民国|中華民國|taipei|台北|臺北/i.test(
    n
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
    if (emoji === "🇹🇼") return "🇨🇳";
    return emoji;
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
      '<div style="font-family:-apple-system;padding:12px">' +
        escapeHtml(body || "完成") +
        "</div>",
  };
  if (theme && theme.sfSymbol) payload.icon = theme.sfSymbol;
  if (theme && theme.color) payload["icon-color"] = theme.color;
  $done(payload);
}

function fail(message) {
  if (finished) return;
  finished = true;
  const title = "⚠️ 节点 IP 质量检测";
  const msg = String(message || "未知错误");
  try {
    $notify(title, "失败", msg);
  } catch (e) {}
  $done({
    title: title,
    htmlMessage:
      '<div style="font-family:-apple-system;text-align:center;padding:12px">' +
      '<div style="font-size:32px">⚠️</div>' +
      '<div style="margin-top:10px;font-size:15px;font-weight:600;color:#FF453A;line-height:1.4">' +
      escapeHtml(msg) +
      "</div>" +
      '<div style="margin-top:12px;font-size:12px;color:#8e8e93;line-height:1.4">可尝试：长按节点运行 · 开启 Tunnel · argument=block=0</div>' +
      "</div>",
    icon: "exclamationmark.triangle.fill",
    "icon-color": "#FF453A",
  });
}
