/* Black hole renderer for the 404 page and the standalone /void.html.
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
  const CURSOR_PULL = 0.7;   // how far toward the pointer the hole reaches (0 = ignore, 1 = all the way)
  const PULL_FOLLOW = 0.0005;  // how tightly the hole tracks the pointer while held/hovering
  const PULL_FRICTION = 0.90;  // on release it coasts on its last velocity, slowing to a stop where it lands
  const DISK_SPEED_PER_MASS = 4.0; // streaks speed up with mass: speed = 1 + (mass-1)*this (fed = faster/more violent)
  const FEED_TAP = 0.15; // size the hole gains per press (a tap of mass)
  const FEED_RATE = 0.8;  // extra size per second while a press is held (pouring mass in)
  const MASS_MAX = 4.0;  // hard cap on the size multiplier (how big it can ever get)
  const MASS_DECAY = 0.004;// how fast it shrinks back toward baseline when not fed (slow)
  const MASS_EASE = 0.08; // how smoothly the visible size follows the accumulated mass
  const MASS_SIZE_GAIN = 0.35; // feeding enlarges the hole (shadow + disk + lensing scale up together, with luminance) -- the realistic "more mass" look
  const MASS_LUM_GAIN = 2.5;  // how much feeding brightens the disk (the main "flare" cue); 0 = no brighten
  const VIEW_FIT = 1.15; // responsive base size: shrink the hole on narrow screens so the whole disk fits
  const VIEW_MIN = 0.45; // floor for that base size (never smaller than this fraction)
  const INFLOW_SPEED = 0.6;  // how fast the disk's matter spirals inward while you hold (drives INFALL_K in the shader; 0 = off)
  const INFLOW_RELAX = 0.97; // when released, how fast that inward pull eases back out (per frame)

  // the field of text the hole bends. lowercase, no em-dashes (house style).
  // a page can override the copy via window.BLACKHOLE_LINES (e.g. /void.html);
  // these defaults are the 404 set.
  const LINES = (window.BLACKHOLE_LINES && window.BLACKHOLE_LINES.length) ? window.BLACKHOLE_LINES : [
    '404 not found',
    'that page drifted off into space',
    'head back where you belong',
    'signal lost beyond the horizon',
    'GET /lost returns 404',
    'nothing here but the pull of gravity',
    'the map ends where the light bends',
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
  let prog, uRes, uTime, uCursor, uDiskTime, uMass, uFlare, uInflow, tex, raf = 0, startT = 0;
  let pullX = 0, pullY = 0, tgtPullX = 0, tgtPullY = 0; // hole's drift toward the pointer (uv offset)
  let velX = 0, velY = 0, pointerActive = false, pressed = false; // pull momentum + press state
  let diskTime = 0, lastMs = 0;                        // disk-streak warped clock (speed follows mass)
  let mass = 1.0, massTarget = 1.0;                    // hole size: accumulates when fed, eased + relaxes
  let baseScale = 1.0, szEff = 1.0;                    // responsive base size (per viewport) x the fed size
  let inflowPhase = 0;                                 // accumulated infall (grows while held, drives the disk's inward spiral)
  let cfg = null;            // shader constants parsed from the frag (kept in sync)
  let navItems = [];         // nav links + their natural-position uv, for click tracking
  let fragSource = '';       // the raw shader source (preset is swapped in per selection)
  let presetScale = 1.0;     // per-preset size normalization so each look fills the frame similarly
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

  // the hole's drifting center in uv (autonomous drift + pointer pull)
  function holeCenterUV(time) {
    const s = time * cfg.driftSpeed * 0.15;
    return {
      x: 0.5 + cfg.driftAmt * (0.75 * Math.sin(s * 0.37) + 0.25 * Math.sin(s * 0.83 + 1.0)) + pullX,
      y: 0.5 + cfg.driftAmt * (0.70 * Math.sin(s * 0.54 + 2.1) + 0.30 * Math.sin(s * 1.07)) + pullY,
    };
  }

  // move each transparent nav link onto its bent label, so it stays clickable
  // wherever the lensing puts it (nav sits in the analytic far field).
  function navUpdate(time) {
    if (!cfg || !navItems.length) return;
    const W = window.innerWidth, H = window.innerHeight, aspect = W / H;
    const cc = holeCenterUV(time);
    const cx = cc.x, cy = cc.y;
    const rh = cfg.holeR * szEff, Wm = B_CRIT / Math.max(rh, 1e-4); // effective size (base x fed); keep nav in sync
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

  // the disk-look presets are compile-time (#define PRESET) in the shader. to let
  // the visitor switch at runtime we swap the #define and relink the program.
  const PRESET_RE = /#define\s+PRESET\s+(\w+)/;
  function fragWithPreset(name) { return fragSource.replace(PRESET_RE, '#define PRESET ' + name); }
  function presetNames(src) {
    const re = /const\s+DiskLook\s+(\w+)\s*=\s*DiskLook/g, out = []; let m;
    while ((m = re.exec(src))) out.push(m[1]);
    return out;
  }

  // compile + link a fragment shader source into a program (vertex shader is fixed)
  function compileProgram(src) {
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, src);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('blackhole link error:\n' + gl.getProgramInfoLog(p));
      gl.deleteProgram(p);
      return null;
    }
    return p;
  }

  // make a freshly-built program current and (re)bind its uniforms (uniforms are
  // per-program, so this re-fetches every location after a relink)
  function useNewProgram(p) {
    if (prog) gl.deleteProgram(prog);
    prog = p;
    gl.useProgram(prog);
    uRes = gl.getUniformLocation(prog, 'iResolution');
    uTime = gl.getUniformLocation(prog, 'iTime');
    uCursor = gl.getUniformLocation(prog, 'iCursor');
    uDiskTime = gl.getUniformLocation(prog, 'iDiskTime');
    uMass = gl.getUniformLocation(prog, 'iMass');
    uFlare = gl.getUniformLocation(prog, 'iFlare');
    uInflow = gl.getUniformLocation(prog, 'iInflow');
    gl.uniform1i(gl.getUniformLocation(prog, 'iChannel0'), 0);
  }

  // each preset has a different disk outer radius, so without this the disk would
  // render tiny (M87) or huge (BLAZAR) when switching. normalize so every look
  // fills a similar fraction of the frame (folded into szEff, alongside the fed size).
  function computePresetScale() {
    const TARGET = 0.32; // disk outer edge as a fraction of screen height
    const raw = TARGET * B_CRIT / Math.max(cfg.rout * cfg.holeR, 1e-4);
    presetScale = Math.max(0.5, Math.min(raw, 6.0));
  }

  // relink with the chosen preset, resync the parsed constants + size, redraw
  function applyPreset(name) {
    const src = fragWithPreset(name);
    const p = compileProgram(src);
    if (!p) return;
    useNewProgram(p);
    cfg = parseCfg(src);
    computePresetScale();
    try { localStorage.setItem('bh-preset', name); } catch (e) { /* private mode / file:// */ }
    resize();                    // resets viewport + iResolution + re-uploads the text texture for the new program
    if (reduceMotion) start();   // running loop picks it up; static frame needs a manual redraw
  }

  function init(fragSrc) {
    fragSource = fragSrc;

    // the visitor's last choice (shared across 404 + void), else the file default
    let initial = (fragSrc.match(PRESET_RE) || [])[1] || 'QUASAR';
    try {
      const saved = localStorage.getItem('bh-preset');
      if (saved && presetNames(fragSrc).indexOf(saved) !== -1) initial = saved;
    } catch (e) { /* private mode / file:// */ }

    gl.bindVertexArray(gl.createVertexArray());
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);

    const p = compileProgram(fragWithPreset(initial));
    if (!p) return;
    useNewProgram(p);
    cfg = parseCfg(fragWithPreset(initial));
    computePresetScale();

    // only now (WebGL2 is live) hide the real nav text; its lensed copy shows
    document.body.classList.add('bh-lensed-nav');

    resize();
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pointermove', onPointerMove); // hover (mouse) / drag (touch): pulls the hole
    window.addEventListener('pointerdown', onPointerDown); // press: flare burst + starts the spin-up
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('mouseleave', onMouseLeave); // desktop: end the pull when the cursor leaves
    addPresetPicker(initial);
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
    // shrink the hole on narrow/portrait screens so the whole disk fits the width
    baseScale = Math.max(VIEW_MIN, Math.min(1.0, (window.innerWidth / window.innerHeight) * VIEW_FIT));
    buildTextTexture(q);
  }

  function render(nowMs) {
    if (!startT) startT = nowMs;
    const t = (nowMs - startT) / 1000;
    const dt = lastMs ? Math.min((nowMs - lastMs) / 1000, 0.1) : 0;
    lastMs = nowMs;

    // pull: while held/hovering the hole tracks the pointer (slowing as it nears,
    // no overshoot). on release it keeps its last velocity and coasts to a stop
    // where it was heading -- momentum, no spring back to center.
    if (pointerActive) {
      const nx = pullX + (tgtPullX - pullX) * PULL_FOLLOW;
      const ny = pullY + (tgtPullY - pullY) * PULL_FOLLOW;
      velX = nx - pullX; velY = ny - pullY;
      pullX = nx; pullY = ny;
    } else {
      pullX += velX; pullY += velY;
      velX *= PULL_FRICTION; velY *= PULL_FRICTION;
    }

    // mass: holding pours mass in (grows the hole), capped; released it slowly
    // shrinks back. the visible size eases toward the accumulated target.
    if (pressed) massTarget = Math.min(massTarget + FEED_RATE * dt, MASS_MAX);
    else massTarget += (1.0 - massTarget) * MASS_DECAY;
    mass += (massTarget - mass) * MASS_EASE;

    // disk speed is tied to mass: the more you've fed it, the faster (and more
    // violently) the streaks whirl. driven through diskTime (a warped clock) so
    // they advect AND renew faster together -- no extra winding.
    const diskSpeed = 1.0 + (mass - 1.0) * DISK_SPEED_PER_MASS;
    diskTime += dt * diskSpeed;

    // feeding is mostly a brightness flare + a subtle swell (not a zoom). the
    // responsive base size keeps the whole disk on-screen on narrow viewports.
    szEff = baseScale * presetScale * (1.0 + (mass - 1.0) * MASS_SIZE_GAIN);
    const flare = 1.0 + (mass - 1.0) * MASS_LUM_GAIN;

    // infall phase grows while held, eases out on release; drives the disk's inward spiral
    if (pressed) inflowPhase += dt * INFLOW_SPEED;
    else inflowPhase *= INFLOW_RELAX;

    gl.uniform1f(uTime, t);
    gl.uniform2f(uCursor, pullX, pullY);
    gl.uniform1f(uDiskTime, diskTime);
    gl.uniform1f(uMass, szEff);
    gl.uniform1f(uFlare, flare);
    gl.uniform1f(uInflow, inflowPhase);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    navUpdate(t);
    raf = requestAnimationFrame(render);
  }

  function start() {
    cancelAnimationFrame(raf);
    if (reduceMotion) {
      gl.uniform1f(uTime, 8.0); // one composed static frame
      gl.uniform2f(uCursor, pullX, pullY);
      gl.uniform1f(uDiskTime, diskTime);
      szEff = baseScale * presetScale * (1.0 + (mass - 1.0) * MASS_SIZE_GAIN);
      gl.uniform1f(uMass, szEff);
      gl.uniform1f(uFlare, 1.0 + (mass - 1.0) * MASS_LUM_GAIN);
      gl.uniform1f(uInflow, inflowPhase);
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
      lastMs = 0;
      start();
    }
  }

  // pull target follows the pointer (mouse hover, or a held/dragged touch); the
  // momentum + coast live in render(). nav tracking uses the same pull.
  function onPointerMove(e) {
    tgtPullX = (e.clientX / window.innerWidth - 0.5) * CURSOR_PULL;
    tgtPullY = (e.clientY / window.innerHeight - 0.5) * CURSOR_PULL;
    pointerActive = true;
  }
  // press = feed: a tap of mass; holding pours more in (render()). the disk speed
  // follows mass, so feeding also energizes the streaks. nav stays in sync via mass.
  // a press on a control (the preset picker, a link, a button) shouldn't feed.
  function onPointerDown(e) {
    if (e.target.closest && e.target.closest('.bh-preset, a, button, select, input')) return;
    onPointerMove(e);
    pressed = true;
    massTarget = Math.min(massTarget + FEED_TAP, MASS_MAX);
  }
  // release: stop the spin-up. touch/pen also ends the pull so it coasts to a
  // stop; mouse keeps following its cursor (the desktop pull ends on mouseleave).
  function onPointerUp(e) {
    pressed = false;
    if (e.pointerType !== 'mouse') pointerActive = false;
  }
  function onMouseLeave() { pointerActive = false; pressed = false; }

  // on-scene control to switch the black-hole look; each pick relinks the shader
  function addPresetPicker(current) {
    const names = presetNames(fragSource);
    if (names.length < 2) return;
    const wrap = document.createElement('label');
    wrap.className = 'bh-preset';
    const cap = document.createElement('span');
    cap.className = 'bh-preset-label';
    cap.textContent = 'black hole';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'black hole type');
    names.forEach(function (n) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = (n === 'M87') ? 'M87' : n.toLowerCase(); // M87 is a catalog name, keep it
      if (n === current) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { applyPreset(sel.value); });
    wrap.appendChild(cap);
    wrap.appendChild(sel);
    document.body.appendChild(wrap);
  }

  fetch('/assets/shaders/blackhole.frag', { cache: 'no-cache' }) // always revalidate so shader edits aren't served stale
    .then(function (r) { return r.text(); })
    .then(init)
    .catch(function (e) { console.error('blackhole: failed to load shader', e); });
})();
