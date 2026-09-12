/* diag.js v1.4.0 — 诊断中心逻辑 (v1.4.0 P2: 野人哥卡片决策映射·操作建议可直接执行)
   数据: 腾讯JSONP(GBK, K线/行情/搜索) + fund_data.js快照(个股累积历史) + 新浪60日(非候选池历史) + push2delay(资金流当日) + DC(大宗)
   计算: MA/MACD/RSI/KDJ/BOLL/量比 → 六类信号 → 五档位阶聚类 → 综合评分
   声明: 全部为条件概率诊断, 非预测, 不构成投资建议
   v1.1.2: em()加时间戳防CDN缓存; 资金流/大宗接口全挂时从 fund_data.js 快照兜底; 标注主力口径与同花顺差异
   v1.1.3: em()加 referrerPolicy=no-referrer 尝试绕过东财 Referer 拦截
   v1.2.0: 资金流改为「后端快照优先」三级降级链: FUND_DATA.hist(候选池累积历史) → push2delay(任意股票当日) →
           FUND_DATA.stocks(当日兜底)。移除浏览器直连 push2his/push2 — 实测被 Sec-Fetch-Site 跨站拦截且
           JSONP 9s超时严重拖慢首屏; 后端直连亦被IP封禁, 完整历史改由 15:10 管道逐日累积(每股75日)
   v1.3.0: 新增新浪 MoneyFlow 接口补全非候选池 60 日历史(实测后端直连+浏览器跨站 JSONP 均放行):
           降级链变四级 FUND_DATA.hist → 新浪60日 → push2delay → FUND_DATA.stocks。新浪口径主力=特大单+大单,
           与东财划分标准不同(同股同日差可达5-10倍), 图表与KPI同源自洽, 绝对值不与东财直接对比
   v1.4.0: 大盘诊断新增「多周期轨道·海拔体系」(蒸馏自公开博主@Keep方法论, 已回测校准):
           腾讯60分钟线 → 60分/120分布林轨道 + MACD背离预警 + 日线中轨破位/收复状态。
           回测证据(700日日线+256日60分线): 顶背离后3日下跌概率75%(n=8); 破中轨后3日反弹概率64.86%(n=37);
           收复中轨后3日胜率63.16%(n=38); 中轨支撑买入(B1)与「小级别服从大级别」持有(B5)无超额, 不作为信号输出 */
(function () {
'use strict';

/* ═══════════ 工具 ═══════════ */
const $ = (id) => document.getElementById(id);
const R2 = (x) => Math.round(x * 100) / 100;
const fmtNum = (x, d) => Number(x).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtYi = (x) => (x >= 0 ? '+' : '') + fmtNum(x, 2) + '亿';
const fmtWan = (x) => (x >= 0 ? '+' : '') + fmtNum(x, 0) + '万';
const ARED = '#FF3B30', AGREEN = '#34C759', BLUE = '#007AFF', ORANGE = '#FF9500';
let cbSeq = 0;

/* 腾讯 JSONP (GBK): script charset=gbk, 轮询全局变量 */
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

/* 东财 JSONP: cb= 全局回调
   v1.1.0: 支持 cbParam 指定回调参数名 — push2系用 cb=, datacenter-web 只认 callback=
   v1.1.2: 加 _= 时间戳, 防止 CDN/浏览器缓存旧 JSONP 响应
   v1.1.3: 加 referrerPolicy=no-referrer
   v1.2.0 注: push2his/push2 无论是否带 Referer 均被 Sec-Fetch-Site: cross-site 拦截(浏览器受保护头,
           前端无法移除), 仅 push2delay/datacenter 对跨站 JSONP 放行 — 资金流完整历史改走后端快照 */
function em(url, timeout, cbParam) {
  return new Promise((resolve, reject) => {
    const cb = '_emcb' + (++cbSeq);
    const s = document.createElement('script');
    let tm = null;
    window[cb] = (data) => { clearTimeout(tm); delete window[cb]; s.remove(); resolve(data); };
    tm = setTimeout(() => { delete window[cb]; s.remove(); reject(new Error('timeout')); }, timeout || 9000);
    s.onerror = () => { clearTimeout(tm); delete window[cb]; s.remove(); reject(new Error('network')); };
    s.referrerPolicy = 'no-referrer';
    s.src = url + (url.includes('?') ? '&' : '?') + (cbParam || 'cb') + '=' + cb + '&_=' + Date.now();
    document.head.appendChild(s);
  });
}

/* 腾讯搜索: v_hint="sz~002161~远望谷~ywg~GP-A;..."
   v1.1.0 修复: 实际格式为 mkt~code~name~拼音~type 五段, 完整代码 = p[0]+p[1]
   (v1.0 错取 p[0] 当完整代码, 导致名称搜索后 full='sz' 丢码 → 数据获取失败) */
async function searchStock(q) {
  const hint = await tencent('https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(q) + '&t=all', 'v_hint', 6000);
  const raw = String(hint || '').trim();
  if (!raw || raw === 'N') return [];
  return raw.split(';').filter(Boolean).map(seg => {
    const p = seg.split('~');
    if (p.length < 3) return null;
    const mkt = p[0], code = p[1];                 // p[0]=sz p[1]=002161
    return {
      mkt, code, full: mkt + code,
      name: (p[2] || '').replace(/\s+/g, ''), type: p[4] || '',
      valid: /^\d{6}$/.test(code) && (p[4] || '').includes('GP'),
    };
  }).filter(x => x && x.valid);
}

/* 腾讯K线: _var 自定义变量; [date,open,close,high,low,vol] 前复权 */
async function fetchKline(full, n) {
  const varName = 'kd_' + Math.random().toString(36).slice(2, 8);
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + full + ',day,,,' + n + ',qfq&_var=' + varName;
  const d = await tencent(url, varName);
  const rows = (d && d.data && d.data[full] && (d.data[full].qfqday || d.data[full].day)) || [];
  return rows.map(r => ({
    d: r[0], o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5],
  }));
}

/* v1.4.1 腾讯60分钟线: [datetime,open,close,high,low,vol]; 大盘轨道数据源
   proxy.finance.qq.com 镜像优先(web.ifzq 的 mkline 路径会302到 web3 且连接被关闭,
   与 Python 回测侧同结论); 双域名兜底, 均失败时轨道节降级为日线级展示 */
async function fetchM60(n) {
  const varName = 'mk_' + Math.random().toString(36).slice(2, 8);
  const param = 'param=sh000001,m60,,' + n + '&_var=' + varName;
  const hosts = [
    'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline',
    'https://web.ifzq.gtimg.cn/appstock/app/kline/mkline',
  ];
  let rows = [];
  for (const h of hosts) {
    try {
      const d = await tencent(h + '?' + param, varName, 10000);
      rows = (d && d.data && d.data.sh000001 && d.data.sh000001.m60) || [];
      if (rows.length) break;
    } catch (e) { /* 尝试下一域名 */ }
  }
  if (!rows.length) throw new Error('m60 empty');
  return rows.map(r => ({ d: String(r[0]), c: +r[2], h: +r[3], l: +r[4] }));
}

/* v1.4.0 60分钟→120分钟聚合(同日两根合1) */
function agg120(m60) {
  const out = []; let buf = [], lastDay = null;
  const flush = () => {
    if (!buf.length) return;
    out.push({ d: buf[0].d, c: buf[buf.length - 1].c,
      h: Math.max(...buf.map(b => b.h)), l: Math.min(...buf.map(b => b.l)) });
    buf = [];
  };
  for (const b of m60) {
    const day = b.d.slice(0, 8);
    if (day !== lastDay && buf.length) flush();
    buf.push(b); lastDay = day;
    if (buf.length === 2) flush();
  }
  flush();
  return out;
}

/* v1.4.0 布林序列: 中轨=SMA20, 上下轨=±2σ(总体标准差, 与常用软件一致) */
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

/* v1.4.0 EMA序列 + MACD·DIF */
function emaArr(vals, w) {
  const out = []; const kk = 2 / (w + 1); let e = null;
  for (const v of vals) { e = e === null ? v : v * kk + e * (1 - kk); out.push(e); }
  return out;
}
function difArr(closes) {
  const f = emaArr(closes, 12), s = emaArr(closes, 26);
  return closes.map((_, i) => f[i] - s[i]);
}

/* v1.4.0 60分钟MACD背离检测(与回测脚本同参数: order=2/间隔≥6/等高低点±0.1%/强度≥0.05)
   返回 [{idx, kind, strength, dt}] */
function detectDiv60(m60) {
  const closes = m60.map(r => r.c);
  const dif = difArr(closes);
  const order = 2, minGap = 6, tol = 0.001;
  const hi = [], lo = [];
  for (let i = order; i < closes.length - order; i++) {
    const win = closes.slice(i - order, i + order + 1);
    if (closes[i] === Math.max(...win) && win.filter(x => x === closes[i]).length === 1) hi.push(i);
    if (closes[i] === Math.min(...win) && win.filter(x => x === closes[i]).length === 1) lo.push(i);
  }
  const out = [];
  for (let a = 0; a < hi.length - 1; a++) {
    const i1 = hi[a], i2 = hi[a + 1];
    if (i2 - i1 < minGap) continue;
    if (closes[i2] >= closes[i1] * (1 - tol) && dif[i2] < dif[i1]) {
      const st = (dif[i1] - dif[i2]) / Math.max(Math.abs(dif[i1]), 0.01);
      if (st >= 0.05) out.push({ idx: i2, kind: 'top', strength: st, dt: m60[i2].d });
    }
  }
  for (let a = 0; a < lo.length - 1; a++) {
    const i1 = lo[a], i2 = lo[a + 1];
    if (i2 - i1 < minGap) continue;
    if (closes[i2] <= closes[i1] * (1 + tol) && dif[i2] > dif[i1]) {
      const st = (dif[i2] - dif[i1]) / Math.max(Math.abs(dif[i1]), 0.01);
      if (st >= 0.05) out.push({ idx: i2, kind: 'bottom', strength: st, dt: m60[i2].d });
    }
  }
  return out;
}

/* 腾讯实时行情 88字段 (v1.1.0: 腾讯对短名称做空格填充如"远 望 谷", 统一去除内部空格) */
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

/* 东财资金流: v1.3.1 快照优先四级降级链, 返回 {primary, sina} 双口径
   primary: 1) FUND_DATA.hist[code] 后端15:10管道逐日累积(候选池, 万→元) → 2) 新浪60日 →
            3) push2delay 当日(push2his/push2 被Sec-Fetch-Site拦截已移除) → 4) FUND_DATA.stocks 当日兜底
   sina:    候选池快照命中时额外拉取新浪60日作切换视图(口径不同不可混拼, 由用户切换查看) */
function sinaFflow(daima, timeout) {
  return new Promise((resolve, reject) => {
    const varName = '_snff' + (++cbSeq);
    const s = document.createElement('script');
    let iv = null, tm = null;
    const cleanup = () => { clearInterval(iv); clearTimeout(tm); delete window[varName]; s.remove(); };
    tm = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout || 7000);
    iv = setInterval(() => {
      if (window[varName] !== undefined) { const v = window[varName]; cleanup(); resolve(v); }
    }, 40);
    s.onerror = () => { cleanup(); reject(new Error('network')); };
    s.src = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/jsonp_v2.php/' + varName +
            '=/MoneyFlow.ssl_qsfx_lscjfb?page=1&num=60&sort=opendate&asc=0&daima=' + daima + '&_=' + Date.now();
    document.head.appendChild(s);
  });
}
/* 新浪 60 日 rows 映射 (r0特大/r1大/r2中/r3小净额, 元; 接口降序→升序) */
async function fetchSinaRows(mkt, code) {
  try {
    const arr = await sinaFflow((mkt === '1' ? 'sh' : 'sz') + code);
    if (Array.isArray(arr) && arr.length) {
      return arr.slice(0, 60).reverse().map(x => ({
        d: x.opendate,
        main: (+x.r0_net || 0) + (+x.r1_net || 0),
        sup: +x.r0_net || 0, big: +x.r1_net || 0, mid: +x.r2_net || 0, small: +x.r3_net || 0,
        rate: (+x.ratioamount || 0) * 100, close: +x.trade || 0, pct: (+x.changeratio || 0) * 100,
      }));
    }
  } catch (e) { /* 降级 */ }
  return null;
}
async function fetchFundFlow(mkt, code) {
  /* 1. 候选池东财快照 (m主力/u超大/b大/n中/s小/r净率%, 万→元) */
  const sh = (window.FUND_DATA && window.FUND_DATA.hist && window.FUND_DATA.hist[code]) || null;
  const snapRows = sh && sh.length ? sh.map(x => ({
    d: x.d, main: x.m * 1e4, small: x.s * 1e4, mid: x.n * 1e4,
    big: x.b * 1e4, sup: x.u * 1e4, rate: x.r, close: 0, pct: 0,
  })) : null;
  /* 新浪 60 日: 快照命中时作切换视图, 未命中时作为 primary */
  const sinaRows = await fetchSinaRows(mkt, code);
  if (snapRows) return {
    primary: { rows: snapRows, full: true, src: 'snap' },
    sina: sinaRows ? { rows: sinaRows, full: true, src: 'sina' } : null,
  };
  if (sinaRows) return { primary: { rows: sinaRows, full: true, src: 'sina' }, sina: null };
  /* 2. push2delay: 任意股票当日 */
  const path = '/api/qt/stock/fflow/daykline/get?lmt=0&klt=101&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65&secid=' + mkt + '.' + code + '&ut=b2884a393a59ad64002292a3e90d46a5';
  try {
    const d = await em('https://push2delay.eastmoney.com' + path);
    const kl = (d && d.data && d.data.klines) || [];
    const rows = kl.map(line => {
      const p = line.split(',');
      return { d: p[0], main: +p[1], small: +p[2], mid: +p[3], big: +p[4], sup: +p[5], rate: +p[6], close: +p[11], pct: +p[12] };
    });
    if (rows.length) return { primary: { rows, full: false, src: 'live' }, sina: null };
  } catch (e) { /* 降级 */ }
  /* 4. 快照兜底: 候选池个股当日(单位万→元); 中/小单不可拆分, 合并归入小单保持代数闭合 */
  const st = (window.FUND_DATA && window.FUND_DATA.stocks && window.FUND_DATA.stocks[code]) || null;
  if (st) {
    const sup = st.super * 1e4, big = st.big * 1e4, main = st.main * 1e4;
    return { primary: { rows: [{ d: st.d, main, small: -main, mid: 0, big, sup, rate: st.rate, close: 0, pct: st.pct }], full: false, src: 'snapshot' }, sina: null };
  }
  return { primary: null, sina: null };
}

/* DC 大宗交易(个股近60日) — v1.1.0: datacenter-web 只支持 callback= 参数(cb=会返回裸JSON被ORB拦截)
   v1.1.2: 失败自动重试1次; 仍失败时从 fund_data.js 当日全市场大宗 Top10 匹配兜底 */
async function fetchBlockTrade(code) {
  const d60 = new Date(Date.now() - 61 * 864e5).toISOString().slice(0, 10);
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DATA_BLOCKTRADE&columns=SECURITY_CODE,SECURITY_NAME_ABBR,TRADE_DATE,DEAL_PRICE,DEAL_AMT,PREMIUM_RATIO,DEAL_VOLUME,BUYER_NAME,SELLER_NAME&filter=(SECURITY_CODE%3D%22' + code + '%22)(TRADE_DATE%3E%3D%27' + d60 + '%27)&pageSize=60&pageNumber=1&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB';
  for (let i = 0; i < 2; i++) {
    try {
      const d = await em(url, 10000, 'callback');
      return (d && d.result && d.result.data) || [];
    } catch (e) { if (i) break; await new Promise(r => setTimeout(r, 600)); }
  }
  /* 快照兜底: 当日全市场大宗 Top10 中该股记录(命中有限, 聊胜于无) */
  try {
    const blk = (window.FUND_DATA && window.FUND_DATA.latest && window.FUND_DATA.latest.block) || null;
    const hit = ((blk && blk.top) || []).filter(x => x.code === code);
    if (hit.length) return hit.map(x => ({
      SECURITY_CODE: x.code, SECURITY_NAME_ABBR: x.name,
      TRADE_DATE: ((blk.date || '') + ' 00:00:00'),
      DEAL_PRICE: x.price, DEAL_AMT: (x.amt || 0) * 1e8, PREMIUM_RATIO: x.prem,
    }));
  } catch (e) { /* 忽略 */ }
  return [];
}

/* ═══════════ 指标计算 ═══════════ */
function calcIndicators(k) {
  const n = k.length, closes = k.map(r => r.c);
  const MA = (win) => { const out = []; for (let i = 0; i < n; i++) out.push(i < win - 1 ? null : closes.slice(i - win + 1, i + 1).reduce((a, b) => a + b, 0) / win); return out; };
  const EMA = (win) => { const out = []; let e = null; for (let i = 0; i < n; i++) { e = e === null ? closes[i] : (closes[i] * 2 / (win + 1) + e * (1 - 2 / (win + 1))); out.push(e); } return out; };
  const ma5 = MA(5), ma10 = MA(10), ma20 = MA(20), ma60 = MA(60);
  const ema12 = EMA(12), ema26 = EMA(26);
  const dif = ema12.map((v, i) => v - ema26[i]);
  let sig = []; { let e = null; for (let i = 0; i < n; i++) { e = e === null ? dif[i] : (dif[i] * 2 / 10 + e * 0.8); sig.push(e); } }
  const hist = dif.map((v, i) => v - sig[i]);
  // RSI14 Wilder
  const rsi = [null]; { let ag = 0, al = 0; for (let i = 1; i < n; i++) { const ch = closes[i] - closes[i - 1]; const g = Math.max(ch, 0), l = Math.max(-ch, 0); if (i <= 14) { ag += g; al += l; if (i === 14) { ag /= 14; al /= 14; rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al)); } else rsi.push(null); } else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al)); } } }
  // KDJ 9,3,3
  const kdjK = [], kdjD = []; { let pk = 50, pd = 50; for (let i = 0; i < n; i++) { const s = Math.max(0, i - 8); const hh = Math.max(...k.slice(s, i + 1).map(r => r.h)); const ll = Math.min(...k.slice(s, i + 1).map(r => r.l)); const rsv = hh === ll ? 50 : (k[i].c - ll) / (hh - ll) * 100; pk = 2 / 3 * pk + 1 / 3 * rsv; pd = 2 / 3 * pd + 1 / 3 * pk; kdjK.push(pk); kdjD.push(pd); } }
  // BOLL 20±2σ
  const bollU = [], bollL = []; for (let i = 0; i < n; i++) { if (i < 19) { bollU.push(null); bollL.push(null); continue; } const w = closes.slice(i - 19, i + 1); const m = w.reduce((a, b) => a + b, 0) / 20; const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 20); bollU.push(m + 2 * sd); bollL.push(m - 2 * sd); }
  return { ma5, ma10, ma20, ma60, dif, sig, hist, rsi, kdjK, kdjD, bollU, bollL, closes };
}

