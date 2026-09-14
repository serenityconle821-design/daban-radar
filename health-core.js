/* health-core.js v1.3.1 — 持仓体检引擎 (设计手册Problem 3落地)
   架构: Fetcher(并发≤4·指数退避) → Indicator(纯函数·与diag.js口径逐字一致) → Decider(三组分组+三档触发价) → MarketEnv(大盘联动)
   数据: 腾讯JSONP(K线/行情/搜索) + SITE_DATA快照(相位/市场分) + 上证K线实时(中轨判据)
   v1.3.1 [卖飞复盘修复·2026-09-14]: ①冰冷期reduce上移仅对结构性弱势生效, 9010/8515强结构且
           MA20上方豁免(原: 全员上移至现价×0.99, 强势股锚=MA20低于现价, 上移后=平盘即卖,
           回暖反弹日挂单必被扫飞) ②plan.up增回暖失效条款(高开>2%且量比>1.5/触涨停/放量破
           20日高 → 暂缓减仓改MA5移动止盈跟踪), 对冲退潮降档"只降不回" ③reduce指令明确
           "先减半仓+剩余半付认输线"双价格, 防整仓一次性卖飞 ④plan.note执行提示: 勿隔夜
           预挂死单, 挂单前看盘中量能区分"放量突破"与"冲高乏力"
   v1.3.0 [C档·复盘七步法第7步]: buildAction新增认输线quit_line+明日计划plan三条件
           (冲高/平开/破线·触发式退出), 复用体检链路不另建模块, 执行层不入行情模型
   v1.2.0: profitPct盈亏口径统一实时quote.price vs 用户成本(与市值/当日盈亏同源,
           数据源已验证quote.price==qfq收盘价, 但保险起见趋势判断仍用前复权自洽序列)
   v1.1.0: decideHolding新增野人两板块明确建议(bbAction/pdAction, 附MA5/MA10具体数值);
           buildAction主操作指令(动作+价格锚点), applyMarketEnv环境降档后同步重算
   声明: 规则化条件概率诊断, 非预测, 不构成投资建议
   注: 引擎函数为 diag.js 独立副本(零改动生产文件), 供 port.js / three.html 复用 */
(function () {
'use strict';

/* ═══════════ 工具 ═══════════ */
const R2 = (x) => Math.round(x * 100) / 100;
const fmtNum = (x, d) => Number(x).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtWan = (x) => (x >= 0 ? '+' : '') + fmtNum(x, 0) + '万';
const fmtYi = (x) => (x >= 0 ? '+' : '') + fmtNum(x, 2) + '亿';
const ARED = '#FF3B30', AGREEN = '#34C759', BLUE = '#007AFF', ORANGE = '#FF9500';
let cbSeq = 0;

/* 腾讯 JSONP (GBK): 与 diag.js 同口径 */
function tencent(url, varName, timeout) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.charset = 'gbk';
    s.src = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
    let iv = null, tm = null;
    const cleanup = () => { clearInterval(iv); clearTimeout(tm); delete window[varName]; s.remove(); };
    tm = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout || 9000);
    iv = setInterval(() => {
      if (window[varName] !== undefined) { const v = window[varName]; cleanup(); resolve(v); }
    }, 40);
    s.onerror = () => { cleanup(); reject(new Error('network')); };
    document.head.appendChild(s);
  });
}

/* 腾讯搜索: smartbox v_hint="mkt~code~name~拼音~type" */
async function searchStock(q) {
  const hint = await tencent('https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(q) + '&t=all', 'v_hint', 6000);
  const raw = String(hint || '').trim();
  if (!raw || raw === 'N') return [];
  return raw.split(';').filter(Boolean).map(seg => {
    const p = seg.split('~');
    if (p.length < 3) return null;
    const mkt = p[0], code = p[1];
    return {
      mkt, code, full: mkt + code,
      name: (p[2] || '').replace(/\s+/g, ''), type: p[4] || '',
      valid: /^\d{6}$/.test(code) && (p[4] || '').includes('GP'),
    };
  }).filter(x => x && x.valid);
}

/* 腾讯K线: 前复权 [date,open,close,high,low,vol] */
async function fetchKline(full, n) {
  const varName = 'kd_' + Math.random().toString(36).slice(2, 8);
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + full + ',day,,,' + n + ',qfq&_var=' + varName;
  const d = await tencent(url, varName);
  const rows = (d && d.data && d.data[full] && (d.data[full].qfqday || d.data[full].day)) || [];
  return rows.map(r => ({ d: r[0], o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5] }));
}

