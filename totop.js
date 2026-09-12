/* ============================================================
 * totop.js v1.0.0 — 全站通用「一键返回顶部」浮动按钮
 * ------------------------------------------------------------
 * · 移动端(≤900px)固定右下角 44×44 液态玻璃圆钮, 桌面端隐藏
 * · 纵向滚动超过 300px 淡入, 回到顶部淡出 (passive 监听零开销)
 * · 点击平滑回顶; iOS 风格: 无边框/浅色玻璃/systemBlue 矢量箭头
 * · 零依赖零配置, 任意页面 <script src="./totop.js" defer> 即插即用
 * ============================================================ */
(function () {
  if (window.__TOTOP_LOADED__) return;
  window.__TOTOP_LOADED__ = true;

  function init() {
    if (document.getElementById('toTopBtn')) return;

    /* ---- 样式 (一次性注入) ---- */
    var st = document.createElement('style');
    st.textContent = [
      '#toTopBtn{',
      '  position:fixed; right:16px;',
      '  bottom:calc(84px + env(safe-area-inset-bottom,0px));',
      '  width:44px; height:44px; border:none; border-radius:50%;',
      '  display:flex; align-items:center; justify-content:center;',
      '  background:rgba(255,255,255,.72);',
      '  -webkit-backdrop-filter:blur(18px) saturate(1.8);',
      '  backdrop-filter:blur(18px) saturate(1.8);',
      '  box-shadow:0 2px 14px rgba(0,0,0,.10), inset 0 0 0 .5px rgba(255,255,255,.9);',
      '  color:#007AFF; cursor:pointer; z-index:9990;',
      '  opacity:0; transform:translateY(10px) scale(.9); pointer-events:none;',
      '  transition:opacity .28s ease, transform .28s ease, background .15s ease;',
      '  -webkit-tap-highlight-color:transparent;',
      '  touch-action:manipulation;',
      '}',
      '#toTopBtn.show{opacity:1; transform:translateY(0) scale(1); pointer-events:auto;}',
      '#toTopBtn:active{transform:scale(.9); background:rgba(255,255,255,.95);}',
      '#toTopBtn svg{display:block; pointer-events:none;}',
      '@media (min-width:901px){#toTopBtn{display:none !important;}}',
      '@media (prefers-reduced-motion:reduce){',
      '  #toTopBtn{transition:opacity .1s linear;}',
      '}',
    ].join('\n');
    document.head.appendChild(st);

    /* ---- 按钮节点 (Lucide 风格矢量箭头) ---- */
    var btn = document.createElement('button');
    btn.id = 'toTopBtn';
    btn.type = 'button';
    btn.setAttribute('aria-label', '返回顶部');
    btn.title = '返回顶部';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none"'
      + ' stroke="currentColor" stroke-width="2.4" stroke-linecap="round"'
      + ' stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
    document.body.appendChild(btn);

    /* ---- 显隐控制: 滚动>300px 出现 (状态缓存避免重复 classList) ---- */
    var shown = false;
    function onScroll() {
      var y = window.scrollY || document.documentElement.scrollTop || 0;
      var need = y > 300;
      if (need !== shown) {
        shown = need;
        btn.classList.toggle('show', need);
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    onScroll();

    /* ---- 点击平滑回顶 ---- */
    btn.addEventListener('click', function () {
      try {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (e) {
        window.scrollTo(0, 0); /* 老浏览器兜底 */
      }
      btn.blur();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