/* ═══════════ 信号规则(收盘级) ═══════════ */
function calcSignals(k, ind, fund) {
  const i = k.length - 1, c = k[i].c;
  const c1 = k[i - 1], ma5v = ind.ma5[i], ma10v = ind.ma10[i], ma20v = ind.ma20[i], ma60v = ind.ma60[i];
  const ma20prev = ind.ma20[i - 5], volToday = k[i].v, volAvg5 = k.slice(i - 4, i + 1).reduce((a, r) => a + r.v, 0) / 5;
  const volAvg20 = k.slice(i - 19, i + 1).reduce((a, r) => a + r.v, 0) / 20;
  const volRatio = volAvg5 ? volToday / volAvg5 : 1;
  const hi20 = Math.max(...k.slice(i - 19, i).map(r => r.h));
  const hiVol20 = Math.max(...k.slice(i - 19, i).map(r => r.v));
  const pctToday = (c / c1.c - 1) * 100;
  const bull = ma5v && ma10v && ma20v && ma60v && ma5v > ma10v && ma10v > ma20v && ma20v > ma60v;
  const sig = [];

  // 1 回踩买入
  if (bull && ma10v && Math.abs(c - ma10v) / ma10v <= 0.015 && volToday < volAvg5 && c >= ma10v) {
    sig.push({ dir: 'buy', name: '回踩观察 · 多头缩量回踩MA10', conf: 2,
      desc: '多头排列下缩量回踩10日线并站稳，历史上多为趋势内加仓观察点',
      why: 'MA5>MA10>MA20>MA60 多头排列 · 距MA10 ' + R2((c / ma10v - 1) * 100) + '% · 量能 ' + R2(volToday / volAvg5) + '倍于5日均量' });
  }
  // 2 突破买入
  if (c > hi20 && volRatio >= 1.5) {
    sig.push({ dir: 'buy', name: '突破观察 · 放量突破20日新高', conf: 2,
      desc: '收盘创20日新高且显著放量，动量延续概率观察点',
      why: '收盘 ' + R2(c) + ' > 20日高点 ' + R2(hi20) + ' · 量比 ' + R2(volRatio) });
  }
  // 3 动量买入
  if (ind.dif[i - 1] <= ind.sig[i - 1] && ind.dif[i] > ind.sig[i] && ind.hist[i] > 0 && volRatio >= 1.2) {
    sig.push({ dir: 'buy', name: '动量观察 · MACD金叉放量', conf: 2,
      desc: 'MACD金叉且柱体转正、量能配合，短线动量观察点',
      why: 'DIF上穿DEA · Histogram ' + R2(ind.hist[i]) + ' · 量比 ' + R2(volRatio) });
  }
  // 4 风险卖出
  if (ma20v && c < ma20v && (ma20v - c) / ma20v > 0.01) {
    sig.push({ dir: 'sell', name: '风险提示 · 有效跌破MA20', conf: 2,
      desc: '收盘有效跌破20日均线，趋势走弱信号',
      why: '收盘低于MA20 ' + R2((c / ma20v - 1) * 100) + '% · MA20' + (ma20v > ma20prev ? '仍上行' : '已下行') });
  }
  // 5 强制止损
  if (pctToday <= -4 && volToday >= 1.5 * volAvg20) {
    sig.push({ dir: 'sell', name: '止损预警 · 放量长阴', conf: 3,
      desc: '单日跌幅超4%且量能为20日均量1.5倍以上，恐慌抛售特征',
      why: '当日 ' + R2(pctToday) + '% · 量/20日均量 ' + R2(volToday / volAvg20) + '倍' });
  }
  // 6 止盈预警
  const priceNewHigh = c >= Math.max(...ind.closes.slice(Math.max(0, i - 10), i)) - 1e-9;
  if (ind.rsi[i] > 75 && ind.bollU[i] && c >= ind.bollU[i] * 0.995 && priceNewHigh && volToday < hiVol20) {
    sig.push({ dir: 'sell', name: '止盈预警 · 超买量价背离', conf: 2,
      desc: 'RSI超买+触及布林上轨+价新高而量未新高，动能衰竭观察',
      why: 'RSI ' + R2(ind.rsi[i]) + ' · 触布林上轨 · 量能未配合新高' });
  }
  // 资金流联动提示
  if (fund && fund.rows && fund.rows.length) {
    const fl = fund.rows[fund.rows.length - 1];
    if (fl.main > 0 && fl.rate > 5) {
      sig.push({ dir: 'buy', name: '资金观察 · 主力净流入', conf: 1,
        desc: '当日主力资金净流入且占成交额比例较高',
        why: '主力净流入 ' + fmtWan(fl.main / 1e4) + ' · 净流入率 ' + R2(fl.rate) + '%' });
    } else if (fl.main < 0 && fl.rate < -5) {
      sig.push({ dir: 'sell', name: '资金观察 · 主力净流出', conf: 1,
        desc: '当日主力资金净流出且占比显著',
        why: '主力净流出 ' + fmtWan(Math.abs(fl.main) / 1e4) + ' · 净流出率 ' + R2(fl.rate) + '%' });
    }
  }
  return sig;
}

