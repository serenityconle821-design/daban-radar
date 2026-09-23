/* three.js v1.2.0 — 三时段作战室逻辑
   数据: premarket_data.js(PREMARKET_DATA) + intraday_data.js(INTRADAY_DATA) + settle_data.js(SETTLE_DATA)
         + 腾讯JSONP实时轮询(竞价雷达/盘中指数, 浏览器直连零token)
   渲染: 盘前温度计gauge+贡献条+隔夜明细+命中率 | 盘中情绪/资金/时点曲线+竞价雷达+尾盘异动+RT实时作战 | 盘后复盘全景
   声明: 全部为条件概率观察, 非预测, 不构成投资建议
   v1.0.1: 手动点击Tab后phaseLocked锁定, 每秒时段自动迁移仅在未锁定时执行, 横幅追加锁定提示
   v1.1.0: 新增RT实时作战引擎(三路AI设计合成): 实时MA20中轨精确进场点位+两级MACD顶背离盘中预警
           (60主/30前置/15尾盘)+攻防决策树(进攻/防守/观望/预警)+次日预判(明日中轨/支撑/压力)。
           数据: 日K(fqkline)+m60/m30/m15/m1(mkline)+实时quote+恒指, 全部浏览器直连腾讯零token
   v1.1.1: 修复明日中轨预估公式(分子需含今收+明收假设两个p, 原仅一个导致偏低约现价/20);
           支撑/压力改以明日中轨为基准, 与次日预判口径一致
   v1.1.2: 新增外弧预警第四通道(野人哥·P1, 独立AI方案合成): 价格创新高∧内部空头量占比抬升=表强实弱
           空头bar(m5)=阴线(c<o)或假阳/冲高回收(c>=o且c<前收); S_d=当日空头bar量占比;
           M5=近5完整日S_d均值 vs M5p=前5日; 新高=日内高>max(前19完整日收盘);
           观察(黄)=新高∧今日S_d>1.10×M5 | 预警(橙)=新高∧M5>1.2×M5p
           确认(红)=预警∧现价>=0.995×max(日内高,19日收盘高)·当日锁存防闪烁;
           与div60/div30/div15并行独立不打架, 确认级进决策树「预警」层+风险点
   v1.2.0: 盘前外围升级 — ①日经改东财push2delay实时源(新浪int_nikkei已失效返回旧值)
           ②新增韩国KOSPI(韩综)展示+温度计权重10% ③新增美股三大期货CME实时展示组
           ④温度计新权重: 美股45/A50·25/韩综10/日经5/港股5/CNH10(配套premarket_fetch.py v1.1.0)
   v1.2.1: 盘后「明日关注」改读主系统荐股(window.SITE_DATA · data.js 15:32生成), 与主看板
           荐股区同源: M/S/A梯队+挂单价(昨收+5%)+两年胜率·均值+仓位; 弃用settle_data.js的
           tomorrow.candidates(源自9/1一次性脚本tomorrow_candidates.json, 已停更三周数据过期)。
           B级3进4停用档与炸板≥3淘汰标的折叠为灰字附注(需three.html先加载data.js) */
(function () {
'use strict';

const $ = (id) => document.getElementById(id);
const R2 = (x) => Math.round(x * 100) / 100;
const ARED = '#FF3B30', AGREEN = '#34C759', BLUE = '#007AFF', ORANGE = '#FF9500', GRAY = '#8E8E93';
const FONT = '"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",-apple-system,sans-serif';
let cbSeq = 0;

/* ═══ 腾讯 JSONP (GBK) — 复用诊断中心成熟封装 ═══ */
function tencent(url, varName, timeout) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.charset = 'gbk';
    s.src = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
    let iv = null, tm = null;
    const cleanup = () => { clearInterval(iv); clearTimeout(tm); delete window[varName]; s.remove(); };
    tm = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout || 8000);
    iv = setInterval(() => {
      if (window[varName] !== undefined) { const v = window[varName]; cleanup(); resolve(v); }
    }, 40);
    s.onerror = () => { cleanup(); reject(new Error('network')); };
    document.head.appendChild(s);
  });
}

/* v1.1.0 多变量版: qt.gtimg.cn 实测忽略 _var 参数, 按每个代码分配 v_代码 变量
   (q=sh000001,hkHSI → v_sh000001="..";v_hkHSI="..";), 需同时轮询多个变量名 */
function tencentMulti(url, varNames, timeout) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.charset = 'gbk';
    s.src = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
    let iv = null, tm = null;
    const cleanup = () => { clearInterval(iv); clearTimeout(tm); varNames.forEach(n => delete window[n]); s.remove(); };
    tm = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout || 8000);
    iv = setInterval(() => {
      if (window[varNames[0]] !== undefined) {
        const out = varNames.map(n => window[n]);
        cleanup(); resolve(out);
      }
    }, 40);
    s.onerror = () => { cleanup(); reject(new Error('network')); };
    document.head.appendChild(s);
  });
}

/* 腾讯指数报价: sh000001/sz399001/sz399006 */
async function fetchIdxQuote(code) {
  const v = await tencent('https://qt.gtimg.cn/q=' + code, 'v_' + code, 7000);
  const f = String(v).split('~');
  if (f.length < 50) throw new Error('fields');
  return {
    name: (f[1] || '').replace(/\s+/g, ''),
    price: +f[3], prevClose: +f[4],
    pct: R2(+f[32]),
    time: (f[30] || '').split(' ')[1] || f[30] || '',
  };
}

/* ═══ 时段判定 ═══ */
function currentPhase() {
  const now = new Date();
  const day = now.getDay();                 // 0周日 6周六
  const m = now.getHours() * 60 + now.getMinutes();
  if (day === 0 || day === 6) return 'post';
  if (m < 9 * 60 + 30) return 'pre';
  if (m < 15 * 60 + 10) return 'mid';
  return 'post';
}

const PHASE_TXT = {
  pre: ['盘前时段', '隔夜外围已定格 · A股竞价未开启 — 以下为盘前预判依据'],
  mid: ['盘中时段', '快照 + 实时轮询进行中 — 情绪 / 资金 / 异动尽收'],
  post: ['盘后时段', '当日数据已定格 — 复盘与明日关注已生成'],
};

let phase = 'pre';
let phaseLocked = false;   /* 手动切换后锁定: 时段自动迁移暂停, 刷新页面恢复自动 */
let charts = {};

function setPhase(p) {
  phase = p;
  $('viewPre').classList.toggle('hidden', p !== 'pre');
  $('viewMid').classList.toggle('hidden', p !== 'mid');
  $('viewPost').classList.toggle('hidden', p !== 'post');
  $('phPre').classList.toggle('on', p === 'pre');
  $('phMid').classList.toggle('on', p === 'mid');
  $('phPost').classList.toggle('on', p === 'post');
  const t = PHASE_TXT[p];
  $('pbTxt').innerHTML = '<b>' + t[0] + '</b> — ' + t[1] +
    (phaseLocked ? ' · <span style="color:#007AFF;font-weight:600;">手动锁定 (刷新恢复自动)</span>' : '');
  renderLiveCards();
  setTimeout(() => { Object.values(charts).forEach(c => c && c.resize()); }, 60);
}

/* ══════════════ 盘前渲染 ══════════════ */
function pctClass(p) { return p > 0 ? 'up' : (p < 0 ? 'down' : ''); }
function fmtSigned(x, suffix) {
  return (x > 0 ? '+' : '') + x.toFixed(2) + (suffix || '%');
}

function gaugeClass(score) {
  if (score >= 40) return 'g-hi';
  if (score >= 15) return 'g-warm';
  if (score > -15) return 'g-mid';
  if (score > -40) return 'g-cool';
  return 'g-lo';
}