/* 腾讯实时行情: 名称/现价/昨收(与diag.js同字段) */
async function fetchQuote(full) {
  const v = await tencent('https://qt.gtimg.cn/q=' + full, 'v_' + full);
  const f = String(v).split('~');
  if (f.length < 50) throw new Error('quote fields');
  return {
    name: (f[1] || '').replace(/\s+/g, ''), code: f[2], price: +f[3], prevClose: +f[4], open: +f[5],
    pct: +f[32], high: +f[33], low: +f[34], volHand: +f[36], amtWan: +f[37],
    turnover: +f[38], pe: +f[39], ztPrice: +f[47], dtPrice: +f[48], volRatio: +f[49],
    floatMV: +f[44], totalMV: +f[45], time: f[30],
  };
}

/* ═══════════ Indicator: 指标层(纯函数, 口径=diag.js) ═══════════ */
/* MA序列 */
function maSeries(vals, win) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    out.push(i < win - 1 ? null : vals.slice(i - win + 1, i + 1).reduce((a, b) => a + b, 0) / win);
  }
  return out;
}
/* 布林序列: SMA20 ±2σ总体标准差 */
function bollSeries(vals, w, k) {
  const mid = [], up = [], low = [];
  for (let i = 0; i < vals.length; i++) {
    if (i < w - 1) { mid.push(null); up.push(null); low.push(null); continue; }
    const seg = vals.slice(i - w + 1, i + 1);
    const m = seg.reduce((a, b) => a + b, 0) / w;
    const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) * (b - m), 0) / w);
    mid.push(m); up.push(m + k * sd); low.push(m - k * sd);
  }
  return { mid, up, low };
}
/* 野人哥·多空四档 (与diag.js calcBullBear逐字一致: win20/vp/c vs MA20) */
function calcBullBear(k) {
  if (!k || k.length < 70) return null;
  const n = k.length;
  let ups = 0, volUp = 0, volDn = 0, nUp = 0, nDn = 0;
  for (let j = Math.max(1, n - 20); j < n; j++) {
    if (k[j].c > k[j - 1].c) { ups++; volUp += k[j].v; nUp++; }
    else { volDn += k[j].v; nDn++; }
  }
  const win20 = ups / 20;
  const vp = (nUp && nDn && volDn > 0) ? (volUp / nUp) / (volDn / nDn) : 1;
  const ma20 = k.slice(-20).reduce((a, r) => a + r.c, 0) / 20;
  const c = k[n - 1].c;
  let tier, label, mode;
  if (win20 >= 0.65 && vp >= 1.2 && c > ma20) {
    tier = '9010'; label = '极强单边'; mode = '龙头/连板持有为主，趋势跟随';
  } else if (win20 >= 0.55 && c > ma20) {
    tier = '8515'; label = '强趋势'; mode = '超短趋势/回撤做T';
  } else if (win20 >= 0.45) {
    tier = '8020'; label = '多空拉扯'; mode = '极限拉扯/低吸战法区间，打板接力慎入';
  } else {
    tier = '7030'; label = '分歧显著'; mode = '谨慎低吸/观望为主';
  }
  return { tier, label, mode, win20, vp, c, ma20, above: c > ma20, ups };
}
/* 野人哥·物理距离低系数 (与diag.js calcPdLow逐字一致) */
function calcPdLow(k) {
  if (!k || k.length < 65) return null;
  let upDays = 0;
  for (let j = Math.max(1, k.length - 20); j < k.length; j++) {
    if (k[j].c > k[j - 1].c) upDays++;
  }
  const v5 = k.slice(-5).reduce((a, r) => a + r.v, 0) / 5;
  const v60 = k.slice(-60).reduce((a, r) => a + r.v, 0) / 60;
  const vr560 = v60 > 0 ? v5 / v60 : 0;
  return { upDays, vr560: R2(vr560), noRight: upDays < 3, pileUp: vr560 > 1.5, hit: upDays < 3 && vr560 > 1.5 };
}

