/**
 * 节点 IP 质量检测 · Quantumult X
 *
 * 整合：
 * - 本仓库原有：出口 IP / 地区 ASN / 多源风险 / 图标面板
 * - IPPure 纯净度（参考 ddgksf2013 server-info-pure）
 * - 节点阻断诊断（参考 RavelloH block_check）
 *
 * 用法：长按节点 → 本脚本
 * 备选：argument=policy=节点名&mask=0&pure=1&block=1
 *
 * @Updated: 2026-07-20
 */

const VERSION = "2026-07-20.qx4";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1";
const IPPURE_URL = "https://my.ippure.com/v1/info";
const IP_API = "http://ip-api.com/json?lang=zh-CN";
const CHECK_HOST = "https://check-host.net";
const GP_API = "https://api.globalping.io/v1/measurements";
const TIMEOUT = 8000;

const envVars =
  typeof $environment !== "undefined" && $environment.variables
    ? $environment.variables
    : {};
const argRaw =
  typeof $argument !== "undefined" && $argument !== null ? String($argument) : "";
const args = Object.assign({}, envVars, parseArgument(argRaw));

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
const PURE_ON = isTruthy(args.pure, true);
const BLOCK_ON = isTruthy(args.block, true);

const lines = [];
const warn = [];

(async () => {
  log(`start ${VERSION} policy=${POLICY || "(默认)"} pure=${PURE_ON} block=${BLOCK_ON}`);

  if (!POLICY) {
    warn.push(
      "未指定节点：测的是当前默认路由。请长按目标节点，或 argument=policy=完整节点名"
    );
  }

  // 并行：出口 IP、IPPure、本机直连、节点 host:port
  const [ip, ipure, direct, serverEP] = await Promise.all([
    discoverIP().catch((e) => {
      warn.push(`出口探测: ${err(e)}`);
      return "";
    }),
    PURE_ON
      ? fetchIPPure().catch((e) => {
          warn.push(`IPPure: ${err(e)}`);
          return null;
        })
      : Promise.resolve(null),
    BLOCK_ON
      ? checkDirectNet().catch(() => ({ ok: false }))
      : Promise.resolve({ ok: null }),
    BLOCK_ON && POLICY
      ? getServerHostPort(POLICY).catch(() => null)
      : Promise.resolve(null),
  ]);

  // IPPure 也可作为出口 IP 兜底
  const egressIP = ip || normalizeIP(ipure && ipure.ip) || "";
  const nodeOk = !!egressIP;

  if (!egressIP) {
    // 仍尝试出阻断结论（节点完全不通）
    if (BLOCK_ON && POLICY) {
      const remote = serverEP
        ? await checkHostRemote(serverEP.host, serverEP.port).catch(() => ({
            ok: false,
            error: "远端探测失败",
          }))
        : { ok: false, error: "无节点地址" };
      let gp = null;
      if (direct.ok && remote.ok && serverEP) {
        gp = await runGlobalping(serverEP.host, serverEP.port).catch(() => null);
      }
      const block = buildBlockReport({
        nodeOk: false,
        directOk: !!direct.ok,
        remote,
        gp,
        nodeIp: "",
        nodeLoc: "",
        nodeIsp: "",
      });
      finishWithBlockOnly(block);
      return;
    }
    fail(
      POLICY
        ? `无法经「${POLICY}」获取出口 IP（节点名是否一致？Tunnel 是否开启？）`
        : "无法获取出口 IP（请检查网络 / Tunnel）"
    );
    return;
  }

  // 并行：详情库 + 远端 TCP（可选）
  const [ipApi, ipapiIs, remote] = await Promise.all([
    fetchJson(
      `http://ip-api.com/json/${egressIP}?lang=zh-CN&fields=status,message,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,asname,mobile,proxy,hosting,query`,
      { direct: true, timeout: TIMEOUT }
    ).catch((e) => {
      warn.push(`ip-api: ${err(e)}`);
      return null;
    }),
    fetchJson(`https://api.ipapi.is/?q=${encodeURIComponent(egressIP)}`, {
      direct: true,
      timeout: TIMEOUT,
    }).catch((e) => {
      warn.push(`ipapi.is: ${err(e)}`);
      return null;
    }),
    BLOCK_ON && serverEP
      ? checkHostRemote(serverEP.host, serverEP.port).catch(() => ({
          ok: false,
          error: "远端探测失败",
        }))
      : Promise.resolve(null),
  ]);

  let gp = null;
  if (
    BLOCK_ON &&
    !nodeOk === false &&
    direct.ok &&
    remote &&
    remote.ok &&
    !nodeOk
  ) {
    // unreachable - nodeOk is true here
  }
  // 节点代理失败且远端可达 → 国内运营商定位（与 block_check 一致）
  // 此处 nodeOk 为 true；若将来 discover 与连通性分离再启用
  // 补充：若出口 IP 拿到了但用户仍关心阻断，仅在「节点探测失败」路径走 GP
  // 当 remote 失败且 node 成功：节点正常

  // 若 IP 获取成功但我们想在「代理请求失败」场景走 GP——discover 已成功即代理通
  // 阻断脚本的 node 失败指 ip-api via policy 失败；我们用 nodeOk=!!egressIP

  if (BLOCK_ON && !nodeOk && direct.ok && remote && remote.ok && serverEP) {
    gp = await runGlobalping(serverEP.host, serverEP.port).catch(() => null);
  }

  const basic = buildBasic(egressIP, ipApi, ipapiIs, ipure);
  const risks = buildRisks(ipApi, ipapiIs, ipure);
  const pure = buildPure(ipure);
  const block = BLOCK_ON
    ? buildBlockReport({
        nodeOk: true,
        directOk: direct.ok === null ? null : !!direct.ok,
        remote,
        gp,
        nodeIp: displayIP(egressIP),
        nodeLoc: basic.region || basic.city || "",
        nodeIsp: basic.org || "",
      })
    : null;

  const theme = resultTheme(basic, risks, pure);
  renderAll(basic, risks, pure, block, theme);
})().catch((e) => {
  fail(`异常: ${err(e)}`);
});