function renderPre() {
  const d = window.PREMARKET_DATA;
  if (!d || !d.gauge) return;
  const g = d.gauge;

  /* 数据时间 */
  $('gaugeTime').textContent = d.date + ' ' + (d.fetchTime || '');

  /* gauge 主体 */
  const ARC = Math.PI * 110;                 // 半圆弧长 ≈ 345.6
  if (g.score === null || g.score === undefined) {
    $('gaugeNum').textContent = '—';
    $('gaugeSub').textContent = '数据不足';
    $('gaugeLabel').textContent = '数据不足';
    $('gaugeLabel').className = 'gauge-label-hero g-mid';
    $('gaugeNote').style.display = 'block';
    $('gaugeNote').textContent = '当前有效权重 ' + (g.wsum || 0) + '% (<50%)，外围数据源部分缺失，本次温度计判定无效。';
    return;
  }
  const s = Math.max(-100, Math.min(100, g.score));
  const p = (s + 100) / 200;
  const arc = $('gaugeArc');
  arc.setAttribute('stroke-dasharray', (p * ARC).toFixed(1) + ' 999');
  arc.setAttribute('stroke', s >= 15 ? 'url(#ggRed)' : (s <= -15 ? 'url(#ggGreen)' : '#8E8E93'));
  $('gaugeNum').textContent = (s > 0 ? '+' : '') + s.toFixed(2);
  $('gaugeSub').textContent = '外围综合温度';
  $('gaugeLabel').textContent = g.label || '—';
  $('gaugeLabel').className = 'gauge-label-hero ' + gaugeClass(s);
  $('gaugeHint').textContent = g.hint || '';
  $('gaugeMeta').innerHTML =
    '<span class="badge2 b-gray">数据时点 ' + (d.date || '') + ' ' + (d.fetchTime || '') + '</span>' +
    '<span class="badge2 b-gray">有效权重 ' + (g.wsum || 100) + '%</span>' +
    '<span class="badge2 b-blue">美股45 · A50·25 · 韩综10 · CNH·10 · 日经5 · 港股5</span>';

  /* 贡献条形 */
  const maxC = 45;                          // 满分贡献 = 权重30×1.5
  $('contribRows').innerHTML = (g.items || []).map(it => {
    const c = it.contrib || 0;
    const w = Math.min(Math.abs(c), maxC) / maxC * 50;
    const fill = c >= 0
      ? '<i class="ct-fill pos" style="width:' + w.toFixed(2) + '%"></i>'
      : '<i class="ct-fill neg" style="width:' + w.toFixed(2) + '%"></i>';
    return '<div class="ct-row">' +
      '<span class="ct-name">' + it.name + (it.inverse ? '<span style="font-size:9px;color:var(--tertiary);font-weight:600;"> 反</span>' : '') + '</span>' +
      '<span class="ct-pct ' + pctClass(it.pct) + '">' + fmtSigned(it.pct) + '</span>' +
      '<span class="ct-track"><i class="ct-zero"></i>' + fill + '</span>' +
      '<span class="ct-val ' + pctClass(c) + '">' + (c >= 0 ? '+' : '') + c.toFixed(2) + '</span>' +
      '</div>';
  }).join('');
}

function qRow(name, price, pct, time, unit) {
  return '<div class="q-row">' +
    '<span class="n">' + name + '</span>' +
    '<span class="p">' + price.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + (unit || '') + '</span>' +
    '<span class="c ' + pctClass(pct) + '">' + fmtSigned(pct) + '</span>' +
    '<span class="t">' + (time || '') + '</span>' +
    '</div>';
}

function renderOvernight() {
  const d = window.PREMARKET_DATA;
  if (!d) return;
  let html = '';
  if ((d.us || []).length) {
    html += '<div class="q-group-title">美股 · 隔夜收盘</div>';
    d.us.forEach(u => { html += qRow(u.name, u.price, u.pct, u.time); });
  }
  if ((d.usfut || []).length) {
    html += '<div class="q-group-title">美股期货 · CME实时</div>';
    d.usfut.forEach(u => { html += qRow(u.name, u.price, u.pct, (u.time || '') + ' 实时'); });
  }
  if (d.a50 || d.nikkei || d.kospi || d.fx) {
    html += '<div class="q-group-title">亚洲 · A50 / 日经 / 韩综 / 人民币</div>';
    if (d.a50) html += qRow(d.a50.name || 'A50期货', d.a50.price, d.a50.pct, d.a50.time + ' 定格');
    if (d.nikkei) html += qRow(d.nikkei.name, d.nikkei.price, d.nikkei.pct, (d.nikkei.time || '') + ' 实时');
    if (d.kospi) html += qRow(d.kospi.name, d.kospi.price, d.kospi.pct, (d.kospi.time || '') + ' 实时');
    if (d.fx) html += qRow(d.fx.name, d.fx.price, d.fx.pct, '');
  }
  if ((d.hk || []).length) {
    html += '<div class="q-group-title">港股 · 昨收盘</div>';
    d.hk.forEach(h => { html += qRow(h.name, h.price, h.pct, h.time); });
  }
  if ((d.comm || []).length) {
    html += '<div class="q-group-title">大宗商品 · 夜盘</div>';
    d.comm.forEach(c => { html += qRow(c.name, c.price, c.pct, c.time); });
  }
  $('overnightRows').innerHTML = html || '<div class="empty-note">暂无隔夜数据</div>';
}

function renderVerifyChart() {
  const s = window.SETTLE_DATA;
  const hist = (s && s.verifyHist) || [];
  const stats = (s && s.verifyStats) || null;
  if (stats) {
    $('verifyStatsBadge').textContent = stats.n
      ? '样本 ' + stats.n + ' · 开盘命中 ' + (stats.openHitRate === null ? '—' : stats.openHitRate + '%')
      : '待累积';
  } else {
    $('verifyStatsBadge').textContent = '待累积';
  }
  const el = $('verifyChart');
  if (!hist.length) {
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--tertiary);font-size:13px;">验证样本待每日盘后复盘累积 (每日一条)</div>';
    return;
  }
  if (!window.echarts) return;
  if (charts.verify) charts.verify.dispose();
  const c = echarts.init(el);
  charts.verify = c;
  c.setOption({
    grid: { left: 46, right: 46, top: 28, bottom: 26 },
    tooltip: { trigger: 'axis', textStyle: { fontSize: 12 } },
    legend: { data: ['温度计', '上证开盘%'], top: 0, textStyle: { fontSize: 11 } },
    xAxis: { type: 'category', data: hist.map(h => (h.date || '').slice(5)), axisLabel: { fontSize: 10 } },
    yAxis: [
      { type: 'value', name: '温度', min: -100, max: 100, splitLine: { lineStyle: { color: 'rgba(120,120,128,.10)' } }, axisLabel: { fontSize: 10 } },
      { type: 'value', name: '开盘%', splitLine: { show: false }, axisLabel: { fontSize: 10, formatter: v => v + '%' } },
    ],
    series: [
      {
        name: '温度计', type: 'bar', data: hist.map(h => ({
          value: h.gauge,
          itemStyle: { color: h.gauge >= 0 ? ARED : AGREEN, opacity: h.openHit ? 1 : 0.38, borderRadius: 3 },
        })),
        barMaxWidth: 26,
      },
      { name: '上证开盘%', type: 'line', yAxisIndex: 1, symbol: 'circle', symbolSize: 6,
        lineStyle: { color: BLUE, width: 2 }, itemStyle: { color: BLUE } },
    ],
  });
}

