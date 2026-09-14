/* port.js v1.7.1 — 持仓体检交互逻辑 (设计手册Problem 2/4/5落地)
   模块: preprocess(canvas重采样/灰度/锐化) + ocr(自托管fast语言包/打开即预热/降级) +
         parser(双粒度聚类+三通道候选+区域竞争: L1单行/SEG名称锚定段/VP垂直价格对) +
         match(三级匹配: 本地全市场语料LCS模糊/在线多档前缀/smartbox反查) + ui(五步状态机/确认表格/报告渲染/localStorage历史)
   v1.7.1 [卖飞复盘修复]: 作战计划卡新增plan.note执行提示行(勿隔夜挂死单/挂单前看量能),
           渲染引擎v1.3.1的回暖失效条款+双价格指令(修复2026-09-14回暖日强势股卖飞)
   v1.7.0 [C档·复盘七步法第⑦步]: 报告新增「明日作战计划·认输线」卡 —
           每只持仓认输线价格+距线空间+冲高/平开/破线三条件计划(触发式退出, 执行层)
   v1.6.0: ① 成本价方向修复 — 用户确认布局: 持仓数量后紧邻两值, 前(上)为成本后(下)为现价;
             数量紧邻规则+4, 移除P>C偏置(亏损持仓会翻转正确顺序), VP翻转需强证据(≥2反向%或显式负号单命中),
             新增市值顺序复核(V≈上行×数量 且不匹配下行才翻转), vHit容差5%→1.5%;
           ② 名称匹配三级化 — names.js全市场语料(A股+ETF)LCS字符模糊, 错字(龙蟒→龙鞭)/丢首字(→发龙蟒)/
             粘连噪声均可离线命中; 在线档增至2字滑窗; extractName表头词剥离不再整段丢弃
   v1.5.0: 职责边界明确 — OCR只识别名称/数量/成本价, 现价一律实时行情自动匹配:
           ① 名称/代码双向智能匹配: 输入≥2字符实时下拉候选(名称·代码·市场, 点击/键盘选择),
             输入代码自动带出名称(修复原只改数据不刷新输入框的bug), 输入名称自动带出代码;
           ② 确认表现价/市值/盈亏%列全部改实时计算(识别后并发拉行情, 30s缓存),
             OCR现价仅用于消歧与偏差核对(与实时偏差>2%黄标提示标的可能选错);
           ③ KPI当日盈亏标注数据时点(截至xx收盘, 消除周末对照截图困惑),
             明细行新增当日盈亏块((现价-昨收)×数量+涨跌幅);
           ④ 报告盈亏口径统一quote.price实时价 vs 用户成本(与市值同源, 数据源已验证quote==kline)
   v1.4.0: 成本保留原始精度(≤3位小数, ETF如1.082); 代码列可编辑(6位代码或sh588200式, 反查前缀)
   v1.3.0: 修复垂直布局(成本上/现价下)识别率低; 报告「操作指令+野人两板块建议」行
   引擎: window.Health (health-core.js v1.3.0, 与diag.js口径逐字一致)
   声明: 条件概率诊断, 非预测, 不构成投资建议 */
(function () {
'use strict';

const $ = (id) => document.getElementById(id);
const H = window.Health;
const R2 = H.R2, fmtNum = H.fmtNum, fmtWan = H.fmtWan;
const ARED = '#FF3B30', AGREEN = '#34C759', BLUE = '#007AFF', ORANGE = '#FF9500';

/* v1.4.0: 价格智能显示 — 最多3位小数去尾零 (A股2位如17.25, ETF3位如1.082, 整数33) */
function fmtPx(x) {
  if (x == null || !isFinite(x)) return '';
  let s = Number(x).toFixed(3);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/* ═══════════ v1.5.0: 实时行情层 ═══════════
   职责边界: OCR只识别名称/数量/成本价; 现价/市值/盈亏/分析全部实时数据
   30s缓存避免确认表回填与报告引擎重复拉取 */
const quoteCache = {};
async function getLiveQuote(full) {
  if (!full) return null;
  const hit = quoteCache[full];
  if (hit && Date.now() - hit.ts < 30000) return hit.q;
  try {
    const q = await H.fetchQuote(full);
    quoteCache[full] = { q, ts: Date.now() };
    return q;
  } catch (e) { return hit ? hit.q : null; }
}
/* 行情数据时点: quote.time(yyyymmddhhmmss) → 「截至09-11收盘」 */
function quoteAsOf(quotes) {
  for (const q of quotes) {
    if (q && q.time && /^\d{14}$/.test(q.time)) {
      const mm = q.time.slice(4, 6), dd = q.time.slice(6, 8);
      return '截至' + mm + '-' + dd + '收盘';
    }
  }
  return '';
}

/* ═══════════ v1.5.0: 名称/代码双向智能匹配下拉 ═══════════
   输入≥2字符(350ms防抖) → smartbox候选 → fixed定位下拉(名称·代码·市场)
   点击/Enter选中 → 名称+代码+前缀全填充 → 拉实时行情回填现价
   挂body避免.tbl-wrap overflow裁剪; 同一时间仅一个下拉 */
let acBox = null, acCtx = null, acTimer = null, acHi = -1;
function closeAc() {
  if (acBox) { acBox.remove(); acBox = null; acCtx = null; acHi = -1; }
  if (acTimer) { clearTimeout(acTimer); acTimer = null; }
}
function openAc(inp, r, tr) {
  const v = inp.value.trim();
  if (v.length < 2) { closeAc(); return; }
  acCtx = { inp, r, tr };
  acTimer = setTimeout(async () => {
    let cands = [];
    try { cands = await searchAll(v); } catch (e) { return; }
    if (!acCtx || acCtx.inp !== inp || inp.value.trim() !== v) return; /* 已切换目标 */
    if (!cands.length) { closeAc(); return; }
    showAc(cands.slice(0, 8));
  }, 350);
}
function showAc(cands) {
  closeAc();
  const rect = acCtx.inp.getBoundingClientRect();
  acBox = document.createElement('div');
  acBox.className = 'ac-drop';
  acBox.style.left = Math.max(8, Math.min(rect.left, innerWidth - 336)) + 'px';
  acBox.style.top = (rect.bottom + 6) + 'px';
  acBox.style.width = 'min(320px, calc(100vw - 24px))';
  acBox.__cands = cands;
  cands.forEach((c, i) => {
    const it = document.createElement('div');
    it.className = 'ac-item';
    it.innerHTML = '<span class="ac-name">' + esc(c.name) + '</span><span class="ac-code">' + c.full.toUpperCase() + '</span>';
    /* mousedown先于blur(真实点击)保住dropPickedAt时序; click兜底(触屏/自动化场景) — applyCandidate幂等, 二次进入acCtx已清直接返回 */
    const pick = (ev) => { ev.preventDefault(); applyCandidate(c); };
    it.addEventListener('mousedown', pick);
    it.addEventListener('click', pick);
    acBox.appendChild(it);
  });
  document.body.appendChild(acBox);
  acHi = -1;
}
function acMove(d) {
  if (!acBox) return;
  const items = [...acBox.children];
  if (!items.length) return;
  acHi = (acHi + d + items.length) % items.length;
  items.forEach((el, i) => el.classList.toggle('hi', i === acHi));
  items[acHi].scrollIntoView({ block: 'nearest' });
}
async function applyCandidate(c) {
  const { r, tr } = acCtx || {};
  closeAc();
  if (!r || !tr) return;
  r.name = c.name; r.code = c.code; r.full = c.full;
  r.matched = c; r.cands = [c]; r.codeManual = false; r.dropPickedAt = Date.now();
  const ni = tr.querySelector('input[data-f="name"]'), ci = tr.querySelector('input[data-f="code"]');
  if (ni) ni.value = c.name;
  if (ci) { ci.value = c.code; ci.title = c.full.toUpperCase() + '（已匹配）'; }
  await fillLive(r, tr);
}
/* 拉实时行情回填行内显示: 现价/市值/盈亏% + 与OCR价偏差核对(选错标的黄标) */
async function fillLive(r, tr) {
  r.liveLoading = true;
  const pxTd = tr.querySelector('td[data-td="px"]'), mvTd = tr.querySelector('td[data-td="mv"]'), pnlTd = tr.querySelector('td[data-td="pnl"]');
  if (pxTd) pxTd.textContent = '…';
  const q = await getLiveQuote(r.full);
  r.liveLoading = false;
  if (!q) {
    if (pxTd) pxTd.textContent = r.price != null ? fmtPx(r.price) : '—';
    return;
  }
  r.livePrice = q.price; r.livePrev = q.prevClose; r.liveName = q.name;
  if (r.price != null && r.price > 0 && Math.abs(q.price - r.price) / r.price > 0.02) {
    r.liveWarn = '识别现价' + fmtPx(r.price) + '与实时' + fmtPx(q.price) + '偏差>' + '2% — 请核对名称是否选对标的';
  } else r.liveWarn = null;
  refreshLiveCells(r, tr);
  const res = validateRow(r);
  r.status = res.status; r.issues = res.issues;
  tr.className = r.status === 'red' ? 'row-err' : r.status === 'yellow' ? 'row-warn' : '';
  const badgeTd = tr.querySelector('td:nth-child(8)');
  if (badgeTd) badgeTd.innerHTML = statusBadge(r);
}
/* 确认表实时列刷新: 现价 | 市值=现价×数量 | 盈亏%=(现价/成本-1)×100 */
function refreshLiveCells(r, tr) {
  const px = r.livePrice != null ? r.livePrice : r.price;
  const pxTd = tr && tr.querySelector('td[data-td="px"]');
  const mvTd = tr && tr.querySelector('td[data-td="mv"]');
  const pnlTd = tr && tr.querySelector('td[data-td="pnl"]');
  if (pxTd) pxTd.textContent = r.livePrice != null ? fmtPx(r.livePrice) : (r.price != null ? fmtPx(r.price) + '*' : '—');
  if (mvTd) mvTd.textContent = (px != null && r.qty > 0) ? fmtNum(px * r.qty, 2) : '—';
  if (pnlTd) {
    if (px != null && r.cost > 0) {
      const pv = (px / r.cost - 1) * 100;
      pnlTd.textContent = R2(pv) + '%';
      pnlTd.style.color = pv >= 0 ? ARED : AGREEN;
    } else { pnlTd.textContent = '—'; pnlTd.style.color = ''; }
  }
}
/* 智能输入框: input防抖下拉 + keydown键盘导航 + blur自动匹配兜底 */
function bindSmartInput(inp, r, tr) {
  inp.addEventListener('input', () => { closeAc(); openAc(inp, r, tr); });
  inp.addEventListener('keydown', (e) => {
    if (!acBox) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); acMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); acMove(-1); }
    else if (e.key === 'Enter' && acHi >= 0 && acBox.__cands) { e.preventDefault(); applyCandidate(acBox.__cands[acHi]); }
    else if (e.key === 'Escape') closeAc();
  });
  inp.addEventListener('blur', () => setTimeout(closeAc, 200));
}