/* 持仓指标全集: 一次计算全部维度
   输入 k(75根K线), 返回 {ma5,ma10,ma20,ma60,bias,bbPos,bbUpper,bbLower,bbMid,
   volRatio5_60,range60,bullBear,pdLow,c} */
function computeIndicators(k) {
  const closes = k.map(r => r.c);
  const i = k.length - 1, c = k[i].c;
  const ma5 = maSeries(closes, 5), ma10 = maSeries(closes, 10), ma20 = maSeries(closes, 20), ma60 = maSeries(closes, 60);
  const boll = bollSeries(closes, 20, 2);
  const bbMid = boll.mid[i], bbUp = boll.up[i], bbLow = boll.low[i];
  /* 布林位置百分位: (c-lower)/(upper-lower), 越界截断 */
  let bbPos = null;
  if (bbMid != null && bbUp > bbLow) bbPos = Math.max(0, Math.min(1, (c - bbLow) / (bbUp - bbLow)));
  /* 60日区间位置 */
  const w60 = k.slice(-60);
  const hi60 = Math.max(...w60.map(r => r.h)), lo60 = Math.min(...w60.map(r => r.l));
  const range60 = hi60 > lo60 ? (c - lo60) / (hi60 - lo60) : 0.5;
  /* 量比 5日均量/60日均量 */
  const v5 = k.slice(-5).reduce((a, r) => a + r.v, 0) / 5;
  const v60 = k.slice(-60).reduce((a, r) => a + r.v, 0) / 60;
  const volRatio5_60 = v60 > 0 ? v5 / v60 : 1;
  /* 20日高点/低点(触发价锚定) */
  const w20 = k.slice(-21, -1);
  const hi20 = Math.max(...w20.map(r => r.h)), lo20 = Math.min(...w20.map(r => r.l));
  return {
    c, ma5: ma5[i], ma10: ma10[i], ma20: ma20[i], ma60: ma60[i],
    ma20prev5: ma20[i - 5], bias: ma20[i] ? (c / ma20[i] - 1) : null,
    bbPos, bbMid, bbUpper: bbUp, bbLower: bbLow,
    range60, hi60, lo60, hi20, lo20,
    volRatio5_60: R2(volRatio5_60),
    bullBear: calcBullBear(k), pdLow: calcPdLow(k),
    closeDate: k[i].d,
  };
}

/* ═══════════ Decider: 决策层(三组分组+三档触发价) ═══════════
   分组优先级: 锁定利润 > 反弹减仓 > 持有观察 (一只标的只进一组)
   - 锁定利润: 浮盈>10% 且 多空win20≥0.55 (8515/9010结构, 趋势健康)
   - 反弹减仓: 收盘<MA20 或 乖离>15% 或 (win20<0.45 且 收盘<布林下轨)
   - 持有观察: 其余
   三档触发价: reduce=max(MA20,布林中轨) | halve=min(MA10,20日高)-0.5%缓冲 | clear=min(布林下轨,20日低) */