/* ══════════════ 盘中渲染 ══════════════ */
function renderMid() {
  const d = window.INTRADAY_DATA;
  if (!d || !d.latest) {
    $('midEmotion').innerHTML = '<div class="empty-note">盘中快照待生成 (计划任务 10:30 / 14:00 / 14:30 触发)</div>';
    return;
  }
  const L = d.latest;
  $('midTime').textContent = L.date + ' ' + (L.time || '');

  /* 情绪仪表 */
  if (!L.trading || !L.emotion) {
    $('midEmotion').innerHTML = '<div class="empty-note">最新快照为非交易日标记 (' + (L.date || '') + ')，等待下一交易日盘中数据。</div>';
  } else {
    const e = L.emotion;
    const lad = Object.entries(e.ladder || {}).map(([lb, n]) => lb + '板×' + n).join(' → ');
    $('midEmotion').innerHTML =
      '<div class="kpi-grid">' +
      kpi('涨停(全口径)', e.zt, '家') +
      kpi('涨停(核心)', e.ztCore, '主板10cm·非ST') +
      kpi('炸板', e.zb, '家') +
      kpi('跌停', e.dt, '家') +
      kpi('封板率', R2(e.sealRate), '%') +
      kpi('最高连板', e.maxLb, '核心口径') +
      '</div>' +
      (lad ? '<div style="margin-top:12px;"><span class="badge2 b-blue">连板梯队 ' + lad + '</span></div>' : '');
  }

  /* 指数资金流 */
  const idx = L.idxFlow || {};
  $('midIdxFund').innerHTML = ['sh', 'sz', 'cyb'].map(k => {
    const v = idx[k];
    if (!v) return '';
    return kpi(v.name, (v.main >= 0 ? '+' : '') + R2(v.main), '亿 · 净率 ' + fmtSigned(v.rate) + ' · ' + fmtSigned(v.pct));
  }).join('');

  /* 板块条形 */
  const maxAbs = (arr) => Math.max(1, ...arr.map(x => Math.abs(x.main || 0)));
  const barHtml = (arr) => arr.map(x => {
    const pct = Math.abs(x.main) / maxAbs(arr) * 100;
    const red = x.main >= 0;
    return '<div class="sec-row">' +
      '<span class="sec-name">' + x.name + '</span>' +
      '<span class="sec-track"><i class="sec-fill" style="width:' + pct.toFixed(1) + '%;background:' + (red ? 'linear-gradient(90deg,#FF6B5E,#FF3B30)' : 'linear-gradient(90deg,#34C759,#52D06B)') + ';"></i></span>' +
      '<span class="sec-val ' + (red ? 'up' : 'down') + '">' + (x.main >= 0 ? '+' : '') + R2(x.main) + '亿</span>' +
      '</div>';
  }).join('');
  $('midSectorIn').innerHTML = barHtml((L.sectors || {}).inTop || []);
  $('midSectorOut').innerHTML = barHtml((L.sectors || {}).outTop || []);

  /* 尾盘异动 */
  if (L.tail) {
    $('tailCard').style.display = 'block';
    const t = L.tail;
    let html = '<div class="kpi-grid">' +
      kpi('涨停增减', (t.ztDelta >= 0 ? '+' : '') + t.ztDelta, '相对 ' + (t.prevTime || '前次')) +
      kpi('核心涨停增减', (t.ztCoreDelta >= 0 ? '+' : '') + t.ztCoreDelta, '家') +
      kpi('封板率变化', fmtSigned(t.sealDelta), 'pp') +
      '</div>';
    if ((t.accelerate || []).length) {
      html += '<div class="q-group-title" style="margin-top:16px;">尾盘加速流入板块</div>' +
        t.accelerate.map(m => '<div class="q-row"><span class="n">' + m.name + '</span>' +
          '<span class="c up">+' + R2(m.delta) + '亿 增量</span>' +
          '<span class="t">累计 ' + fmtSigned(m.main) + '亿</span></div>').join('');
    } else {
      html += '<div class="empty-note">尾盘无显著加速流入板块 (阈值: 净流入增加 ≥ 1亿)</div>';
    }
    $('tailBody').innerHTML = html;
  } else {
    $('tailCard').style.display = 'none';
  }

  renderMidSeries(d.series || []);
}

function kpi(k, v, s) {
  return '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div>' +
    (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
}

function emoSeriesOption(points) {
  return {
    grid: { left: 44, right: 44, top: 28, bottom: 26 },
    tooltip: { trigger: 'axis', textStyle: { fontSize: 12 } },
    legend: { data: ['涨停家数', '封板率%'], top: 0, textStyle: { fontSize: 11 } },
    xAxis: { type: 'category', data: points.map(p => String(p.time || '').slice(0, 5)), axisLabel: { fontSize: 10 } },
    yAxis: [
      { type: 'value', name: '家', min: 0, splitLine: { lineStyle: { color: 'rgba(120,120,128,.10)' } }, axisLabel: { fontSize: 10 } },
      { type: 'value', name: '%', min: 0, max: 100, splitLine: { show: false }, axisLabel: { fontSize: 10 } },
    ],
    series: [
      { name: '涨停家数', type: 'bar', data: points.map(p => p.zt), itemStyle: { color: ARED, borderRadius: 3 }, barMaxWidth: 30 },
      { name: '封板率%', type: 'line', yAxisIndex: 1, data: points.map(p => p.sealRate),
        symbol: 'circle', symbolSize: 6, lineStyle: { color: BLUE, width: 2 }, itemStyle: { color: BLUE } },
    ],
  };
}

function renderMidSeries(series) {
  const points = series.filter(s => s && s.trading && s.emo).map(s => ({
    time: s.time, zt: s.emo.zt, sealRate: R2(s.emo.sealRate),
  }));
  const el = $('midSeries');
  if (!points.length) {
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--tertiary);font-size:13px;">当日时点数据待盘中快照累积</div>';
    return;
  }
  if (!window.echarts) return;
  if (charts.midSeries) charts.midSeries.dispose();
  charts.midSeries = echarts.init(el);
  charts.midSeries.setOption(emoSeriesOption(points));
}

/* ═══ 实时卡片 (竞价雷达 / 盘中指数) ═══ */
const IDX_CODES = [['sh000001', '上证指数'], ['sz399001', '深证成指'], ['sz399006', '创业板指']];
let liveTimer = null;

function inAuction() {
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  return now.getDay() >= 1 && now.getDay() <= 5 && m >= 9 * 60 + 14 && m < 9 * 60 + 31;
}
function inSession() {
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  return now.getDay() >= 1 && now.getDay() <= 5 && m >= 9 * 60 + 30 && m < 15 * 60 + 10;
}

async function pollIdx(gridId) {
  try {
    const rs = await Promise.all(IDX_CODES.map(([, n], i) => fetchIdxQuote(IDX_CODES[i][0]).catch(() => null)));
    $(gridId).innerHTML = rs.map((r, i) => r
      ? '<div class="live-item"><div class="k">' + (r.name || IDX_CODES[i][1]) + '</div>' +
        '<div class="v">' + R2(r.price) + '</div>' +
        '<div class="s ' + pctClass(r.pct) + '">' + fmtSigned(r.pct) + '</div>' +
        '<div class="tm">' + r.time + '</div></div>'
      : '<div class="live-item"><div class="k">' + IDX_CODES[i][1] + '</div><div class="v">—</div></div>').join('');
  } catch (e) { /* 静默重试 */ }
}

/* v1.1.0 统一实时数据主循环: 三指数+恒指一次拉取(避免与RT引擎抢同一window变量),
   渲染 liveIdxGrid 并把上证全字段+恒指喂给RT引擎 */
async function masterTick() {
  try {
    const rs = await tencentMulti('https://qt.gtimg.cn/q=sh000001,sz399001,sz399006,hkHSI',
      ['v_sh000001', 'v_sz399001', 'v_sz399006', 'v_hkHSI'], 7000);
    const parse = v => String(v).split('~');
    const fs = [parse(rs[0]), parse(rs[1]), parse(rs[2])];
    $('liveIdxGrid').innerHTML = fs.map((f, i) => f.length >= 40
      ? '<div class="live-item"><div class="k">' + ((f[1] || '').replace(/\s+/g, '') || IDX_CODES[i][1]) + '</div>' +
        '<div class="v">' + R2(+f[3]) + '</div>' +
        '<div class="s ' + pctClass(R2(+f[32])) + '">' + fmtSigned(R2(+f[32])) + '</div>' +
        '<div class="tm">' + ((f[30] || '').split(' ')[1] || f[30] || '') + '</div></div>'
      : '<div class="live-item"><div class="k">' + IDX_CODES[i][1] + '</div><div class="v">—</div></div>').join('');
    const fA = fs[0];
    if (fA.length >= 40) {
      const hb = rs[3] ? parse(rs[3]) : null;
      const hsi = (hb && hb.length > 35 && !isNaN(+hb[32])) ? { pct: R2(+hb[32]), price: +hb[3] } : null;
      RT.ingest({
        price: +fA[3], prevClose: +fA[4], open: +fA[5],
        high: +fA[33], low: +fA[34], vol: +fA[36], time: fA[30] || '',
      }, hsi);
    }
  } catch (e) { /* 静默重试 */ }
}

function renderLiveCards() {
  const auction = phase === 'mid' && inAuction();
  const live = phase === 'mid' && inSession();
  $('auctionCard').style.display = auction ? 'block' : 'none';
  $('liveIdxCard').style.display = live ? 'block' : 'none';
  /* RT 实时作战面板: 盘中Tab内常显(引擎自适应 live/pre/frozen/closed 模式) */
  $('rtCard').style.display = phase === 'mid' ? 'block' : 'none';
  if (phase === 'mid') RT.start(); else RT.stop();
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (auction) {
    pollIdx('auctionGrid');
    liveTimer = setInterval(() => { if (phase === 'mid' && inAuction()) pollIdx('auctionGrid'); else renderLiveCards(); }, 8000);
  } else if (live) {
    masterTick();
    liveTimer = setInterval(() => { if (phase === 'mid' && inSession()) masterTick(); else renderLiveCards(); }, 15000);
  } else {
    /* 盘中Tab但非交易时段(盘前/盘后/休市锁定): 30秒督导, 转9:30交易时段自动重挂主循环 */
    liveTimer = setInterval(() => {
      if (phase !== 'mid' || inSession() || inAuction()) renderLiveCards();
    }, 30000);
  }
}