/* ═══════════════════ 模块1: 预处理 ═══════════════════
   canvas等比缩放 width≤1600px + 灰度 + 对比度1.2× + 锐化(3×3卷积)
   二值化不默认启用(汉字/负号易丢), 仅置信度不足时二次识别可切换 */
function preprocessImage(img) {
  const MAXW = 1600;
  const scale = Math.min(1, MAXW / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  let data = ctx.getImageData(0, 0, w, h);
  /* 灰度 + 对比度1.2 */
  const px = data.data;
  const CONTRAST = 1.2;
  for (let i = 0; i < px.length; i += 4) {
    let g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    g = (g - 128) * CONTRAST + 128;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    px[i] = px[i + 1] = px[i + 2] = g;
  }
  ctx.putImageData(data, 0, 0);
  /* 锐化卷积(轻微, 中心5-邻-1) */
  const src = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  const s = src.data, o = out.data;
  const K = [0, -0.6, 0, -0.6, 3.4, -0.6, 0, -0.6, 0]; // 归一化≈1
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let acc = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          acc += s[((y + ky) * w + (x + kx)) * 4] * K[(ky + 1) * 3 + (kx + 1)];
        }
      }
      acc = acc < 0 ? 0 : acc > 255 ? 255 : acc;
      const di = (y * w + x) * 4;
      o[di] = o[di + 1] = o[di + 2] = acc; o[di + 3] = 255;
    }
  }
  /* 边缘1px保留原灰度 */
  for (let x = 0; x < w; x++) { for (const y of [0, h - 1]) { const di = (y * w + x) * 4; o[di] = o[di+1] = o[di+2] = s[di]; o[di+3] = 255; } }
  for (let y = 0; y < h; y++) { for (const x of [0, w - 1]) { const di = (y * w + x) * 4; o[di] = o[di+1] = o[di+2] = s[di]; o[di+3] = 255; } }
  ctx.putImageData(out, 0, 0);
  return cv;
}
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ img, url }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片加载失败')); };
    img.src = url;
  });
}

/* ═══════════════════ 模块2: OCR ═══════════════════
   资源自托管 ./ocr/ (Cloudflare Pages 全球边缘节点, 免海外CDN慢链路):
   worker/core(wasm)/fast语言包全部本地; fast版 chi_sim 1.7MB (best版12MB的1/7,
   持仓表格为规整印刷体, fast识别足够)
   预热: 页面打开即后台完整加载引擎(core+语言包), 用户点识别时已就绪
   降级: 连续2次置信度<0.6 或 单次>20s → 手动输入模式 */
const OCR_BASE = new URL('./ocr/', document.baseURI).href;
const OCR_CDN = {
  workerPath: OCR_BASE + 'worker.min.js',
  corePath: OCR_BASE,
  langPath: OCR_BASE,
};
let ocrWorker = null, ocrLoading = null, warmupDone = false;

/* 引擎预热状态显示(上传区徽标) */
function setWarmBadge(txt, cls) {
  const el = document.getElementById('ocrWarm');
  if (el) { el.textContent = txt; el.className = 'dz-warm ' + (cls || ''); }
}
function getWorker() {
  if (ocrWorker) return Promise.resolve(ocrWorker);
  if (ocrLoading) return ocrLoading;
  ocrLoading = (async () => {
    const STAGE = {
      'loading tesseract core': '加载识别内核',
      'initializing tesseract': '初始化引擎',
      'loading language traineddata': '下载中文语言包',
      'initializing api': '启动识别接口',
    };
    const w = await Tesseract.createWorker('chi_sim+eng', 1, {
      ...OCR_CDN,
      logger: (m) => {
        if (m.status === 'recognizing text' && m.progress != null) setStepMeta('ocr', Math.round(m.progress * 100) + '%');
        else if (m.progress != null && m.status !== 'recognizing text') {
          const label = STAGE[m.status] || m.status;
          setWarmBadge('引擎预热中 · ' + label + ' ' + Math.round(m.progress * 100) + '%', 'warming');
        }
      },
    });
    ocrWorker = w;
    setWarmBadge('✓ 引擎已就绪 · 点击即识别', 'ready');
    return w;
  })().catch((e) => {
    ocrLoading = null; /* 失败可重试 */
    setWarmBadge('引擎预热失败 · 可手动输入', 'fail');
    throw e;
  });
  return ocrLoading;
}
/* 预热: 页面空闲后(约1s)即完整加载引擎(core+fast语言包约8MB),
   用户浏览页面/选截图的同时后台完成, 点「开始识别」零等待 */
function warmup() {
  if (warmupDone) return;
  warmupDone = true;
  setWarmBadge('引擎预热中…', 'warming');
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1000));
  idle(() => {
    getWorker().catch(() => { /* 预热失败不弹错, 用户点识别时才真正降级 */ });
  });
}
async function ocrRecognize(canvas, timeoutMs) {
  const w = await getWorker();
  timeoutMs = timeoutMs || 20000;
  return Promise.race([
    w.recognize(canvas, {}, { blocks: true, text: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('ocr-timeout')), timeoutMs)),
  ]);
}
/* 提取OCR行: blocks → paragraphs → lines[{text,bbox,confidence}] */
function extractLines(result) {
  const out = [];
  const data = result && result.data;
  if (!data) return out;
  if (Array.isArray(data.blocks)) {
    for (const b of data.blocks) {
      for (const p of (b.paragraphs || [])) {
        for (const l of (p.lines || [])) {
            /* v5 line.confidence 为0-100制, 规范化到0-1(>1视为百分制) */
            if (l.text && l.bbox) {
              const raw = l.confidence;
              const conf = raw == null ? 0.8 : (raw > 1 ? raw / 100 : raw);
              out.push({ text: l.text, bbox: l.bbox, conf });
            }
          }
      }
    }
  }
  if (!out.length && data.text) {
    data.text.split('\n').filter(t => t.trim()).forEach((t, i) => out.push({ text: t, bbox: { x0: 0, y0: i * 20, x1: 100, y1: i * 20 + 20 }, conf: 0.6 }));
  }
  return out;
}

/* ═══════════════════ 模块3: 解析(双粒度聚类 + 三通道候选 + 区域竞争) ═══════════════════
   v1.3.0 重构 — 解决「8只只识别出2只」与「成本/现价混淆」:
   垂直布局(成本在上/现价在下)时, 名称行与数据行分离, 单行解析必然失败;
   滑窗兜底仅在0识别时启用是召回率低的直接根源, 改为多通道全量竞争
   - 双粒度聚类(0.45细/0.65粗): 不同App行距差异大, 两套行划分并行竞争
   - L1 单行解析: 横排布局(名称+全部数据同一行)
   - SEG 名称锚定段: 名称行起至下一名称行(≤5行)合并, 解决名称与数据分行
   - VP 垂直价格对: 纯数字两行(成本上/现价下), 名称从左侧/上方找
   - 区域竞争: 同一标的区域多候选取约束评分最高者, 不同布局自动择优 */
/* 视觉行聚类: y中心差 < 中位行高×factor 归同组 */
function clusterLines(lines, factor) {
  factor = factor || 0.62;
  const sorted = lines.slice().sort((a, b) => (a.bbox.y0 + a.bbox.y1) - (b.bbox.y0 + b.bbox.y1));
  const rows = [];
  for (const l of sorted) {
    const yc = (l.bbox.y0 + l.bbox.y1) / 2;
    const hh = l.bbox.y1 - l.bbox.y0;
    const last = rows[rows.length - 1];
    if (last && Math.abs(yc - last.yc) < Math.max(last.hh, hh) * factor) {
      last.items.push(l); last.yc = (last.yc + yc) / 2; last.hh = Math.max(last.hh, hh);
    } else {
      rows.push({ yc, hh, items: [l] });
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.bbox.x0 - b.bbox.x0);
  return rows;
}
/* 中文姓名提取: 连续≥2个汉字(排除"持仓/可用/市值/盈亏/成本"等表头词)
   v1.6.0: run内含表头词时只剥离表头保留残余(原逻辑整段丢弃, "川发龙蟒 成本"粘连会连名称一起丢) */
const HEADER_WORDS = /持仓|可用|市值|盈亏|成本|现价|证券|代码|名称|金额|数量|浮动|参考|总计|账户|资产|盈亏比|当日|参考成本|买入|均价/;
function stripHeaders(s) {
  let out = s, m;
  while ((m = out.match(HEADER_WORDS))) out = out.replace(m[0], '');
  return out;
}
function extractName(rowText) {
  const m = rowText.match(/[\u4e00-\u9fa5]{2,10}/g);
  if (!m) return null;
  const cand = m.map(stripHeaders).filter(x => x.length >= 2);
  return cand.length ? cand.sort((a, b) => b.length - a.length)[0] : null;
}
/* 数字token: 含数值/百分号/中文单位(万/亿); pos=文本内位置(价格方向启发用) */
function extractTokens(rowText) {
  const toks = [];
  const re = /(-?\d[\d,]*\.?\d*)(%|万|亿)?/g;
  let m;
  while ((m = re.exec(rowText)) !== null) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(val)) continue;
    toks.push({ val, raw: m[0], pos: m.index, isPct: m[2] === '%', unitWan: m[2] === '万', unitYi: m[2] === '亿', isInt: !m[1].includes('.') && !m[1].includes(',') || /^\d+$/.test(m[1].replace(/,/g, '')) });
  }
  return toks;
}
/* 单只持仓行解析: 约束搜索(P,C,Q)三元组
   规则(设计手册Problem 2):
   - V ≈ P×Q (±5%, 含万/亿单位换算)
   - R ≈ (P/C-1)×100 (±0.5pp, R为带%token)
   - Q为整数且%100==0优先, 范围[100,5×10^7]
   - P/C ∈ [0.05, 20] */
