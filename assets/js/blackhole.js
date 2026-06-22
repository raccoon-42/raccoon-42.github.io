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
  const PULL_FOLLOW = 0.0005;  // mouse: how tightly the hole tracks the cursor while hovering (very slow, heavy gravitational lag)
  const PULL_STIFF = 20.0;     // touch: spring stiffness toward the finger (lower = heavier, more initial lag before it moves)
  const PULL_DAMP = 10.0;     // touch: damping (>~2*sqrt(STIFF) = no springback, just a heavy sluggish catch-up)
  const PULL_COAST = 3.5;      // touch: after release, how fast the coasting hole slows to rest (per second)
  const PULL_FRICTION = 0.90;  // mouse: on release it coasts on its last velocity, slowing to a stop where it lands
  const DISK_SPEED_K = 0.9; // the whirl fastens exponentially with mass while held: speed = e^(K*(mass-1)) (gentle, then ramps up)
  const FEED_TAP = 0.15; // size the hole gains per press (a tap of mass)
  const FEED_RATE = 0.8;  // extra size per second while a press is held (pouring mass in)
  const MASS_MAX = 3.0;  // hard cap on the size multiplier (how big it can ever get)
  const MASS_DECAY = 0.1;  // on release, how fast the accumulated mass falls back to baseline (high = quick zoom-back)
  const MASS_EASE = 0.08; // how smoothly the visible size follows the accumulated mass
  const MASS_SIZE_K = 0.5; // the event horizon largens exponentially with mass: size = e^(K*(mass-1)) (higher = the zoom accelerates sooner/harder)
  const MASS_LUM_K = 0.7; // feeding brightens + heats the disk (bluer, via the shader's TEMP_BLUE): flare = e^(K*(mass-1)) (lower = reaches white more gradually)
  const VIEW_FIT = 0.8;  // responsive base size: zoom the hole out on narrow/portrait screens so the event horizon has margin (mobile); wide screens clamp to 1.0 (unaffected)
  const VIEW_MIN = 0.33; // floor for that base size (never smaller than this fraction)
  const INFLOW_SPEED = 0.6;  // how fast the disk's matter spirals inward while you hold (drives INFALL_K in the shader; 0 = off)
  const INFLOW_RELAX = 0.97; // when released, how fast that inward pull eases back out (per frame)
  const WOBBLE_AMP = 0.085; // changing the hole "drops it onto the screen": base drop (uv), scaled by the hole's mass
  const WOBBLE_OMEGA = 4.5;   // base natural frequency (rad/s); divided by sqrt(mass) so heavy holes wobble slower (inertia)
  const WOBBLE_ZETA = 0.16;  // damping ratio: low = keeps shaking (several decaying oscillations) after a swipe; ~cycles before settling = 0.37/this
  const WOBBLE_SIZE = 0.18;  // on impact the hole swells this much, deepening the gravity well (spacetime bend felt), relaxing with the wobble
  const RIPPLE_FEED_K = 1.3; // feeding shakes the spacetime fabric: vibration = 1 - e^(-(mass-1)*this), saturating as you feed (0 = only the wobble ripples)
  const RIPPLE_VEL_K = 0.25; // the size *changing* shakes it too; the fast snap-back on release is the biggest change, so it ripples hardest
  const REL_RIP_GAIN = 0.7;  // on release the hole returns smoothly but the spacetime FABRIC keeps rippling: kick = (fed mass - 1) * this (bigger feed -> bigger ripple)
  const REL_RIP_DECAY = 0.997;// how slowly that release ripple fades (per frame; closer to 1 = longer train of fabric oscillations)
  const REL_RIP_MAX = 1.6;   // cap on the release ripple kick
  const DISK_WOB_W = 1.3;    // the disk nods with the wobble's shake (radians of inclination per unit wobble offset)
  const DISK_WOB_V = 7.0;    // the disk nods with the hole's drag velocity (radians per unit per-frame motion)

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
  let prog, uRes, uTime, uCursor, uDiskTime, uMass, uFlare, uInflow, uRipple, uDiskWob, tex, raf = 0, startT = 0;
  let pullX = 0, pullY = 0, tgtPullX = 0, tgtPullY = 0; // hole's drift toward the pointer (uv offset)
  let velX = 0, velY = 0, pointerActive = false, pressed = false, pullTouch = false; // pull momentum + press state (touch = faster follow)
  let diskTime = 0, lastMs = 0;                        // disk-streak warped clock (speed follows mass)
  let mass = 1.0, massTarget = 1.0, prevMass = 1.0;    // hole size: accumulates when fed, returns smoothly on release
  let relRip = 0, wasPressed = false;                  // release ripple: the fabric keeps rippling after a feed (long, fades), the hole itself does not pulse
  let prevHoleX = 0, prevHoleY = 0;                    // last hole-center offset, for the disk's motion-driven nod
  let baseScale = 1.0, szEff = 1.0;                    // responsive base size (per viewport) x the fed size
  let inflowPhase = 0;                                 // accumulated infall (grows while held, drives the disk's inward spiral)
  let cfg = null;            // shader constants parsed from the frag (kept in sync)
  let navItems = [];         // nav links + their natural-position uv, for click tracking
  let fragSource = '';       // the raw shader source (preset is swapped in per selection)
  let presetScale = 1.0;     // per-preset size normalization so each look fills the frame similarly
  let currentPreset = '';    // the active preset name (kept in sync between the picker + swipe)
  let presetSelect = null;   // the picker <select>, so swipe can keep it in sync
  let swTouch = false, swX = 0, swY = 0, swT = 0, swPullX = 0, swPullY = 0; // touch swipe tracking (+ pull at gesture start, to undo it on a swipe)
  let wobAge = 1e9, wobDX = 0, wobDY = 0, wobX = 0, wobY = 0, wobSwell = 0, wobRip = 0; // preset-change "drop" wobble (2D throw + size swell + fabric ripple)
  let wobW = WOBBLE_OMEGA, wobZ = WOBBLE_ZETA;              // per-change natural frequency + damping ratio (set on kick)
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
      diskCycle: n(/DISK_CYCLE\s*=\s*([-\d.eE]+)/, 8.0),
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
      x: 0.5 + cfg.driftAmt * (0.75 * Math.sin(s * 0.37) + 0.25 * Math.sin(s * 0.83 + 1.0)) + pullX + wobX,
      y: 0.5 + cfg.driftAmt * (0.70 * Math.sin(s * 0.54 + 2.1) + 0.30 * Math.sin(s * 1.07)) + pullY + wobY,
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
    uRipple = gl.getUniformLocation(prog, 'iRipple');
    uDiskWob = gl.getUniformLocation(prog, 'iDiskWob');
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
    currentPreset = name;
    if (presetSelect && presetSelect.value !== name) presetSelect.value = name; // keep the picker in sync (swipe)
    try { localStorage.setItem('bh-preset', name); } catch (e) { /* private mode / file:// */ }
    resize();                    // resets viewport + iResolution + re-uploads the text texture for the new program
    if (reduceMotion) start();   // running loop picks it up; static frame needs a manual redraw
  }

  // a "drop in" wobble for when the hole changes. the throw goes along (dirX,dirY)
  // -- the swipe vector -- so a horizontal-dominant swipe throws it horizontally,
  // its force carried by `strength`. with no direction (dropdown) it falls in from
  // above. randomized per change (magnitude, ring rate, settle, jitter) so each
  // black hole + swipe lands differently; amplitude also scales with mass (presetScale).
  function kickWobble(dirX, dirY, strength) {
    if (reduceMotion) return;
    const len = Math.hypot(dirX || 0, dirY || 0);
    let ux, uy;
    if (len > 1e-4) { ux = dirX / len; uy = dirY / len; } // throw along the swipe direction
    else { ux = (Math.random() - 0.5) * 0.5; uy = -1.0; } // no swipe: fall in from above
    const amp = Math.min(WOBBLE_AMP * presetScale * (0.75 + Math.random() * 0.6) * (strength || 1), 0.22); // cap so it stays in frame
    ux += (Math.random() - 0.5) * 0.25;                   // a little jitter so it's never identical
    uy += (Math.random() - 0.5) * 0.25;
    wobDX = amp * ux;
    wobDY = amp * uy;
    wobW = WOBBLE_OMEGA / Math.sqrt(presetScale) * (0.9 + Math.random() * 0.2); // heavier hole -> slower wobble (inertia)
    wobZ = WOBBLE_ZETA * (0.95 + Math.random() * 0.12);                          // slight per-change variation
    wobAge = 0;
  }

  // step to the next/previous preset (wraps); used by the mobile swipe gesture.
  // (dirX,dirY)/strength carry the swipe vector + force into the drop wobble.
  function cyclePreset(dir, dirX, dirY, strength) {
    const names = presetNames(fragSource);
    if (names.length < 2) return;
    let i = names.indexOf(currentPreset);
    if (i < 0) i = 0;
    applyPreset(names[(i + dir + names.length) % names.length]);
    kickWobble(dirX, dirY, strength);
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
    currentPreset = initial;

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
    if (pullTouch) {
      // touch: the hole is a mass on a spring with mass = presetScale, so a heavier
      // hole lags more, follows more sluggishly, and coasts longer (inertia ~ mass).
      // damping scales with sqrt(mass) so the feel stays heavy (never bouncy) at any mass.
      const m = presetScale;
      if (pointerActive) {
        const c = PULL_DAMP * Math.sqrt(m);
        velX += (PULL_STIFF * (tgtPullX - pullX) - c * velX) / m * dt;
        velY += (PULL_STIFF * (tgtPullY - pullY) - c * velY) / m * dt;
      } else {
        const drag = PULL_COAST / Math.sqrt(m);  // heavier coasts longer
        velX -= velX * drag * dt;
        velY -= velY * drag * dt;
      }
      pullX += velX * dt;
      pullY += velY * dt;
    } else if (pointerActive) {
      // mouse: very slow exponential lag toward the cursor (heavy gravitational drag)
      const nx = pullX + (tgtPullX - pullX) * PULL_FOLLOW;
      const ny = pullY + (tgtPullY - pullY) * PULL_FOLLOW;
      velX = nx - pullX; velY = ny - pullY;
      pullX = nx; pullY = ny;
    } else {
      pullX += velX; pullY += velY;             // mouse released: coast on last velocity
      velX *= PULL_FRICTION; velY *= PULL_FRICTION;
    }

    // mass: holding pours mass in (grows the hole), capped; on release it returns
    // smoothly to baseline (the hole itself does NOT pulse/ring). the big mass shift
    // on release instead kicks a long ripple in the spacetime fabric (below).
    if (pressed) massTarget = Math.min(massTarget + FEED_RATE * dt, MASS_MAX);
    else massTarget += (1.0 - massTarget) * MASS_DECAY;
    mass += (massTarget - mass) * MASS_EASE;

    // on release of a feed, the collapsing mass shift sets the fabric rippling; it
    // then keeps oscillating and slowly damps out (long), scaled by how much was fed.
    if (wasPressed && !pressed && mass > 1.05) relRip = Math.min(relRip + (mass - 1.0) * REL_RIP_GAIN, REL_RIP_MAX);
    wasPressed = pressed;
    relRip *= REL_RIP_DECAY;

    // the whirl, the largening, and the flare/color all ride the SAME exponential
    // feed curve (feedPow), each with its own gain, so they ramp together (proportional).
    // gentle at first as you start holding, then ramps up the longer you feed.
    const diskSpeed = feedPow(DISK_SPEED_K);
    diskTime += dt * diskSpeed;
    const wrapT = cfg.diskCycle * 4096.0;        // bound the disk clock (feeding is uncapped) without changing fract(t/cycle)
    if (diskTime > wrapT) diskTime -= wrapT;

    // feeding is mostly a brightness flare + a subtle swell (not a zoom). the
    // responsive base size keeps the whole disk on-screen on narrow viewports.
    szEff = baseScale * presetScale * feedPow(MASS_SIZE_K);
    const flare = feedPow(MASS_LUM_K);

    // infall phase grows while held, eases out on release; drives the disk's inward spiral
    if (pressed) inflowPhase += dt * INFLOW_SPEED;
    else inflowPhase *= INFLOW_RELAX;

    // preset-change wobble: the new hole drops in and settles (decaying cosine,
    // starts displaced up + leaning so it falls onto the screen). per-change random.
    if (wobAge < 7.0) {
      wobAge += dt;
      const zw = wobZ * wobW;
      const wd = wobW * Math.sqrt(Math.max(1.0 - wobZ * wobZ, 1e-3)); // damped frequency
      const decay = Math.exp(-zw * wobAge);
      // free response from an initial displacement (zero initial velocity): eases back
      // with at most one gentle overshoot -> a heavy settle, not a springy bounce
      const s = decay * (Math.cos(wd * wobAge) + (zw / wd) * Math.sin(wd * wobAge));
      wobX = wobDX * s;
      wobY = wobDY * s;
      wobSwell = WOBBLE_SIZE * decay;   // lands swollen -> deeper gravity well (bend felt), relaxes
      wobRip = decay;                   // drive the fabric ripple while it rings
    } else if (wobX !== 0 || wobY !== 0 || wobSwell !== 0 || wobRip !== 0) {
      wobX = 0; wobY = 0; wobSwell = 0; wobRip = 0;
    }
    szEff *= (1.0 + wobSwell);           // the impact swell deepens the lensing

    gl.uniform1f(uTime, t);
    gl.uniform2f(uCursor, pullX + wobX, pullY + wobY);
    gl.uniform1f(uDiskTime, diskTime);
    gl.uniform1f(uMass, szEff);
    gl.uniform1f(uFlare, flare);
    gl.uniform1f(uInflow, inflowPhase);
    // spacetime vibration: feeding shakes the fabric (sustained), the size *changing*
    // shakes it more -- and on release the size RINGS, so each swing of that ring
    // re-shakes the fabric, giving a long wobble train that fades with the ring.
    const feedRip = Math.max(0, 1.0 - Math.exp(-(mass - 1.0) * RIPPLE_FEED_K));
    const moveRip = (dt > 0 ? Math.abs(mass - prevMass) / dt : 0) * RIPPLE_VEL_K;
    prevMass = mass;
    gl.uniform1f(uRipple, Math.min(wobRip + feedRip + moveRip + relRip, 1.6));

    // the disk nods/sloshes with the hole's shake (the wobble oscillation) and with
    // its motion (the drag velocity), so it visibly wobbles, not just translates.
    const holeX = pullX + wobX, holeY = pullY + wobY;
    const diskWob = (wobX + wobY) * DISK_WOB_W + ((holeX - prevHoleX) + (holeY - prevHoleY)) * DISK_WOB_V;
    prevHoleX = holeX; prevHoleY = holeY;
    gl.uniform1f(uDiskWob, Math.max(-0.5, Math.min(0.5, diskWob)));

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    navUpdate(t);
    raf = requestAnimationFrame(render);
  }

  // the one feed curve: how much "fed mass" (mass-1) amplifies an effect, e^(k*(mass-1)).
  // the whirl, the largening, and the flare/color all use this (with their own k), so
  // they stay proportional -- ramping together on the same exponential.
  function feedPow(k) { return Math.exp(k * (mass - 1.0)); }

  function start() {
    cancelAnimationFrame(raf);
    if (reduceMotion) {
      gl.uniform1f(uTime, 8.0); // one composed static frame
      gl.uniform2f(uCursor, pullX, pullY);
      gl.uniform1f(uDiskTime, diskTime);
      szEff = baseScale * presetScale * feedPow(MASS_SIZE_K);
      gl.uniform1f(uMass, szEff);
      gl.uniform1f(uFlare, feedPow(MASS_LUM_K));
      gl.uniform1f(uInflow, inflowPhase);
      gl.uniform1f(uRipple, 0.0); // no wobble ripple in the static (reduced-motion) frame
      gl.uniform1f(uDiskWob, 0.0);
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
    pullTouch = (e.pointerType !== 'mouse'); // touch drifts faster than the slow mouse hover
  }
  // press = feed: a tap of mass; holding pours more in (render()). the disk speed
  // follows mass, so feeding also energizes the streaks. nav stays in sync via mass.
  // a press on a control (the preset picker, a link, a button) shouldn't feed.
  // a touch press also starts swipe tracking (a horizontal swipe cycles presets).
  function onPointerDown(e) {
    swTouch = false;
    if (e.target.closest && e.target.closest('.bh-preset, a, button, select, input')) return;
    if (e.pointerType !== 'mouse') { swTouch = true; swX = e.clientX; swY = e.clientY; swT = e.timeStamp; swPullX = pullX; swPullY = pullY; }
    onPointerMove(e);
    pressed = true;
    massTarget = Math.min(massTarget + FEED_TAP, MASS_MAX);
  }
  // release: stop the spin-up. touch/pen also ends the pull so it coasts to a
  // stop; mouse keeps following its cursor (the desktop pull ends on mouseleave).
  // a quick, axis-dominant touch swipe (horizontal OR vertical) cycles presets:
  // left/up = next, right/down = previous. the throw follows the swipe vector.
  function onPointerUp(e) {
    pressed = false;
    if (e.pointerType !== 'mouse') pointerActive = false;
    if (swTouch) {
      const dx = e.clientX - swX, dy = e.clientY - swY, dt = e.timeStamp - swT;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      const horiz = adx >= ady;
      const major = horiz ? dx : dy, amaj = horiz ? adx : ady, amin = horiz ? ady : adx;
      const span = horiz ? window.innerWidth : window.innerHeight;
      const minMove = Math.max(60, span * 0.12);
      if (dt < 600 && amaj > minMove && amaj > amin * 1.8) {
        // a swipe is a "change preset" gesture, not a drag: undo the pull (and its
        // coast) the swipe dragged in, so the hole doesn't also fly to the swipe end
        // and stack past the edge with the wobble. only the capped wobble moves it.
        pullX = swPullX; pullY = swPullY; velX = 0; velY = 0;
        const strength = 0.7 + Math.min(amaj / span, 0.6) * 1.5; // longer swipe = harder throw
        cyclePreset(major < 0 ? 1 : -1, dx, dy, strength); // left/up = next, right/down = previous
      }
      swTouch = false;
    }
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
    sel.addEventListener('change', function () { applyPreset(sel.value); kickWobble(0, 0, 1); });
    wrap.appendChild(cap);
    wrap.appendChild(sel);
    document.body.appendChild(wrap);
    presetSelect = sel; // so the swipe gesture can keep the picker in sync
  }

  fetch('/assets/shaders/blackhole.frag', { cache: 'no-cache' }) // always revalidate so shader edits aren't served stale
    .then(function (r) { return r.text(); })
    .then(init)
    .catch(function (e) { console.error('blackhole: failed to load shader', e); });
})();