/* ══════════════ RT 实时作战引擎 v1.1.0 ══════════════
   设计来源: 三路AI并行设计答案合成 (2026-09-12)
   Q1 实时中轨精确点位: MA20_t=(Σ前19完整日收盘+实时价)/20 · 收复三级确认(上穿后3分钟站稳·最低不破中轨0.999·
      现价≥中轨×1.001·VWAP上方) · 进场价=确认时刻中轨×1.001(精确0.01) · 一级防守=破中轨0.10%减仓 · 二级防守=破下轨(2σ)退出
   Q2 两级顶背离: 60分钟主周期(确认后调整0.5~2个交易日)+30分钟前置验证+15分钟尾盘逃顶 · 摆动顶5K窗口·两顶间隔≥8根·
      DIF差≥0.3×ATR(DIF)防钝化·两顶DIF同在零上 · 一级形成中=价格实时新高+DIF较前峰衰减≥max(δ,50%峰值) ·
      二级确认=收线结构背离成立(距今≤5根)+现价未收复前顶 · 一级供盯盘预警、二级才执行减仓
   Q3 攻防决策: 进攻四条件=站稳中轨(现价上方+3根5分钟收盘+回踩低≥0.999)×量比≥1.5(近5分/前30分)×无背离×
      外围(温度计≥60且恒指≥-0.3%) · 防守优先级=背离确认>破中轨(2根5分钟)>外围恶化(温度计<40或恒指≤-1%) ·
      缩量反抽(量比<0.8)=观望 · 中轨±0.3%内30分钟穿越≥3次=观望 · 背离形成中=预警(仓位上限50%)
   次日预判: 明日中轨=(S19-最早1根+今收+明收假设)/20 · 支撑=min(明日中轨×0.99,今日低) · 压力=max(明日中轨×1.01,今日高) */