function parseHoldingRow(rowText) {
  const name = extractName(rowText);
  if (!name) return null;
  const toks = extractTokens(rowText);
  const pctToks = toks.filter(t => t.isPct);
  const numToks = toks.filter(t => !t.isPct);
  if (numToks.length < 2) return null;
  /* 代码: 6位连续数字 */
  const codeM = rowText.match(/[（(]?([0-9]{6})[）)]?/);
  let best = null;
  for (let i = 0; i < numToks.length; i++) {
    for (let j = 0; j < numToks.length; j++) {
      if (i === j) continue;
      const P = numToks[i].val, C = numToks[j].val;
      if (!(P > 0.1 && P < 100000 && C > 0.1 && C < 100000)) continue;
      if (!(P / C > 0.05 && P / C < 20)) continue;
      const Rcalc = (P / C - 1) * 100;
      /* R匹配: 行内任一%token */
      let rHit = 0;
      for (const t of pctToks) if (Math.abs(t.val - Rcalc) < 0.5) rHit++;
      for (const t of numToks) if (Math.abs(t.val - Rcalc) < 0.5) rHit += 0.5; // 无%号的盈亏比
      for (let q = 0; q < numToks.length; q++) {
        if (q === i || q === j) continue;
        const T = numToks[q];
        const Q = T.val * (T.unitWan ? 1e4 : T.unitYi ? 1e8 : 1);
        if (!(Q >= 100 && Q <= 5e7)) continue;
        const hun = T.isInt && Math.round(T.val) % 100 === 0 ? 2 : (Math.abs(Q / 100 - Math.round(Q / 100)) < 0.01 ? 1 : 0);
        /* V匹配: 行内任一数值 ≈ P×Q (v1.6.0容差5%→1.5%: 成本/现价接近时仍可分辨两种解释) */
        let vHit = 0, vTok = null;
        const Vcalc = P * Q;
        for (const t of numToks) {
          if (t === numToks[i] || t === numToks[j] || t === T) continue;
          const V = t.val * (t.unitWan ? 1e4 : t.unitYi ? 1e8 : 1);
          if (V > 1000 && Math.abs(V - Vcalc) / Vcalc < 0.015) { vHit = 1; vTok = t; break; }
        }
        /* v1.6.0价格方向: 用户确认布局 — 持仓数量后面紧邻两个数值, 前面(上面)是成本, 后面是现价
           ① 数量紧邻规则: cost=数量后第1值 ∧ price=第2值 → +4
           ② 文本位置: price在cost后 → +0.2 (垂直布局合并文本保留上行先出=成本顺序)
           ③ 原P>C偏置已移除: 亏损持仓(现价<成本)会把正确顺序翻转, 是成本误识根源 */
        const score = hun * 3 + rHit * 4 + vHit * 6 + (q + 1 === j && q + 2 === i ? 4 : 0) +
          (numToks[i].pos > numToks[j].pos ? 0.2 : 0);
        /* v1.4.0: 价格/成本保留原始精度(≤3位小数, ETF如1.082), 不做R2截断
           — 盈亏与市值计算完全按截图持仓口径 */
        if (!best || score > best.score) {
          best = { score, name, code: codeM ? codeM[1] : null, price: P, cost: C, qty: Math.round(Q), rHit, vHit, hun, raw: rowText };
        }
      }
    }
  }
  if (!best) return null;
  best.conf = best.vHit && best.hun >= 1 ? 'high' : (best.rHit ? 'mid' : 'low');
  return best;
}
/* 垂直价格对解析: 券商App「成本在上/现价在下」两行布局 (v1.3.0)
   判据: 两行均无中文名称且含数字, x区间重叠≥40%, y紧邻(中心差≤2.2×行高);
         上行首个小数价格=成本, 下行首个小数价格=现价, 有盈亏%时按校验自动纠偏
   名称: 左侧同高行优先(y覆盖价格对且x在价格列左), 其次上方≤3行高内的名称行
   数量: %100==0整数优先, 市值≈现价×数量佐证; 全缺失时按市值/现价反推 */
function parseVerticalPair(info, i) {
  const a = info[i], b = info[i + 1];
  if (extractName(a.text) || extractName(b.text)) return null; /* 行内有名称交给L1/SEG */
  const ta = extractTokens(a.text), tb = extractTokens(b.text);
  const na = ta.filter(t => !t.isPct), nb = tb.filter(t => !t.isPct);
  if (!na.length || !nb.length) return null;
  const ow = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const minW = Math.min(a.x1 - a.x0, b.x1 - b.x0);
  if (minW > 0 && ow < 0.4 * minW) return null;       /* x区间不重叠, 非同列价格对 */
  if (b.yc - a.yc > 2.2 * Math.max(a.hh, b.hh)) return null; /* y不相邻 */
  const pick = (toks) => toks.find(t => t.raw.includes('.') && t.val > 0.1 && t.val < 10000) || toks.find(t => t.val > 0.1 && t.val < 10000);
  const cTok = pick(na), pTok = pick(nb);
  if (!cTok || !pTok) return null;
  let cost = cTok.val, price = pTok.val;
  const pctAll = [...ta, ...tb].filter(t => t.isPct);
  const rOf = (P, C) => (P / C - 1) * 100;
  let rHit = pctAll.filter(t => Math.abs(t.val - rOf(price, cost)) < 1.2).length;
  const rRev = pctAll.filter(t => Math.abs(t.val - rOf(cost, price)) < 1.2).length;
  /* v1.6.0: 默认上行=成本(用户确认: 数量后两值上为成本下为现价), 翻转需强证据 —
     ≥2个反向%命中, 或带显式负号的单命中(OCR丢负号会把正向%误配到反向, 单弱命中不再翻转) */
  const rRevStrong = pctAll.filter(t => /-/.test(t.raw) && Math.abs(t.val - rOf(cost, price)) < 1.2).length;
  if ((rRev >= 2 || rRevStrong >= 1) && rRev > rHit) { const t = cost; cost = price; price = t; rHit = rRev; } /* 个别App现价在上 */
  if (!(price > 0.1 && price < 100000 && cost > 0.1 && cost < 100000)) return null;
  if (!(price / cost > 0.05 && price / cost < 20)) return null;
  /* 名称: 左侧同高行 → 上方名称行 */
  let name = null;
  const py0 = a.yc - a.hh, py1 = b.yc + b.hh;
  for (let j = 0; j < info.length; j++) {
    if (j === i || j === i + 1) continue;
    const r = info[j];
    if (r.yc + r.hh / 2 < py0 || r.yc - r.hh / 2 > py1) continue; /* y不覆盖价格对 */
    if (r.x1 > Math.min(a.x0, b.x0) - 4) continue;                 /* 需在价格列左侧 */
    const nm = extractName(r.text);
    if (nm) { name = nm; break; }
  }
  if (!name) {
    for (let j = i - 1; j >= 0; j--) {
      const r = info[j];
      if (a.yc - r.yc > 3 * a.hh) break;
      const nm = extractName(r.text);
      if (nm) { name = nm; break; }
    }
  }
  if (!name) return null;
  /* 数量: %100==0整数加分 + 市值佐证; 缺失时市值/现价反推 */
  const all = [...na, ...nb], priceToks = [cTok, pTok];
  let qty = null, bestSc = -1;
  for (const t of all) {
    if (priceToks.includes(t)) continue;
    const Q = t.val * (t.unitWan ? 1e4 : t.unitYi ? 1e8 : 1);
    if (!(Q >= 100 && Q <= 5e7)) continue;
    let vHit = 0;
    for (const v of all) {
      if (v === t || priceToks.includes(v)) continue;
      const V = v.val * (v.unitWan ? 1e4 : v.unitYi ? 1e8 : 1);
      if (V > 1000 && Math.abs(V - price * Q) / (price * Q) < 0.08) { vHit = 6; break; }
    }
    const hun = t.isInt && Math.round(t.val) % 100 === 0 ? 3 : 1;
    const sc = hun + vHit + (t.isInt ? 0.5 : 0);
    if (sc > bestSc) { bestSc = sc; qty = Q; }
  }
  if (qty == null) {
    for (const v of all) {
      if (priceToks.includes(v)) continue;
      const V = v.val * (v.unitWan ? 1e4 : v.unitYi ? 1e8 : 1);
      if (V > 1000 && V / price >= 100 && V / price <= 5e7) { qty = Math.round(V / price); bestSc = 1; break; }
    }
  }
  /* v1.6.0 市值顺序复核(最强证据, 免疫%符号/OCR噪声): 存在V≈上行×数量 且不匹配 V≈下行×数量
     → 上行才是现价(个别App); 用户常规布局下V≈下行×数量, 维持上=成本 */
  if (qty != null && qty >= 100) {
    let hitTop = 0, hitBot = 0;
    for (const v of all) {
      if (priceToks.includes(v)) continue;
      const V = v.val * (v.unitWan ? 1e4 : v.unitYi ? 1e8 : 1);
      if (V <= 1000) continue;
      if (Math.abs(V - cost * qty) / (cost * qty) < 0.08) hitTop++;
      if (Math.abs(V - price * qty) / (price * qty) < 0.08) hitBot++;
    }
    if (hitTop && !hitBot) { const t = cost; cost = price; price = t; }
  }
  const codeM = (a.text + ' ' + b.text + ' ' + name).match(/[（(]?([0-9]{6})[）)]?/);
  return {
    name, code: codeM ? codeM[1] : null,
    /* v1.4.0: 原始精度(≤3位小数), 不R2截断 — ETF成本1.082完整保留 */
    price: price, cost: cost, qty: qty != null ? Math.round(qty) : null,
    score: 4 + rHit * 4 + Math.max(bestSc, 0), rHit, vHit: bestSc >= 6 ? 1 : 0, hun: bestSc >= 3 ? 2 : 0,
    conf: rHit ? 'mid' : 'low', raw: a.text + ' / ' + b.text,
  };
}
/* 全图解析 v1.3.0: 双粒度×三通道候选 + 区域竞争去重
   每通道独立产出候选(含y区域), 评分降序挑选, 同名或y重叠>55%视为同标的只留最高分 */