function decideHolding(h) {
  const { ind, cost, qty } = h;
  const c = ind.c; /* 趋势判断用前复权收盘(与MA20/布林自洽) */
  /* v1.2.0: 盈亏用实时quote.price vs 用户成本(与市值/当日盈亏同源口径) */
  const livePx = (h.quote && h.quote.price) ? h.quote.price : c;
  const profitPct = cost > 0 ? (livePx / cost - 1) * 100 : 0;
  const bb = ind.bullBear;
  const win20 = bb ? bb.win20 : 0.5;
  let group, groupColor, reasons = [];

  if (profitPct > 10 && win20 >= 0.55) {
    group = 'lock'; groupColor = AGREEN;
    reasons.push('浮盈+' + R2(profitPct) + '%且多空' + (bb ? bb.tier : '—') + '档，趋势结构健康');
    reasons.push('用移动止盈锁定利润，跌破触发价分批离场');
  } else if (c < ind.ma20 || (ind.bias != null && ind.bias > 0.15) || (win20 < 0.45 && ind.bbPos != null && ind.bbPos < 0.02)) {
    group = 'reduce'; groupColor = ORANGE;
    if (c < ind.ma20) reasons.push('收盘已破MA20(' + R2(ind.ma20) + ')，趋势转弱');
    if (ind.bias != null && ind.bias > 0.15) reasons.push('乖离MA20达+' + R2(ind.bias * 100) + '%，超买回落风险');
    if (win20 < 0.45 && ind.bbPos != null && ind.bbPos < 0.02) reasons.push('多空' + (bb ? bb.tier : '—') + '档且贴布林下轨，弱势结构');
    reasons.push('将反弹视作减仓窗口而非加仓窗口');
  } else {
    group = 'hold'; groupColor = BLUE;
    reasons.push('结构未破坏：收盘' + (c > ind.ma20 ? '在MA20上方' : '贴近MA20') + '，多空' + (bb ? bb.tier : '—') + '档');
    reasons.push('持有观察，触发价破位再降档');
  }

  /* 三档触发价 */
  const reduce = ind.ma20 != null ? Math.max(ind.ma20, ind.bbMid || ind.ma20) : null;   // 减仓触发
  const halve = ind.ma10 != null ? Math.min(ind.ma10, ind.hi20 * 0.995) : null;          // 再减半触发
  const clear = Math.min(ind.bbLower || ind.lo20, ind.lo20);                             // 清仓红线
  return {
    group, groupColor, profitPct: R2(profitPct), reasons,
    triggers: { reduce: reduce != null ? R2(reduce) : null, halve: halve != null ? R2(halve) : null, clear: R2(clear) },
    /* v1.1.0: 野人两板块明确建议 (与diag.js BB_ACT/PD_ACT同口径, 附均线具体数值) */
    bbAction: bbHoldAdvice(bb, ind), pdAction: pdHoldAdvice(ind.pdLow, ind),
  };
}

/* 野人哥·多空四档持有建议 (与diag.js BB_ACT同口径, 附MA5/MA10具体数值)
   lvl: ok=强结构(绿) / warn=弱结构(橙) */
function bbHoldAdvice(bb, ind) {
  if (!bb) return null;
  const f = (x) => (x != null ? R2(x) : '—');
  const M = {
    '9010': '强结构：趋势跟随不逆势做T；红线：收盘首次跌破MA5(' + f(ind.ma5) + ')减半，跌破MA10(' + f(ind.ma10) + ')再减半',
    '8515': '回撤MA10(' + f(ind.ma10) + ')附近可做T降成本；红线：收盘跌破MA10(' + f(ind.ma10) + ')减半，跌破MA20(' + f(ind.ma20) + ')清仓',
    '8020': '不追加仓位，反弹至压力位减仓；红线：单日-3%(收盘<' + R2(ind.c * 0.97) + ')强制减半（该档打板回测胜率18.92%）',
    '7030': '减至底仓；红线：收盘跌破MA20(' + f(ind.ma20) + ')无条件清仓',
  };
  const txt = M[bb.tier];
  return txt ? { tier: bb.tier, lvl: (bb.tier === '9010' || bb.tier === '8515') ? 'ok' : 'warn', txt } : null;
}

/* 野人哥·物理距离低系数持有建议 (与diag.js pdAct hit态同口径) */
function pdHoldAdvice(pd, ind) {
  if (!pd || !pd.hit) return null;
  return { lvl: 'warn', txt: '抄底筹码型（近20日上涨收盘仅' + pd.upDays + '天且5/60量比' + pd.vr560 + '倍堆积）：次日冲高抛压大，反弹减至轻仓或清仓不补仓；止损可放宽至' + R2(ind.c * 0.95) + '(-5%)' };
}

/* ═══════════ MarketEnv: 大盘联动 ═══════════
   数据源: SITE_DATA(15:10管道快照: 市场分score10/相位cycle) + 实时上证K线(中轨判据)
   注入规则(设计手册Problem 3):
   - 退潮期(ebb) → 全部标的强制group='reduce' + 减仓纪律
   - 市场分<4 → 所有reduce触发价上移至 max(reduce, 现价×0.99)
   - 上证失守中轨 → 报告注入「组合降仓至五成」纪律行 */
