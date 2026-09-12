/* three.js v1.0.1 — 三时段作战室逻辑
   数据: premarket_data.js(PREMARKET_DATA) + intraday_data.js(INTRADAY_DATA) + settle_data.js(SETTLE_DATA)
         + 腾讯JSONP实时轮询(竞价雷达/盘中指数, 浏览器直连零token)
   渲染: 盘前温度计gauge+贡献条+隔夜明细+命中率 | 盘中情绪/资金/时点曲线+竞价雷达+尾盘异动 | 盘后复盘全景
   声明: 全部为条件概率观察, 非预测, 不构成投资建议
   v1.0.1: 手动点击Tab后phaseLocked锁定, 每秒时段自动迁移仅在未锁定时执行, 横幅追加锁定提示 */
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
    '<span class="badge2 b-blue">美股50 · A50·30 · CNH·10 · 港股·10</span>';

  /* 贡献条形 */
  const maxC = 45;                          // 满分贡献 = 权重30×1.5
  $('contribRows').innerHTML = (g.items || []).map(it => {
    const c = it.contrib || 0;
    const w = Math.min(Math.abs(c), maxC) / maxC * 50;
    const fill = c >= 0
      ? '<i class="ct-fill pos" style="width:' + w.toFixed(1) + '%"></i>'
      : '<i class="ct-fill neg" style="width:' + w.toFixed(1) + '%"></i>';
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
  if (d.a50 || d.nikkei || d.fx) {
    html += '<div class="q-group-title">亚洲 · A50夜盘 / 日经 / 人民币</div>';
    if (d.a50) html += qRow(d.a50.name || 'A50期货', d.a50.price, d.a50.pct, d.a50.time + ' 定格');
    if (d.nikkei) html += qRow(d.nikkei.name, d.nikkei.price, d.nikkei.pct, '');
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

function renderLiveCards() {
  const auction = phase === 'mid' && inAuction();
  const live = phase === 'mid' && inSession();
  $('auctionCard').style.display = auction ? 'block' : 'none';
  $('liveIdxCard').style.display = live ? 'block' : 'none';
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (auction) {
    pollIdx('auctionGrid');
    liveTimer = setInterval(() => { if (phase === 'mid' && inAuction()) pollIdx('auctionGrid'); else renderLiveCards(); }, 8000);
  } else if (live) {
    pollIdx('liveIdxGrid');
    liveTimer = setInterval(() => { if (phase === 'mid' && inSession()) pollIdx('liveIdxGrid'); else renderLiveCards(); }, 15000);
  }
}

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

  /* 明日关注 */
  const tm = L.tomorrow || {};
  $('tomorrowThemes').innerHTML = (tm.themes || []).map((t, i) =>
    '<span class="badge2 ' + (i === 0 ? 'b-red' : 'b-blue') + '" style="margin:4px 6px 0 0;">' + t + '</span>').join('') ||
    '<div class="empty-note">暂无主线题材</div>';
  $('candBody').innerHTML = (tm.candidates || []).map(c =>
    '<tr><td>' + c.code + '</td><td>' + c.name + '</td><td>' + (c.industry || '') + '</td>' +
    '<td>' + (c.lb || 1) + '板 ' + (c.board_type || '') + '</td>' +
    '<td>' + R2(c.turnover || 0) + '</td><td>' + R2(c.seal_money_yi || 0) + '</td></tr>').join('') ||
    '<tr><td colspan="6" style="color:var(--tertiary);">明日候选待生成</td></tr>';
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