const RT = (function () {
  const st = {
    running: false, timers: [], mode: null, err: null,
    daily: null, m60: null, m30: null, m15: null, m1: null,
    quote: null, hsi: null, prev19: null, yVol: null,
    ma20: null, sd: null, upper: null, lower: null,
    vwap: null, vr: null, buckets: [], activeDay: null,
    above: { since: null, ok: false },
    entry: { confirmed: false, price: null, time: null, broken: false },
    div60: { level: 'nodata' }, div30: { level: 'nodata' }, div15: { level: 'nodata' },
    m5: null, arc: { level: 'nodata' },
    cross30: 0, preScore: null, dec: null,
  };

  /* ── 模式: live实时 / pre盘前预估 / frozen盘后定格 / closed休市 ── */
  function rtMode() {
    const n = new Date(), day = n.getDay(), m = n.getHours() * 60 + n.getMinutes();
    if (day === 0 || day === 6) return 'closed';
    if (m >= 9 * 60 + 30 && m < 15 * 60) return 'live';
    if (m >= 15 * 60) return 'frozen';
    return 'pre';
  }
  function todayStr() {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  }
  function nowHMS() { return new Date().toTimeString().slice(0, 8); }
  function isTail() {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes() >= 14 * 60 + 30;
  }

  /* ── 数据层: 日K 40根(fqkline, 分离今日实时根) ── */
  async function rtFetchDaily() {
    const varName = 'rtd_' + (cbSeq++);
    const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,40,qfq&_var=' + varName;
    const d = await tencent(url, varName, 10000);
    const rows = (d && d.data && d.data.sh000001 && (d.data.sh000001.qfqday || d.data.sh000001.day)) || [];
    if (rows.length < 21) throw new Error('daily empty');
    const ks = rows.map(r => ({ d: String(r[0]), c: +r[2], v: +r[5] }));
    const full = ks[ks.length - 1].d === todayStr() ? ks.slice(0, -1) : ks;   // 完整交易日(不含今日实时根)
    if (full.length < 19) throw new Error('daily short');
    return {
      prev19: full.slice(-19).map(k => k.c),                                  // 前19完整日收盘
      yVol: full[full.length - 1].v,                                          // 昨日成交量
    };
  }

  /* ── 数据层: 分钟K(mkline, 双域名兜底, 同 diag.js v1.4.1 结论) ── */
  async function rtFetchMk(p, n) {
    const varName = 'rt' + p + '_' + (cbSeq++);
    const param = 'param=sh000001,' + p + ',,' + n + '&_var=' + varName;
    const hosts = [
      'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline',
      'https://web.ifzq.gtimg.cn/appstock/app/kline/mkline',
    ];
    let rows = [];
    for (const h of hosts) {
      try {
        const d = await tencent(h + '?' + param, varName, 10000);
        rows = (d && d.data && d.data.sh000001 && d.data.sh000001[p]) || [];
        if (rows.length) break;
      } catch (e) { /* 尝试下一域名 */ }
    }
    if (!rows.length) throw new Error(p + ' empty');
    return rows.map(r => ({ d: String(r[0]), o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5] }));
  }

  /* ── 数据层: 实时报价(上证全字段+恒指, qt.gtimg.cn 按代码分配v_变量, 用多变量轮询) ── */
  async function rtFetchQuote() {
    const rs = await tencentMulti('https://qt.gtimg.cn/q=sh000001,hkHSI', ['v_sh000001', 'v_hkHSI'], 7000);
    const f = String(rs[0]).split('~');
    if (f.length < 40 || !f[3]) throw new Error('quote fields');
    const q = {
      price: +f[3], prevClose: +f[4], open: +f[5],
      high: +f[33], low: +f[34], vol: +f[36], time: f[30] || '',
    };
    const hb = rs[1] ? String(rs[1]).split('~') : null;
    if (hb && hb.length > 35 && !isNaN(+hb[32])) q._hsi = { pct: R2(+hb[32]), price: +hb[3] };
    return q;
  }

  /* ── MACD·DIF (EMA12-EMA26, 同 diag.js 口径) ── */
  function emaArr(vals, w) {
    const out = []; const kk = 2 / (w + 1); let e = null;
    for (const x of vals) { e = e === null ? x : x * kk + e * (1 - kk); out.push(e); }
    return out;
  }
  function difArr(closes) {
    const f = emaArr(closes, 12), s = emaArr(closes, 26);
    return closes.map((_, i) => f[i] - s[i]);
  }

  /* ── Q2: 顶背离状态(参数化周期, 不等K线收线即可评估) ── */
  function divStatus(bars, price, liveBar) {
    if (!bars || bars.length < 30) return { level: 'nodata' };
    const closed = liveBar ? bars.slice(0, -1) : bars.slice();   // live模式下最后一根视为未走完
    const closes = closed.map(r => r.c);
    if (closes.length < 30) return { level: 'nodata' };
    const difC = difArr(closes);
    const difRt = difArr(closes.concat([price]));               // 追加实时价逼近实时DIF
    /* 摆动顶: 5K窗口(中心最高且唯一) */
    const hi = [];
    for (let i = 2; i < closes.length - 2; i++) {
      const w = closes.slice(i - 2, i + 3);
      if (closes[i] === Math.max(...w) && w.filter(x => x === closes[i]).length === 1) hi.push(i);
    }
    if (!hi.length) return { level: 'none' };
    const P1 = hi[hi.length - 1];                               // 最近确认局部顶
    /* δ = 0.3 × ATR(DIF): 最近20根DIF一阶差绝对值均值(自适应防钝化) */
    const dd = [];
    for (let i = Math.max(1, difC.length - 20); i < difC.length; i++) dd.push(Math.abs(difC[i] - difC[i - 1]));
    const delta = 0.3 * (dd.length ? dd.reduce((a, b) => a + b, 0) / dd.length : 0);
    /* P0: 与P1间隔≥8根的前一顶 */
    let P0 = null;
    for (let j = hi.length - 2; j >= 0; j--) if (P1 - hi[j] >= 8) { P0 = hi[j]; break; }
    /* 二级「确认」: 收线结构背离成立 + 距今≤5根 + 现价未收复前顶 */
    if (P0 !== null && difC[P0] > 0 && difC[P1] > 0 &&
        closes[P1] >= closes[P0] * 0.999 && difC[P1] < difC[P0] - delta &&
        closes.length - 1 - P1 <= 5 && price < closes[P1]) {
      return { level: 'confirmed', p0: R2(closes[P0]), p1: R2(closes[P1]),
        drop: (difC[P0] - difC[P1]) / Math.max(Math.abs(difC[P0]), 0.01) };
    }
    /* 一级「形成中」: 现价创新高 + 实时DIF较前峰衰减 ≥ max(δ, 50%前峰) */
    if (difC[P1] > 0 && price > closes[P1]) {
      const dec = difC[P1] - difRt[difRt.length - 1];
      if (dec >= Math.max(delta, 0.5 * Math.abs(difC[P1]))) {
        return { level: 'forming', p1: R2(closes[P1]),
          drop: dec / Math.max(Math.abs(difC[P1]), 0.01) };
      }
    }
    return { level: 'none' };
  }

  /* ── P1-2: 外弧预警(野人哥) — 价格新高 ∧ 内部空头量占比抬升 = 表强实弱 ──
     独立第四预警通道, 与MACD顶背离并行互不干扰。
     空头bar(m5): 阴线(c<o) 或 假阳/冲高回收(c>=o 且 c<前收)
     S_d = 当日空头bar成交量占比 | M5 = 近5完整日S_d均值 | M5p = 前5完整日均值
     新高: 日内高 > max(前19完整日收盘)  级联: 确认(当日锁存) > 预警 > 观察 */
  function arcCalc(p) {
    if (!st.m5 || st.m5.length < 240 || !st.prev19 || !st.quote) { st.arc = { level: 'nodata' }; return; }
    const byDay = new Map();
    st.m5.forEach(r => {
      const d = r.d.slice(0, 8);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    });
    const days = [...byDay.keys()].sort();
    if (days.length < 6) { st.arc = { level: 'nodata' }; return; }
    const today = days[days.length - 1];
    const full = days.slice(0, -1);
    const sOf = rows => {
      let vb = 0, va = 0, prevC = null;
      rows.forEach(r => {
        if ((r.c < r.o) || (r.c >= r.o && prevC !== null && r.c < prevC)) vb += r.v;
        va += r.v;
        prevC = r.c;
      });
      return va > 0 ? vb / va : null;
    };
    const last5 = full.slice(-5).map(d => sOf(byDay.get(d))).filter(x => x !== null);
    const prev5 = full.slice(-10, -5).map(d => sOf(byDay.get(d))).filter(x => x !== null);
    if (last5.length < 3) { st.arc = { level: 'nodata' }; return; }
    const M5 = last5.reduce((a, b) => a + b, 0) / last5.length;
    const M5p = prev5.length >= 3 ? prev5.reduce((a, b) => a + b, 0) / prev5.length : null;
    const sToday = sOf(byDay.get(today));
    const maxC19 = Math.max.apply(null, st.prev19);
    const nh = st.quote.high > maxC19;
    const lift = M5p ? M5 / M5p : null;
    const a0 = { level: 'none', sToday: sToday, m5: M5, m5p: M5p, lift: lift, nh: nh,
      locked: false, lockDay: null };
    /* 当日确认锁存(防闪烁): 确认后当日保持, 次日自动解除 */
    if (st.arc && st.arc.locked && st.arc.lockDay === today) {
      st.arc = Object.assign(a0, { level: 'confirmed', locked: true, lockDay: today });
      return;
    }
    if (nh && lift !== null && lift > 1.2) {
      if (p >= 0.995 * Math.max(st.quote.high, maxC19)) {
        a0.level = 'confirmed'; a0.locked = true; a0.lockDay = today;
      } else {
        a0.level = 'warn';
      }
    } else if (nh && sToday !== null && M5 > 0 && sToday > M5 * 1.10) {
      a0.level = 'watch';
    }
    st.arc = a0;
  }

  /* ── 当日m1 → VWAP / 量比 / 5分钟桶 ── */
  function buildIntraday() {
    st.vwap = null; st.vr = null; st.buckets = []; st.activeDay = null;
    if (!st.m1 || !st.m1.length) return;
    const day = st.m1[st.m1.length - 1].d.slice(0, 8);
    const rows = st.m1.filter(r => r.d.slice(0, 8) === day);
    if (!rows.length) return;
    st.activeDay = day;
    let sv = 0, sc = 0;
    rows.forEach(r => { sv += r.c * (r.v || 0); sc += (r.v || 0); });
    st.vwap = sc > 0 ? sv / sc : null;                          // 指数分钟量加权均价
    const n = rows.length;
    const avg = a => a.length ? a.reduce((x, y) => x + (y.v || 0), 0) / a.length : 0;
    const a30 = avg(rows.slice(Math.max(0, n - 35), Math.max(0, n - 5)));
    st.vr = a30 > 0 ? avg(rows.slice(Math.max(0, n - 5))) / a30 : null;   // 量比: 近5分/前30分
    const map = new Map();
    rows.forEach(r => {
      const hh = r.d.slice(8, 10), mm = +r.d.slice(10, 12);
      const k = day + hh + String(Math.floor(mm / 5) * 5).padStart(2, '0');
      if (!map.has(k)) map.set(k, { c: r.c, l: r.l, h: r.h });
      else { const b = map.get(k); b.c = r.c; b.l = Math.min(b.l, r.l); b.h = Math.max(b.h, r.h); }
    });
    st.buckets = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
  }

  /* ── Q3: 攻防决策树 ── */
  function decide(p) {
    const ma = st.ma20;
    const b = st.buckets;
    const r3 = b.slice(-4, -1);                                 // 最近3根已收线5分钟
    const holdOk = p > ma && r3.length === 3 && r3.every(x => x.c > ma) && r3.every(x => x.l >= ma * 0.999);
    const volOk = st.vr !== null && st.vr >= 1.5;
    const divClean = st.div60.level === 'none' && st.div30.level === 'none' && st.div15.level === 'none';
    const preOk = st.preScore !== null && st.preScore >= 60;
    const hsiOk = !st.hsi || st.hsi.pct >= -0.3;
    const envOk = preOk && hsiOk;
    const conf = [holdOk, volOk, divClean, envOk].filter(Boolean).length;
    /* 防守优先级(高→低, 命中即返回) */
    if (st.div60.level === 'confirmed')
      return { act: '防守', conf, reasons: [
        '60分钟顶背离已确认 · 前顶' + st.div60.p0 + ' → ' + st.div60.p1 + ' DIF衰减' + R2((st.div60.drop || 0) * 100) + '%',
        '对应日线级别调整通常 0.5~2 个交易日 · 减仓防守'] };
    const r2 = b.slice(-3, -1);
    if (p < ma && r2.length === 2 && r2.every(x => x.c < ma))
      return { act: '防守', conf, reasons: [
        '跌破日中轨 ' + ma.toFixed(2) + ' · 连续2根5分钟收盘确认',
        '一级防守位 ' + R2(ma * 0.999).toFixed(2) + ' 已失守 · 减仓, 破下轨 ' + st.lower.toFixed(2) + ' 退出'] };
    if (st.preScore !== null && st.preScore < 40)
      return { act: '防守', conf, reasons: ['外围温度计 ' + st.preScore.toFixed(2) + ' (<40) · 外围恶化'] };
    if (st.hsi && st.hsi.pct <= -1.0)
      return { act: '防守', conf, reasons: ['恒指 ' + fmtSigned(st.hsi.pct) + ' (≤-1.0%) · 外围恶化'] };
    if (p > ma && st.vr !== null && st.vr < 0.8)
      return { act: '观望', conf, reasons: [
        '缩量反抽 · 量比 ' + st.vr.toFixed(2) + ' (<0.8)',
        '反弹至中轨上方但量能不继 · 不追高'] };
    const hit = [['60分钟', st.div60], ['30分钟', st.div30], ['15分钟', st.div15]]
      .find(([, dv]) => dv.level === 'forming' || dv.level === 'confirmed');
    if (hit)
      return { act: '预警', conf, reasons: [
        hit[0] + '顶背离形成中 · 价格新高但DIF较前峰衰减' + R2((hit[1].drop || 0) * 100) + '%',
        '仓位上限降至50% · 若DIF死叉DEA升级为防守'] };
    /* P1-2: 外弧确认级 → 预警(独立第四通道, 优先级低于MACD背离) */
    if (st.arc && st.arc.level === 'confirmed')
      return { act: '预警', conf, reasons: [
        '外弧确认 · 价格新高但内部空头量占比抬升' +
          (st.arc.m5 !== null && st.arc.lift !== null
            ? '（近5日空头量占比' + R2(st.arc.m5 * 100) + '% · 为前5日的' + R2(st.arc.lift * 100) + '%）' : ''),
        '表强实弱 · 仓位上限50% · 与MACD背离独立互不覆盖'] };
    if (Math.abs(p - ma) / ma <= 0.003 && st.cross30 >= 3)
      return { act: '观望', conf, reasons: [
        '中轨反复争夺 · 35分钟内穿越' + st.cross30 + '次',
        '±0.3%内震荡 · 待5分钟收盘突破0.3%以上再决策'] };
    if (conf === 4)
      return { act: '进攻', conf, reasons: [
        '收复并站稳日中轨 · 近3根5分钟收盘均在中轨上方',
        '量能放大 · 量比 ' + st.vr.toFixed(2) + ' (≥1.5)',
        '无顶背离 · 60/30/15分钟全清',
        st.preScore !== null ? '外围配合 · 温度计 ' + st.preScore.toFixed(2) + ' (≥60)'
          : '外围配合 · 恒指' + fmtSigned(st.hsi ? st.hsi.pct : 0)] };
    /* 默认观望: 列出未满足项 */
    const miss = [];
    if (!holdOk) miss.push(p > ma ? '中轨站稳待确认 (需3根5分钟收盘站上)' : '现价位于中轨下方');
    if (!volOk) miss.push(st.vr === null ? '量比待分时数据' : '量比 ' + st.vr.toFixed(2) + ' (<1.5)');
    if (!divClean) miss.push('顶背离状态未清');
    if (!envOk) miss.push(st.preScore === null ? '温度计数据缺失' : '温度计 ' + st.preScore.toFixed(2) + ' (<60)');
    return { act: '观望', conf, reasons: miss.length ? miss : ['等待信号'] };
  }

  /* ── 核心计算(每次行情刷新后) ── */
  function rtCalc() {
    const q = st.quote;
    if (!q || !st.prev19) return;
    const p = q.price;
    /* Q1: 实时中轨 = (Σ前19完整日收盘 + 实时价) / 20, 上下轨±2σ */
    const s19 = st.prev19.reduce((a, b) => a + b, 0);
    st.ma20 = (s19 + p) / 20;
    const seg = st.prev19.concat([p]);
    st.sd = Math.sqrt(seg.reduce((a, b) => a + (b - st.ma20) * (b - st.ma20), 0) / 20);
    st.upper = st.ma20 + 2 * st.sd;
    st.lower = st.ma20 - 2 * st.sd;
    buildIntraday();
    /* Q1: 收复三级确认状态机(3分钟站稳·最低不破0.999·高于1.001·VWAP上方) */
    if (p >= st.ma20 * 0.999) {
      if (!st.above.since) st.above.since = Date.now();
      if (Date.now() - st.above.since >= 180000 && p >= st.ma20 * 1.001
          && (st.vwap === null || p > st.vwap)) {
        if (!st.above.ok) {
          st.above.ok = true;
          st.entry.confirmed = true; st.entry.broken = false;
          st.entry.price = R2(st.ma20 * 1.001);                 // 进场价精确至0.01
          st.entry.time = nowHMS();
        }
      }
    } else {
      st.above.since = null; st.above.ok = false;
      if (st.entry.confirmed && !st.entry.broken) st.entry.broken = true;
    }
    /* Q2: 两级背离(60主/30前置/15尾盘, live模式最后一根视为未走完) */
    const liveBar = st.mode === 'live';
    st.div60 = divStatus(st.m60, p, liveBar);
    st.div30 = divStatus(st.m30, p, liveBar);
    st.div15 = isTail() ? divStatus(st.m15, p, liveBar) : { level: 'none' };
    /* P1-2: 外弧预警(独立第四通道) */
    arcCalc(p);
    /* 边界态: 近35分钟5分钟桶收盘相对中轨的翻转次数 */
    st.cross30 = 0;
    const bs = st.buckets.slice(-7);
    for (let i = 1; i < bs.length; i++) {
      if ((bs[i - 1].c >= st.ma20) !== (bs[i].c >= st.ma20)) st.cross30++;
    }
    /* 盘前温度计(08:45管道产出) */
    const pre = window.PREMARKET_DATA && window.PREMARKET_DATA.gauge && window.PREMARKET_DATA.gauge.score;
    st.preScore = typeof pre === 'number' ? pre : null;
    st.dec = decide(p);
  }

  /* ── 渲染 ── */
  function renderRt() {
    const mode = st.mode || rtMode();
    const MT = {
      live: ['实时 · 15秒引擎', 'b-blue'],
      pre: ['盘前预估', 'b-orange'],
      frozen: ['盘后定格', 'b-gray'],
      closed: ['休市定格', 'b-gray'],
    }[mode] || ['—', 'b-gray'];
    $('rtBadge').className = 'badge2 ' + MT[1];
    $('rtBadge').textContent = MT[0];
    if (!st.quote || !st.prev19 || st.ma20 === null) {
      $('rtBody').innerHTML = '<div class="empty-note">' +
        (st.err || '行情与K线数据获取中… (日K/60分/30分/15分/1分/实时报价共6路腾讯直连, 若长时间无响应请检查网络)') + '</div>';
      return;
    }
    const p = st.quote.price, ma = st.ma20;
    const d = st.dec || { act: '观望', conf: 0, reasons: [] };
    const ACT = {
      '进攻': [ARED, '满足四条件 · 可加仓'],
      '防守': [AGREEN, '减仓规避 · 等待企稳'],
      '观望': [BLUE, '方向未明 · 等待信号'],
      '预警': [ORANGE, '仓位上限50% · 死叉升级防守'],
    }[d.act] || [BLUE, ''];
    /* 攻防横幅 */
    let html = '<div class="rt-banner">' +
      '<div class="rt-act"><div class="a" style="color:' + ACT[0] + ';font-size:31px;font-weight:900;">' + d.act + '</div>' +
      '<div class="s">' + ACT[1] + '</div></div>' +
      '<div class="rt-reasons">' + (d.reasons || []).map(r => '<span>· ' + r + '</span>').join('') + '</div>' +
      '<div class="rt-conf"><div class="n" style="color:' + ACT[0] + ';">' + (d.act === '进攻' ? '4/4' : d.conf + '/4') + '</div>' +
      '<div class="k">进攻条件置信度</div></div>' +
      '</div>';
    /* Q1 中轨与精确点位 */
    let entryV, entryS;
    if (st.entry.confirmed) {
      entryV = st.entry.price.toFixed(2);
      entryS = (st.entry.broken ? '已失守 · ' : '') + st.entry.time + ' 确认';
    } else {
      entryV = R2(ma * 1.001).toFixed(2);
      entryS = '待确认 · 随中轨动态';
    }
    const distPct = (p - ma) / ma * 100;
    html += '<div class="kpi-grid">' +
      kpi('实时中轨 MA20', ma.toFixed(2), '现价' + (distPct >= 0 ? '高' : '低') + '于中轨 ' + fmtSigned(R2(distPct))) +
      kpi('进场触发价', entryV, entryS) +
      kpi('一级防守 · 减仓', R2(ma * 0.999).toFixed(2), '中轨-0.10% 破位减仓') +
      kpi('二级防守 · 退出', st.lower.toFixed(2), '布林下轨2σ 破位退出') +
      '</div>';
    /* Q2 背离区 */
    const divP = (nm, dv, note) => {
      const M = { none: ['无背离', 'b-gray'], forming: ['形成中', 'b-orange'], confirmed: ['已确认', 'b-red'], nodata: ['数据不足', 'b-gray'] }[dv.level] || ['—', 'b-gray'];
      const extra = (dv.level === 'forming' || dv.level === 'confirmed') && dv.drop !== undefined ? '·DIF衰减' + R2(dv.drop * 100) + '%' : '';
      return '<span class="badge2 ' + M[1] + '">' + nm + ' ' + M[0] + extra + '</span>' +
        '<span class="badge2 b-gray">' + note + '</span>';
    };
    html += '<div class="rt-sub">顶背离预警 · 60分钟主 / 30分钟前置 / 15分钟尾盘</div>' +
      '<div class="rt-div-row">' +
      divP('60分钟', st.div60, '主周期·确认后调整0.5~2日') +
      divP('30分钟', st.div30, '前置验证·半日级回调') +
      (isTail() ? divP('15分钟', st.div15, '尾盘逃顶·当日级')
        : '<span class="badge2 b-gray">15分钟 · 14:30后启用</span><span class="badge2 b-gray">尾盘逃顶·当日级</span>') +
      '</div>';
    /* P1-2: 外弧预警第四通道(野人哥) */
    const arc = st.arc || { level: 'nodata' };
    const ARCM = {
      none: ['外弧无信号', 'b-gray'], watch: ['外弧观察', 'b-orange'],
      warn: ['外弧预警', 'b-orange'], confirmed: ['外弧确认·表强实弱', 'b-red'],
      nodata: ['外弧数据不足', 'b-gray'],
    }[arc.level] || ['外弧 —', 'b-gray'];
    const divActive = st.div60.level !== 'none' || st.div30.level !== 'none' || st.div15.level !== 'none';
    const arcReso = divActive && (arc.level === 'warn' || arc.level === 'confirmed');
    html += '<div class="rt-sub">外弧预警 · 量价结构第四通道 · 野人哥P1' +
      (arcReso ? ' <span class="badge2 b-red">背离×外弧共振</span>' : '') + '</div>' +
      '<div class="rt-div-row">' +
      '<span class="badge2 ' + ARCM[1] + '">' + ARCM[0] + '</span>' +
      (arc.sToday !== null ? '<span class="badge2 b-gray">今日空头量占比 ' + R2(arc.sToday * 100) + '%</span>' : '') +
      (arc.m5 !== null ? '<span class="badge2 b-gray">近5日均 ' + R2(arc.m5 * 100) + '%</span>' : '') +
      (arc.lift !== null ? '<span class="badge2 ' + (arc.lift > 1.2 ? 'b-orange' : 'b-gray') + '">抬升比 ' + R2(arc.lift * 100) + '%</span>' : '') +
      (arc.nh ? '<span class="badge2 b-orange">日内高>19日收盘高</span>' : '') +
      '</div>';
    /* 量能/VWAP/外围 */
    const vwapPill = st.vwap === null
      ? '<span class="badge2 b-gray">VWAP 待分时数据</span>'
      : '<span class="badge2 ' + (p > st.vwap ? 'b-red' : 'b-green') + '">VWAP ' + st.vwap.toFixed(2) + ' · 现价' + (p > st.vwap ? '上方' : '下方') + '</span>';
    const vrPill = st.vr === null
      ? '<span class="badge2 b-gray">量比待分时</span>'
      : '<span class="badge2 ' + (st.vr >= 1.5 ? 'b-red' : (st.vr < 0.8 ? 'b-green' : 'b-gray')) + '">量比 ' + st.vr.toFixed(2) + ' (近5分/前30分)</span>';
    const hsiPill = st.hsi
      ? '<span class="badge2 ' + (st.hsi.pct >= 0 ? 'b-red' : 'b-green') + '">恒指 ' + fmtSigned(st.hsi.pct) + '</span>'
      : '<span class="badge2 b-gray">恒指 —</span>';
    const prePill = st.preScore !== null
      ? '<span class="badge2 ' + (st.preScore >= 60 ? 'b-red' : (st.preScore < 40 ? 'b-green' : 'b-gray')) + '">温度计 ' + (st.preScore > 0 ? '+' : '') + st.preScore.toFixed(2) + '</span>'
      : '<span class="badge2 b-gray">温度计 —</span>';
    html += '<div class="rt-sub">量能 · VWAP · 外围</div>' +
      '<div class="rt-div-row">' + vwapPill + vrPill + hsiPill + prePill + '</div>';
    /* 次日预判: 新19日窗口=去最早1根+今收, 再加明收假设p → 分子含两个p */
    const s19 = st.prev19.reduce((a, b) => a + b, 0);
    const nextMa = (s19 - st.prev19[0] + p + p) / 20;
    const sup = Math.min(nextMa * 0.99, st.quote.low || nextMa * 0.99);
    const res = Math.max(nextMa * 1.01, st.quote.high || nextMa * 1.01);
    html += '<div class="rt-sub">次日预判 · 以现价 ' + p.toFixed(2) + ' 为今收</div>' +
      '<div class="kpi-grid">' +
      kpi('明日中轨预估', nextMa.toFixed(2), '20日滚动·含今收假设') +
      kpi('支撑位', sup.toFixed(2), '明日中轨×0.99 与今日低 取低') +
      kpi('压力位', res.toFixed(2), '明日中轨×1.01 与今日高 取高') +
      '</div>';
    /* 风险点 */
    const risks = [];
    if (st.div60.level === 'forming' || st.div60.level === 'confirmed') risks.push('顶背离延续风险');
    if (st.div30.level === 'forming') risks.push('30分钟背离前置信号');
    if (st.arc && st.arc.level === 'watch') risks.push('外弧观察·新高但今日空头占比抬升');
    if (st.arc && st.arc.level === 'warn') risks.push('外弧预警·空头占比5日抬升>1.2倍');
    if (st.arc && st.arc.level === 'confirmed') risks.push('外弧确认·表强实弱');
    if (st.preScore !== null && st.preScore < 40) risks.push('外围温度计<40');
    if (st.quote.vol && st.yVol && st.quote.vol < st.yVol * 0.8) risks.push('量能萎缩 今/昨<0.8');
    html += '<div class="rt-div-row" style="margin-top:12px;">' +
      (risks.length ? risks.map(r => '<span class="badge2 b-orange">' + r + '</span>').join('')
        : '<span class="badge2 b-gray">无显著风险点</span>') +
      '</div>';
    $('rtBody').innerHTML = html;
  }

  /* ── 轮询调度 ── */
  function T(sec, fn) { st.timers.push(setInterval(fn, sec * 1000)); }
  async function quoteTick() {
    if (st.mode !== rtMode()) { stop(); start(); return; }       // 模式漂移自动重启
    try {
      const q = await rtFetchQuote();
      st.quote = q; st.hsi = q._hsi || null; st.err = null;
    } catch (e) { st.err = '实时行情获取失败 · 自动重试中'; }
    rtCalc(); renderRt();
  }
  /* masterTick喂入(交易时段): 上证全字段+恒指由统一主循环拉取, RT只算不拉 */
  function ingest(quote, hsi) {
    if (!quote || !quote.price) return;
    st.quote = quote; st.hsi = hsi || null; st.err = null;
    rtCalc(); renderRt();
  }
  async function m1Tick() { try { st.m1 = await rtFetchMk('m1', 280); } catch (e) { /* 静默 */ } }
  async function divTick() {
    try { st.m60 = await rtFetchMk('m60', 120); } catch (e) { /* 静默 */ }
    try { st.m30 = await rtFetchMk('m30', 120); } catch (e) { /* 静默 */ }
    try { st.m15 = await rtFetchMk('m15', 120); } catch (e) { /* 静默 */ }
    try { st.m5 = await rtFetchMk('m5', 560); } catch (e) { /* 静默·外弧通道容错 */ }
  }
  async function dailyTick() {
    try { const x = await rtFetchDaily(); st.daily = x; st.prev19 = x.prev19; st.yVol = x.yVol; } catch (e) { /* 静默 */ }
  }
  async function loadAll() {
    st.mode = rtMode();
    await Promise.allSettled([
      rtFetchDaily().then(x => { st.daily = x; st.prev19 = x.prev19; st.yVol = x.yVol; }).catch(() => {}),
      rtFetchMk('m1', 280).then(x => { st.m1 = x; }).catch(() => {}),
      rtFetchMk('m60', 120).then(x => { st.m60 = x; }).catch(() => {}),
      rtFetchMk('m30', 120).then(x => { st.m30 = x; }).catch(() => {}),
      rtFetchMk('m15', 120).then(x => { st.m15 = x; }).catch(() => {}),
      rtFetchMk('m5', 560).then(x => { st.m5 = x; }).catch(() => {}),
    ]);
  }
  async function start() {
    if (st.running) return;
    st.running = true;
    $('rtNote').textContent = '口径: 实时中轨=(前19完整交易日收盘+实时价)/20 · 收复确认=上穿后3分钟站稳且最低不破中轨0.999、现价≥中轨×1.001、VWAP上方 · 进场价=中轨×1.001(精确0.01) · 防守=破中轨0.10%减仓/破下轨2σ退出 · 背离δ=0.3×ATR(DIF)·两顶间隔≥8根·DIF零上 · 全部为规则化条件提示，非投资建议。';
    await loadAll();
    await quoteTick();
    if (st.mode === 'live') {                                    // 交易时段: quote由masterTick喂, RT只轮询K线
      T(60, m1Tick);
      T(120, divTick);
      T(300, dailyTick);
    } else {                                                      // 盘前/盘后/休市: 低频自拉自愈+模式漂移检测
      T(120, quoteTick);
    }
  }
  function stop() {
    st.timers.forEach(clearInterval);
    st.timers = [];
    st.running = false;
  }
  return { start, stop, ingest };
})();