async function fetchMarketEnv() {
  const env = {
    score10: null, cycle: null, cycleLabel: '—',
    shAboveMid: null, shClose: null, shMa20: null, maPos: null,
    cold: false, ebb: false, breakMid: false,
    discipline: [],
  };
  /* 1. SITE_DATA 快照 (data.js 用 const 声明, 不挂 window, 需裸标识符访问 — 与 index.html 同口径) */
  try {
    const sd = (typeof SITE_DATA !== 'undefined') ? SITE_DATA : null;
    if (sd && sd.market) {
      env.score10 = sd.market.score10;
      env.cold = env.score10 != null && env.score10 < 4;
    }
    if (sd && sd.entry_grading) {
      env.cycle = sd.entry_grading.cycle;
      const cycMap = { start: '启动', ferment: '发酵', climax: '高潮', ebb: '退潮' };
      env.cycleLabel = cycMap[env.cycle] || env.cycle || '—';
      env.ebb = env.cycle === 'ebb';
    }
  } catch (e) { /* data.js 未加载, 忽略 */ }
  /* 2. 实时上证中轨 */
  try {
    const k = await fetchKline('sh000001', 75);
    if (k.length > 20) {
      const closes = k.map(r => r.c);
      const ma20arr = maSeries(closes, 20);
      const i = k.length - 1;
      env.shClose = R2(closes[i]);
      env.shMa20 = R2(ma20arr[i]);
      env.shAboveMid = closes[i] > ma20arr[i];
      const w = k.slice(-60);
      const hi = Math.max(...w.map(r => r.h)), lo = Math.min(...w.map(r => r.l));
      env.maPos = hi > lo ? R2((closes[i] - lo) / (hi - lo) * 100) : 50;
    }
  } catch (e) { /* 中轨降级: 不阻塞体检 */ }
  env.breakMid = env.shAboveMid === false;

  /* 3. 纪律注入 */
  if (env.ebb) env.discipline.push('情绪周期「退潮」：所有信号降级处理，反弹是减仓窗口不是加仓窗口');
  if (env.cold) env.discipline.push('市场分' + env.score10 + '/10 冰冷：不开新仓，总敞口压降至五成以内');
  if (env.breakMid) env.discipline.push('上证已失守日线中轨(' + env.shMa20 + ')：组合整体降仓至五成，优先兑现浮盈标的');
  if (!env.discipline.length) env.discipline.push('环境未触发强制纪律：按个股触发价执行分批纪律');
  return env;
}

/* 大盘环境注入决策: 退潮强制全员降档至反弹减仓 + 冰冷期reduce上移(仅结构性弱势) */
function applyMarketEnv(h, env) {
  /* 退潮期: 锁定利润/持有观察 均强制降档 (设计手册: 反弹视作减仓窗口而非加仓窗口)
     v1.3.1: 降档保留, 但buildAction的plan.up带回暖失效条款对冲 — 回暖日强势股暂缓减仓改MA5跟踪 */
  if (env.ebb && (h.decision.group === 'hold' || h.decision.group === 'lock')) {
    const prevLabel = h.decision.group === 'lock' ? '锁定利润' : '持有观察';
    h.decision.group = 'reduce';
    h.decision.groupColor = ORANGE;
    h.decision.reasons.unshift('退潮期强制降档：' + prevLabel + ' → 反弹减仓');
  }
  /* v1.3.1修复①: 冰冷期上移只对结构性弱势生效, 健康结构(9010/8515且MA20上方)豁免。
     原逻辑全员上移至现价×0.99 — 强势股reduce锚=MA20(低于现价), 上移后=平盘即卖,
     V型回暖日挂单必被扫飞; 而弱势股reduce锚本就高于现价×0.99, 上移仅覆盖少数
     "结构弱但价贴MA20"的边缘情况, 豁免健康结构不影响冰冷期纪律本身 */
  const bb = h.ind ? h.ind.bullBear : null;
  const healthy = bb && (bb.tier === '9010' || bb.tier === '8515') && h.ind.c > h.ind.ma20;
  if (env.cold && h.decision.triggers.reduce != null) {
    if (healthy) {
      h.decision.reasons.push('冰冷期豁免：' + bb.tier + '强结构且MA20上方，减仓价维持 ' + R2(h.decision.triggers.reduce) + ' 锚位不上移（防回暖日平盘扫飞）');
    } else {
      const floor = R2(h.ind.c * 0.99);
      if (h.decision.triggers.reduce < floor) {
        h.decision.triggers.reduce = floor;
        h.decision.reasons.push('冰冷期减仓触发价上移至现价×0.99（' + floor + '）');
      }
    }
  }
  buildAction(h); /* v1.1.0: 环境注入后(含降档/触发价上移)重算主操作指令 */
}