function parseScreenshot(lines) {
  const cands = [];
  const addParse = (text, yTop, yBot, src) => {
    const p = parseHoldingRow(text);
    if (p) cands.push({ p, yTop, yBot, src });
  };
  for (const factor of [0.45, 0.65]) {
    const rows = clusterLines(lines, factor);
    const info = rows.map(r => {
      const text = r.items.map(it => it.text).join(' ').replace(/\s+/g, ' ').trim();
      let x0 = Infinity, x1 = -Infinity;
      r.items.forEach(it => { x0 = Math.min(x0, it.bbox.x0); x1 = Math.max(x1, it.bbox.x1); });
      return { yc: r.yc, hh: r.hh, x0, x1, text };
    });
    const span = (i) => ({ top: info[i].yc - info[i].hh / 2, bot: info[i].yc + info[i].hh / 2 });
    /* 通道L1: 单行解析(横排布局) */
    info.forEach((r, i) => { const g = span(i); addParse(r.text, g.top, g.bot, 'L1'); });
    /* 通道SEG: 名称锚定段(名称行起至下一名称行, ≤5行) — 解决名称与数据分行 */
    const nameIdx = [];
    info.forEach((r, i) => { if (extractName(r.text)) nameIdx.push(i); });
    for (let s = 0; s < nameIdx.length; s++) {
      const head = nameIdx[s];
      const tail = Math.min(s + 1 < nameIdx.length ? nameIdx[s + 1] : info.length, head + 5);
      if (tail - head < 2) continue; /* 单行段L1已覆盖 */
      const merged = info.slice(head, tail).map(r => r.text).join(' ');
      const g0 = span(head), g1 = span(tail - 1);
      addParse(merged, g0.top, g1.bot, 'SEG');
    }
    /* 通道VP: 垂直价格对(成本上/现价下) */
    for (let i = 0; i < info.length - 1; i++) {
      const vp = parseVerticalPair(info, i);
      if (vp) { const g0 = span(i), g1 = span(i + 1); cands.push({ p: vp, yTop: g0.top, yBot: g1.bot, src: 'VP' }); }
    }
  }
  /* 区域竞争: 评分降序, 同名或y区间重叠率>55%(按较短候选)视为同标的, 只留最高分 */
  cands.sort((a, b) => b.p.score - a.p.score);
  const picked = [];
  for (const c of cands) {
    if (picked.some(x => x.p.name === c.p.name)) continue;
    const ch = c.yBot - c.yTop;
    const clash = picked.some(x => {
      const ov = Math.min(x.yBot, c.yBot) - Math.max(x.yTop, c.yTop);
      return ov > 0 && ov / Math.min(x.yBot - x.yTop, ch) > 0.55;
    });
    if (clash) continue;
    picked.push(c);
  }
  picked.sort((a, b) => a.yTop - b.yTop);
  return picked.map(x => Object.assign({ src: x.src }, x.p));
}

/* ═══════════════════ 模块4: 六条算术自洽校验 ═══════════════════ */
/* row: {name, code, full, qty, cost, price, mv, pnlPct, livePrice, liveWarn}
   返回 {status: 'green|yellow|red', issues: []} — 设计手册Problem 2容差
   v1.5.0: 现价已非用户输入(实时行情), OCR价仅作消歧; 新增实时偏差黄标(选错标的预警) */
function validateRow(row) {
  const issues = [];
  let status = 'green';
  const up = (sev, msg) => { issues.push(msg); if (sev === 'red' || status !== 'red') status = sev === 'red' ? 'red' : (status === 'green' ? 'yellow' : status); };
  /* 5 字段完整性 (v1.5.0: 现价自动实时, 不校验) */
  if (!row.qty || !row.cost || !row.name) up('red', '关键字段缺失（名称/数量/成本不全）');
  if (row.qty <= 0 || row.cost <= 0) up('red', '数值非法（数量/成本必须为正）');
  if (row.price != null && row.price <= 0) up('yellow', '识别现价异常（不影响分析，现价按实时行情）');
  /* v1.5.0: 未匹配代码 → 提示(名称或代码列输入即自动匹配) */
  if (!row.full) up('red', '未匹配代码 — 在名称或代码列输入即可自动匹配（名称→代码 / 代码→名称双向）');
  /* v1.5.0: OCR识别现价 vs 实时价偏差>2% → 标的可能选错, 黄标核对 */
  if (row.liveWarn) up('yellow', row.liveWarn);
  if (status === 'red') return { status, issues };
  /* 1 市值一致性 V ≈ P×Q ±2% (OCR截图市值, 仅在解析出时校验数量) */
  if (row.mv != null && row.mv > 0 && row.price != null && row.price > 0) {
    const Vcalc = row.price * row.qty;
    const dev = Math.abs(row.mv - Vcalc) / Vcalc;
    if (dev > 0.02) up('yellow', '截图市值校验偏差' + R2(dev * 100) + '%（现价×数量 ≠ 市值，请核对数量是否识别正确）');
  }
  /* 2 盈亏比例 R ≈ (P/C-1)×100% ±0.3pp (OCR截图盈亏%, 仅在解析出时校验成本/现价) */
  if (row.pnlPct != null && row.price != null && row.price > 0) {
    const Rcalc = (row.price / row.cost - 1) * 100;
    const dev = Math.abs(row.pnlPct - Rcalc);
    if (dev > 0.3) up('yellow', '截图盈亏' + R2(row.pnlPct) + '% vs 计算值' + R2(Rcalc) + '%（请核对成本/数量是否识别正确）');
  }
  /* 4 数值合法性(位数/量级) */
  if (row.qty != null && row.qty > 5e7) up('yellow', '持仓数量异常（>5000万股，请核对单位）');
  if (row.price != null && row.price > 10000) up('yellow', '识别现价异常（主板<10000元，可能抓到市值，不影响分析）');
  return { status, issues };
}

/* ═══════════════════ 模块5: 代码匹配(smartbox反查/ETF多候选) ═══════════════════ */
/* 宽松搜索: 保留ETF/指数(不过滤GP), 返回候选数组 */
async function searchAll(q) {
  const hint = await H.tencent('https://smartbox.gtimg.cn/s3/?v=2&q=' + encodeURIComponent(q) + '&t=all', 'v_hint', 6000);
  const raw = String(hint || '').trim();
  if (!raw || raw === 'N') return [];
  return raw.split(';').filter(Boolean).map(seg => {
    const p = seg.split('~');
    if (p.length < 3) return null;
    const mkt = p[0], code = p[1];
    if (!/^\d{6}$/.test(code)) return null;
    return { mkt, code, full: mkt + code, name: (p[2] || '').replace(/\s+/g, ''), type: p[4] || '' };
  }).filter(Boolean);
}
/* ═══ v1.6.0 三级匹配 — 解决OCR丢字/错字/换字导致「川发龙蟒」类匹配失败 ═══
   ① 本地全市场语料( names.js, A股+ETF, 每日管道刷新 ): 对名称变体做LCS字符模糊,
     任意位置错1字(龙蟒→龙鞭)/丢首字(川发龙蟒→发龙蟒)/粘连噪声均可命中, 离线零网络;
   ② 在线多档前缀: 全名→4字→3字→2字→全部2字滑窗(≤12档, 精确命中即早退);
   ③ 合并池按LCS相似度重排, 现价消歧逻辑不变 */