/* ═══════════ 位阶合成(聚类±1.5%) ═══════════ */
function calcLevels(k, ind) {
  const i = k.length - 1, c = k[i].c;
  const win = k.slice(-60);
  const hi = Math.max(...win.map(r => r.h)), lo = Math.min(...win.map(r => r.l));
  const range = hi - lo;
  let cand = [];
  const push = (p, src, w) => { if (p && isFinite(p) && p > 0) cand.push({ p: R2(p), src, w: w || 1 }); };
  push(hi, '60日前高', 3); push(lo, '60日前低', 3);
  if (ind.ma20[i]) push(ind.ma20[i], 'MA20', 2);
  if (ind.ma60[i]) push(ind.ma60[i], 'MA60', 2);
  if (ind.bollU[i]) push(ind.bollU[i], '布林上轨', 1.5);
  if (ind.bollL[i]) push(ind.bollL[i], '布林下轨', 1.5);
  push(lo + range * 0.618, 'Fib 0.618', 1); push(lo + range * 0.5, 'Fib 0.5', 1); push(lo + range * 0.382, 'Fib 0.382', 1);
  // 20日成交密集区: 按(高+低+2*收)/4 加权聚类峰
  { const buckets = {}; for (const r of k.slice(-20)) { const vp = R2((r.h + r.l + 2 * r.c) / 4 / 0.02) * 0.02; buckets[vp] = (buckets[vp] || 0) + r.v; }
    const peak = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0]; if (peak) push(+peak[0], '成交密集区', 3); }
  // 触碰次数
  for (const cd of cand) { cd.touch = win.filter(r => Math.abs(r.l - cd.p) / cd.p < 0.01 || Math.abs(r.h - cd.p) / cd.p < 0.01).length; }
  // 聚类 ±1.5%
  cand.sort((a, b) => a.p - b.p);
  const clusters = [];
  for (const cd of cand) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(cd.p - last.p) / last.p <= 0.015) {
      last.w += cd.w; last.touch += cd.touch; last.p = R2((last.p + cd.p) / 2);
      if (!last.srcs.includes(cd.src)) last.srcs.push(cd.src);
    } else clusters.push({ p: cd.p, w: cd.w, touch: cd.touch, srcs: [cd.src] });
  }
  // 评分与分档
  const maxW = Math.max(...clusters.map(x => x.w), 1), maxT = Math.max(...clusters.map(x => x.touch), 1);
  for (const cl of clusters) {
    cl.score = R2((0.45 * (cl.w / maxW) + 0.30 * (cl.touch / maxT) + 0.25 * (1 - Math.min(Math.abs(cl.p - c) / c / 0.10, 1))) * 100);
    cl.dist = R2((cl.p / c - 1) * 100);
  }
  const below = clusters.filter(x => x.p < c * 0.992).sort((a, b) => b.p - a.p);
  const above = clusters.filter(x => x.p >= c * 0.992).sort((a, b) => a.p - b.p);
  const out = [];
  if (below[0]) out.push({ tag: '支撑①', ...below[0], color: AGREEN });
  if (below[1]) out.push({ tag: '强支撑', ...below[1], color: AGREEN });
  if (above[0]) out.push({ tag: '压力①', ...above[0], color: ARED });
  if (above[1]) out.push({ tag: '强压力', ...above[1], color: ARED });
  return { levels: out, clusters };
}

/* ═══════════ 综合评分 ═══════════ */
function calcScore(k, ind, fund) {
  const i = k.length - 1, c = k[i].c;
  let trend = 0, vol = 0, emo = 0, risk = 0, notes = [];
  const bull = ind.ma5[i] > ind.ma10[i] && ind.ma10[i] > ind.ma20[i] && (ind.ma60[i] === null || ind.ma20[i] > ind.ma60[i]);
  if (bull) { trend += 20; notes.push('多头排列+20'); }
  if (ind.ma20[i] && c > ind.ma20[i]) { trend += 8; notes.push('MA20上方+8'); }
  if (ind.ma20[i] && ind.ma20[i] > ind.ma20[i - 5]) { trend += 6; notes.push('MA20上行+6'); }
  if (c >= Math.max(...ind.closes.slice(-60)) - 1e-9) { trend += 6; notes.push('60日新高+6'); }
  const volAvg5 = k.slice(-5).reduce((a, r) => a + r.v, 0) / 5;
  const volRatio = volAvg5 ? k[i].v / volAvg5 : 1;
  if (volRatio >= 1.5) { vol += 10; notes.push('放量+10'); }
  else if (volRatio < 0.8 && c > (ind.ma20[i] || 0)) { vol += 6; notes.push('缩量回调+6'); }
  const fl = fund && fund.rows && fund.rows.length ? fund.rows[fund.rows.length - 1] : null;
  if (fl && fl.main > 0) { vol += 9; notes.push('主力净流入+9'); }
  else if (fl && fl.main < 0 && fl.rate < -5) { vol -= 4; notes.push('主力大幅流出-4'); }
  const rsi = ind.rsi[i] || 50;
  if (rsi >= 40 && rsi <= 70) { emo += 10; notes.push('RSI健康区+10'); }
  if (ind.hist[i] > 0) { emo += 5; notes.push('MACD红柱+5'); }
  if (ind.kdjK[i] > ind.kdjD[i]) { emo += 5; notes.push('KDJ K>D+5'); }
  if (ind.ma20[i] && Math.abs(c / ind.ma20[i] - 1) < 0.03) { risk += 5; notes.push('贴近MA20+5'); }
  if (ind.bollU[i] && c < ind.bollU[i] * 0.99) { risk += 5; notes.push('未触上轨+5'); }
  const last5 = k.slice(-5); if (!last5.some(r => (r.c / (r.o || r.c) - 1) * 100 <= -4)) { risk += 5; notes.push('无长阴+5'); }
  trend = Math.max(0, Math.min(40, trend)); vol = Math.max(0, Math.min(25, vol));
  emo = Math.max(0, Math.min(20, emo)); risk = Math.max(0, Math.min(15, risk));
  const total = Math.round(trend + vol + emo + risk);
  return { total, trend, vol, emo, risk, notes: notes.slice(0, 6) };
}

/* ═══════════ 野人哥·物理距离低系数检查 (v1.2.0) ═══════════
   《野人哥交易实战笔记》: 启动前缺乏右侧上涨趋势 + 底部堆积抄底筹码的标的,
   获利盘抛压的物理距离近, 次日冲高回落风险大 — 与综合评分独立, 只作风险预警不改分。
   判定: 近20日上涨收盘<3天(无右侧结构) 且 近5日均量/60日均量>1.5(底部量堆积) */
function calcPdLow(k) {
  if (!k || k.length < 65) return null;
  let upDays = 0;
  for (let j = Math.max(1, k.length - 20); j < k.length; j++) {
    if (k[j].c > k[j - 1].c) upDays++;
  }
  const v5 = k.slice(-5).reduce((a, r) => a + r.v, 0) / 5;
  const v60 = k.slice(-60).reduce((a, r) => a + r.v, 0) / 60;
  const vr560 = v60 > 0 ? v5 / v60 : 0;
  return {
    upDays: upDays,
    vr560: R2(vr560),
    noRight: upDays < 3,
    pileUp: vr560 > 1.5,
    hit: upDays < 3 && vr560 > 1.5,
  };
}

/* ═══════════ 野人哥·多空比值估算 (P1-1, v1.3.0) ═══════════
   《野人哥交易实战笔记》: 以 9010/8515/8020/7030 刻画个股多空力量结构。
   口径与本地增量回测(p1_fusion_analysis, 178笔基准)完全一致:
     win20 = 近20日上涨收盘占比 | vp = 阳线日均量/阴线日均量 | c vs MA20
   档位: 9010=win≥.65∧vp≥1.2∧c>MA20 | 8515=win≥.55∧c>MA20
         8020=win≥.45 | 7030=其余 (单调可解释, 不依赖未来数据)
   定位: 独立结构识别标签, 不并入四维评分 — 教训: 评分与未来收益反向单调,
   相位级动态仓位亦被证伪; 本卡片仅提示力量结构与战法匹配度。
   回测背书: 8020档 2进3打板胜率 18.92% (n=37, Fisher p=0.0001),
   剔除后全样本胜率 47.19%→54.61% (+7.42pp), 跨年方向一致(2024/2025均<20%)。 */
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

/* ═══════════ 操作建议合成 (v1.1.0 新增) ═══════════
   信号多空力量 + 综合评分 + 资金方向 + 量价关系 + 位阶位置 → 五档动作 + 入场/止损/目标/盈亏比 */