// ── 出口 / 纯净 / 阻断 ───────────────────────────────────

async function discoverIP() {
  const probes = [
    {
      name: "ipify",
      run: () =>
        fetchJson("https://api4.ipify.org?format=json", { timeout: 6000 }).then(
          (j) => j && j.ip
        ),
    },
    {
      name: "ip-api",
      run: () =>
        fetchJson(`${IP_API}&fields=status,query`, { timeout: 6000 }).then(
          (j) => j && j.status === "success" && j.query
        ),
    },
    {
      name: "icanhazip",
      run: () =>
        fetchText("https://ipv4.icanhazip.com/", { timeout: 6000 }).then(
          (t) => t && t.trim()
        ),
    },
  ];

  const results = await Promise.all(
    probes.map((p) =>
      p
        .run()
        .then((v) => ({ name: p.name, ip: normalizeIP(v) }))
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

/** IPPure：走节点出口探测纯净度（server-info-pure） */
async function fetchIPPure() {
  const data = await fetchJson(IPPURE_URL, {
    timeout: 5000,
    headers: { "User-Agent": UA },
  });
  if (!data || typeof data !== "object") throw new Error("空响应");
  return data;
}

/** 本机直连是否正常（block_check） */
async function checkDirectNet() {
  try {
    const j = await fetchJson(`${IP_API}&fields=status,query`, {
      direct: true,
      timeout: TIMEOUT,
      forceNoPolicy: true,
    });
    return { ok: !!(j && j.status === "success") };
  } catch (_) {
    return { ok: false };
  }
}

/** 从 QX 取节点 server host:port */
function getServerHostPort(tag) {
  return new Promise((resolve) => {
    if (
      !tag ||
      typeof $configuration === "undefined" ||
      typeof $configuration.sendMessage !== "function"
    ) {
      resolve(null);
      return;
    }
    $configuration
      .sendMessage({ action: "get_server_description", content: tag })
      .then(
        (msg) => {
          try {
            const desc =
              msg && msg.ret && msg.ret[tag] ? String(msg.ret[tag]) : "";
            const eq = desc.indexOf("=");
            if (eq < 0) {
              resolve(null);
              return;
            }
            const after = desc.slice(eq + 1);
            const comma = after.indexOf(",");
            const hp = comma < 0 ? after : after.slice(0, comma);
            const colon = hp.lastIndexOf(":");
            if (colon < 0) {
              resolve(null);
              return;
            }
            const host = hp.slice(0, colon).trim();
            const port = hp.slice(colon + 1).trim();
            if (!host || !port) {
              resolve(null);
              return;
            }
            resolve({ host, port });
          } catch (_) {
            resolve(null);
          }
        },
        () => resolve(null)
      );
  });
}

/** check-host.net 远端 TCP */
async function checkHostRemote(host, port) {
  const target = `${host}:${port}`;
  const submit = await fetchJson(
    `${CHECK_HOST}/check-tcp?host=${encodeURIComponent(target)}&max_nodes=10`,
    {
      direct: true,
      forceNoPolicy: true,
      timeout: TIMEOUT,
      headers: { Accept: "application/json", "User-Agent": UA },
    }
  );
  if (!submit || !submit.ok || !submit.request_id) {
    return { ok: false, error: "提交失败", items: [] };
  }
  const rid = submit.request_id;
  const nodeList = submit.nodes || {};
  const nodeNames = Object.keys(nodeList);
  const countryMap = {};
  nodeNames.forEach((n) => {
    const info = nodeList[n];
    if (info && info.length >= 1) countryMap[n] = info[0];
  });

  await sleep(3500);

  const res = await fetchJson(`${CHECK_HOST}/check-result/${rid}`, {
    direct: true,
    forceNoPolicy: true,
    timeout: TIMEOUT,
    headers: { Accept: "application/json", "User-Agent": UA },
  });

  let reachable = false;
  const items = [];
  nodeNames.forEach((n) => {
    const cc = countryMap[n] || "";
    const flag = cc ? flagsEmoji(cc) || "🌍" : "🌍";
    const nr = res && res[n];
    let ms = "--.--ms";
    if (nr && Array.isArray(nr) && nr.length > 0 && nr[0].time !== undefined) {
      reachable = true;
      ms = formatMs(nr[0].time * 1000);
    }
    items.push({ flag, ms, ok: ms !== "--.--ms" });
  });
  return { ok: reachable, items, error: reachable ? "" : "远端不可达" };
}

/** Globalping 国内运营商探测（仅阻断嫌疑时） */
async function runGlobalping(host, port) {
  const body = {
    type: "ping",
    target: host,
    measurementOptions: { port: parseInt(port, 10), protocol: "TCP" },
    locations: [{ country: "CN", tags: ["eyeball-network"] }],
    limit: 12,
  };
  const created = await fetchJson(GP_API, {
    method: "POST",
    direct: true,
    forceNoPolicy: true,
    timeout: TIMEOUT,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
  });
  if (!created || !created.id) return null;
  await sleep(6000);
  return fetchJson(`${GP_API}/${created.id}`, {
    direct: true,
    forceNoPolicy: true,
    timeout: TIMEOUT,
    headers: { Accept: "application/json", "User-Agent": UA },
  });
}

// ── 组装展示数据 ─────────────────────────────────────────

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

  const asRaw =
    (ipure && ipure.asn ? String(ipure.asn) : "") ||
    clean(okApi && okApi.as) ||
    clean(asnObj.asn);
  const asn = asRaw
    ? String(asRaw).indexOf("AS") === 0
      ? String(asRaw)
      : `AS${asRaw}`
    : "";
  const org =
    clean(ipure && ipure.asOrganization) ||
    clean(okApi && (okApi.asname || okApi.org || okApi.isp)) ||
    clean(asnObj.org) ||
    clean(ipapiIs && ipapiIs.company && ipapiIs.company.name);

  const nature = classifyNature(okApi, ipapiIs, ipure);

  return {
    ip,
    nature,
    region: code
      ? `${flagEmoji} [${code}] ${country || ""}`.trim()
      : flagEmoji
        ? `${flagEmoji} ${country || ""}`.trim()
        : country,
    flagEmoji,
    flagImg: flagImageUrl(taiwan ? "CN" : code),
    city: cityParts.join(" · "),
    asn,
    org,
    timezone:
      clean(ipure && ipure.timezone) ||
      clean(okApi && okApi.timezone) ||
      clean(loc.timezone),
  };
}

function classifyNature(okApi, ipapiIs, ipure) {
  // IPPure 优先
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
  const mobile =
    !!(okApi && okApi.mobile) || !!(ipapiIs && ipapiIs.is_mobile);
  const proxyLike =
    !!(okApi && okApi.proxy) ||
    !!(ipapiIs && (ipapiIs.is_proxy || ipapiIs.is_vpn || ipapiIs.is_tor));
  const typeBits = [
    ipapiIs && ipapiIs.company && ipapiIs.company.type,
    ipapiIs && ipapiIs.asn && ipapiIs.asn.type,
  ]
    .map((x) => clean(x).toLowerCase())
    .filter(Boolean)
    .join(" ");

  if (hosting || /\b(hosting|data\s*center|datacenter|cdn)\b/.test(typeBits)) {
    return "机房 IP · 服务器/数据中心，一般不是家用宽带";
  }
  if (mobile || /\bmobile\b/.test(typeBits)) {
    return "移动 IP · 手机/蜂窝流量网络";
  }
  if (proxyLike) return "代理特征 · 库标记像代理/VPN（仅供参考）";
  if (/\b(isp|residential|education|government)\b/.test(typeBits)) {
    return "家宽倾向 · 更像宽带运营商线路（非机房）";
  }
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
  const type = ipure.isResidential
    ? ipure.isBroadcast
      ? "住宅 · 广播"
      : "住宅 · 原生倾向"
    : typeof ipure.isResidential === "boolean"
      ? "数据中心"
      : "未知";
  return {
    score: score === null ? null : score,
    level,
    levelKey,
    type,
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
        `IPPure　欺诈值 ${s} · ${s <= 25 ? "低" : s <= 50 ? "中" : s <= 75 ? "高" : "极高"}风险`
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
    const bad = flags.length > 0;
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

function buildBlockReport(ctx) {
  const { nodeOk, directOk, remote, gp, nodeIp, nodeLoc, nodeIsp } = ctx;
  const rOk = remote && remote.ok;
  const items = (remote && remote.items) || [];

  let conclusion = "❓ 数据不完整";
  let conclusionKey = "unknown";
  let gpAnalysis = null;

  if (directOk === false) {
    conclusion = "⚠️ 本机网络异常";
    conclusionKey = "local";
  } else if (nodeOk && rOk) {
    conclusion = "✅ 节点正常";
    conclusionKey = "ok";
  } else if (nodeOk && remote === null) {
    conclusion = "✅ 节点代理可达（未做远端 TCP）";
    conclusionKey = "ok";
  } else if (nodeOk && !rOk) {
    conclusion = "⚠️ 节点可代理，但服务端口远端探测失败（或无地址信息）";
    conclusionKey = "warn";
  } else if (!nodeOk && rOk && directOk) {
    if (gp && gp.results) {
      gpAnalysis = analyzeBlockSource(gp);
      conclusion = gpAnalysis.conclusion;
      conclusionKey = "block";
    } else {
      conclusion = "🚫 疑似被运营商/GFW 阻断";
      conclusionKey = "block";
    }
  } else if (!nodeOk && !rOk && directOk) {
    conclusion = "💤 节点离线";
    conclusionKey = "offline";
  }

  return {
    nodeOk,
    directOk,
    remoteOk: remote === null ? null : !!rOk,
    remoteError: remote && remote.error ? remote.error : "",
    remoteItems: items,
    nodeIp,
    nodeLoc,
    nodeIsp,
    conclusion,
    conclusionKey,
    gpAnalysis,
  };
}

function analyzeBlockSource(gpData) {
  const results = gpData.results;
  if (!results) return null;
  const ispGroups = {};
  results.forEach((r) => {
    const isp = classifyISP(r.probe && r.probe.network);
    if (!isp) return;
    if (!ispGroups[isp]) ispGroups[isp] = { probes: [], reachable: false };
    const res = r.result || {};
    const stats = res.stats;
    let ok = false;
    let ms = "--.--ms";
    if (res.status === "finished" && stats) {
      ok = stats.rcv > 0;
      ms = ok ? formatMs(stats.avg || 0) : "--.--ms";
    }
    if (ok) ispGroups[isp].reachable = true;
    ispGroups[isp].probes.push({
      city: cnCity(r.probe.city),
      ok,
      ms,
    });
  });

  const reachableIsps = [];
  const blockedIsps = [];
  Object.keys(ispGroups).forEach((k) => {
    if (!ispGroups[k].probes.length) return;
    if (ispGroups[k].reachable) reachableIsps.push(k);
    else blockedIsps.push(k);
  });

  let conclusion;
  if (reachableIsps.length === 0) {
    conclusion = "🚫 GFW 全局阻断 — 国内三大运营商均无法访问";
  } else if (blockedIsps.length > 0) {
    conclusion =
      "🚫 运营商级拦截 — " +
      blockedIsps.join("、") +
      " 不可达，" +
      reachableIsps.join("、") +
      " 正常";
  } else {
    conclusion =
      "✅ 国内三大运营商全部可达，非 GFW/运营商拦截，请检查客户端配置";
  }
  return { ispGroups, conclusion };
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
    Kunming: "昆明",
    Hefei: "合肥",
    Ningbo: "宁波",
    Suzhou: "苏州",
    Harbin: "哈市",
    Changchun: "长春",
    Shenyang: "沈阳",
    Foshan: "佛山",
    Dongguan: "东莞",
  };
  return map[en] || en || "";
}

// ── 渲染 ─────────────────────────────────────────────────

function renderAll(basic, risks, pure, block, theme) {
  lines.push(`🌐 IP　${displayIP(basic.ip)}`);
  if (basic.nature) lines.push(`${theme.natureEmoji} 类型　${basic.nature}`);
  if (basic.region) lines.push(`📍 地区　${basic.region}`);
  if (basic.city) lines.push(`🏙️ 城市　${basic.city}`);
  if (basic.asn) lines.push(`🔢 ASN　${basic.asn}`);
  if (basic.org) lines.push(`🏢 组织　${basic.org}`);
  if (basic.timezone) lines.push(`🕐 时区　${basic.timezone}`);
  if (FROM_UI && POLICY) lines.push(`📡 节点　${POLICY}`);
  else if (POLICY) lines.push(`📡 策略　${POLICY}`);

  if (pure) {
    lines.push("");
    lines.push("✨ IPPure 纯净度");
    lines.push(`　类型　${pure.type}`);
    if (pure.score !== null) {
      lines.push(`　欺诈值　${pure.score} · ${pure.level}`);
    }
  }

  if (risks.length) {
    lines.push("");
    lines.push("🛡️ 风险");
    risks.forEach((r) => lines.push(`　${r.icon} ${r.text}`));
  }

  if (block) {
    lines.push("");
    lines.push("🔗 连通 / 阻断");
    lines.push(
      `　节点代理　${block.nodeOk ? "✅ 正常" : "❌ 不可达"}`
    );
    if (block.directOk !== null) {
      lines.push(
        `　本机网络　${block.directOk ? "✅ 正常" : "❌ 异常"}`
      );
    }
    if (block.remoteOk !== null) {
      lines.push(
        `　远端探测　${block.remoteOk ? "✅ 可达" : "❌ 不可达"}`
      );
      if (block.remoteItems && block.remoteItems.length) {
        const pair = block.remoteItems
          .slice(0, 6)
          .map((it) => `${it.flag} ${it.ms}`)
          .join("  ");
        lines.push(`　${pair}`);
      } else if (block.remoteError) {
        lines.push(`　${block.remoteError}`);
      }
    }
    lines.push(`　结论　${block.conclusion}`);
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
  const html = buildResultHtml(basic, risks, pure, block, warn, theme);

  $notify(title, subtitle, body);
  $done({
    title,
    htmlMessage: html,
    icon: theme.sfSymbol,
    "icon-color": theme.color,
  });
}

function finishWithBlockOnly(block) {
  lines.push("🔗 连通 / 阻断");
  lines.push(`　节点代理　❌ 不可达`);
  if (block.directOk !== null) {
    lines.push(
      `　本机网络　${block.directOk ? "✅ 正常" : "❌ 异常"}`
    );
  }
  if (block.remoteOk !== null) {
    lines.push(
      `　远端探测　${block.remoteOk ? "✅ 可达" : "❌ 不可达"}`
    );
    if (block.remoteItems && block.remoteItems.length) {
      lines.push(
        `　${block.remoteItems
          .slice(0, 6)
          .map((it) => `${it.flag} ${it.ms}`)
          .join("  ")}`
      );
    }
  }
  lines.push(`　结论　${block.conclusion}`);
  if (POLICY) lines.push(`📡 节点　${POLICY}`);

  const title = "🌐 节点 IP 质量检测";
  const body = lines.join("\n");
  const html =
    `<div style="font-family:-apple-system;font-size:14px;line-height:1.45;text-align:left">` +
    htmlSection("🔗 连通 / 阻断") +
    htmlBlockSection(block) +
    (POLICY ? htmlRow("📡", "节点", POLICY) : "") +
    `</div>`;

  $notify(title, POLICY || "失败", body);
  $done({
    title,
    htmlMessage: html,
    icon: "exclamationmark.triangle.fill",
    "icon-color": "#FF453A",
  });
}

function riskItem(level, text) {
  return {
    level,
    text,
    icon: level === "warn" ? "🟠" : level === "bad" ? "🔴" : "🟢",
  };
}

function resultTheme(basic, risks, pure) {
  const nature = (basic && basic.nature) || "";
  const hasWarn = (risks || []).some(
    (r) => r.level === "warn" || r.level === "bad"
  );
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
  if (nature.indexOf("移动") >= 0) {
    return {
      titleEmoji: "📱",
      natureEmoji: "📱",
      sfSymbol: "antenna.radiowaves.left.and.right",
      color: "#0A84FF",
      badge: "移动",
    };
  }
  if (hasWarn || nature.indexOf("代理") >= 0) {
    return {
      titleEmoji: "🛡️",
      natureEmoji: "🕵️",
      sfSymbol: "network.badge.shield.half.filled",
      color: "#FF9F0A",
      badge: "关注",
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
      rows.push(htmlRow("📊", "欺诈值", `${pure.score} 分 · ${pure.level}`, c));
    }
  }

  rows.push(htmlSection("🛡️ 风险"));
  if (risks && risks.length) {
    risks.forEach((r) => rows.push(htmlRiskLine(r)));
  } else {
    rows.push(htmlMuted("⚪ 本次无可用标记"));
  }

  if (block) {
    rows.push(htmlSection("🔗 连通 / 阻断"));
    rows.push(htmlBlockSection(block));
  }

  if (warnings && warnings.length) {
    rows.push(htmlSection("💡 提示"));
    warnings.slice(0, 5).forEach((w) => rows.push(htmlMuted(`⚠️ ${w}`)));
  }

  return (
    `<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica;font-size:14px;line-height:1.45;text-align:left;color:#1c1c1e">` +
    rows.join("") +
    `</div>`
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
    parts.push(htmlMuted(`IP ${block.nodeIp}${block.nodeLoc ? " · " + block.nodeLoc : ""}`));
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
      for (let i = 0; i < block.remoteItems.length; i += 2) {
        const a = block.remoteItems[i];
        const b = block.remoteItems[i + 1];
        grid += `<div style="font-size:12px;font-family:Menlo,monospace;margin:2px 0">${escapeHtml(a.flag + " " + a.ms)}`;
        if (b) grid += `&emsp;${escapeHtml(b.flag + " " + b.ms)}`;
        grid += `</div>`;
      }
      parts.push(grid);
    } else if (block.remoteError) {
      parts.push(htmlMuted(block.remoteError));
    }
  }

  if (block.gpAnalysis && block.gpAnalysis.ispGroups) {
    parts.push(htmlMuted("国内探测"));
    const order = ["中国电信", "中国联通", "中国移动"];
    const abbr = { 中国电信: "电信", 中国联通: "联通", 中国移动: "移动" };
    order.forEach((k) => {
      const g = block.gpAnalysis.ispGroups[k];
      if (!g) return;
      g.probes.forEach((p) => {
        const c = p.ok ? "#30D158" : "#FF453A";
        parts.push(
          `<div style="font-size:12px;margin:2px 0">${escapeHtml(abbr[k] + "·" + p.city)} <span style="color:${c};font-family:Menlo,monospace">${escapeHtml(p.ms)}</span></div>`
        );
      });
    });
  }

  parts.push(
    `<div style="margin-top:10px;padding:10px 12px;border-radius:10px;background:#f2f2f7;font-weight:700;line-height:1.4">${escapeHtml(block.conclusion)}</div>`
  );
  return parts.join("");
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

function htmlKV(label, value, color) {
  return (
    `<div style="margin:0 0 8px 0;font-size:13px">` +
    `<span style="color:#8e8e93;font-weight:600">${escapeHtml(label)}</span>　` +
    `<span style="font-weight:700;color:${color || "#1c1c1e"}">${escapeHtml(value)}</span>` +
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
    risk.level === "bad"
      ? "#FF453A"
      : risk.level === "warn"
        ? "#FF9F0A"
        : "#30D158";
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

function htmlRegionRow(basic) {
  const img = basic.flagImg
    ? `<img src="${escapeHtml(basic.flagImg)}" width="22" height="16" alt="" style="vertical-align:-2px;margin-right:6px;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,0.08)" />`
    : "";
  const emoji = basic.flagEmoji ? escapeHtml(basic.flagEmoji) + " " : "";
  const text = String(basic.region || "")
    .replace(/^(?:\uD83C[\uDDE6-\uDDFF]){2}\s*/g, "")
    .trim();
  return (
    `<div style="margin:0 0 10px 0">` +
    `<div style="font-size:11px;color:#8e8e93">📍 地区</div>` +
    `<div style="margin-top:2px;font-size:14px;font-weight:600;line-height:1.35;word-break:break-word">` +
    img +
    emoji +
    escapeHtml(text) +
    `</div></div>`
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
    timeout: numberOrNull(opt.timeout) !== null ? Number(opt.timeout) : TIMEOUT,
  };
  if (typeof opt.body !== "undefined") req.body = opt.body;

  // direct / forceNoPolicy → 官方 direct；否则绑长按节点 / argument 策略
  if (opt.forceNoPolicy || opt.direct) {
    req.opts = { policy: "direct" };
  } else if (POLICY) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function numberOrNull(value) {
  if (value === null || typeof value === "undefined" || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "0.00ms";
  if (n >= 10000) return Math.floor(n) + "ms";
  if (n >= 1000) return Math.floor(n) + "ms";
  if (n >= 100) return n.toFixed(1) + "ms";
  if (n >= 10) return n.toFixed(2) + "ms";
  return n.toFixed(3) + "ms";
}

function isTaiwanRegion(code, country) {
  const c = String(code || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  const n = String(country || "");
  if (c === "TW" || c === "TWN") return true;
  return /taiwan|twn|台灣|台湾|臺湾|中华民国|中華民國|taipei|台北|臺北/i.test(n);
}

function flagsEmoji(countryCode) {
  const code = String(countryCode || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (code.length !== 2) return "";
  if (code === "TW" || code === "CN") return "🇨🇳";
  const emoji = String.fromCodePoint(
    ...code.split("").map((ch) => 0x1f1a5 + ch.charCodeAt(0))
  );
  if (emoji === "🇹🇼") return "🇨🇳";
  return emoji;
}

function flagImageUrl(code) {
  const c = String(code || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (c.length !== 2) return "";
  const iso = c === "tw" ? "cn" : c;
  return `https://flagcdn.com/w40/${iso}.png`;
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
