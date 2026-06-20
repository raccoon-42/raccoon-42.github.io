/* Black hole renderer for the 404 page.
   Runs a ported WebGL2 fragment shader (assets/shaders/blackhole.frag): a
   per-pixel geodesic trace of a Schwarzschild black hole. The whole screen is
   filled with a field of monospace text and fed in as the lens plane, so the
   hole bends and mirrors that text around itself (the Ghostty terminal look).
   The hole gently drifts, so the bent text ripples. Heavy near the hole, so it
   renders at a capped resolution, pauses when hidden, and falls back to the
   static CSS background if WebGL2 is unavailable. */

(function () {
  const canvas = document.getElementById('blackhole-canvas');
  if (!canvas) return;

  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
  if (!gl) return; // no WebGL2: leave the CSS fallback background in place

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MAXQ = 2; // render resolution cap; full device pixels so it's sharp at 100% zoom

  // the field of text the hole bends. lowercase, no em-dashes (house style).
  const LINES = [
    '404 not found',
    'that page drifted off into space',
    'head back where you belong',
    'signal lost beyond the horizon',
    'GET /lost returns 404',
    'nothing here but the pull of gravity',
    'the map ends where the light bends',
    'you have drifted past the event horizon',
  ];

  const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('blackhole shader error:\n' + gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  const B_CRIT = 2.5980762;  // shadow radius in r_s; matches the shader
  let prog, uRes, uTime, tex, raf = 0, startT = 0;
  let cfg = null;            // shader constants parsed from the frag (kept in sync)
  let navItems = [];         // nav links + their natural-position uv, for click tracking
  const tcvs = document.createElement('canvas');
  const tctx = tcvs.getContext('2d');

  function buildTextTexture(q) {
    const W = window.innerWidth, H = window.innerHeight;
    tcvs.width = Math.round(W * q);
    tcvs.height = Math.round(H * q);
    const c = tctx;
    c.setTransform(q, 0, 0, q, 0, 0); // draw in CSS px; texture is q-x for crisp bent text
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);

    const fs = Math.max(12, Math.round(H * 0.017));
    const lh = Math.round(fs * 1.5);
    c.font = fs + 'px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    c.textBaseline = 'top';

    let row = 0;
    // text fills the whole background; the "go home" link keeps its own dark
    // clearing (box-shadow) so it stays legible over the field
    const top = 0;
    const bottom = H;
    for (let y = top; y < bottom; y += lh, row++) {
      // subtle two-tone banding gives the field some depth
      c.fillStyle = (row % 2 === 0) ? '#828ea4' : '#6d7689';
      // repeat the phrase across the full width, staggered per row, so the
      // field reads dense like a terminal rather than a tidy column
      const base = LINES[row % LINES.length] + '   ';
      let line = '';
      while (c.measureText(line).width < W + 120) line += base;
      const offset = -((row * 53) % 220);
      c.fillText(line, offset, y);
    }

    drawNav(c);

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tcvs);
  }

  // draw the nav labels into the lens plane so they bend with the field. The
  // real links stay put (transparent + clickable) over their drawn labels.
  // Desktop only: the mobile hamburger menu keeps a normal visible nav.
  function drawNav(c) {
    navItems = [];
    if (window.innerWidth < 672) return;
    const links = document.querySelectorAll('.nav-menu a');
    const W = window.innerWidth, H = window.innerHeight;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillStyle = '#e6ebf3';
    links.forEach(function (el) {
      el.style.transform = '';                  // measure the natural (untransformed) box
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      const cs = getComputedStyle(el);
      const fsz = parseFloat(cs.fontSize) || 16;
      const padL = parseFloat(cs.paddingLeft) || 0;
      c.font = fsz + 'px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
      c.fillText(el.textContent, r.left + padL, r.top + r.height / 2 + 1);
      navItems.push({ el: el, ux: (r.left + r.width / 2) / W, uy: (r.top + r.height / 2) / H });
    });
  }

  // parse the shader constants needed to predict where each lensed nav label
  // lands (read from the actual frag source so there are no duplicated numbers).
  function parseCfg(src) {
    function n(re, d) { const m = src.match(re); return m ? parseFloat(m[1]) : d; }
    const c = {
      holeR: n(/HOLE_RADIUS\s*=\s*([-\d.eE]+)/, 0.06),
      lensDepth: n(/LENS_DEPTH\s*=\s*([-\d.eE]+)/, 13),
      warpLean: n(/WARP_LEAN\s*=\s*([-\d.eE]+)/, 0.0),
      driftAmt: n(/DRIFT_AMT\s*=\s*([-\d.eE]+)/, 0.0),
      driftSpeed: n(/DRIFT_SPEED\s*=\s*([-\d.eE]+)/, 1.0),
    };
    const name = (src.match(/#define\s+PRESET\s+(\w+)/) || [])[1] || 'QUASAR';
    const pm = src.match(new RegExp('DiskLook\\s+' + name + '\\s*=\\s*DiskLook\\(([^)]*)\\)'));
    const pv = pm ? pm[1].split(',').map(parseFloat) : [];
    const rin = Math.max(pv[3] || 1.8, 1.6);
    c.rout = Math.max(pv[4] || 8, rin + 0.5);
    return c;
  }

  // move each transparent nav link onto its bent label, so it stays clickable
  // wherever the lensing puts it (nav sits in the analytic far field).
  function navUpdate(time) {
    if (!cfg || !navItems.length) return;
    const W = window.innerWidth, H = window.innerHeight, aspect = W / H;
    const s = time * cfg.driftSpeed * 0.15;
    const cx = 0.5 + cfg.driftAmt * (0.75 * Math.sin(s * 0.37) + 0.25 * Math.sin(s * 0.83 + 1.0));
    const cy = 0.5 + cfg.driftAmt * (0.70 * Math.sin(s * 0.54 + 2.1) + 0.30 * Math.sin(s * 1.07));
    const rh = cfg.holeR, Wm = B_CRIT / Math.max(rh, 1e-4);
    const Z0 = Math.max(14, cfg.rout + 5), bmax = cfg.rout + 3;
    for (let i = 0; i < navItems.length; i++) {
      const it = navItems[i];
      const px = (it.ux - cx) * aspect, py = it.uy - cy;
      const plen = Math.max(Math.hypot(px, py), 1e-5);
      const b = plen * Wm;
      const win = Math.exp(-Math.pow(plen / (7 * rh), 2));
      let dx = 0, dy = 0;
      if (b >= bmax) {
        const u = Z0 / Math.sqrt(Z0 * Z0 + b * b);
        const defl = (2 / (Wm * Wm)) / plen * (1.29 * u + 0.07) *
                     Math.max(cfg.lensDepth - 2.14 * u + 0.75, 0) * win;
        dx = (px / plen) * defl - cfg.warpLean * py * win;
        dy = (py / plen) * defl;
      }
      it.el.style.transform = 'translate(' + (dx * H).toFixed(1) + 'px,' + (dy * H).toFixed(1) + 'px)';
    }
  }

  function init(fragSrc) {
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return;
    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('blackhole link error:\n' + gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);
    uRes = gl.getUniformLocation(prog, 'iResolution');
    uTime = gl.getUniformLocation(prog, 'iTime');
    gl.bindVertexArray(gl.createVertexArray());

    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(gl.getUniformLocation(prog, 'iChannel0'), 0);

    cfg = parseCfg(fragSrc);

    // only now (WebGL2 is live) hide the real nav text; its lensed copy shows
    document.body.classList.add('bh-lensed-nav');

    resize();
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    start();
  }

  function resize() {
    const q = Math.min(window.devicePixelRatio || 1, MAXQ); // re-read so zoom adapts
    const w = Math.max(1, Math.round(window.innerWidth * q));
    const h = Math.max(1, Math.round(window.innerHeight * q));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    if (uRes) gl.uniform3f(uRes, w, h, 1.0);
    buildTextTexture(q);
  }

  function render(nowMs) {
    if (!startT) startT = nowMs;
    const t = (nowMs - startT) / 1000;
    gl.uniform1f(uTime, t);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    navUpdate(t);
    raf = requestAnimationFrame(render);
  }

  function start() {
    cancelAnimationFrame(raf);
    if (reduceMotion) {
      gl.uniform1f(uTime, 8.0); // one composed static frame
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      navUpdate(8.0);
    } else {
      raf = requestAnimationFrame(render);
    }
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resize(); if (reduceMotion) start(); }, 150);
  }

  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(raf);
    } else if (!reduceMotion) {
      startT = 0;
      start();
    }
  }

  fetch('/assets/shaders/blackhole.frag')
    .then(function (r) { return r.text(); })
    .then(init)
    .catch(function (e) { console.error('blackhole: failed to load shader', e); });
})();