let namesCorpus = null;
function parseNamesCorpus() {
  if (namesCorpus) return namesCorpus;
  const raw = typeof window !== 'undefined' ? window.STOCK_NAMES : null;
  if (typeof raw !== 'string' || raw.length < 100) return null;
  namesCorpus = [];
  for (const seg of raw.split(';')) {
    const i = seg.indexOf('~');
    if (i < 4) continue;
    namesCorpus.push({ full: seg.slice(0, i), name: seg.slice(i + 1) });
  }
  return namesCorpus.length > 1000 ? namesCorpus : null;
}
/* 最长公共子序列(名称≤10字, O(n·m)轻量) */
function lcsLen(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1).fill(0), cur;
  for (let i = 1; i <= m; i++) {
    cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[n];
}
/* 名称相似度: 相等=1; LCS/短边为主, 包含关系按长度比加权 */
function scoreNamePair(scr, candName) {
  if (scr === candName) return 1;
  const L = lcsLen(scr, candName);
  if (L < 2) return 0;
  const mn = Math.min(scr.length, candName.length);
  let s = L / mn;
  if (candName.includes(scr) || scr.includes(candName)) s = Math.max(s, 0.6 + 0.35 * mn / Math.max(scr.length, candName.length));
  return s;
}
/* 名称变体: 主名(全权重) + raw文本内全部剥离表头后的中文run(0.75权重, 捕捉拆行/粘连噪声) */
function nameVariants(primary, rawText) {
  const out = [], seen = {};
  const push = (x) => {
    x = (x || '').replace(/\s+/g, '');
    if (x.length >= 2 && !seen[x]) { seen[x] = 1; out.push(x); }
  };
  push(primary && String(primary).replace(/(SH|SZ|BJ|\*|ST|退|U|A)$/gi, '').trim());
  if (rawText) (String(rawText).match(/[\u4e00-\u9fa5]{2,10}/g) || []).forEach(r => push(stripHeaders(r)));
  return out;
}
async function matchCandidates(scrName, rawText) {
  const variants = nameVariants(scrName, rawText);
  const clean = variants[0] || (scrName || '').trim();
  if (clean.length < 2) return [];
  /* ① 本地语料LCS模糊 */
  const corpus = parseNamesCorpus();
  if (corpus) {
    const scored = [];
    for (const c of corpus) {
      let best = 0;
      for (let k = 0; k < variants.length; k++) {
        const s = scoreNamePair(variants[k], c.name) * (k === 0 ? 1 : 0.75);
        if (s > best) best = s;
      }
      if (best >= 0.55) scored.push({ c, s: best });
    }
    if (scored.length) {
      scored.sort((x, y) => y.s - x.s || x.c.name.length - y.c.name.length);
      return scored.slice(0, 6).map(x => ({ mkt: x.c.full.slice(0, 2), code: x.c.full.slice(2), full: x.c.full, name: x.c.name, type: 'corpus' }));
    }
  }
  /* ② 在线多档前缀(全名→4→3→2→2字滑窗) */
  const queries = [];
  const addQ = (q) => { q = (q || '').trim(); if (q.length >= 2 && !queries.includes(q)) queries.push(q); };
  for (const v of variants) {
    addQ(v); addQ(v.slice(0, 4)); addQ(v.slice(0, 3)); addQ(v.slice(0, 2));
    for (let k = 0; k + 2 <= v.length; k++) addQ(v.slice(k, k + 2));
  }
  const pool = [], seen = {};
  for (const q of queries.slice(0, 12)) {
    let cands = [];
    try { cands = await searchAll(q); } catch (e) { continue; }
    for (const c of cands) if (!seen[c.full]) { seen[c.full] = 1; pool.push(c); }
    const exact = pool.filter(c => variants.some(v => v.length >= 2 && (c.name.includes(v) || v.includes(c.name))));
    if (exact.length) return exact.slice(0, 6);
  }
  if (!pool.length) return [];
  /* ③ 合并池LCS重排 */
  const sim = (c) => {
    let s = 0;
    for (let k = 0; k < variants.length; k++) {
      const v = scoreNamePair(variants[k], c.name) * (k === 0 ? 1 : 0.75);
      if (v > s) s = v;
    }
    return s;
  };
  pool.sort((a, b) => sim(b) - sim(a) || a.name.length - b.name.length);
  return pool.slice(0, 6);
}
/* 多候选消歧: 按现价最接近原则 argmin|P-P_i|/P_i (需先拉各候选行情) */
async function disambiguate(cands, scrPrice) {
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  let best = null, bestDev = Infinity;
  for (const c of cands.slice(0, 6)) {
    try {
      const q = await H.fetchQuote(c.full);
      const dev = Math.abs(q.price - scrPrice) / scrPrice;
      if (dev < bestDev) { bestDev = dev; best = c; }
    } catch (e) { /* 忽略单个失败 */ }
  }
  return best || cands[0];
}

/* ═══════════════════ 模块6: 状态机 + UI ═══════════════════ */
const els = {
  drop: $('dropzone'), file: $('fileInput'), previewWrap: $('previewWrap'), preview: $('preview'),
  btnOcr: $('btnOcr'), btnManual: $('btnManual'),
  secProgress: $('secProgress'), stepsOl: $('stepsOl'),
  secConfirm: $('secConfirm'), editBody: $('editBody'), btnAddRow: $('btnAddRow'), btnRun: $('btnRun'),
  secReport: $('secReport'), reportMeta: $('reportMeta'), kpiGrid: $('kpiGrid'), envWrap: $('envWrap'),
  grpGrid: $('grpGrid'), holdDetail: $('holdDetail'), discList: $('discList'), posWrap: $('posWrap'),
  planWrap: $('planWrap'),   /* v1.7.0 [C档·复盘七步法第⑦步] 明日作战计划挂载点 */
  btnBackEdit: $('btnBackEdit'), btnSave: $('btnSave'),
  histList: $('histList'),
};
let curFile = null, curImg = null, curUrl = null;
let reviewRows = [];   /* 确认表数据: {name, code, full, cands, qty, cost, price, mv, pnlPct, status, issues} */
let lastReport = null; /* 最近一次报告快照 */

/* 状态: IDLE → READY → ENGINE → OCR → MATCH → REVIEW → FETCH → COMPUTE → REPORT */
function setState(next) { /* 简易: 只做展示切换 */ }

/* 时间线 */
function setStep(name, state) {
  const li = els.stepsOl.querySelector('li[data-step="' + name + '"]');
  if (!li) return;
  li.classList.remove('doing', 'done');
  if (state) li.classList.add(state);
}
function setStepMeta(name, txt) {
  const li = els.stepsOl.querySelector('li[data-step="' + name + '"]');
  if (!li) return;
  const meta = li.querySelector('[data-meta]');
  if (meta) meta.textContent = txt;
}
function resetSteps() {
  ['engine', 'ocr', 'match', 'fetch', 'compute'].forEach(s => { setStep(s, null); setStepMeta(s, '—'); });
}