function calcAdvice(sigs, score, lvl, fund, k, ind) {
  const i = k.length - 1, c = k[i].c;
  const c1 = k[i - 1] || k[i];
  const pctToday = (c / c1.c - 1) * 100;

  /* 多空力量 (按置信度加权) */
  let bull = 0, bear = 0;
  sigs.forEach(s => { if (s.dir === 'buy') bull += s.conf; else bear += s.conf; });
  const net = bull - bear;

  /* 资金方向: 当日方向 + 近3日累计, 合成 -2..+2 */
  let fundDir = 0, fundTxt = '资金流数据缺失';
  if (fund && fund.rows && fund.rows.length) {
    const rows = fund.rows, fl = rows[rows.length - 1];
    const sum3 = rows.slice(-3).reduce((a, r) => a + r.main, 0);
    fundDir = (fl.main > 0 ? 1 : -1) + (sum3 > 0 ? 1 : -1);
    fundTxt = '当日主力' + (fl.main >= 0 ? '净流入 ' : '净流出 ') + fmtWan(Math.abs(fl.main) / 1e4) +
      (sum3 >= 0 ? ' · 近3日累计流入' : ' · 近3日累计流出');
  }

  /* 量价关系一句话 */
  const volAvg5 = k.slice(-6, -1).reduce((a, r) => a + r.v, 0) / 5;
  const vr = volAvg5 ? k[i].v / volAvg5 : 1;
  let pv;
  if (pctToday >= 1 && vr >= 1.3) pv = { t: '量价齐升', d: '放量上涨，多头主动，趋势延续概率较高', cls: 'up' };
  else if (pctToday >= 0.5 && vr < 0.85) pv = { t: '缩量上涨', d: '缩量上涨，抛压减轻但追涨动能有限', cls: 'up' };
  else if (pctToday <= -1 && vr >= 1.3) pv = { t: '放量下跌', d: '放量下跌，抛压沉重，短线规避', cls: 'down' };
  else if (pctToday <= -0.5 && vr < 0.85) pv = { t: '缩量回调', d: '缩量回调，浮筹清洗特征，关注支撑位企稳', cls: 'down' };
  else if (Math.abs(pctToday) < 0.5 && vr < 0.8) pv = { t: '缩量整理', d: '缩量横盘，方向待选择，等待放量确认', cls: '' };
  else if (Math.abs(pctToday) < 0.5 && vr >= 1.3) pv = { t: '放量滞涨', d: '放量滞涨，多空分歧加大，警惕变盘', cls: '' };
  else pv = { t: '量能温和', d: '量能温和，延续既有结构观察', cls: pctToday >= 0 ? 'up' : 'down' };

  /* 位阶位置 */
  const sup1 = lvl.levels.find(x => x.tag === '支撑①');
  const sup2 = lvl.levels.find(x => x.tag === '强支撑');
  const res1 = lvl.levels.find(x => x.tag === '压力①');
  const res2 = lvl.levels.find(x => x.tag === '强压力');
  const nearRes = res1 && (res1.p / c - 1) < 0.03;   // 距压力① 3%以内

  /* 决策矩阵: 五档动作 */
  let action, cls, plan;
  if (net >= 3 && score.total >= 60 && fundDir >= 1) {
    action = '积极关注'; cls = 'adv-strong';
    plan = '多头信号占优、资金配合、结构评分 ' + score.total + '，回踩支撑不破可分批参与';
  } else if (net >= 2 && score.total >= 45) {
    action = '轻仓试错'; cls = 'adv-mid';
    plan = '偏多信号存在但未全面共振（评分 ' + score.total + (fundDir < 0 ? '，资金未配合' : '') + '），轻仓验证、破位即止损';
  } else if (net <= -3 || (bear >= 3 && score.total < 45)) {
    action = '减仓避险'; cls = 'adv-weak';
    plan = '空头信号占优（净力量 ' + net + '），逢反弹降低仓位，暂不抄底';
  } else if (score.total < 35) {
    action = '空仓等待'; cls = 'adv-weak';
    plan = '结构评分仅 ' + score.total + '，量价结构偏弱，等待右侧放量信号再介入';
  } else {
    action = '持有观望'; cls = 'adv-hold';
    plan = '多空信号均衡（净力量 ' + net + '），维持既有仓位，按位阶区间高抛低吸';
  }

  /* 交易计划: 入场/止损/目标/盈亏比 (全部锚定位阶聚类, 不预测)
     v1.1.1: 突破入场(nearRes)时 entryNum=压力①, 目标①顺延到压力②, 避免盈亏比恒为0 */
  let entry = '—', entryTxt = '结构未给出明确锚点', entryNum = c;
  const sup = sup1 || sup2;
  if (nearRes && res1) {
    entry = '突破 ' + fmtNum(res1.p, 2) + ' 确认'; entryTxt = '现价贴近压力①，放量突破后回踩确认再介入';
    entryNum = res1.p;
  } else if (sup) {
    entry = fmtNum(sup.p, 2) + ' ±1%'; entryTxt = '回踩支撑' + (sup.tag === '强支撑' ? '(强) ' : '') + sup.p + ' 企稳分批，不追高';
    entryNum = sup.p;
  }
  const stopNum = sup ? Math.min(sup.p * 0.97, c * 0.95) : c * 0.95;
  const stop = fmtNum(stopNum, 2);
  const stopTxt = sup ? ('支撑失守 -3% 即离场（' + stop + '）') : '无支撑锚点, 按现价 -5% 纪律止损';
  const t1 = nearRes ? (res2 ? res2.p : R2(c * 1.06)) : (res1 ? res1.p : R2(c * 1.08));
  const t2 = nearRes ? (res2 ? R2(res2.p * 1.05) : R2(c * 1.12)) : (res2 ? res2.p : R2(c * 1.15));
  const rrRaw = (t1 - entryNum) / Math.max(entryNum - stopNum, 1e-9);
  return { action, cls, plan, bull, bear, net, pv, fundTxt, fundDir, nearRes: !!(nearRes && res1), entry, entryTxt, stop, stopTxt, t1, t2, rr: rrRaw > 0 ? R2(rrRaw) : 0, rrOk: rrRaw > 0 };
}


function baseOpt() {
  return { backgroundColor: 'transparent', textStyle: { fontFamily: '-apple-system, PingFang SC, sans-serif' } };
}
const axisStyle = {
  axisLine: { lineStyle: { color: 'rgba(60,60,67,.18)' } }, axisTick: { show: false },
  axisLabel: { color: '#929298', fontSize: 10.5 }, splitLine: { lineStyle: { color: 'rgba(60,60,67,.07)' } },
};

function renderKchart(el, k, ind, marks, levels) {
  const chart = echarts.init(el, null, { renderer: 'canvas' });
  const dates = k.map(r => r.d.slice(5));
  const upColor = { color: 'rgba(255,59,48,.9)', color0: 'rgba(52,199,89,.9)', borderColor: '#FF3B30', borderColor0: '#34C759' };
  const opt = baseOpt();
  opt.animationDuration = 400;
  opt.grid = [
    { left: 52, right: 16, top: 30, height: '52%' },
    { left: 52, right: 16, top: '68%', height: '10%' },
    { left: 52, right: 16, top: '83%', height: '13%' },
  ];
  opt.tooltip = { trigger: 'axis', axisPointer: { type: 'cross', label: { backgroundColor: 'rgba(29,29,31,.85)' } },
    backgroundColor: 'rgba(255,255,255,.94)', borderColor: 'rgba(15,23,42,.08)', textStyle: { color: '#1D1D1F', fontSize: 12 },
    extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);' };
  opt.axisPointer = { link: [{ xAxisIndex: 'all' }] };
  opt.xAxis = [0, 1, 2].map(gi => ({ type: 'category', gridIndex: gi, data: dates, ...axisStyle, axisLabel: gi === 2 ? axisStyle.axisLabel : { show: false }, boundaryGap: true }));
  opt.yAxis = [
    { gridIndex: 0, scale: true, ...axisStyle, splitNumber: 4 },
    { gridIndex: 1, scale: true, ...axisStyle, splitNumber: 2, axisLabel: { ...axisStyle.axisLabel, formatter: v => (v / 1e4).toFixed(0) + '万' } },
    { gridIndex: 2, scale: true, ...axisStyle, splitNumber: 2 },
  ];
  opt.series = [
    { name: 'K线', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, data: k.map(r => [r.o, r.c, r.l, r.h]), itemStyle: upColor,
      markPoint: marks && marks.length ? { symbolSize: 1, label: { show: false }, data: [] } : undefined,
      markLine: levels && levels.length ? { symbol: 'none', silent: true,
        lineStyle: { type: 'dashed', width: 1.2 }, label: { position: 'insideEndTop', fontSize: 10, fontWeight: 600 },
        data: levels.map(lv => ({ yAxis: lv.p, lineStyle: { color: lv.color + 'BB' }, label: { color: lv.color, formatter: lv.tag + ' ' + lv.p } })) } : undefined },
    { name: 'MA5', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ind.ma5, showSymbol: false, lineStyle: { width: 1.4, color: '#FF9500' }, itemStyle: { color: '#FF9500' } },
    { name: 'MA10', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ind.ma10, showSymbol: false, lineStyle: { width: 1.4, color: '#007AFF' }, itemStyle: { color: '#007AFF' } },
    { name: 'MA20', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ind.ma20, showSymbol: false, lineStyle: { width: 1.6, color: '#AF52DE' }, itemStyle: { color: '#AF52DE' } },
    { name: 'MA60', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ind.ma60, showSymbol: false, lineStyle: { width: 1.2, color: '#8E8E93' }, itemStyle: { color: '#8E8E93' } },
    { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: k.map(r => ({ value: r.v, itemStyle: { color: r.c >= r.o ? 'rgba(255,59,48,.55)' : 'rgba(52,199,89,.55)' } })) },
    { name: 'MACD', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, data: ind.hist.map(v => ({ value: v, itemStyle: { color: v >= 0 ? 'rgba(255,59,48,.6)' : 'rgba(52,199,89,.6)' } })) },
    { name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: ind.dif, showSymbol: false, lineStyle: { width: 1.2, color: '#007AFF' }, itemStyle: { color: '#007AFF' } },
    { name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: ind.sig, showSymbol: false, lineStyle: { width: 1.2, color: '#FF9500' }, itemStyle: { color: '#FF9500' } },
  ];
  // 买卖点三角标记 (最后一个信号若在近5日内)
  if (marks && marks.length) {
    opt.series[0].markPoint = {
      symbol: 'triangle', symbolSize: 11,
      data: marks.map(m => ({ coord: [m.d.slice(5), m.y], symbolRotate: m.dir === 'buy' ? 0 : 180,
        itemStyle: { color: m.dir === 'buy' ? ARED : AGREEN }, label: { show: false } })),
    };
  }
  opt.dataZoom = [
    { type: 'inside', xAxisIndex: [0, 1, 2], start: Math.max(0, 100 - 70), end: 100 },
  ];
  opt.legend = { top: 2, textStyle: { fontSize: 10.5, color: '#6E6E73' }, itemWidth: 14, itemHeight: 2, data: ['MA5', 'MA10', 'MA20', 'MA60'] };
  chart.setOption(opt);
  return chart;
}

/* ═══════════ 资金流卡片渲染 (v1.3.1 双口径切换) ═══════════
   候选池个股: primary=东财快照(逐日累积), sina=新浪60日 → chip 切换, 默认数据天数多的一方
   非候选池:   primary=新浪60日(单一口径无切换) */