/* 主操作指令合成 (v1.1.0): 每组明确动作+价格锚点, 持有者视角
   lock: 移动止盈三档 | reduce: 反弹减半+清仓红线 | hold: 破MA20降档 */
function buildAction(h) {
  const d = h.decision, ind = h.ind;
  if (!ind || !d) return;
  const f = (x) => (x != null ? R2(x) : '—');
  const t = d.triggers || {};
  if (d.group === 'lock') {
    d.action = '锁利：MA5(' + f(ind.ma5) + ')上方持有，跌破「再减」' + f(t.halve) + '减半，跌破「清仓红线」' + f(t.clear) + '离场';
  } else if (d.group === 'reduce') {
    d.action = '减仓：反弹至' + f(t.reduce) + '附近先减半仓，剩余半仓收盘跌破' + f(t.clear) + '清仓；不加仓不补仓';
  } else {
    d.action = '持有：收盘跌破MA20(' + f(ind.ma20) + ')即降档减仓，跌破' + f(t.clear) + '清仓；MA10(' + f(ind.ma10) + ')上方结构完好';
  }
  /* v1.2.0 [C档·复盘七步法第7步]: 认输线+明日计划结构化(执行层流程字段, 不入行情模型)
     认输线=清仓红线(布林下轨/20日低点取低); 三条件计划=冲高/平开/破线, 触发式退出对齐视频「提前定义错误条件」 */
  d.quit_line = t.clear != null ? t.clear : (ind.ma20 != null ? R2(ind.ma20) : null);
  const q = d.quit_line != null ? R2(d.quit_line) : null;
  const qp = q != null ? q : '—';
  if (d.group === 'lock') {
    d.plan = {
      up: '冲高持有让利润奔跑(MA5 ' + f(ind.ma5) + ' 上方不动)，不因涨幅大而主动了结',
      flat: '震荡持有；跌破「再减」' + f(t.halve) + '减半仓',
      down: '收盘跌破认输线 ' + qp + ' → 无条件清仓离场，不幻想不摊薄',
    };
  } else if (d.group === 'reduce') {
    d.plan = {
      /* v1.3.1修复②: 回暖失效条款 — 对冲退潮降档"只降不回"。
         依据(2026-09-14卖飞复盘): 退潮+冰冷报告把强势股卖价钉在昨收附近, 次日情绪
         回暖(涨停39家/晋级率75%)强势股全部平盘位被扫掉后继续上涨。此条款让"放量
         突破"与"冲高乏力"分开处理, 高开>2%且量比>1.5/触涨停/放量破20日高任一成立
         → 暂缓减仓, 改用MA5移动止盈让利润奔跑(破MA5再执行减仓) */
      up: '冲高至 ' + f(t.reduce) + ' 附近先减半仓(非清仓)；回暖失效条款：高开>2%且盘中量比>1.5 / 触涨停 / 放量突破20日高 ' + f(ind.hi20) + ' 任一成立 → 暂缓减仓，改MA5(' + f(ind.ma5) + ')上方移动止盈跟踪，跌破MA5再执行减仓',
      flat: '平开震荡不加仓不补仓，等反弹触发减仓；已减半后，剩余半仓跌破认输线 ' + qp + ' 清仓',
      down: '收盘跌破认输线 ' + qp + ' → 无条件清仓离场，不幻想不摊薄',
    };
  } else {
    d.plan = {
      up: '冲高观察不追不加仓，涨幅扩大注意乖离回落',
      flat: '持有观察；收盘破MA20(' + f(ind.ma20) + ')即降档减仓',
      down: '收盘跌破认输线 ' + qp + ' → 无条件清仓离场，不幻想不摊薄',
    };
  }
  /* v1.3.1修复④: 执行层提示 — 触发式计划需盘中确认量能再挂单, 隔夜死单无法区分
     "放量突破"(不该卖)与"冲高乏力"(该卖), 2026-09-14多笔卖飞直接原因之一 */
  if (d.plan) d.plan.note = '执行提示：触发式计划勿隔夜预挂死单——挂单前先看盘中量能：放量突破挂单价(量比>1.5)撤单改MA5跟踪，冲高乏力(量比<1)再挂单。';
}