/* ── 上传交互 ── */
els.drop.addEventListener('click', () => els.file.click());
els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('drag'); });
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('drag'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault(); els.drop.classList.remove('drag');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) acceptFile(f);
});
els.file.addEventListener('change', () => {
  const f = els.file.files && els.file.files[0];
  if (f) acceptFile(f);
});
async function acceptFile(f) {
  if (!/^image\//.test(f.type)) { toast('请上传图片文件（PNG/JPG）'); return; }
  curFile = f;
  try {
    const { img, url } = await loadImage(f);
    curImg = img; if (curUrl) URL.revokeObjectURL(curUrl); curUrl = url;
    els.preview.src = url;
    els.previewWrap.style.display = 'block';
    els.btnOcr.disabled = false;
    toast('截图已就绪（' + img.naturalWidth + '×' + img.naturalHeight + 'px），点击「开始识别」');
  } catch (e) { toast('图片加载失败: ' + e.message); }
}

/* ── 手动输入 ── */
els.btnManual.addEventListener('click', () => {
  reviewRows = [emptyRow()];
  renderConfirmTable();
  showSection('confirm');
  toast('手动输入模式：名称列输入名称或代码（≥2字符出候选下拉），现价/市值自动取实时行情');
});
function emptyRow() {
  return { name: '', code: '', full: '', cands: [], qty: null, cost: null, price: null, mv: null, pnlPct: null, status: 'red', issues: ['手动输入行'], manual: true };
}

/* ── OCR 主流程 ── */
let ocrFailCount = 0;
els.btnOcr.addEventListener('click', async () => {
  if (!curImg) return;
  els.btnOcr.disabled = true;
  showSection('progress');
  resetSteps();
  const t0 = Date.now();
  try {
    /* 1 引擎 */
    setStep('engine', 'doing'); setStepMeta('engine', '加载中…');
    await getWorker();
    setStep('engine', 'done'); setStepMeta('engine', Math.round((Date.now() - t0) / 100) / 10 + 's');
    /* 2 识别(预处理后) */
    setStep('ocr', 'doing'); setStepMeta('ocr', '预处理+识别中…');
    const cv = preprocessImage(curImg);
    const t1 = Date.now();
    let result = await ocrRecognize(cv);
    const avgConf = (() => {
      const ls = extractLines(result);
      return ls.length ? ls.reduce((a, l) => a + (l.conf || 0.8), 0) / ls.length : 0;
    })();
    setStep('ocr', 'done'); setStepMeta('ocr', Math.round((Date.now() - t1) / 100) / 10 + 's · 置信' + R2(avgConf * 100) + '%');
    /* 低置信: 原图二次识别 */
    let lines = extractLines(result);
    if (avgConf < 0.78 || !lines.length) {
      setStepMeta('ocr', '二次识别(原图)…');
      try {
        const r2 = await ocrRecognize(curImg, 20000);
        const ls2 = extractLines(r2);
        const c2 = ls2.length ? ls2.reduce((a, l) => a + (l.conf || 0.8), 0) / ls2.length : 0;
        if (c2 > avgConf) { result = r2; lines = ls2; setStepMeta('ocr', '二次识别采用 · 置信' + R2(c2 * 100) + '%'); }
      } catch (e) { /* 二次失败沿用 */ }
    }
    /* 3 解析+匹配 */
    setStep('match', 'doing'); setStepMeta('match', '解析中…');
    const holdings = parseScreenshot(lines);
    if (!holdings.length) {
      ocrFailCount++;
      if (ocrFailCount >= 2) {
        toast('连续' + ocrFailCount + '次未识别出持仓行，已切换手动输入模式');
        els.btnManual.click();
        return;
      }
      toast('未识别出持仓行（截图请截「持仓」列表页），可重试或手动输入');
      showSection('upload');
      els.btnOcr.disabled = false;
      return;
    }
    /* 逐只匹配代码(并发4) */
    const total = holdings.length; let done = 0;
    await H.runPool(holdings.map(h => async () => {
      try {
        const cands = await matchCandidates(h.name, h.raw);
        h.cands = cands;
        if (h.code) { /* 优先用OCR的6位代码校验 */
          const m = cands.find(c => c.code === h.code);
          h.matched = m || null;
        }
        if (!h.matched && cands.length) {
          h.matched = await disambiguate(cands, h.price || 0) ;
        }
      } catch (e) { h.cands = []; }
      done++; setStepMeta('match', done + '/' + total);
    }), 4);
    setStep('match', 'done'); setStepMeta('match', total + '只 · ' + holdings.filter(h => h.matched).length + '只自动匹配');
    /* 4-5 后续步骤在btnRun执行, 此处先到确认表 */
    reviewRows = holdings.map(h => ({
      name: h.name, code: h.matched ? h.matched.code : (h.code || ''), full: h.matched ? h.matched.full : '',
      cands: h.cands || [], qty: h.qty, cost: h.cost, price: h.price,
      mv: null, pnlPct: null, status: 'green', issues: [], conf: h.conf, raw: h.raw,
    }));
    /* 立即校验一轮(市值行内若OCR有则用) */
    reviewRows.forEach(r => { const v = validateRow(r); r.status = v.status; r.issues = v.issues; });
    renderConfirmTable();
    showSection('confirm');
    const warn = reviewRows.filter(r => r.status !== 'green').length;
    toast('识别' + total + '只持仓' + (warn ? '，' + warn + '只有疑点需核对（黄/红标行）' : '，校验全部通过'));
  } catch (e) {
    ocrFailCount++;
    setStep('ocr', null);
    if (String(e.message).includes('timeout') && ocrFailCount >= 2) {
      toast('OCR超时' + ocrFailCount + '次，已切换手动输入模式');
      els.btnManual.click();
    } else {
      toast('识别失败: ' + e.message + '（可重试或手动输入）');
      showSection('upload');
    }
  } finally {
    els.btnOcr.disabled = false;
  }
});

/* ── 确认表格 ── */
els.btnAddRow.addEventListener('click', () => { reviewRows.push(emptyRow()); renderConfirmTable(); });
function renderConfirmTable() {
  closeAc();
  els.editBody.innerHTML = '';
  reviewRows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.className = r.status === 'red' ? 'row-err' : r.status === 'yellow' ? 'row-warn' : '';
    /* v1.5.0: 现价/市值/盈亏% 改实时单元格(数据源自动匹配, 非输入);
       名称/代码框均支持智能下拉(输入名称匹配代码, 输入代码带出名称) */
    tr.innerHTML =
      '<td class="cell-name"><input class="inp' + fldCls(r, 'name') + '" data-f="name" value="' + esc(r.name) + '" placeholder="名称或代码" autocomplete="off"></td>' +
      '<td class="cell-code"><input class="inp' + fldCls(r, 'code') + '" data-f="code" value="' + esc(r.code || '') + '" placeholder="6位代码" inputmode="text" style="min-width:86px;" autocomplete="off" title="' + esc(r.full ? r.full.toUpperCase() + '（已匹配）' : '输入名称或代码自动匹配') + '"></td>' +
      '<td><input class="inp' + fldCls(r, 'qty') + '" data-f="qty" inputmode="numeric" value="' + (r.qty != null ? r.qty : '') + '"></td>' +
      '<td><input class="inp' + fldCls(r, 'cost') + '" data-f="cost" inputmode="decimal" value="' + fmtPx(r.cost) + '"></td>' +
      '<td class="cell-px" data-td="px" title="实时行情价">' + (r.liveLoading ? '…' : (r.livePrice != null ? fmtPx(r.livePrice) : (r.price != null ? fmtPx(r.price) + '*' : '—'))) + '</td>' +
      '<td class="cell-mv" data-td="mv">' + ((r.livePrice != null || r.price != null) && r.qty > 0 ? fmtNum((r.livePrice != null ? r.livePrice : r.price) * r.qty, 2) : '—') + '</td>' +
      '<td class="cell-pnl" data-td="pnl">' + ((r.livePrice != null || r.price != null) && r.cost > 0 ? R2(((r.livePrice != null ? r.livePrice : r.price) / r.cost - 1) * 100) + '%' : '—') + '</td>' +
      '<td>' + statusBadge(r) + '</td>' +
      '<td><button class="icon-btn" data-del="' + i + '" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></td>';
    els.editBody.appendChild(tr);
    /* 已匹配行: 实时行情回填(现价/市值/盈亏%) */
    if (r.full && !r.livePrice && !r.liveLoading && !r.liveDone) { r.liveDone = true; fillLive(r, tr); }
  });
  /* 事件绑定 */
  els.editBody.querySelectorAll('input[data-f]').forEach(inp => {
    const tr = inp.closest('tr');
    const idx = [...els.editBody.children].indexOf(tr);
    const r = reviewRows[idx];
    if (!r) return;
    if (f0(inp) === 'name' || f0(inp) === 'code') bindSmartInput(inp, r, tr);
    inp.addEventListener('change', () => onFieldEdit(inp));
    inp.addEventListener('blur', () => onFieldEdit(inp));
  });
  els.editBody.querySelectorAll('button[data-del]').forEach(btn => {
    btn.addEventListener('click', () => { reviewRows.splice(+btn.dataset.del, 1); renderConfirmTable(); });
  });
}
function f0(inp) { return inp.dataset.f; }
function fldCls(r, f) {
  if (r.status === 'red' && ['name', 'qty', 'cost', 'code'].includes(f)) return ' err';
  if (r.status === 'yellow' && ['cost', 'price', 'qty'].includes(f)) return ' warn';
  return '';
}
function statusBadge(r) {
  const map = { green: ['bm-green', '通过'], yellow: ['bm-orange', '存疑'], red: ['bm-red', '需修正'] };
  const [cls, txt] = map[r.status] || map.yellow;
  return '<span class="badge-mini ' + cls + '" title="' + esc((r.issues || []).join('；')) + '">' + txt + '</span>';
}
async function onFieldEdit(inp) {
  const tr = inp.closest('tr');
  const idx = [...els.editBody.children].indexOf(tr);
  const r = reviewRows[idx];
  if (!r) return;
  const f = inp.dataset.f;
  const v = inp.value.trim();
  /* 下拉刚选中800ms内跳过blur自动匹配(避免覆盖用户明确选择) */
  if (r.dropPickedAt && Date.now() - r.dropPickedAt < 800) { r.dropPickedAt = 0; return; }
  /* change+blur连触防重入(400ms) */
  if (r._lastF === f && Date.now() - (r._lastT || 0) < 400) return;
  r._lastF = f; r._lastT = Date.now();
  if (f === 'name') {
    r.name = v;
    /* v1.5.0: 名称→代码自动匹配(下拉未交互时blur兜底); codeManual手填代码不被覆盖 */
    if (v.length >= 2 && !(r.codeManual && r.code)) {
      try {
        const cands = await matchCandidates(v);
        if (Date.now() - (r.dropPickedAt || 0) < 1500) return; /* await期间用户已从下拉选择, 不覆盖 */
        if (cands.length) {
          r.cands = cands;
          const hit = (r.code ? cands.find(c => c.code === r.code) : null) || cands[0];
          r.matched = hit; r.code = hit.code; r.full = hit.full;
          const ci = tr.querySelector('input[data-f="code"]');
          if (ci) { ci.value = hit.code; ci.title = hit.full.toUpperCase() + '（已匹配）'; }
          r.liveDone = true; fillLive(r, tr);
        }
      } catch (e) { /* 网络失败静默 */ }
    }
  } else if (f === 'code') {
    /* v1.5.0: 代码→名称自动带出(修复原只改数据不刷新输入框) + 实时行情回填 */
    const m = v.replace(/\s+/g, '').match(/^(sh|sz|bj)?(\d{6})$/i);
    if (!m) {
      r.code = ''; r.full = ''; r.matched = null; r.codeManual = false;
      r.livePrice = null; r.liveWarn = null;
      if (v) toast('代码格式：6位数字，可带 sh/sz/bj 前缀（如 588200 或 sh588200），或直接输入名称');
    } else {
      const pfx = m[1] ? m[1].toLowerCase() : '';
      const code6 = m[2];
      r.code = code6; r.codeManual = true;
      let matchedName = '';
      if (pfx) {
        r.full = pfx + code6; r.matched = { code: code6, full: r.full, name: r.name };
      } else {
        let ok = false;
        try {
          const cands = await searchAll(code6);
          if (Date.now() - (r.dropPickedAt || 0) < 1500) return; /* await期间用户已从下拉选择, 不覆盖 */
          const hit = cands.find(c => c.code === code6);
          if (hit) {
            r.full = hit.full; r.matched = hit; r.cands = cands;
            if (!r.name || r.name.length < 2) r.name = hit.name;
            matchedName = hit.name; ok = true;
          }
        } catch (e) { /* 网络失败走本地推断 */ }
        if (!ok) { r.full = guessMkt(code6) + code6; r.matched = { code: code6, full: r.full, name: r.name }; }
      }
      /* 名称输入框同步显示(输入代码自动匹配名称) */
      const ni = tr.querySelector('input[data-f="name"]');
      if (ni && matchedName && ni.value.trim() !== matchedName) ni.value = r.name;
      r.liveDone = true; fillLive(r, tr);
    }
    const ci = tr.querySelector('input[data-f="code"]');
    if (ci) ci.title = r.full ? r.full.toUpperCase() + '（已匹配）' : '输入名称或代码自动匹配';
  } else if (f === 'qty') {
    r.qty = v ? parseInt(v.replace(/[^\d]/g, ''), 10) || null : null;
    refreshLiveCells(r, tr);
  } else if (f === 'cost') {
    r.cost = v ? parseFloat(v) || null : null;
    refreshLiveCells(r, tr);
  }
  const res = validateRow(r);
  r.status = res.status; r.issues = res.issues;
  tr.className = r.status === 'red' ? 'row-err' : r.status === 'yellow' ? 'row-warn' : '';
  const badgeTd = tr.querySelector('td:nth-child(8)');
  if (badgeTd) badgeTd.innerHTML = statusBadge(r);
  inp.className = 'inp' + fldCls(r, f);
}
/* v1.4.0: 6位代码 → 市场前缀本地推断(smartbox不可达时的兜底)
   6/9开头→sh(沪A/B股), 5开头→sh(ETF/债), 0/2/3开头→sz(深主板/ETF/创业板), 4/8开头→bj(北交所) */
function guessMkt(code6) {
  const c = code6[0];
  if (c === '6' || c === '9' || c === '5') return 'sh';
  if (c === '0' || c === '2' || c === '3') return 'sz';
  return 'bj';
}