let fundPair = null, fundView = 'primary';
function renderFundCard(pair) {
  fundPair = pair;
  if (!pair || !pair.primary || !pair.primary.rows || !pair.primary.rows.length) {
    $('fundMain').textContent = '—';
    $('fundDate').textContent = '获取失败';
    $('fundBars').innerHTML = '<div class="fund-note">资金流接口暂不可用，稍后重试</div>';
    $('fundSwitch').innerHTML = '';
    $('fundHistNote').textContent = '';
    return;
  }
  fundView = (pair.sina && pair.sina.rows.length > pair.primary.rows.length) ? 'sina' : 'primary';
  drawFundView();
}
function drawFundView() {
  const f = fundView === 'sina' ? fundPair.sina : fundPair.primary;
  if (!f || !f.rows || !f.rows.length) return;
  const fl = f.rows[f.rows.length - 1];
  const amtYi = Math.abs(fl.main) / 1e8;
  const mainEl = $('fundMain');
  mainEl.textContent = (fl.main >= 0 ? '+' : '-') + fmtNum(amtYi, 2) + '亿';
  mainEl.className = 'v ' + (fl.main >= 0 ? 'up' : 'down');
  $('fundDate').textContent = fl.d + (f.src === 'snap' ? ' · 每日快照' : f.src === 'sina' ? ' · 新浪口径 · 60日' : f.full ? '' : (f.src === 'snapshot' ? ' · 快照兜底 · 仅当日' : ' · 仅当日'));
  const isSina = f.src === 'sina';
  const mx = Math.max(Math.abs(fl.sup), Math.abs(fl.big), Math.abs(fl.mid), Math.abs(fl.small), 1);
  const rows = isSina
    ? [['特大单', fl.sup, ARED], ['大单', fl.big, '#FF6B5E'], ['中单', fl.mid, '#8E8E93'], ['小单', fl.small, AGREEN]]
    : [['超大单', fl.sup, ARED], ['大单', fl.big, '#FF6B5E'], ['中单', fl.mid, '#8E8E93'], ['小单', fl.small, AGREEN]];
  $('fundBars').innerHTML = rows.map(([n, v, c]) => {
    const w = Math.abs(v) / mx * 50;
    return '<div class="fb-row"><span class="fb-lab">' + n + '</span><div class="fb-track">' +
      '<i class="fb-fill" style="' + (v >= 0 ? 'left:50%;' : 'right:50%;') + 'width:' + w + '%;background:' + c + '"></i>' +
      '<i style="position:absolute;left:50%;top:0;bottom:0;width:.5px;background:rgba(60,60,67,.18)"></i></div>' +
      '<span class="fb-val ' + (v >= 0 ? 'up' : 'down') + '">' + (v >= 0 ? '+' : '') + fmtNum(v / 1e8, 2) + '亿</span></div>';
  }).join('');
  /* 切换 chip: 双口径可用且 primary 非新浪时展示 */
  const sw = $('fundSwitch');
  if (fundPair.sina && fundPair.primary && fundPair.primary.src !== 'sina') {
    const emLab = '东财 · ' + (fundPair.primary.full ? fundPair.primary.rows.length + '日' : '当日');
    sw.innerHTML = '<button type="button" class="fs-chip' + (fundView === 'primary' ? ' on' : '') + '" data-v="primary">' + emLab + '</button>' +
      '<button type="button" class="fs-chip' + (fundView === 'sina' ? ' on' : '') + '" data-v="sina">新浪 · ' + fundPair.sina.rows.length + '日</button>';
    sw.querySelectorAll('.fs-chip').forEach(btn => btn.addEventListener('click', () => {
      if (fundView === btn.dataset.v) return;
      fundView = btn.dataset.v;
      const old = echarts.getInstanceByDom($('fundHist'));
      if (old) old.dispose();
      drawFundView();
    }));
  } else { sw.innerHTML = ''; }
  /* 历史柱状 */
  const oldCh = echarts.getInstanceByDom($('fundHist'));
  if (oldCh) oldCh.dispose();
  const hist = f.rows.slice(-30);
  const ch = echarts.init($('fundHist'), null, { renderer: 'canvas' });
  const opt = baseOpt();
  opt.grid = { left: 56, right: 14, top: 18, bottom: 24 };
  opt.tooltip = { trigger: 'axis', backgroundColor: 'rgba(255,255,255,.94)', borderColor: 'rgba(15,23,42,.08)', textStyle: { color: '#1D1D1F', fontSize: 12 }, extraCssText: 'border-radius:10px;' };
  opt.xAxis = { type: 'category', data: hist.map(r => r.d.slice(5)), ...axisStyle };
  opt.yAxis = { type: 'value', ...axisStyle, axisLabel: { ...axisStyle.axisLabel, formatter: v => v + '亿' } };
  opt.series = [{
    name: '主力净流入', type: 'bar', data: hist.map(r => R2(r.main / 1e8)),
    itemStyle: { color: p => p.value >= 0 ? 'rgba(255,59,48,.75)' : 'rgba(52,199,89,.75)', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 14,
  }];
  ch.setOption(opt); currentCharts.push(ch);
  $('fundHistNote').textContent = (isSina
    ? '主力 = 特大单 + 大单，新浪口径 · 数据源为新浪60日历史(划分标准与东财不同，绝对值不可直接对比，同源趋势参考)'
    : '主力 = 超大单(单笔≥100万) + 大单(20~100万)，东财口径')
    + ' · 净流入率 ' + R2(fl.rate) + '% · 近' + hist.length + '日累计 ' + fmtNum(hist.reduce((a, r) => a + r.main / 1e8, 0), 2) + '亿'
    + (f.src === 'snap' ? '（东财历史自 2026-09-12 起逐日累积，可切换「新浪」查看60日完整趋势）' : f.full ? '' : '（历史接口受限，当前仅当日，趋势将随每日快照累积）')
    + (f.src === 'snapshot' ? ' · 快照兜底：中/小单合并计入小单' : isSina ? '' : ' · 与同花顺划分标准不同(≥20万即计大单)，数值差异属正常');
}

/* ═══════════ 个股诊断主流程 ═══════════ */
let currentCharts = [];
function disposeCharts() { currentCharts.forEach(c => { try { c.dispose(); } catch (e) {} }); currentCharts = []; }

async function diagnose(full) {
  $('stockEmpty').classList.add('hidden');
  $('stockResult').classList.remove('hidden');
  $('stockResult').style.opacity = '.4';
  disposeCharts();
  const mkt = full.slice(0, 2) === 'sh' ? '1' : '0';
  const code = full.slice(2);

  // 并行拉取
  const [kRes, qRes, fRes, btRes] = await Promise.allSettled([
    fetchKline(full, 130), fetchQuote(full), fetchFundFlow(mkt, code), fetchBlockTrade(code),
  ]);
  const k = kRes.status === 'fulfilled' ? kRes.value : [];
  const q = qRes.status === 'fulfilled' ? qRes.value : null;
  const fundPair = fRes.status === 'fulfilled' ? fRes.value : null;
  const fund = fundPair && fundPair.primary ? fundPair.primary : null;   // 信号/评分/建议: 主口径(东财优先)
  const bts = btRes.status === 'fulfilled' ? btRes.value : [];
  if (k.length < 70 || !q) {
    $('stockResult').style.opacity = '1';
    $('symName').textContent = '数据获取失败';
    $('symMetas').innerHTML = '<span>该标的可能已退市或接口异常，请重试 / 换一只</span>';
    return;
  }
  const ind = calcIndicators(k);
  const sigs = calcSignals(k, ind, fund);
  const lvl = calcLevels(k, ind);
  const score = calcScore(k, ind, fund);
  const pd = calcPdLow(k);

  /* 物理距离低系数卡片 (v1.2.0): 三态 — 双条件命中/单维度预警/通过
     [v1.4.0 P2] 附带决策映射: 触发→按空仓/持有两态给出可直接执行的动作 */
  const pdCard = $('pdCard');
  if (pdCard){
    if (pd){
      pdCard.style.display = '';
      const box = $('pdBox');
      const pdFlag = $('pdFlag'), pdDims = $('pdDims'), pdNote = $('pdNote'), pdAct = $('pdAct');
      pdDims.innerHTML = '近20日上涨收盘 <b>' + pd.upDays + ' 天</b>（阈值&lt;3 判无右侧结构） · 近5日/60日均量比 <b>' + pd.vr560 + ' 倍</b>（阈值&gt;1.5 判底部堆积）';
      if (pd.hit){
        box.className = 'pd-box';
        pdFlag.textContent = '物理距离低系数 · 抄底筹码型';
        pdNote.textContent = '该标的近20日缺乏右侧上涨结构且底部堆积抄底量，获利盘距现价物理距离近，次日冲高抛压大；即使评分高也应降低参与预期，等右侧结构确立后再评估。';
        pdAct.className = 'pd-act risk';
        pdAct.innerHTML = '<span class="act-hd">操作建议</span>空仓者<b>禁入</b>不抄底；持有者<b>减至 1% 或清仓</b>，反弹不补仓，止损可放宽至 <em>-5%</em>（该结构波动大）。回测：触发后3日下跌概率 <em>75%</em>（近1年 8 次，均 <em>-0.94%</em>）。';
      } else if (pd.noRight || pd.pileUp){
        box.className = 'pd-box half';
        pdFlag.textContent = '单维度预警' + (pd.noRight ? ' · 无右侧结构' : '') + (pd.pileUp ? ' · 底部量堆积' : '');
        pdNote.textContent = '仅触发单一条件，未构成完整抄底筹码型结构，按常规流程观察即可，但需留意' + (pd.noRight ? '趋势尚未确立' : '近期量能异常放大') + '。';
        pdAct.className = 'pd-act';
        pdAct.innerHTML = '<span class="act-hd">操作建议</span>按五档决策正常执行；重点跟踪' + (pd.noRight ? '右侧上涨结构是否确立（近20日上涨收盘是否达 3 天）' : '量能是否持续堆积演化为完整抄底筹码型') + '，达触发条件即按上表降级。';
      } else {
        box.className = 'pd-box pass';
        pdFlag.textContent = '物理距离检查通过';
        pdNote.textContent = '近20日右侧上涨结构正常且无明显底部抄底量堆积，抛压物理距离健康。';
        pdAct.className = 'pd-act';
        pdAct.innerHTML = '<span class="act-hd">操作建议</span>按五档决策正常执行，本维度无额外限制。';
      }
    } else {
      pdCard.style.display = 'none';
    }
  }

  /* 多空比值卡片 (P1-1, v1.3.0): 独立结构标签 — 8020档警示 / 强结构 / 分歧三态
     [v1.4.0 P2] 四档决策映射: 每档按空仓/持有两态给出动作+仓位+红线 */
  const bb = calcBullBear(k);
  const bbCard = $('bbCard');
  if (bbCard) {
    if (bb) {
      bbCard.style.display = '';
      const box = $('bbBox');
      const bbFlag = $('bbFlag'), bbDims = $('bbDims'), bbNote = $('bbNote'), bbAct = $('bbAct');
      const ratioTxt = bb.tier.slice(0, 2) + ':' + bb.tier.slice(2);
      bbDims.innerHTML = '近20日上涨收盘 <b>' + bb.ups + ' 天</b>（占比 ' + R2(bb.win20 * 100) + '%） · 阳/阴日均量比 <b>' + R2(bb.vp) + ' 倍</b> · 收盘' + (bb.above ? '<b>MA20 上方</b>' : 'MA20 下方');
      /* 四档决策映射 (仓位上限遵守单票2-3%·冰点期降级1%硬约束) */
      const BB_ACT = {
        '9010': '<span class="act-hd">操作建议</span>空仓者可入 ≤<em>3%</em> 追强势；持有者<b>趋势跟随</b>不逆势做T；红线：首次<b>跌破 MA5 减半</b>。',
        '8515': '<span class="act-hd">操作建议</span>空仓者可入 ≤<em>2.5%</em> 或回撤 MA10 低吸；持有者<b>回撤做T</b>降成本；红线：<b>跌破 MA10 减半</b>。',
        '8020': '<span class="act-hd">操作建议</span>空仓者<b>禁打板接力</b>，低吸需等下沿企稳；持有者<b>不追加</b>，反弹至压力位减仓；红线：单日 <em>-3%</em> 强制执行。',
        '7030': '<span class="act-hd">操作建议</span>空仓者<b>观望</b>；持有者<b>减至 1% 以下</b>；红线：分歧未收敛前<b>无条件减仓</b>。',
      };
      if (bb.tier === '8020') {
        box.className = 'pd-box';
        bbFlag.textContent = '多空比值 ' + ratioTxt + ' · ' + bb.label + ' · 结构警示';
        bbNote.textContent = '该档位在 2进3 打板回测中胜率仅 18.92%（n=37，Fisher p=0.0001），剔除后全样本胜率 +7.42pp，跨年方向一致；接力打板慎入，低吸/拉扯战法按各自纪律评估。本标签独立展示，不参与综合评分。';
        bbAct.className = 'pd-act risk';
        bbAct.innerHTML = BB_ACT['8020'] + ' 与五档决策冲突时以更谨慎者为准（本档已列入影子验证，4周后实盘定论）。';
      } else if (bb.tier === '9010' || bb.tier === '8515') {
        box.className = 'pd-box pass';
        bbFlag.textContent = '多空比值 ' + ratioTxt + ' · ' + bb.label;
        bbNote.textContent = '多方结构占优，适配「' + bb.mode + '」。独立结构识别标签，不参与综合评分。';
        bbAct.className = 'pd-act';
        bbAct.innerHTML = BB_ACT[bb.tier];
      } else {
        box.className = 'pd-box half';
        bbFlag.textContent = '多空比值 ' + ratioTxt + ' · ' + bb.label;
        bbNote.textContent = '「' + bb.mode + '」。该档位回测样本仅 5 笔，无统计结论，按常规纪律评估。独立展示，不参与综合评分。';
        bbAct.className = 'pd-act';
        bbAct.innerHTML = BB_ACT['7030'];
      }
    } else {
      bbCard.style.display = 'none';
    }
  }

  /* Header */
  const up = q.pct >= 0;
  $('symName').textContent = q.name;
  $('symCode').textContent = code + ' · ' + (full.slice(0, 2) === 'sh' ? '沪' : '深');
  $('symPrice').textContent = fmtNum(q.price, 2);
  $('symPrice').className = 'sym-price ' + (up ? 'up' : 'down');
  $('symPct').textContent = (up ? '+' : '') + fmtNum(q.pct, 2) + '%';
  $('symPct').className = 'sym-pct ' + (up ? 'up' : 'down');
  $('symMetas').innerHTML = [
    '今开 <b>' + fmtNum(q.open, 2) + '</b>', '最高 <b>' + fmtNum(q.high, 2) + '</b>', '最低 <b>' + fmtNum(q.low, 2) + '</b>',
    '成交 <b>' + fmtNum(q.amtWan / 1e4, 2) + '亿</b>', '换手 <b>' + fmtNum(q.turnover, 2) + '%</b>',
    '量比 <b>' + fmtNum(q.volRatio, 2) + '</b>', '流通 <b>' + fmtNum(q.floatMV, 0) + '亿</b>',
    '涨停 <b class="up">' + fmtNum(q.ztPrice, 2) + '</b>', '跌停 <b class="down">' + fmtNum(q.dtPrice, 2) + '</b>',
  ].map(s => '<span>' + s + '</span>').join('');
  // 评分环
  const arc = $('ringArc'), circ = 2 * Math.PI * 54;
  arc.setAttribute('stroke-dasharray', (score.total / 100 * circ) + ' ' + circ);
  const sc = score.total >= 70 ? AGREEN : (score.total >= 40 ? BLUE : ORANGE);
  arc.setAttribute('stroke', sc);
  $('ringNum').textContent = score.total;
  $('ringNum').setAttribute('fill', sc);
  $('ringLab').textContent = (score.total >= 70 ? '偏强结构' : score.total >= 40 ? '中性结构' : '偏弱结构') + ' · 模型输出非预测';

  /* K线 + 环境徽标 */
  const i = k.length - 1;
  const ma20v = ind.ma20[i], ma60v = ind.ma60[i];
  const maEnv = ma20v && ma60v ? (k[i].c > ma20v && ma20v > ma60v ? '多头·strong' : k[i].c > ma60v ? 'MA60上方·mid' : '弱势·weak') : '—';
  const envBadge = $('maEnvBadge');
  const envMap = { '多头·strong': ['b-red', '多头排列'], 'MA60上方·mid': ['b-blue', 'MA60上方'], '弱势·weak': ['b-orange', '双均线下方'] };
  const eb = envMap[maEnv] || ['b-gray', '—'];
  envBadge.className = 'badge2 ' + eb[0]; envBadge.textContent = eb[1];
  const marks = [];
  if (sigs.length) { const m = sigs[0]; marks.push({ d: k[i].d, y: m.dir === 'sell' ? k[i].h * 1.01 : k[i].l * 0.99, dir: m.dir }); }
  currentCharts.push(renderKchart($('kchart'), k, ind, marks, lvl.levels));
  $('klineNote').textContent = '前复权日线 · 虚线为聚类位阶 · 三角为最新信号方向；近20日区间 [' + R2(Math.min(...k.slice(-20).map(r => r.l))) + ', ' + R2(Math.max(...k.slice(-20).map(r => r.h))) + ']';

  /* 信号列表 */
  $('sigCount').textContent = sigs.length + ' 条';
  $('sigList').innerHTML = sigs.length ? sigs.map(s => {
    const conf = s.conf >= 3 ? ['b-red', '高'] : s.conf === 2 ? ['b-blue', '中'] : ['b-gray', '弱'];
    const ico = s.dir === 'buy' ? 'buy' : 'sell';
    const sym = s.dir === 'buy' ? '▲' : '▼';
    return '<div class="sig-row"><div class="sig-ico ' + ico + '">' + sym + '</div>' +
      '<div class="sig-body"><div class="sig-name">' + s.name + '<span class="badge2 ' + conf[0] + '">置信度' + conf[1] + '</span></div>' +
      '<div class="sig-desc">' + s.desc + '</div><div class="sig-why">依据: ' + s.why + '</div></div></div>';
  }).join('') : '<div class="sig-row"><div class="sig-ico info">i</div><div class="sig-body"><div class="sig-name">无有效信号</div><div class="sig-desc">当前量价结构未触发任何规则阈值，保持观望也是信号</div></div></div>';

  /* 操作建议 (v1.1.0): 量价/信号/资金/位阶 → 五档动作 + 交易计划 */
  const adv = calcAdvice(sigs, score, lvl, fund, k, ind);
  const actEl = $('advAction');
  actEl.textContent = adv.action;
  actEl.className = 'adv-action ' + adv.cls;
  const pvEl = $('advPv');
  pvEl.textContent = '量价 · ' + adv.pv.t;
  pvEl.title = adv.pv.d;
  pvEl.className = 'badge2 ' + (adv.pv.cls === 'up' ? 'b-red' : adv.pv.cls === 'down' ? 'b-green' : 'b-gray');
  const fdEl = $('advFund');
  fdEl.textContent = adv.fundTxt;
  fdEl.className = 'badge2 ' + (adv.fundDir > 0 ? 'b-red' : adv.fundDir < 0 ? 'b-green' : 'b-gray');
  $('advPlan').textContent = adv.plan;
  $('advBar').innerHTML = '<i class="b" style="flex:' + Math.max(adv.bull, .1) + '"></i><i class="s" style="flex:' + Math.max(adv.bear, .1) + '"></i>';
  $('advBull').textContent = adv.bull;
  $('advBear').textContent = adv.bear;
  const num2 = (v) => typeof v === 'number' ? fmtNum(v, 2) : String(v);
  const hasRes2 = lvl.levels.some(x => x.tag === '强压力');
  $('advPlanGrid').innerHTML = [
    ['入场参考', num2(adv.entry), adv.entryTxt],
    ['止损纪律', num2(adv.stop), adv.stopTxt],
    ['目标①', num2(adv.t1), adv.nearRes ? (hasRes2 ? '强压力锚点' : '突破延伸 +6%') : '压力①锚点'],
    ['目标②', num2(adv.t2), adv.nearRes ? '突破延伸目标' : (hasRes2 ? '强压力锚点' : '动量延伸 +15%')],
    ['盈亏比', adv.rrOk ? fmtNum(adv.rr, 2) : '—', adv.rrOk ? '(目标①−入场)÷(入场−止损)' : '目标低于入场价，结构异常'],
  ].map(([k2, v, s]) => '<div class="kpi"><div class="k">' + k2 + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>').join('');

  /* 位阶表 */
  $('lvlBody').innerHTML = lvl.levels.map(lv =>
    '<tr><td style="color:' + lv.color + '">' + lv.tag + '</td><td>' + fmtNum(lv.p, 2) + '</td><td class="' + (lv.dist >= 0 ? 'up' : 'down') + '">' + (lv.dist >= 0 ? '+' : '') + fmtNum(lv.dist, 2) + '%</td><td style="font-size:12px;color:var(--secondary)">' + lv.srcs.slice(0, 3).join(' / ') + '</td><td><div class="lvl-bar"><i style="width:' + Math.max(12, lv.score) + '%;background:' + lv.color + '"></i></div></td></tr>'
  ).join('') || '<tr><td colspan="5" style="color:var(--secondary)">数据不足</td></tr>';

  /* 资金流 (v1.3.1 双口径切换渲染) */
  renderFundCard(fundPair);

  /* 大宗(暗盘) */
  $('btCount').textContent = bts.length + ' 笔 · 近60日';
  if (bts.length) {
    const total = bts.reduce((a, x) => a + (x.DEAL_AMT || 0), 0) / 1e8;
    const avgP = bts.filter(x => x.PREMIUM_RATIO != null).reduce((a, x, _, arr) => a + (x.PREMIUM_RATIO || 0) / arr.length, 0);
    $('btSummary').innerHTML = '<div class="bt-grid">' +
      '<div class="bt-item"><div class="k">累计成交额</div><div class="v">' + fmtNum(total, 2) + '亿</div></div>' +
      '<div class="bt-item"><div class="k">平均折溢价</div><div class="v ' + (avgP >= 0 ? 'up' : 'down') + '">' + (avgP >= 0 ? '+' : '') + fmtNum(avgP, 2) + '%</div></div>' +
      '<div class="bt-item"><div class="k">最近一笔</div><div class="v" style="font-size:15px;">' + (bts[0].TRADE_DATE || '').slice(0, 10) + '</div></div>' +
      '</div>';
    $('btList').innerHTML = bts.slice(0, 10).map(x =>
      '<div class="bt-row"><div class="n"><b>' + x.SECURITY_NAME_ABBR + '</b><span class="c">' + fmtNum(x.DEAL_PRICE, 2) + '元</span></div>' +
      '<span class="amt">' + fmtNum((x.DEAL_AMT || 0) / 1e8, 2) + '亿</span>' +
      '<span class="pm ' + ((x.PREMIUM_RATIO || 0) >= 0 ? 'up' : 'down') + '">' + ((x.PREMIUM_RATIO || 0) >= 0 ? '+' : '') + fmtNum(x.PREMIUM_RATIO || 0, 2) + '%</span></div>'
    ).join('');
  } else {
    $('btSummary').innerHTML = '';
    $('btList').innerHTML = '<div class="fund-note" style="margin-top:10px;">近60日无大宗交易记录 — 该股暂无明显暗盘动向</div>';
  }
  $('stockResult').style.opacity = '1';
}

/* ═══════════ 搜索交互 ═══════════ */
const sInput = $('searchInput'), sGo = $('searchGo'), sBox = $('suggest');
let debTimer = null, curSug = [], curIdx = -1, lastQuery = '';

function hideSug() { sBox.classList.remove('show'); curIdx = -1; }
sInput.addEventListener('input', () => {
  clearTimeout(debTimer);
  const q = sInput.value.trim();
  if (q.length < 2) { hideSug(); return; }
  debTimer = setTimeout(async () => {
    try {
      curSug = await searchStock(q);
      if (!curSug.length) { hideSug(); return; }
      lastQuery = q;
      sBox.innerHTML = curSug.slice(0, 8).map((s, j) =>
        '<div class="sg-item" data-j="' + j + '"><b>' + s.name + '</b><span class="sg-code">' + s.code + '</span><span class="sg-mkt">' + (s.mkt === 'sh' ? '沪A' : '深A') + '</span></div>').join('');
      sBox.classList.add('show');
      sBox.querySelectorAll('.sg-item').forEach(el => el.addEventListener('click', () => pickSug(+el.dataset.j)));
    } catch (e) { hideSug(); }
  }, 300);
});
sInput.addEventListener('keydown', (e) => {
  if (!sBox.classList.contains('show')) { if (e.key === 'Enter') tryDirect(); return; }
  const items = sBox.querySelectorAll('.sg-item');
  if (e.key === 'ArrowDown') { curIdx = Math.min(curIdx + 1, items.length - 1); }
  else if (e.key === 'ArrowUp') { curIdx = Math.max(curIdx - 1, 0); }
  else if (e.key === 'Enter') { if (curIdx >= 0 && curSug[curIdx]) return pickSug(curIdx); tryDirect(); return; }
  else if (e.key === 'Escape') { hideSug(); return; }
  else return;
  e.preventDefault();
  items.forEach((el, j) => el.classList.toggle('on', j === curIdx));
});
function pickSug(j) { const s = curSug[j]; if (!s) return; hideSug(); sInput.value = s.name; diagnose(s.full); window.scrollTo({ top: 260, behavior: 'smooth' }); }
function tryDirect() {
  const q = sInput.value.trim();
  const m = q.match(/^(\d{6})$/);
  if (m) {
    const code = m[1];
    const full = (code[0] === '6' || code[0] === '5' || code[0] === '9') ? 'sh' + code : (code[0] === '4' || code[0] === '8') ? 'bj' + code : 'sz' + code;
    diagnose(full); window.scrollTo({ top: 260, behavior: 'smooth' });
  }
}
sGo.addEventListener('click', () => { if (curSug.length && sBox.classList.contains('show')) pickSug(0); else tryDirect(); });
document.addEventListener('click', (e) => { if (!sBox.contains(e.target) && e.target !== sInput) hideSug(); });

/* 快捷入口: 今日候选池 */
function renderChips() {
  const pools = (window.FUND_DATA && window.FUND_DATA.pools) || [];
  if (!pools.length) return;
  $('quickChips').innerHTML = '<span style="font-size:12px;color:var(--tertiary);align-self:center;">今日候选:</span>' +
    pools.slice(0, 9).map(p => '<button class="chip" data-full="' + p.f + '">' + p.n + '</button>').join('');
  $('quickChips').querySelectorAll('.chip').forEach(el => el.addEventListener('click', () => {
    sInput.value = el.textContent; diagnose(el.dataset.full); window.scrollTo({ top: 260, behavior: 'smooth' });
  }));
}
renderChips();

/* ═══════════ TAB 2: 大盘板块 ═══════════ */
/* v1.4.0 多周期轨道·海拔体系: 蒸馏自公开博主@Keep方法论, 按回测证据校准信号权重
   dk=上证日K, m20arr=日线SMA20序列(=日线布林中轨) */
async function renderOrbit(dk, m20arr) {
  const kpisEl = $('orbKpis'), ladderEl = $('orbLadder'), sigsEl = $('orbSigs');
  if (!kpisEl) return;
  try {
    const closes = dk.map(r => r.c);
    const i = closes.length - 1, c = closes[i];
    /* 日线BOLL(20,2) */
    const dm = m20arr[i];
    const seg20 = closes.slice(-20);
    const dsd = Math.sqrt(seg20.reduce((a, b) => a + (b - dm) * (b - dm), 0) / 20);
    const dUp = dm + 2 * dsd, dLow = dm - 2 * dsd;
    /* 60分钟 + 120分钟轨道(失败降级为日线级) */
    let m60 = [], m60mid = null, m60low = null, m60lowPrev = null, m120mid = null, divs = [], m60ok = false;
    try {
      m60 = await fetchM60(320);
      m60ok = m60.length >= 60;
    } catch (e) { m60ok = false; }
    if (m60ok) {
      const b60 = bollSeries(m60.map(r => r.c), 20, 2);
      const j = b60.mid.length - 1;
      m60mid = b60.mid[j]; m60low = b60.low[j];
      m60lowPrev = b60.low[Math.max(0, j - 4)];          /* 前一交易日下轨(4根/日) */
      const b120 = bollSeries(agg120(m60).map(r => r.c), 20, 2);
      m120mid = b120.mid[b120.mid.length - 1];
      divs = detectDiv60(m60);
    }
    /* 破位/收复状态: 收盘与日中轨的连续相对位置 */
    let belowRun = 0, justReclaimed = false;
    if (c < m20arr[i]) {
      for (let j2 = i; j2 >= 0 && m20arr[j2] != null; j2--) {
        if (closes[j2] < m20arr[j2]) belowRun++; else break;
      }
    } else if (i > 0 && m20arr[i - 1] != null && closes[i - 1] < m20arr[i - 1]) {
      justReclaimed = true;   /* 今日收复, 昨日尚在下方 */
    }
    const dist = (v) => v ? R2((c / v - 1) * 100) : null;

    $('orbDate').textContent = (dk[i].d || '').slice(0, 10).replace(/-/g, '/') + (m60ok ? ' · 含60分/120分' : ' · 仅日线级');

    /* KPI */
    $('orbKpis').innerHTML = [
      ['日线中轨 SMA20', fmtNum(dm, 2), (c >= dm ? '收盘上方 ' : '收盘下方 ') + dist(dm) + '%'],
      ['120分钟中轨', m120mid ? fmtNum(m120mid, 2) : '—', m120mid ? (c >= m120mid ? '收盘上方 ' : '收盘下方 ') + dist(m120mid) + '%' : '60分数据缺失'],
      ['60分钟中轨', m60mid ? fmtNum(m60mid, 2) : '—', m60mid ? (c >= m60mid ? '收盘上方 ' : '收盘下方 ') + dist(m60mid) + '%' : '60分数据缺失'],
      ['60分钟下轨', m60low ? fmtNum(m60low, 2) : '—', m60low && m60lowPrev ? (m60low >= m60lowPrev ? '抬升中 ↑' : '下移 ↓') : '—'],
    ].map(([k2, v, s]) => '<div class="kpi"><div class="k">' + k2 + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>').join('');

    /* 海拔梯: 日下轨 → 日上轨 */
    const span = Math.max(dUp - dLow, 0.01);
    const ladder = [
      ['日线上轨', dUp], ['120分中轨', m120mid], ['日线中轨', dm], ['60分中轨', m60mid],
      ['当前收盘', c, true], ['60分下轨', m60low], ['日线下轨', dLow],
    ].filter(x => x[1] != null);
    ladderEl.innerHTML = ladder.map(([n, v, cur]) => {
      const pos = Math.min(Math.max((v - dLow) / span * 100, 0), 100);
      return '<div class="orb-row' + (cur ? ' cur' : '') + '"><span class="orb-name">' + n + '</span>' +
        '<span class="orb-track"><i class="orb-dot" style="left:' + pos.toFixed(1) + '%"></i></span>' +
        '<span class="orb-val">' + fmtNum(v, 2) + '<small>' + (cur ? '距日中轨 ' + dist(dm) + '%' : '距收盘 ' + R2((v / c - 1) * 100) + '%') + '</small></span></div>';
    }).join('');

    /* 信号(按回测证据加权): 顶背离=规避预警 > 破位/收复状态 > 底背离观察 */
    const sigs = [];
    const recentTop = divs.filter(x => x.kind === 'top' && x.idx >= m60.length - 8);
    const recentBot = divs.filter(x => x.kind === 'bottom' && x.idx >= m60.length - 8);
    if (recentTop.length) {
      const t = recentTop[recentTop.length - 1];
      sigs.push(['sell', '▼', '60分钟顶背离预警',
        '价格创新高/平高但MACD·DIF未创新高，动能衰竭结构（' + t.dt.slice(4, 6) + '/' + t.dt.slice(6, 8) + ' ' + t.dt.slice(8, 10) + ':' + t.dt.slice(10, 12) + ' 第二个高点）',
        '回测近一年8次，其后3日下跌概率75%，平均-0.94% — 体系中最强规避信号，打板仓位应相应收敛']);
    }
    if (belowRun >= 1) {
      sigs.push(['warn', '!', '日线中轨下方 · 第' + belowRun + '日',
        '收盘 ' + fmtNum(c, 2) + ' 低于日线中轨 ' + fmtNum(dm, 2) + '（' + dist(dm) + '%）',
        '近3年37次破位后3日反弹概率64.86%（均值+0.46%）— 短线不宜恐慌割肉；若3日内收复中轨，收复后3日胜率63.16%']);
    } else if (justReclaimed) {
      sigs.push(['buy', '▲', '刚收复日线中轨',
        '收盘重新站上日线中轨 ' + fmtNum(dm, 2),
        '近3年38次收复后3日胜率63.16%，均值+0.45% — 收复确认比破位当日追空更可靠']);
    }
    if (recentBot.length) {
      sigs.push(['info', 'i', '60分钟底背离观察',
        '价格创新低/平低但MACD·DIF未创新低（' + recentBot[recentBot.length - 1].dt.slice(4, 6) + '/' + recentBot[recentBot.length - 1].dt.slice(6, 8) + '）',
        '回测近一年6次，3日胜率50%（+0.05%）— 统计上无显著优势，仅作观察不加仓']);
    }
    if (!sigs.length) {
      sigs.push(['info', 'i', '轨道中性区',
        '收盘位于日线中轨上方且无背离结构',
        '「中轨上方持有」在回测中无超额（次日胜率50.77% vs 下方59.20%）— 不作为加仓依据，仅描述位置']);
    }
    sigsEl.innerHTML = sigs.map(([ico, sym, name, desc, why]) =>
      '<div class="sig-row"><div class="sig-ico ' + ico + '">' + sym + '</div>' +
      '<div class="sig-body"><div class="sig-name">' + name + '</div>' +
      '<div class="sig-desc">' + desc + '</div><div class="sig-why">回测依据: ' + why + '</div></div></div>').join('');
  } catch (e) {
    kpisEl.innerHTML = '<div class="fund-note">多周期轨道获取失败，请稍后刷新。</div>';
  }
}

async function renderMarket() {
  const FD = window.FUND_DATA || {};
  const latest = FD.latest || {};

  /* 指数环境: 腾讯上证K线算 MA20/60 */
  let envK = null, envM20 = null;
  try {
    const k = await fetchKline('sh000001', 90);
    const closes = k.map(r => r.c);
    const ma = (w) => closes.map((_, i) => i < w - 1 ? null : closes.slice(i - w + 1, i + 1).reduce((a, b) => a + b, 0) / w);
    const m20 = ma(20), m60 = ma(60);
    envK = k; envM20 = m20;
    const i = k.length - 1, c = closes[i];
    const env = c > m20[i] && m20[i] > m60[i] ? 'strong' : c > m60[i] ? 'mid' : 'weak';
    const pill = $('mEnvPill');
    const envCfg = { strong: ['env-strong', '多头强势'], mid: ['env-mid', 'MA60上方震荡'], weak: ['env-weak', '弱势·双均线下方'] }[env];
    pill.className = 'env-pill ' + envCfg[0]; pill.textContent = envCfg[1];
    const ch = echarts.init($('idxChart'), null, { renderer: 'canvas' });
    const opt = baseOpt();
    opt.grid = { left: 54, right: 16, top: 16, bottom: 24 };
    opt.tooltip = { trigger: 'axis', backgroundColor: 'rgba(255,255,255,.94)', borderColor: 'rgba(15,23,42,.08)', textStyle: { color: '#1D1D1F', fontSize: 12 }, extraCssText: 'border-radius:10px;' };
    opt.xAxis = { type: 'category', data: k.map(r => r.d.slice(5)), ...axisStyle, boundaryGap: false };
    opt.yAxis = { type: 'value', scale: true, ...axisStyle };
    opt.series = [
      { name: '上证', type: 'line', data: closes, showSymbol: false, lineStyle: { width: 2.2, color: BLUE }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(0,122,255,.18)' }, { offset: 1, color: 'rgba(0,122,255,0)' }] } },
        markLine: { symbol: 'none', silent: true, lineStyle: { type: 'dashed', width: 1.2 },
          data: [{ yAxis: R2(m20[i]), lineStyle: { color: '#AF52DE' }, label: { color: '#AF52DE', formatter: 'MA20 ' + R2(m20[i]), position: 'insideEndTop' } },
                 { yAxis: R2(m60[i]), lineStyle: { color: '#8E8E93' }, label: { color: '#8E8E93', formatter: 'MA60 ' + R2(m60[i]), position: 'insideEndTop' } }] } },
      { name: 'MA20', type: 'line', data: m20, showSymbol: false, lineStyle: { width: 1.4, color: '#AF52DE' }, itemStyle: { color: '#AF52DE' } },
      { name: 'MA60', type: 'line', data: m60, showSymbol: false, lineStyle: { width: 1.2, color: '#8E8E93' }, itemStyle: { color: '#8E8E93' } },
    ];
    ch.setOption(opt); currentCharts.push(ch);
    $('idxKpis').innerHTML = [
      ['收盘', fmtNum(c, 2), 'MA20 ' + (c >= m20[i] ? '上方' : '下方')],
      ['距MA20', R2((c / m20[i] - 1) * 100) + '%', R2((c / m60[i] - 1) * 100) + '% 距MA60'],
      ['20日位置', Math.round((c - Math.min(...closes.slice(-20))) / (Math.max(...closes.slice(-20)) - Math.min(...closes.slice(-20))) * 100) + '% 分位', '近20日区间内'],
      ['近5日', R2((c / closes[i - 5] - 1) * 100) + '%', '近20日 ' + R2((c / closes[i - 20] - 1) * 100) + '%'],
    ].map(([k2, v, s]) => '<div class="kpi"><div class="k">' + k2 + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>').join('');
  } catch (e) {
    $('idxChart').innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:var(--secondary);font-size:13px;">指数K线获取失败</div>';
  }

  /* v1.4.0 多周期轨道·海拔体系 (日线K线复用, 60分钟线另拉) */
  if (envK) renderOrbit(envK, envM20);

  /* 大盘资金流 (快照累积 + 当日) */
  const idx = latest.index || {};
  const sh = idx.sh;
  $('mFundDate').textContent = latest.date || '—';
  if (sh) {
    $('mIdxFund').innerHTML = [['上证', sh.main, sh.rate], ['深成', idx.sz ? idx.sz.main : null, idx.sz ? idx.sz.rate : null], ['创业板', idx.cyb ? idx.cyb.main : null, idx.cyb ? idx.cyb.rate : null]]
      .filter(x => x[1] !== null && x[1] !== undefined)
      .map(([n, v, r]) => '<div class="kpi"><div class="k">' + n + '主力净流入</div><div class="v ' + (v >= 0 ? 'up' : 'down') + '">' + fmtYi(v) + '</div><div class="s">净流入率 ' + fmtNum(r, 2) + '%</div></div>').join('');
  }
  const ih = FD.idx_hist || [];
  if (ih.length) {
    const ch = echarts.init($('mFundChart'), null, { renderer: 'canvas' });
    const opt = baseOpt();
    opt.grid = { left: 56, right: 14, top: 30, bottom: 24 };
    opt.tooltip = { trigger: 'axis', backgroundColor: 'rgba(255,255,255,.94)', borderColor: 'rgba(15,23,42,.08)', textStyle: { color: '#1D1D1F', fontSize: 12 }, extraCssText: 'border-radius:10px;' };
    opt.legend = { top: 0, textStyle: { fontSize: 10.5, color: '#6E6E73' }, itemWidth: 12, itemHeight: 8 };
    opt.xAxis = { type: 'category', data: ih.map(x => x.date.slice(4)), ...axisStyle };
    opt.yAxis = { type: 'value', ...axisStyle, axisLabel: { ...axisStyle.axisLabel, formatter: v => v + '亿' } };
    const mk = (key, name, color) => ({ name, type: 'bar', data: ih.map(x => x[key] ? x[key].main : null), itemStyle: { color: p => p.value >= 0 ? color.replace('.7', '.9').replace('#FF3B30', 'rgba(255,59,48,.85)').replace('#007AFF', 'rgba(0,122,255,.85)') : color, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 12 });
    opt.series = [mk('sh', '上证', 'rgba(255,59,48,.7)'), mk('sz', '深成', 'rgba(0,122,255,.7)'), mk('cyb', '创业板', 'rgba(175,82,222,.7)')];
    ch.setOption(opt); currentCharts.push(ch);
    if (ih.length < 3) $('mFundNote').textContent += ' 当前历史 ' + ih.length + ' 日，趋势自快照启用日(' + ih[0].date + ')起逐日累积。';
  }

  /* 板块资金流 */
  const secs = latest.sectors || [], tail = latest.sectors_tail || [];
  if (secs.length) {
    const ch = echarts.init($('sectorChart'), null, { renderer: 'canvas' });
    const opt = baseOpt();
    opt.grid = { left: 76, right: 48, top: 8, bottom: 24 };
    opt.tooltip = { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(255,255,255,.94)', borderColor: 'rgba(15,23,42,.08)', textStyle: { color: '#1D1D1F', fontSize: 12 }, extraCssText: 'border-radius:10px;' };
    const s12 = secs.slice(0, 12).reverse();
    opt.xAxis = { type: 'value', ...axisStyle, axisLabel: { ...axisStyle.axisLabel, formatter: v => v + '亿' } };
    opt.yAxis = { type: 'category', data: s12.map(s => s.name), ...axisStyle, axisLabel: { ...axisStyle.axisLabel, fontSize: 11, color: '#1D1D1F', fontWeight: 600 } };
    opt.series = [{ type: 'bar', data: s12.map(s => s.main), barMaxWidth: 15,
      itemStyle: { color: p => p.value >= 0 ? 'rgba(255,59,48,.78)' : 'rgba(52,199,89,.78)', borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', fontSize: 10, fontWeight: 700, color: '#6E6E73', formatter: p => fmtNum(p.value, 2) } }];
    ch.setOption(opt); currentCharts.push(ch);
    $('sectorTail').innerHTML = tail.map(s =>
      '<div class="sec-row"><span class="sec-name">' + s.name + '</span><div class="sec-track"><i class="sec-fill" style="right:0;width:' + Math.min(Math.abs(s.main) / 12 * 100, 100) + '%;background:rgba(52,199,89,.65)"></i></div><span class="sec-val down">' + fmtNum(s.main, 2) + '亿</span></div>').join('');
  }

  /* 暗盘汇总 */
  const bt = latest.block;
  if (bt) {
    $('mBtDate').textContent = bt.date;
    $('mBtGrid').innerHTML = [
      ['成交总额', fmtNum(bt.amt, 2) + '亿'], ['总笔数', bt.count + ' 笔'],
      ['平均折溢价', fmtNum(bt.avg_prem, 2) + '%', bt.avg_prem >= 0 ? 'up' : 'down'],
      ['折价/溢价笔数', bt.disc_cnt + ' / ' + bt.prem_cnt],
    ].map(([k2, v, cls]) => '<div class="bt-item"><div class="k">' + k2 + '</div><div class="v ' + (cls || '') + '">' + v + '</div></div>').join('');
    $('mBtBody').innerHTML = (bt.top || []).map(x =>
      '<tr><td><b>' + x.name + '</b> <span style="font-size:11px;color:var(--tertiary)">' + x.code + '</span></td><td>' + fmtNum(x.amt, 2) + '亿</td><td class="' + (x.prem >= 0 ? 'up' : 'down') + '">' + fmtNum(x.prem, 2) + '%</td><td style="font-size:11.5px;color:var(--secondary)">' + x.buyer + '</td></tr>').join('');
    $('mBtBuyers').innerHTML = (bt.hot_buyers || []).map(b =>
      '<div class="bt-row"><div class="n"><b>' + b.name + '</b></div><span class="amt" style="color:var(--primary)">' + b.n + ' 笔接盘</span></div>').join('');
  }
}

/* Tab 切换 */
const tStock = $('tabStock'), tMarket = $('tabMarket');
let marketLoaded = false;
function switchTab(which) {
  const isStock = which === 'stock';
  tStock.classList.toggle('on', isStock); tMarket.classList.toggle('on', !isStock);
  $('viewStock').classList.toggle('hidden', !isStock);
  $('viewMarket').classList.toggle('hidden', isStock);
  if (!isStock && !marketLoaded) { marketLoaded = true; renderMarket(); }
  window.scrollTo({ top: 0 });
}
tStock.addEventListener('click', () => switchTab('stock'));
tMarket.addEventListener('click', () => switchTab('market'));

/* URL 参数直达: stock.html?code=sz002161 或 ?tab=market */
(function () {
  const u = new URLSearchParams(location.search);
  if (u.get('tab') === 'market') switchTab('market');
  const code = u.get('code');
  if (code && /^\d{6}$/.test(code)) {
    const full = (code[0] === '6' || code[0] === '5') ? 'sh' + code : 'sz' + code;
    sInput.value = code; diagnose(full);
  }
})();

})();