/* ═══════════ Fetcher: 并发拉取(≤4, 指数退避重试2次) ═══════════ */
async function fetchWithRetry(fn, retries) {
  let lastErr;
  for (let i = 0; i <= (retries || 2); i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; if (i < (retries || 2)) await new Promise(r => setTimeout(r, 400 * Math.pow(2, i))); }
  }
  throw lastErr;
}
/* 并发槽位池: limit=4 */
async function runPool(tasks, limit, onDone) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function runner() {
    while (idx < tasks.length) {
      const my = idx++;
      results[my] = await tasks[my]().catch(e => ({ error: e }));
      if (onDone) onDone(my, results[my]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, runner));
  return results;
}

/* 主入口: 输入确认后的持仓行 [{code, name, cost, qty, mkt, full}]
   输出 [{code, name, cost, qty, k, quote, ind, decision}] + env */
async function runPortfolioHealth(rows, onProgress) {
  const total = rows.length;
  let done = 0;
  const results = await runPool(rows.map(row => async () => {
    const full = row.full || row.mkt + row.code;
    /* K线75根(指标需60+), 失败降级实时行情 */
    let k = null, quote = null;
    try { k = await fetchWithRetry(() => fetchKline(full, 75)); } catch (e) { k = null; }
    try { quote = await fetchWithRetry(() => fetchQuote(full), 1); } catch (e) { quote = null; }
    if (!k || k.length < 25) {
      if (!quote) return { code: row.code, name: row.name, error: 'K线与行情均获取失败' };
      /* 行情降级: 无K线时给基础信息+quote级决策 */
      return { code: row.code, name: row.name, cost: row.cost, qty: row.qty, quote, degraded: true,
        ind: null, decision: { group: 'hold', groupColor: BLUE, profitPct: quote.price && row.cost ? R2((quote.price / row.cost - 1) * 100) : null,
          reasons: ['K线获取失败，降级为行情级展示（' + quote.name + ' 现价 ' + quote.price + '）'], triggers: {} } };
    }
    const ind = computeIndicators(k);
    const h = { code: row.code, name: row.name, cost: row.cost, qty: row.qty, k, quote, ind };
    h.decision = decideHolding(h);
    return h;
  }), 4, () => { done++; if (onProgress) onProgress(done, total); });

  /* 大盘环境 */
  const env = await fetchMarketEnv();
  /* 注入决策 */
  const ok = results.filter(r => r && !r.error && !r.degraded);
  ok.forEach(h => applyMarketEnv(h, env));
  return { holdings: results, env };
}

/* ═══════════ 暴露 window.Health (供 port.js / three.html 复用) ═══════════ */
window.Health = {
  version: '1.3.1',
  /* 数据层 */
  tencent, searchStock, fetchKline, fetchQuote, fetchWithRetry, runPool,
  /* 指标层 */
  maSeries, bollSeries, computeIndicators, calcBullBear, calcPdLow,
  /* 决策层 */
  decideHolding, fetchMarketEnv, applyMarketEnv, runPortfolioHealth,
  bbHoldAdvice, pdHoldAdvice, buildAction,
  /* 工具 */
  R2, fmtNum, fmtWan, fmtYi, ARED, AGREEN, BLUE, ORANGE,
};
})();