/* ── 生成报告 ── */
els.btnRun.addEventListener('click', async () => {
  /* 过滤有效行 */
  const valid = reviewRows.filter(r => r.full && r.qty > 0 && r.cost > 0 && r.name);
  if (!valid.length) { toast('至少需要一行完整数据（名称+代码+持仓+成本），红标行请先修正'); return; }
  /* v1.5.0: 未匹配代码的行给出明确指引(名称/代码列输入即自动匹配) */
  const noCode = reviewRows.filter(r => !r.full && r.name);
  if (noCode.length) toast('「' + noCode.map(r => r.name).join('、') + '」未匹配代码已跳过 — 在名称或代码列输入即可自动匹配');
  showSection('progress');
  setStep('engine', 'done'); setStepMeta('engine', '✓');
  setStep('ocr', 'done'); setStepMeta('ocr', '✓');
  setStep('match', 'done'); setStepMeta('match', valid.length + '/' + reviewRows.length);
  setStep('fetch', 'doing'); setStepMeta('fetch', '0/' + valid.length);
  try {
    const t0 = Date.now();
    const { holdings, env } = await H.runPortfolioHealth(valid.map(r => ({
      code: r.code, name: r.name, cost: r.cost, qty: r.qty, full: r.full,
    })), (done, total) => setStepMeta('fetch', done + '/' + total));
    setStep('fetch', 'done'); setStepMeta('fetch', valid.length + '只 · ' + Math.round((Date.now() - t0) / 100) / 10 + 's');
    setStep('compute', 'doing'); setStepMeta('compute', '合成中…');
    await new Promise(r => setTimeout(r, 60));
    /* 当日盈亏校验(D≈(P-P_prev)×Q): 用实时行情昨收 */
    const report = buildReport(holdings, env, valid);
    setStep('compute', 'done'); setStepMeta('compute', '✓ ' + report.kpi.count + '只');
    lastReport = report;
    renderReport(report);
    showSection('report');
    els.secReport.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    toast('行情拉取失败: ' + e.message + '（网络受限时可稍后重试）');
    showSection('confirm');
  }
});

/* 报告合成 (v1.5.0: 全口径实时价 — 现价/市值/当日盈亏/浮动盈亏统一quote.price, 与确认表同源) */
function buildReport(holdings, env, review) {
  const revMap = {};
  review.forEach(r => { revMap[r.code] = r; });
  const ok = [], errs = [];
  holdings.forEach(h => { (h.error ? errs : ok).push(h); });
  let totalMV = 0, totalCost = 0, dayPnl = 0;
  ok.forEach(h => {
    const price = h.quote ? h.quote.price : (h.ind ? h.ind.c : 0);
    const mv = price * h.qty;
    h.mv = mv; totalMV += mv; totalCost += h.cost * h.qty;
    h.dayPnl = h.quote ? (h.quote.price - h.quote.prevClose) * h.qty : null;
    h.dayPct = h.quote && h.quote.prevClose ? (h.quote.price / h.quote.prevClose - 1) * 100 : null;
    if (h.dayPnl != null) dayPnl += h.dayPnl;
    h.totalPnl = mv - h.cost * h.qty;
  });
  const groups = { reduce: [], hold: [], lock: [] };
  ok.forEach(h => { if (groups[h.decision.group]) groups[h.decision.group].push(h); });
  const totalPnl = totalMV - totalCost;
  return {
    ok, errs, env, groups, revMap,
    asOf: quoteAsOf(ok.map(h => h.quote).filter(Boolean)), /* v1.5.0: 数据时点 */
    kpi: {
      count: ok.length,
      totalMV: R2(totalMV), dayPnl: R2(dayPnl),
      totalPnl: R2(totalPnl), totalPnlPct: totalCost > 0 ? R2(totalPnl / totalCost * 100) : 0,
    },
    ts: Date.now(),
  };
}

/* 报告渲染 */
function renderReport(rep) {
  const d = new Date(rep.ts);
  const cyc = rep.env.cycleLabel || '—';
  els.reportMeta.textContent = '生成于 ' + d.toLocaleString('zh-CN') + ' · ' + rep.ok.length + '只持仓 · 情绪相位「' + cyc + '」'
    + (rep.asOf ? ' · ' + rep.asOf : '') + (rep.errs.length ? ' · ' + rep.errs.length + '只数据获取失败' : '');
  /* KPI四宫格 (v1.5.0: 标注数据时点, 消除周末/盘后对照截图的口径困惑) */
  const k = rep.kpi;
  const pnlCls = k.totalPnl >= 0 ? 'k-up' : 'k-dn';
  const dayCls = k.dayPnl >= 0 ? 'k-up' : 'k-dn';
  els.kpiGrid.innerHTML =
    kpi('总市值', fmtNum(k.totalMV, 2) + '元', (rep.asOf || '实时行情') + ' · ' + k.count + '只持仓') +
    kpi('当日盈亏', (k.dayPnl >= 0 ? '+' : '') + fmtNum(k.dayPnl, 2) + '元', '现价vs昨收' + (rep.asOf ? ' · ' + rep.asOf : ''), dayCls) +
    kpi('总浮动盈亏', (k.totalPnl >= 0 ? '+' : '') + fmtNum(k.totalPnl, 2) + '元', (k.totalPnlPct >= 0 ? '+' : '') + k.totalPnlPct + '% · 现价-成本', pnlCls) +
    kpi('减仓组占比', rep.groups.reduce.length + '/' + k.count, '持有' + rep.groups.hold.length + ' · 锁利' + rep.groups.lock.length, rep.groups.reduce.length > 0 ? 'k-up' : '');
  /* 大盘环境 */
  const env = rep.env;
  let envHtml = '<div class="env-row"><span class="e-label">市场分</span><div class="env-track"><div class="env-fill" style="width:' +
    (env.score10 != null ? env.score10 * 10 : 0) + '%"></div></div><span class="env-val">' +
    (env.score10 != null ? env.score10 + '/10 · ' + (env.cold ? '冰冷' : '可操作') : '快照缺失') + '</span></div>';
  envHtml += '<div class="env-row"><span class="e-label">上证60日位</span><div class="env-track"><div class="env-fill" style="width:' +
    (env.maPos != null ? env.maPos : 0) + '%"></div></div><span class="env-val">' +
    (env.maPos != null ? R2(env.maPos) + '% · ' + (env.shAboveMid ? '中轨上方' : '中轨下方') : '—') + '</span></div>';
  envHtml += '<div class="env-row"><span class="e-label">情绪相位</span><div style="flex:1;font-size:14px;font-weight:700;">' +
    cyc + (env.ebb ? ' — 退潮期纪律已注入' : '') + '</div><span class="env-val" style="color:var(--orange);">' +
    (env.breakMid ? '⚠ 上证破中轨' : '') + '</span></div>';
  els.envWrap.innerHTML = envHtml;
  /* 三组卡 (v1.3.0: desc为明确动作指令) */
  const grpDef = [
    { key: 'reduce', title: '反弹减仓', color: ORANGE, desc: '冲高至触发价减半仓，破清仓红线离场；不加仓不补仓' },
    { key: 'hold', title: '持有观察', color: BLUE, desc: '结构完好持有，收盘破MA20即降档减仓，破红线清仓' },
    { key: 'lock', title: '锁定利润', color: AGREEN, desc: '移动止盈：跌破「再减」触发价减半，跌破红线离场' },
  ];
  els.grpGrid.innerHTML = grpDef.map(g => {
    const list = rep.groups[g.key] || [];
    return '<div class="grp-card"><div class="grp-head"><span class="grp-dot" style="background:' + g.color + '"></span>' + g.title +
      '<span style="margin-left:auto;font-size:12px;color:var(--tertiary);font-weight:600;">' + list.length + '只</span></div>' +
      '<div style="font-size:12px;color:var(--secondary);margin-top:4px;">' + g.desc + '</div>' +
      '<div class="grp-list">' + (list.length ? list.map(h =>
        '<div class="grp-item"><span>' + esc(h.name) + '</span><span class="gi-pct" style="color:' + (h.decision.profitPct >= 0 ? ARED : AGREEN) + '">' +
        (h.decision.profitPct != null ? (h.decision.profitPct >= 0 ? '+' : '') + h.decision.profitPct + '%' : '—') + '</span></div>').join('')
      : '<div class="empty" style="padding:14px 0;">无</div>') + '</div></div>';
  }).join('');
  /* 明细 (v1.5.0: 新增当日盈亏块, 现价优先实时quote) */
  els.holdDetail.innerHTML = rep.ok.map(h => {
    const d2 = h.decision, ind = h.ind, bb = ind && ind.bullBear;
    const pnlColor = d2.profitPct >= 0 ? ARED : AGREEN;
    const t = d2.triggers || {};
    const livePx = h.quote ? h.quote.price : (ind ? ind.c : 0);
    const dayColor = h.dayPnl >= 0 ? ARED : AGREEN;
    return '<div class="hold-row">' +
      '<div class="hr-main"><span class="hr-name">' + esc(h.name) + '</span><span class="hr-code">' + h.code + (h.degraded ? ' · 降级' : '') + '</span></div>' +
      '<div class="hr-block"><span class="hr-label">现价/成本</span><span class="hr-val">' + fmtPx(livePx) + ' / ' + fmtPx(h.cost) + '</span></div>' +
      '<div class="hr-block"><span class="hr-label">持仓盈亏</span><span class="hr-val" style="color:' + pnlColor + '">' + (d2.profitPct >= 0 ? '+' : '') + d2.profitPct + '%</span></div>' +
      (h.dayPnl != null ? '<div class="hr-block"><span class="hr-label">当日盈亏</span><span class="hr-val" style="color:' + dayColor + '">' + (h.dayPnl >= 0 ? '+' : '') + fmtNum(h.dayPnl, 0) + '元' + (h.dayPct != null ? ' · ' + (h.dayPct >= 0 ? '+' : '') + R2(h.dayPct) + '%' : '') + '</span></div>' : '') +
      '<div class="hr-block"><span class="hr-label">市值</span><span class="hr-val">' + fmtNum(h.mv, 0) + '元</span></div>' +
      (bb ? '<div class="hr-block"><span class="hr-label">多空档</span><span class="hr-val">' + bb.tier + ' ' + bb.label + '</span></div>' : '') +
      (ind && ind.range60 != null ? '<div class="hr-block"><span class="hr-label">60日位</span><span class="hr-val">' + R2(ind.range60 * 100) + '%</span></div>' : '') +
      (ind && ind.volRatio5_60 ? '<div class="hr-block"><span class="hr-label">量比5/60</span><span class="hr-val">' + ind.volRatio5_60 + '</span></div>' : '') +
      (t.reduce ? '<div class="chip-row"><span class="tchip tc-reduce">减仓 ' + t.reduce + '</span>' : '<div class="chip-row">') +
      (t.halve ? '<span class="tchip tc-halve">再减 ' + t.halve + '</span>' : '') +
      (t.clear ? '<span class="tchip tc-clear">清仓红线 ' + t.clear + '</span>' : '') + '</div>' +
      '<div class="hr-reasons">' + (d2.reasons || []).map(esc).join(' · ') + '</div>' +
      /* v1.3.0: 操作指令 + 野人两板块建议行 (动作+均线具体数值, 对齐diag.js明确化标准) */
      (function () {
        const acts = [];
        if (d2.action) acts.push({ tag: '指令', cls: 'main', txt: d2.action });
        if (bb && d2.bbAction) acts.push({ tag: '野·多空' + d2.bbAction.tier, cls: d2.bbAction.lvl === 'ok' ? 'ok' : 'warn', txt: d2.bbAction.txt });
        if (ind && d2.pdAction) acts.push({ tag: '野·物理距离', cls: 'warn', txt: d2.pdAction.txt });
        if (!acts.length) return '';
        return '<div class="hr-actions">' + acts.map(a =>
          '<div class="hr-act"><span class="ha-tag ' + a.cls + '">' + esc(a.tag) + '</span><span class="ha-txt">' + esc(a.txt) + '</span></div>').join('') + '</div>';
      })() +
      '</div>';
  }).join('') + (rep.errs.length ? '<div class="empty" style="color:var(--red);">' + rep.errs.map(e => esc(e.name) + ': ' + e.error).join(' · ') + '</div>' : '');
  /* v1.7.0 [C档·复盘七步法第⑦步]: 明日作战计划卡 — 认输线+三条件触发式退出(执行层) */
  if (els.planWrap) {
    const GRP_TAG = { lock: '锁利', reduce: '减仓', hold: '持有' };
    const GRP_CLS = { lock: 'ha-tag ok', reduce: 'ha-tag warn', hold: 'ha-tag main' };
    els.planWrap.innerHTML = rep.ok.map(h => {
      const d2 = h.decision, pl = d2.plan || {};
      const livePx = h.quote ? h.quote.price : (h.ind ? h.ind.c : 0);
      const distToQuit = (d2.quit_line != null && livePx) ? R2((livePx / d2.quit_line - 1) * 100) : null;
      return '<div class="plan-card">' +
        '<div class="plan-top"><span class="plan-name">' + esc(h.name) + '</span>' +
        '<span class="hr-code">' + h.code + '</span>' +
        '<span class="' + (GRP_CLS[d2.group] || 'ha-tag main') + '" style="display:inline-flex;">' + (GRP_TAG[d2.group] || d2.group) + '</span>' +
        (distToQuit != null ? '<span style="font-size:11px;color:var(--tertiary);">距认输线 ' + (distToQuit >= 0 ? '+' : '') + distToQuit + '%</span>' : '') +
        '<span class="plan-quit">认输线 <b>' + (d2.quit_line != null ? d2.quit_line : '—') + '</b></span></div>' +
        '<div class="plan-rows">' +
        (pl.up ? '<div class="plan-row"><span class="p-tag pt-up">冲高</span><span class="p-txt">' + esc(pl.up) + '</span></div>' : '') +
        (pl.flat ? '<div class="plan-row"><span class="p-tag pt-flat">平开</span><span class="p-txt">' + esc(pl.flat) + '</span></div>' : '') +
        (pl.down ? '<div class="plan-row"><span class="p-tag pt-down">破线</span><span class="p-txt">' + esc(pl.down) + '</span></div>' : '') +
        /* v1.7.1: plan.note 执行提示行 (引擎v1.3.1新增, 灰底小字与三条件区分) */
        (pl.note ? '<div class="plan-row" style="margin-top:4px;padding-top:6px;border-top:1px dashed var(--hairline);"><span class="p-tag" style="background:#8E8E93;">提示</span><span class="p-txt" style="color:var(--tertiary);font-size:11px;">' + esc(pl.note) + '</span></div>' : '') +
        '</div></div>';
    }).join('') || '<div class="empty">无持仓数据</div>';
  }
  /* 纪律 (v1.3.0: 新增多空弱档纪律行) */
  const disc = env.discipline.slice();
  if (rep.groups.reduce.length) disc.push('反弹减仓组' + rep.groups.reduce.length + '只：冲高至触发价分批减，不追涨停不加仓');
  if (rep.groups.lock.length) disc.push('锁定利润组：跌破「再减」触发价减半，跌破「清仓红线」离场，让利润奔跑');
  const bbWeak = rep.ok.filter(h => h.ind && h.ind.bullBear && (h.ind.bullBear.tier === '8020' || h.ind.bullBear.tier === '7030'));
  if (bbWeak.length) disc.push('多空拉扯/分歧档' + bbWeak.length + '只（' + bbWeak.map(x => x.name).join('、') + '）：反弹不加仓，单日-3%强制减半（8020档打板回测胜率18.92%）');
  const pdHit = rep.ok.filter(h => h.ind && h.ind.pdLow && h.ind.pdLow.hit);
  if (pdHit.length) disc.push('物理距离低系数' + pdHit.length + '只（' + pdHit.map(x => x.name).join('、') + '）：次日冲高抛压大，反弹减至轻仓不补仓');
  disc.push('单票异常（放量长阴/破MA20超1%）优先处理，与市场相位共振时执行力度加倍');
  els.discList.innerHTML = disc.map(x => '<li><span class="d-dot"></span>' + esc(x) + '</li>').join('');
  /* 仓位分布 */
  const sorted = rep.ok.slice().sort((a, b) => b.mv - a.mv);
  const maxMV = sorted.length ? sorted[0].mv : 1;
  const palette = [BLUE, '#5AC8FA', '#5856D6', ORANGE, AGREEN, '#FF2D55', '#AF52DE', '#FF9500'];
  els.posWrap.innerHTML = sorted.map((h, i) =>
    '<div class="pos-row"><span class="p-name">' + esc(h.name) + '</span><div class="pos-track"><div class="pos-fill" style="width:' +
    R2(h.mv / maxMV * 100) + '%;background:' + palette[i % palette.length] + ';"></div></div><span class="pos-val">' +
    R2(h.mv / (rep.kpi.totalMV || 1) * 100) + '%</span></div>').join('') || '<div class="empty">无数据</div>';
}
function kpi(label, val, sub, cls) {
  return '<div class="kpi"><div class="k-label">' + label + '</div><div class="k-val ' + (cls || '') + '">' + val + '</div><div class="k-sub">' + (sub || '') + '</div></div>';
}

