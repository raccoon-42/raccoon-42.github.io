/* Spaghettified text for the 404 page.
   The "404" and the message show as crisp, readable text, then granulate and
   stretch into curved strands (tidal spaghettification), heat white -> orange,
   and spiral into the black hole behind it (blackhole.js) until gone; then it
   reforms and loops. "home" is a separate intact, clickable link, not part of
   this. Pure canvas2D over the WebGL backdrop; hole center = viewport center. */

(function () {
  const canvas = document.getElementById('fx-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DPR = Math.min(window.devicePixelRatio || 1, 2); // text layer stays sharp

  // global timeline (seconds): write on -> hold readable -> fall in -> empty -> loop
  const WRITE = 1.2, HOLD = 3.4, FALL = 4.4, VOID = 1.4;
  const T1 = WRITE, T2 = T1 + HOLD, T3 = T2 + FALL, TOTAL = T3 + VOID;
  const XFADE = 0.4; // crisp text -> particles handoff at the start of the fall

  const CFG = {
    bigText: '404',
    bigY: 0.15,          // center, fraction of viewport height (symmetric with msgY)
    bigSize: 0.13,       // glyph height, fraction of viewport height
    msg: 'that page drifted off into space. head back where you belong.',
    msgY: 0.85,
    msgSize: 0.028,
    stride: 5,           // strand sampling step (bigger = fewer strands, faster)
    spin: 3.4,           // radians a falling strand winds before it's consumed
    trail: 4,            // segments per strand (curved noodle)
    color: '238,241,246',
  };

  let W, H, cx, cy, bigFont, msgFont, bigYpx, msgYpx;
  let parts = [];

  function rand(a, b) { return a + Math.random() * (b - a); }
  function smooth(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function fitFont(o, text, sizeFrac) {
    let px = Math.round(H * sizeFrac);
    let f = '400 ' + px + 'px "Helvetica Neue", Arial, sans-serif';
    o.font = f;
    const w = o.measureText(text).width;
    if (w > W * 0.92) {
      px = Math.round(px * (W * 0.92) / w);
      f = '400 ' + px + 'px "Helvetica Neue", Arial, sans-serif';
    }
    return f;
  }

  function build() {
    W = window.innerWidth;
    H = window.innerHeight;
    cx = W / 2;
    cy = H / 2;                         // matches the shader's centered hole
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const o = off.getContext('2d');
    o.fillStyle = '#fff';
    o.textAlign = 'center';
    o.textBaseline = 'middle';
    bigYpx = H * CFG.bigY;
    msgYpx = H * CFG.msgY;
    bigFont = fitFont(o, CFG.bigText, CFG.bigSize);
    msgFont = fitFont(o, CFG.msg, CFG.msgSize);
    o.font = bigFont; o.fillText(CFG.bigText, cx, bigYpx);
    o.font = msgFont; o.fillText(CFG.msg, cx, msgYpx);

    // sample the rendered glyphs into strand seed points
    const img = o.getImageData(0, 0, W, H).data;
    const s = CFG.stride;
    parts = [];
    for (let y = 0; y < H; y += s) {
      for (let x = 0; x < W; x += s) {
        if (img[(y * W + x) * 4 + 3] > 128) {
          const dx = x - cx, dy = y - cy;
          const fallDur = rand(1.5, 2.3);
          parts.push({
            x: x, y: y,
            r0: Math.hypot(dx, dy),
            a0: Math.atan2(dy, dx),
            spin: CFG.spin * rand(0.8, 1.25),
            fallDur: fallDur,
            fallDelay: rand(0, Math.max(0.05, FALL - fallDur - 0.1)),
          });
        }
      }
    }
  }

  function drawCrispText(a) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(' + CFG.color + ',' + a.toFixed(3) + ')';
    ctx.font = bigFont; ctx.fillText(CFG.bigText, cx, bigYpx);
    ctx.font = msgFont; ctx.fillText(CFG.msg, cx, msgYpx);
  }

  function posAt(p, fq) {
    if (fq <= 0) return [p.x, p.y];
    const qe = fq * fq;
    const r = p.r0 * (1 - qe);
    const ang = p.a0 + p.spin * qe * qe;
    return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
  }

  function drawStrand(p, fq) {
    const qe = fq * fq;
    const win = 0.10 + 0.26 * qe;       // strand lengthens as it nears the hole
    const a = (1 - smooth(0.82, 1.0, fq)) * 0.85;
    if (a <= 0.01) return;
    const warm = qe;
    const rr = (238 + 17 * warm) | 0;
    const gg = (241 - 91 * warm) | 0;
    const bb = (246 - 176 * warm) | 0;
    ctx.strokeStyle = 'rgba(' + rr + ',' + gg + ',' + bb + ',' + a.toFixed(3) + ')';
    ctx.lineWidth = Math.max(0.5, 1.4 * (1 - qe));
    ctx.beginPath();
    for (let j = 0; j <= CFG.trail; j++) {
      const pt = posAt(p, fq - (j / CFG.trail) * win);
      if (j === 0) ctx.moveTo(pt[0], pt[1]);
      else ctx.lineTo(pt[0], pt[1]);
    }
    ctx.stroke();
  }

  function draw(tg) {
    ctx.clearRect(0, 0, W, H);
    if (tg >= T3) return;               // void: everything is gone

    if (tg < T2) {                      // write on, then hold: crisp readable text
      drawCrispText(0.92 * (tg < T1 ? smooth(0, WRITE, tg) : 1));
      return;
    }

    // fall: crossfade the crisp text out, spaghettify the particles in
    const local = tg - T2;
    const cf = 1 - smooth(0, XFADE, local);
    if (cf > 0.01) drawCrispText(0.92 * cf);

    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const fq = (local - p.fallDelay) / p.fallDur;
      if (fq <= 0) {
        ctx.fillStyle = 'rgba(' + CFG.color + ',0.85)';
        ctx.fillRect(p.x - 1.1, p.y - 1.1, 2.2, 2.2);
      } else if (fq < 1) {
        drawStrand(p, fq);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  let raf = 0, startT = 0;
  function frame(now) {
    if (!startT) startT = now;
    draw(((now - startT) / 1000) % TOTAL);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    cancelAnimationFrame(raf);
    if (reduceMotion) {
      draw(T1);                         // static, fully-formed readable text
    } else {
      startT = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  let resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { build(); start(); }, 150);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) cancelAnimationFrame(raf);
    else if (!reduceMotion) start();
  });

  build();
  start();
})();