/* ══════════════ 盘后渲染 ══════════════ */
const SIG_TXT = {
  open: ['已入场', 'b-red'], closed: ['已平仓', 'b-gray'], no_touch: ['未触及', 'b-gray'], skipped: ['资格未满足', 'b-orange'],
};

function renderPost() {
  const s = window.SETTLE_DATA;
  if (!s || !s.latest) {
    $('postKpis').innerHTML = '<div class="empty-note">盘后复盘待生成 (15:10 管道自动产出)</div>';
    return;
  }
  const L = s.latest;
  $('settleDate').textContent = L.date + (L.isToday ? ' · 当日' : ' · 最近交易日');

  /* KPI */
  const e = L.emoFinal || {};
  const sh = L.sh || {};
  $('postKpis').innerHTML =
    (sh.close ? kpi('上证收盘', R2(sh.close), '开盘 ' + fmtSigned(sh.openPct) + ' · 收盘 ' + fmtSigned(sh.closePct)) : '') +
    (e.zt !== undefined ? kpi('涨停(核心)', e.zt_core, '全口径 ' + e.zt + ' · 炸板 ' + e.zb) : '') +
    (e.seal_rate !== undefined ? kpi('封板率', R2(e.seal_rate), '%') : '') +
    (e.max_lb_core !== undefined ? kpi('最高连板', e.max_lb_core, '核心口径') : '');

  /* 叙事 */
  $('postNarr').innerHTML = (L.narrative || []).map(l => '<span class="nl">' + l + '</span>').join('');

  /* 温度计验证 */
  const v = L.verify;
  if (v) {
    $('postVerify').innerHTML =
      '<div class="verify-hero">' +
      '<div class="vscore"><div class="v ' + (v.gauge >= 0 ? 'up' : 'down') + '">' + (v.gauge > 0 ? '+' : '') + R2(v.gauge) + '</div><div class="k">盘前温度计</div></div>' +
      '<span class="badge2 ' + (v.gaugeLabel ? 'b-blue' : 'b-gray') + '">' + (v.gaugeLabel || '—') + '</span>' +
      '<div class="vscore"><div class="v ' + pctClass(v.shOpenPct) + '">' + fmtSigned(v.shOpenPct) + '</div><div class="k">实际开盘</div></div>' +
      '<span class="badge2 ' + (v.openHit ? 'b-red' : 'b-gray') + '">' + (v.openHit ? '✓ 方向命中' : '✗ 未命中') + '</span>' +
      '<div class="vscore"><div class="v ' + pctClass(v.shClosePct) + '">' + fmtSigned(v.shClosePct) + '</div><div class="k">实际收盘</div></div>' +
      '<span class="badge2 ' + (v.closeHit ? 'b-red' : 'b-gray') + '">' + (v.closeHit ? '✓ 方向命中' : '✗ 未命中') + '</span>' +
      '</div>' +
      '<div class="fund-note" style="margin-top:12px;">命中判定: 温度计 ≥ +15 且上证开盘上涨, 或 ≤ -15 且下跌; 中性区间 (-15~+15) 不参与判定。</div>';
  } else {
    $('postVerify').innerHTML = '<div class="empty-note">本交易日无同日盘前温度计 (快照自 08:45 管道启用日起累积), 或当日为温度计中性区间。</div>';
  }

  /* 情绪演变 */
  const points = (L.emoPoints || []).map(p => ({
    time: (typeof p.time === 'string' && /^\d{6}$/.test(p.time))
      ? p.time.slice(0, 2) + ':' + p.time.slice(2, 4) : p.time,
    zt: p.zt, sealRate: p.sealRate === undefined ? undefined : R2(p.sealRate),
  }));
  if (points.length && window.echarts) {
    if (charts.postEmo) charts.postEmo.dispose();
    charts.postEmo = echarts.init($('postEmoSeries'));
    charts.postEmo.setOption(emoSeriesOption(points));
    $('postEmoNote').textContent = '共 ' + points.length + ' 个时点 (9:26 / 10:30 / 14:00 / 14:30 / 15:10 快照链)';
  } else {
    $('postEmoSeries').innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--tertiary);font-size:13px;">当日时点数据待累积</div>';
    $('postEmoNote').textContent = '';
  }

  /* 信号表现 */
  const det = (L.signal && L.signal.detail) || [];
  $('sigBadge').textContent = (L.signal && L.signal.count ? L.signal.count + ' 笔' : '无');
  $('sigBody').innerHTML = det.map(r => {
    const st = SIG_TXT[r.status] || [r.status || '—', 'b-gray'];
    return '<tr><td>' + r.code + '</td><td>' + (r.name || '') + '</td><td>' + (r.lb || 1) + '板</td>' +
      '<td><span class="badge2 ' + st[1] + '">' + st[0] + '</span></td>' +
      '<td>' + (r.excluded_by_ma20 ? '<span class="b-orange" style="font-weight:700;">排除</span>' : (r.ma20 ? '<span class="b-green" style="font-weight:700;">通过</span>' : '—')) + '</td>' +
      '<td>' + (r.index_regime || '—') + '</td></tr>';
  }).join('') || '<tr><td colspan="6" style="color:var(--tertiary);">当日无新信号</td></tr>';

  /* 明日关注 [v1.2.1] — 候选读主系统荐股(SITE_DATA, 与主看板荐股区同源);
     题材热度由 settle_log v1.1.0 从当日涨停池现算(settle_data.js) */
  const tm = L.tomorrow || {};
  $('tomorrowThemes').innerHTML = (tm.themes || []).map((t, i) =>
    '<span class="badge2 ' + (i === 0 ? 'b-red' : 'b-blue') + '" style="margin:4px 6px 0 0;">' + t + '</span>').join('') ||
    '<div class="empty-note">暂无主线题材</div>';

  /* data.js 顶层为 const SITE_DATA(全局词法绑定, 非 window 属性) — typeof 守卫
     避免 data.js 加载失败时 ReferenceError */
  const SD = (typeof SITE_DATA !== 'undefined') ? SITE_DATA : window.SITE_DATA;
  const TIER_CLS = { S: 'b-red', M: 'b-blue', A: 'b-orange', B: 'b-gray' };
  const POOL_ORDER = ['candidates_1to2', 'candidates_4plus', 'candidates_2to3', 'candidates_3to4'];
  const rows = [], dropped = [];
  let bStopped = 0;
  if (SD) {
    for (const k of POOL_ORDER) {
      for (const c of (SD[k] || [])) {
        const s = c.sel || {};
        if (s.verdict === 'skip') {
          if (s.tier === 'B') { bStopped++; continue; }
          dropped.push((c.name || c.code) + '·' + (s.drop || s.verdict_txt || '淘汰'));
          continue;
        }
        rows.push('<tr><td>' + c.code + '</td>' +
          '<td>' + (c.name || '') + '<span style="display:block;color:var(--tertiary);font-size:11px;">' + (c.industry || '') + '</span></td>' +
          '<td><span class="badge2 ' + (TIER_CLS[s.tier] || 'b-gray') + '">' + (s.label || '—') + '</span> ' + (c.lb || 1) + '板</td>' +
          '<td style="font-weight:700;color:var(--primary);">' + (c.cap5 != null ? c.cap5 : '—') + '</td>' +
          '<td>' + (s.win || '—') + ' / ' + (s.avg || '—') + '</td>' +
          '<td>' + (s.pos || '—') + '</td></tr>');
      }
    }
  }
  $('candBody').innerHTML = rows.join('') ||
    '<tr><td colspan="6" style="color:var(--tertiary);">主系统荐股数据待生成（盘后 15:32 更新）</td></tr>';
  const skipBits = [];
  if (dropped.length) skipBits.push('已淘汰: ' + dropped.join('、'));
  if (bStopped) skipBits.push('B级3进4停用档 ' + bStopped + ' 只（负期望·不参与）');
  const skipDiv = $('candSkipNote');
  /* innerHTML 而非 textContent: drop 原因串含 &lt; 等 HTML 实体(与主看板渲染同口径) */
  if (skipDiv) { skipDiv.innerHTML = skipBits.join(' · '); skipDiv.style.display = skipBits.length ? '' : 'none'; }
}

/* ═══ 启动 ═══ */
function boot() {
  renderPre();
  renderOvernight();
  renderVerifyChart();
  renderMid();
  renderPost();
  setPhase(currentPhase());

  /* 手动切换 → 锁定用户选择, 不再被自动迁移覆盖 */
  $('phPre').onclick = () => { phaseLocked = true; setPhase('pre'); };
  $('phMid').onclick = () => { phaseLocked = true; setPhase('mid'); };
  $('phPost').onclick = () => { phaseLocked = true; setPhase('post'); };

  /* 时钟每秒走; 时段自动迁移仅在未锁定时执行 */
  setInterval(() => {
    const now = new Date();
    $('pbClock').textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
    if (!phaseLocked) {
      const want = currentPhase();
      if (want !== phase) setPhase(want);
    }
  }, 1000);

  window.addEventListener('resize', () => Object.values(charts).forEach(c => c && c.resize()));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
})();