els.btnBackEdit.addEventListener('click', () => { showSection('confirm'); els.secConfirm.scrollIntoView({ behavior: 'smooth' }); });

/* ── 历史(localStorage) ── */
const LS_KEY = 'port_checkups_v1';
function loadHist() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { return []; } }
function saveHist(arr) { try { localStorage.setItem(LS_KEY, JSON.stringify(arr.slice(0, 20))); } catch (e) {} }
els.btnSave.addEventListener('click', () => {
  if (!lastReport) return;
  const h = loadHist();
  h.unshift({
    ts: lastReport.ts,
    meta: { count: lastReport.kpi.count, env: lastReport.env.cycleLabel, score10: lastReport.env.score10 },
    kpi: lastReport.kpi,
    groups: { reduce: lastReport.groups.reduce.map(x => x.name), hold: lastReport.groups.hold.map(x => x.name), lock: lastReport.groups.lock.map(x => x.name) },
  });
  saveHist(h);
  renderHist();
  toast('已保存本次体检（本地保存，最多20条）');
});
function renderHist() {
  const h = loadHist();
  if (!h.length) { els.histList.innerHTML = '<div class="empty">暂无历史体检 — 生成报告后点击「保存本次体检」</div>'; return; }
  els.histList.innerHTML = h.map((item, i) => {
    const prev = h[i + 1];
    let diffHtml = '';
    if (prev) {
      const dv = item.kpi.totalMV - prev.kpi.totalMV;
      const cls = dv >= 0 ? 'diff-pos' : 'diff-neg';
      diffHtml = '<span class="hist-meta">vs上次 <span class="' + cls + '">' + (dv >= 0 ? '+' : '') + fmtNum(dv, 0) + '元</span></span>';
    }
    const d = new Date(item.ts);
    return '<div class="hist-item"><div><div class="hist-date">' + d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '</div>' +
      '<div class="hist-meta">' + item.kpi.count + '只 · ' + (item.meta.env || '—') + (item.meta.score10 != null ? ' · 市场分' + item.meta.score10 : '') + ' · 减仓' + (item.groups.reduce || []).length + '/持有' + (item.groups.hold || []).length + '/锁利' + (item.groups.lock || []).length + '</div></div>' +
      diffHtml + '<span class="hist-val">' + fmtNum(item.kpi.totalMV, 0) + '元</span></div>';
  }).join('');
}

/* ── 工具 ── */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function showSection(which) {
  const map = { upload: 'secUpload', progress: 'secProgress', confirm: 'secConfirm', report: 'secReport' };
  if (which === 'progress') els.secProgress.classList.remove('hide');
  if (which === 'confirm') els.secConfirm.classList.remove('hide');
  if (which === 'report') els.secReport.classList.remove('hide');
  if (which === 'upload') { els.secProgress.classList.add('hide'); }
}
let toastTimer = null;
function toast(msg) {
  let t = document.getElementById('portToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'portToast';
    t.style.cssText = 'position:fixed;left:50%;bottom:34px;transform:translateX(-50%) translateY(20px);background:rgba(29,29,31,.92);color:#fff;font-size:13.5px;font-weight:600;padding:12px 22px;border-radius:14px;z-index:999;opacity:0;transition:all .3s cubic-bezier(.32,.72,0,1);max-width:88vw;text-align:center;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);pointer-events:none;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateX(-50%) translateY(0)'; });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(20px)'; }, 3400);
}

/* ── 初始化 ── */
document.addEventListener('DOMContentLoaded', () => {
  renderHist();
  warmup();
});
if (document.readyState !== 'loading') { renderHist(); warmup(); }

/* v1.6.0 调试接口(只读, 控制台验证OCR匹配链, 生产无副作用):
   __PORT_DEBUG__.matchCandidates('川发蟒').then(c => console.log(c)) */
window.__PORT_DEBUG__ = { extractName, nameVariants, parseNamesCorpus, scoreNamePair, matchCandidates };
})();
