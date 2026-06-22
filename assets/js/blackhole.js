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
  const isCoarse = window.matchMedia('(pointer: coarse)').matches; // mobile/touch: gyro target + calmer ripple
  const MAXQ = 2; // render resolution cap; full device pixels so it's sharp at 100% zoom
  const CURSOR_PULL = 0.7;   // how far toward the pointer the hole reaches (0 = ignore, 1 = all the way)
  const PULL_FOLLOW = 0.0005;  // mouse: how tightly the hole tracks the cursor while hovering (very slow, heavy gravitational lag)
  const PULL_STIFF = 20.0;     // touch: spring stiffness toward the finger (lower = heavier, more initial lag before it moves)
  const PULL_DAMP = 10.0;     // touch: damping (>~2*sqrt(STIFF) = no springback, just a heavy sluggish catch-up)
  const PULL_COAST = 3.5;      // touch: after release, how fast the coasting hole slows to rest (per second)
  const PULL_FRICTION = 0.90;  // mouse: on release it coasts on its last velocity, slowing to a stop where it lands
  const DISK_SPEED_K = 0.0; // the whirl fastens exponentially with mass while held: speed = e^(K*(mass-1)) (gentle, then ramps up)
  const DISK_SPEED_MAX = 6.5; // cap on that whirl: past this the streak advection aliases per frame and the spin flickers. ~the old MASS_MAX=3 top speed, kept smooth now that mass can reach 10
  const FEED_TAP = 0.15; // size the hole gains per press (a tap of mass)
  const FEED_RATE = 0.8;  // extra size per second while a press is held (pouring mass in)
  const MASS_MAX = 4.0;  // hard cap on the size multiplier (how big it can ever get)
  const MASS_COLLAPSE_DUR = 0.34; // release collapse: how long (s) the swift snap back to baseline takes (lower = faster "phiiuuuv")
  const MASS_COLLAPSE_EXP = 3.6;  // shape of that snap: an accelerating e^x curve (0 = linear; higher = more back-loaded -- hangs, then rushes home)
  const MASS_EASE = 0.08; // while held, how smoothly the visible size follows the accumulated mass (the gentle pour-in feel; release uses the collapse animation)
  const MASS_SIZE_K = 0.5; // the event horizon largens exponentially with mass: size = e^(K*(mass-1)) (higher = the zoom accelerates sooner/harder)
  const MASS_LUM_K = 0.7; // feeding brightens + heats the disk (bluer, via the shader's TEMP_BLUE): flare = e^(K*(mass-1)) (lower = reaches white more gradually)
  const VIEW_FIT = 0.8;  // responsive base size: zoom the hole out on narrow/portrait screens so the event horizon has margin (mobile); wide screens clamp to 1.0 (unaffected)
  const VIEW_MIN = 0.33; // floor for that base size (never smaller than this fraction)
  const VIEW_MAX = 0.6;  // ceiling: wide/desktop screens cap here (was 1.0) so the hole isn't too zoomed -- leaves room to see beyond the event horizon
  const EH_ZOOM_REF = 0.07; // desktop: shadow screen-height fraction below which no extra zoom-out (compact-disk presets already sit small; QUASAR/BLAZAR are ~0.05-0.06)
  const EH_ZOOM_K = 3.5;    // desktop: how hard a WIDER event horizon is zoomed out -> presetScale /= 1 + this*(shadowFrac - EH_ZOOM_REF). bigger = the wide-shadow looks (M87, GARGANTUA) zoom out more; 0 = off (disk-normalized only)
  const INFLOW_SPEED = 0.6;  // how fast the disk's matter spirals inward while you hold (drives INFALL_K in the shader; 0 = off)
  const INFLOW_RELAX = 0.85; // when released, how fast that inward pull eases back out (per frame). fast enough to fully ease out within a collapse, so it can't accumulate across rapid hold-releases -- and it's a SMOOTH ease, never a hard reset (which jumps the streak radius)
  const WOBBLE_AMP = 0.085; // changing the hole "drops it onto the screen": base drop (uv), scaled by the hole's mass
  const WOBBLE_OMEGA = 3.7;   // base natural frequency (rad/s); divided by sqrt(mass) so heavy holes wobble slower (inertia)
  const WOBBLE_ZETA = 0.16;  // damping ratio: low = keeps shaking (several decaying oscillations) after a swipe; ~cycles before settling = 0.37/this
  const WOBBLE_SIZE = 0.18;  // on impact the hole swells this much, deepening the gravity well (spacetime bend felt), relaxing with the wobble
  const RIPPLE_FEED_K = 1.3; // feeding shakes the spacetime fabric: vibration = 1 - e^(-(mass-1)*this), saturating as you feed (0 = only the wobble ripples)
  const RIPPLE_VEL_K = 0.15; // the size *changing* shakes it too; the fast snap-back on release is the biggest change, so it ripples hardest
  const REL_RIP_GAIN = 4.0;   // the release ring's strength at a FULL hold (fed mass = MASS_MAX). strength ramps linearly from ~0 at a tap to this at a full hold, so a longer hold rings proportionally HARDER (no early saturation). capped at REL_RIP_MAX.
  const REL_RIP_TAU = 1.0;    // release ringdown time-constant (s) for a light tap: the ring's amplitude decays as exp(-dt/tau) (dt-based, so frame-rate independent). higher = longer ring even for a tap.
  const REL_RIP_TAU_K = 1.5;  // a longer hold (more fed mass) rings LONGER: tau = REL_RIP_TAU * (1 + this*(fedMass-1)). physical: heavier holes ring down slower (tau ~ M). 0 = same duration regardless of hold.
  const REL_RIP_MAX = 4.0;   // hard cap on the release ripple kick (safety ceiling; the ramp above already reaches REL_RIP_GAIN at a full hold)
  const REL_RIP_FREQ = 1.2;  // the release ring rings at a LOWER frequency than feeding -> fewer, bigger, slower fabric waves you can actually feel roll out on release (multiplies the ring's frequency; <1 = lower/slower, 1 = same as feed)
  const RIPPLE_CAP = 4.3;    // overall ceiling on the summed fabric ripple sent to the shader. kept above REL_RIP_MAX so the release ring (the only term this big) passes unclipped; feeding terms top out ~2
  const MOBILE_RIPPLE = 0.85; // mobile: scale the fabric ripple (was 0.5 for nausea, but big-hole rings then read as nothing; the release ring is now proportional to hold so short taps stay calm). lower again toward 0.5 if heavy holds feel sickening on a phone
  const DESKTOP_RIPPLE = 1.2; // desktop: scale the ripple UP -> heavier, stronger fabric (bigger displacement). mobile uses MOBILE_RIPPLE instead
  const DESKTOP_RIP_FREQ = 0.7; // desktop: lower the ripple frequency -> bigger, slower, more ponderous (heavier) waves. 1.0 = same coarseness as mobile
  const RIP_EASE = 0.3;      // low-pass on the ripple sent to the shader so it can't STEP in a single frame: kills the instant ring jolt on first click (the feed-velocity spike) while still letting the release ring swell quickly
  const SILENCE_EASE = 0.15; // how fast the feed ripple ramps back IN when a collapse is interrupted by a new click (lower = gentler ramp). silence snaps on at collapse start, eases off here
  const RIP_MASS_K = 0.5;    // how strongly a heavier hole lowers the ripple frequency -> freqScale = 1/(1 + this*(fedMass-1)). bigger feed = fewer, slower, more ponderous rings (physical: f ~ 1/M; this=1 is exact 1/M, lower is gentler). 0 = fixed frequency. applies on desktop AND mobile.
  const DISK_WOB_W = 1.3;    // the disk nods with the wobble's shake (radians of inclination per unit wobble offset)
  const DISK_WOB_V = 7.0;    // the disk nods with the hole's drag velocity (radians per unit per-frame motion)

  // gyroscope "marble in a bowl" drift (mobile): tilt the phone and the heavy hole
  // rolls toward the low edge. tilt feeds a bounded target; the hole eases toward it
  // with the same heavy gravitational lag (no snap, no bounce). a slow baseline
  // recenter keeps a sustained tilt from parking the hole off-screen. this composes
  // ON TOP of the finger pull and, while live, replaces the autonomous sin-drift.
  const GYRO_MAX = 0.42;      // max uv offset a tilt can push the hole. 0.42 lets it roll right out to the screen edges (center 0.5 +/- this); lower = stays more central
  const GYRO_RANGE = 32.0;    // degrees of tilt from baseline that map to the full GYRO_MAX
  const GYRO_EASE = 0.018;    // how heavily the hole rolls toward the tilt target (low = laggier, heavier, slower marble). dropped from 0.05 since the wider GYRO_MAX made the same ease cover much more distance per frame -> too fast
  const GYRO_RECENTER = 0.0006;// per-reading drift of the neutral baseline toward the held angle. KEPT TINY so a held tilt PERSISTS (hole stays pushed to the edge, doesn't fade back); just enough that a permanent pose change eventually re-neutralizes over ~30s. 0 = never recenter
  const GYRO_SIGN_X = 1.0;    // flip to -1 if left/right tilt rolls the hole the wrong way on device
  const GYRO_SIGN_Y = 1.0;    // flip to -1 if forward/back tilt rolls the hole the wrong way on device
  // direction comes from the GRAVITY VECTOR (devicemotion accelerationIncludingGravity),
  // not Euler beta/gamma -- the gravity (x,y) projected onto the screen IS the true downhill
  // direction, with no gimbal lock / cross-coupling (that was the "wanders off direction").
  const GYRO_G_RANGE = 3.5;   // LEFT/RIGHT: gravity component (m/s^2) that maps to the full GYRO_MAX (~21 deg of tilt: 9.81*sin21). lower = more sensitive
  const GYRO_G_RANGE_Y = 2.0; // FORWARD/BACK gets its own, smaller (more sensitive) range: held at a viewing angle, the vertical gravity component changes much less per degree of fwd/back tilt than left/right roll does, so vertical felt weak/asymmetric. lower = more sensitive
  // shaking the phone feeds the hole like holding: linear acceleration (gravity removed)
  // spikes on a shake; while the smoothed level stays above threshold it pours mass in.
  const SHAKE_THRESH = 7.0;   // m/s^2 of linear accel above which it counts as "shaking" (a deliberate shake is ~10-25, a still hand ~0-2)
  const SHAKE_TAU = 0.25;     // s: how long the shake level coasts between shake peaks, so the fast oscillation reads as one continuous feed (and a stop collapses like a release)
  const SHAKE_FEED = 1.3;     // shaking feeds at this multiple of a hold's FEED_RATE (shaking hard pours faster than a steady hold)

  // per-preset black-hole masses (solar masses), driving a physically-ordered ringdown
  // frequency (heavier hole -> slower wobble + ripple, f ~ 1/M). M87* and GARGANTUA are
  // real measurements; QUASAR/BLAZAR are pinned to 3C 273 / OJ 287; the other four are
  // invented presets given plausible SMBH masses so they slot into the same scheme.
  const PRESET_MASS = {
    GARGANTUA: 1.0e8,   // Interstellar (Kip Thorne, ~100 million)
    ZEN: 2.0e8,   // invented (calm, light)
    INFERNO: 5.0e8,   // invented (vigorous accretor)
    QUASAR: 9.0e8,   // 3C 273 (archetypal quasar, ~886 million)
    FACEON: 1.2e9,   // invented
    M87: 6.5e9,   // M87* (Event Horizon Telescope, 2019)
    PURELENS: 1.0e10,  // invented (dormant giant, no disk)
    BLAZAR: 1.8e10,  // OJ 287 (primary, ~18 billion)
  };
  const MASS_REF = 1.0e8;       // anchor: the lightest hole rings at the full base frequency (scale 1)
  const MASS_FREQ_ALPHA = 0.21; // log-compression: ringScale = (MASS_REF/M)^this. =1 is literal 1/M (heavy ones freeze); 0.21 squeezes the ~180x mass range to ~3x frequency so heavier still rings slower but stays visible
  const WOBBLE_MAXAGE = 13.0;   // how long (s) a drop-in wobble is tracked before it's zeroed; long enough that even the slowest (heaviest) preset has damped to near nothing first (no snap)

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
  let prog, uRes, uTime, uCursor, uDiskTime, uMass, uFlare, uInflow, uRipple, uDiskWob, uDriftScale, uRipFreq, uRipPhase, tex, raf = 0, startT = 0;
  let pullX = 0, pullY = 0, tgtPullX = 0, tgtPullY = 0; // hole's drift toward the pointer (uv offset)
  let velX = 0, velY = 0, pointerActive = false, pressed = false, pullTouch = false; // pull momentum + press state (touch = faster follow)
  let diskTime = 0, lastMs = 0;                        // disk-streak warped clock (speed follows mass)
  let mass = 1.0, massTarget = 1.0, prevMass = 1.0;    // hole size: accumulates when fed, snaps back on release
  let relT = 0, relM0 = 1.0, collapsing = false;       // release collapse: the swift accelerating snap from fed mass back to baseline
  let relRip = 0, wasFeeding = false;                  // release ripple: the fabric keeps rippling after a feed (long, fades), the hole itself does not pulse
  let ripShown = 0;                                    // low-passed ripple actually sent to the shader (no single-frame steps -> no click jolt)
  let ripPhase = 0;                                    // accumulated ripple time-phase (integral of the freq scale); used instead of iTime so a changing freq can't jump the phase
  let ripFreqShown = 1.0;                              // low-passed frequency scale sent to the shader, so the ripple's wavelength can't snap in one frame (e.g. a click clearing the ring)
  let feedSilence = 0;                                 // 1 = feed ripple muted during a collapse; eases back to 0 so an interrupting click doesn't jolt the ring
  let prevHoleX = 0, prevHoleY = 0;                    // last hole-center offset, for the disk's motion-driven nod
  let gyroX = 0, gyroY = 0, gyroTX = 0, gyroTY = 0;    // gyro drift: hole offset + tilt-driven target (eased, marble-in-bowl)
  let gyroBeta0 = null, gyroGamma0 = null;             // orientation-fallback neutral tilt baseline (only used if devicemotion gives no gravity)
  let gravX0 = null, gravY0 = null, motionActive = false; // gravity-vector neutral baseline + whether devicemotion is driving the direction
  let shakeLevel = 0, shaking = false;                 // smoothed shake intensity (linear accel) + whether it's feeding the hole like a hold
  let gyroActive = false, gyroRequested = false, gyroPending = false; // gyro receiving data / iOS permission answered (one-shot) / request in flight
  const GYRO_GESTURES = ['pointerup', 'touchend', 'click']; // iOS: completed-gesture events that reliably carry the activation requestPermission() needs
  let driftScale = 1.0;                                // 1 = autonomous sin-drift on; fades to 0 once the gyro takes over the drift
  let baseScale = 1.0, szEff = 1.0;                    // responsive base size (per viewport) x the fed size
  let inflowPhase = 0;                                 // accumulated infall (grows while held, drives the disk's inward spiral)
  let cfg = null;            // shader constants parsed from the frag (kept in sync)
  let navItems = [];         // nav links + their natural-position uv, for click tracking
  let fragSource = '';       // the raw shader source (preset is swapped in per selection)
  let presetScale = 1.0;     // per-preset size normalization so each look fills the frame similarly
  let presetFreqScale = 1.0; // per-preset ringdown frequency factor from its mass (1 = lightest/fastest, smaller = heavier/slower)
  let currentPreset = '';    // the active preset name (kept in sync between the picker + swipe)
  let presetSelect = null;   // the picker <select>, so swipe can keep it in sync
  let swTouch = false, swX = 0, swY = 0, swT = 0, swPullX = 0, swPullY = 0; // touch swipe tracking (+ pull at gesture start, to undo it on a swipe)
  let wobAge = 1e9, wobDX = 0, wobDY = 0, wobX = 0, wobY = 0, wobSwell = 0, wobRip = 0; // preset-change "drop" wobble (2D throw + size swell + fabric ripple)
  let wobW = WOBBLE_OMEGA, wobZ = WOBBLE_ZETA;              // per-change natural frequency + damping ratio (set on kick)
  const tcvs = document.createElement('canvas');
  const tctx = tcvs.getContext('2d');

  function buildTextTexture(q) {
    // HORIZONTAL: render the field TEX_MARGIN wider than the viewport so rays bent
    //   off-screen sample real text (the mirror seam sits off-screen).
    // VERTICAL: size the texture to an EXACT whole number of line-spacing periods so it
    //   tiles seamlessly top/bottom (WRAP_T=REPEAT continues the rows, no fold, no
    //   half-row jump) -- this is the seam fix; the line spacing shifts a few % to align.
    const M = (cfg && cfg.texMargin) || 0;
    const W = window.innerWidth, H = window.innerHeight;
    const MW = W * (1 + 2 * M);
    // a texture too big for the GPU (big retina + margin) fails texImage2D -> blank bg.
    // the text is lensed/blurred, so a softer plane on huge displays isn't noticeable.
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const qt = Math.min(q, maxTex / MW, maxTex / H);

    // choose a line height that divides the viewport into a whole number of PERIODS (one
    // period = the rows after which the phrase cycle AND the 2-tone banding both repeat),
    // so nRows*lh === H exactly and the top edge meets the bottom edge with no half-row.
    const PERIOD = LINES.length * 2;
    const lhWant = Math.max(12, Math.round(H * 0.017)) * 1.5;
    const periods = Math.max(1, Math.round(H / (PERIOD * lhWant)));
    const nRows = PERIOD * periods;
    const lh = H / nRows;                          // exact: nRows * lh === H
    const fs = Math.max(10, Math.round(lh / 1.5));

    tcvs.width = Math.round(MW * qt);
    tcvs.height = Math.round(H * qt);
    const c = tctx;
    // shift the origin into the horizontal inset (vertical starts at 0); screen positions
    // and the nav labels land where the shader's texSample reads them
    c.setTransform(qt, 0, 0, qt, M * W * qt, 0);
    c.fillStyle = '#000';
    c.fillRect(-M * W, 0, MW, H);

    c.font = fs + 'px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    c.textBaseline = 'top';

    for (let row = 0; row < nRows; row++) {
      const y = row * lh;
      // subtle two-tone banding gives the field some depth
      c.fillStyle = (row % 2 === 0) ? '#828ea4' : '#6d7689';
      // repeat the phrase across the full padded width, staggered per row, so the
      // field reads dense like a terminal rather than a tidy column
      const base = LINES[row % LINES.length] + '   ';
      let line = '';
      while (c.measureText(line).width < MW + 600) line += base;
      const offset = -M * W - 240 - ((row * 53) % 220);
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
      texMargin: n(/TEX_MARGIN\s*=\s*([-\d.eE]+)/, 0.0), // extra text rendered past the viewport on every side; must match the shader's texSample()
    };
    const name = (src.match(/#define\s+PRESET\s+(\w+)/) || [])[1] || 'QUASAR';
    const pm = src.match(new RegExp('DiskLook\\s+' + name + '\\s*=\\s*DiskLook\\(([^)]*)\\)'));
    const pv = pm ? pm[1].split(',').map(parseFloat) : [];
    const rin = Math.max(pv[3] || 1.8, 1.6);
    c.rout = Math.max(pv[4] || 8, rin + 0.5);
    c.incl = (pv[1] != null && isFinite(pv[1])) ? pv[1] : 1.5; // disk inclination (rad): ~0 face-on, ~1.5 edge-on
    return c;
  }

  // the hole's drifting center in uv (autonomous drift + gyro tilt + pointer pull).
  // mirrors the shader's `center` (blackhole.frag) so the lensed nav links track it.
  function holeCenterUV(time) {
    const s = time * cfg.driftSpeed * 0.15;
    return {
      x: 0.5 + cfg.driftAmt * driftScale * (0.75 * Math.sin(s * 0.37) + 0.25 * Math.sin(s * 0.83 + 1.0)) + pullX + wobX + gyroX,
      y: 0.5 + cfg.driftAmt * driftScale * (0.70 * Math.sin(s * 0.54 + 2.1) + 0.30 * Math.sin(s * 1.07)) + pullY + wobY + gyroY,
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
    uDriftScale = gl.getUniformLocation(prog, 'iDriftScale');
    uRipFreq = gl.getUniformLocation(prog, 'iRipFreq');
    uRipPhase = gl.getUniformLocation(prog, 'iRipPhase');
    gl.uniform1i(gl.getUniformLocation(prog, 'iChannel0'), 0);
  }

  // each preset has a different disk outer radius, so without this the disk would
  // render tiny (M87) or huge (BLAZAR) when switching. normalize so every look
  // fills a similar fraction of the frame (folded into szEff, alongside the fed size).
  function computePresetScale() {
    const TARGET = 0.32;       // disk outer edge as a fraction of screen height (edge-on presets)
    const FACE_SHRINK = 0.35;  // MOBILE only: a face-on disk reads as a big filled circle that buries the lensed text on a narrow portrait screen; shrink it by up to this fraction so the fabric stays visible. desktop has horizontal room, so it's untouched.
    const faceOn = isCoarse ? Math.max(0, Math.cos(Math.min(cfg.incl, 1.5707963))) : 0.0; // ~1 face-on, ~0 edge-on; 0 on desktop
    const target = TARGET * (1.0 - FACE_SHRINK * faceOn);
    const raw = target * B_CRIT / Math.max(cfg.rout * cfg.holeR, 1e-4);
    presetScale = Math.max(0.5, Math.min(raw, 6.0));
    // desktop: the disk-normalization above leaves the compact-disk looks (M87, GARGANTUA,
    // ZEN) with a much wider shadow on screen. zoom those out proportional to how wide the
    // shadow sits, so they don't fill the frame; the small-shadow looks (QUASAR, BLAZAR)
    // sit below EH_ZOOM_REF and are left alone.
    if (!isCoarse) {
      const shadowFrac = cfg.holeR * presetScale; // shadow radius as a fraction of screen height (at baseScale 1)
      presetScale /= 1.0 + EH_ZOOM_K * Math.max(0, shadowFrac - EH_ZOOM_REF);
    }
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
    presetFreqScale = presetMassFreqScale(name); // this hole's ringdown frequency from its mass
    // a switched-in hole arrives FRESH: clear any leftover feed/collapse/ring state from
    // the previous one, so nothing accumulates across switches (stuck size, pinned ripple,
    // a stray collapse armed by a swipe-tap). the drop-in wobble (kickWobble) is the only
    // motion a new hole should carry.
    mass = 1.0; massTarget = 1.0; prevMass = 1.0; relM0 = 1.0;
    collapsing = false; relT = 0; relRip = 0; ripShown = 0; feedSilence = 0; inflowPhase = 0; diskTime = 0;
    ripFreqShown = presetFreqScale; // start the new hole at its own baseline frequency, not eased from the old one
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
    // quasinormal ringdown: a perturbed black hole rings at f ~ 1/M, damped. each preset's
    // mass sets its frequency via presetFreqScale (log-compressed 1/M), so heavier holes
    // (M87, BLAZAR) settle slow and ponderous while the lighter ones (GARGANTUA) ring
    // quicker. the small random is just so repeated switches don't land mechanically identical.
    wobW = WOBBLE_OMEGA * presetFreqScale * (0.9 + Math.random() * 0.2);
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
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); // horizontal: padded + mirrored in texSample
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);        // vertical: texture is a whole line-period multiple -> tiles seamlessly top/bottom
    gl.activeTexture(gl.TEXTURE0);

    const p = compileProgram(fragWithPreset(initial));
    if (!p) return;
    useNewProgram(p);
    cfg = parseCfg(fragWithPreset(initial));
    computePresetScale();
    currentPreset = initial;
    presetFreqScale = presetMassFreqScale(initial);

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
    // a long press is a feed gesture here, not a context menu / text selection;
    // suppress the menu the browser would otherwise pop (Android especially)
    window.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('keydown', onKeyDown); // desktop: arrow keys switch the black hole
    // gyro drift: Android exposes the sensor with no prompt, so attach it now for
    // instant tilt. iOS 13+ requires a permission request from a user gesture -> we arm
    // the COMPLETED-gesture events and let the first one trigger the prompt (a bare
    // pointerdown/touchstart often lacks the activation Safari needs).
    if (!reduceMotion && isCoarse) {
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission !== 'function') {
        gyroRequested = true;
        attachMotion(); // Android / older iOS: no prompt
      } else if (DOE) {
        GYRO_GESTURES.forEach(function (ev) { window.addEventListener(ev, enableGyro); });
      }
    }
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
    baseScale = Math.max(VIEW_MIN, Math.min(VIEW_MAX, (window.innerWidth / window.innerHeight) * VIEW_FIT));
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

    // gyro marble-in-bowl: the hole eases toward the tilt-driven target (heavy lag,
    // no snap). once the gyro is live it owns the ambient drift, so the autonomous
    // sin-drift fades out (driftScale -> 0); if the gyro is denied/absent it stays.
    gyroX += (gyroTX - gyroX) * GYRO_EASE;
    gyroY += (gyroTY - gyroY) * GYRO_EASE;
    driftScale += ((gyroActive ? 0.0 : 1.0) - driftScale) * 0.04;

    // shaking the phone feeds the hole like a hold (Ali: "shaking should act same as
    // holding"). the shake level coasts down (SHAKE_TAU) between shake peaks so the fast
    // oscillation reads as one sustained feed, and stopping collapses like a release.
    // EITHER a finger press OR a shake counts as feeding.
    shakeLevel *= Math.exp(-dt / SHAKE_TAU);
    shaking = shakeLevel > SHAKE_THRESH;
    const feeding = pressed || shaking;

    // mass: feeding pours mass in (grows the hole), capped. on release the fed mass
    // COLLAPSES back to baseline along a swift, accelerating e^x curve (the "phiiuuuv"
    // snap): it hangs a beat, then rushes home. the collapse itself is SILENT -- the
    // spacetime fabric only rings AFTER it lands (the kick fires on completion, below).
    if (feeding) {
      collapsing = false;
      massTarget = Math.min(massTarget + FEED_RATE * (shaking ? SHAKE_FEED : 1.0) * dt, MASS_MAX);
      mass += (massTarget - mass) * MASS_EASE;       // gentle pour-in while feeding
    } else {
      if (wasFeeding && mass > 1.001) { relM0 = mass; relT = 0; collapsing = true; } // just released: arm the snap from the fed size
      if (collapsing) {
        relT += dt;
        const p = Math.min(relT / MASS_COLLAPSE_DUR, 1.0);
        // accelerating ease-in: e^(k*p) normalized to 0..1 (k=0 would be linear)
        const ease = (Math.exp(MASS_COLLAPSE_EXP * p) - 1.0) / (Math.exp(MASS_COLLAPSE_EXP) - 1.0);
        mass = 1.0 + (relM0 - 1.0) * (1.0 - ease);
        if (p >= 1.0) {
          mass = 1.0; collapsing = false;
          // collapse has LANDED: ring the fabric. strength scales across the FULL hold
          // range (fed mass 1..MASS_MAX -> 0..1), so a long hold rings proportionally
          // harder than a tap. take the MAX (not a sum) over any still-decaying ring so
          // rapid hold-releases don't accumulate a pinned ripple.
          const fed = Math.min((relM0 - 1.0) / (MASS_MAX - 1.0), 1.0);
          relRip = Math.max(relRip, Math.min(fed * REL_RIP_GAIN, REL_RIP_MAX));
        }
      } else {
        mass = 1.0;
      }
      massTarget = mass;
    }
    wasFeeding = feeding;
    // the post-collapse ring damps out over a time-constant that scales with the fed mass:
    // a long hold (heavy hole) rings for several seconds, a tap fades in ~a second (tau ~ M).
    const relTau = REL_RIP_TAU * (1.0 + REL_RIP_TAU_K * Math.max(0.0, relM0 - 1.0));
    relRip *= Math.exp(-dt / relTau);

    // the whirl, the largening, and the flare/color all ride the SAME exponential
    // feed curve (feedPow), each with its own gain, so they ramp together (proportional).
    // gentle at first as you start holding, then ramps up the longer you feed.
    const diskSpeed = Math.min(feedPow(DISK_SPEED_K), DISK_SPEED_MAX); // cap so the whirl can't advect fast enough to alias/flicker at high fed mass
    diskTime += dt * diskSpeed;
    const wrapT = cfg.diskCycle * 16.0;          // keep the disk clock TINY so feeding can't accumulate it into precision/aliasing flicker; 16 is an integer x cycle, so fract(t/cycle) (the only thing the disk reads) is unchanged -> invisible wrap
    while (diskTime > wrapT) diskTime -= wrapT;  // while-loop: a big feed burst can overshoot by more than one wrap in a frame

    // feeding is mostly a brightness flare + a subtle swell (not a zoom). the
    // responsive base size keeps the whole disk on-screen on narrow viewports.
    szEff = baseScale * presetScale * feedPow(MASS_SIZE_K);
    const flare = feedPow(MASS_LUM_K);

    // infall phase grows while feeding, eases out on release; drives the disk's inward spiral
    if (feeding) inflowPhase += dt * INFLOW_SPEED;
    else inflowPhase *= INFLOW_RELAX;

    // preset-change wobble: the new hole drops in and settles (decaying cosine,
    // starts displaced up + leaning so it falls onto the screen). per-change random.
    if (wobAge < WOBBLE_MAXAGE) {
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
    gl.uniform2f(uCursor, pullX + wobX + gyroX, pullY + wobY + gyroY);
    gl.uniform1f(uDiskTime, diskTime);
    gl.uniform1f(uDriftScale, driftScale);
    gl.uniform1f(uMass, szEff);
    gl.uniform1f(uFlare, flare);
    gl.uniform1f(uInflow, inflowPhase);
    // spacetime vibration: feeding shakes the fabric (sustained) and the size *changing*
    // shakes it more. during the release collapse both are muted (feedSilence) so the
    // snap is clean; the ring then fires on landing (relRip) and re-shakes the fabric in
    // a long train that fades with it.
    // the collapse silences the feed ripple so the snap is clean (the ring fires after via
    // relRip). snap INTO silence at once, but ease OUT of it -- so clicking again mid-collapse
    // ramps the ripple back in instead of stepping feedRip from 0 to full and jolting the ring.
    const silenceTarget = collapsing ? 1.0 : 0.0;
    if (silenceTarget > feedSilence) feedSilence = silenceTarget;
    else feedSilence += (silenceTarget - feedSilence) * SILENCE_EASE;
    const feedActive = 1.0 - feedSilence;
    const feedRip = feedActive * Math.max(0, 1.0 - Math.exp(-(mass - 1.0) * RIPPLE_FEED_K));
    const moveRip = feedActive * (dt > 0 ? Math.abs(mass - prevMass) / dt : 0) * RIPPLE_VEL_K;
    prevMass = mass;
    const ripScale = isCoarse ? MOBILE_RIPPLE : DESKTOP_RIPPLE; // calmer on hand-held screens (nausea), heavier + stronger on desktop
    const ripTarget = Math.min(wobRip + feedRip + moveRip + relRip, RIPPLE_CAP) * ripScale;
    ripShown += (ripTarget - ripShown) * RIP_EASE; // smooth so the ripple can't jolt the ring in one frame
    gl.uniform1f(uRipple, ripShown);
    // ripple frequency follows whichever mass is DRIVING the current ripple -- the live
    // feed OR a still-ringing post-collapse train (relM0) -- whichever is heavier. taking
    // the max is what stops the flicker: otherwise a new press snaps the frequency back to
    // ~1 (30 rings) while a big leftover ring is still at high amplitude, and high amp x
    // high freq aliases the lensed text into a shimmer that compounds across repeats.
    const ringing = relRip > 0.02 && !feeding; // a post-collapse release ring is the active driver (not a live feed/shake)
    const ringMass = ringing ? relM0 : 1.0;
    const freqMass = Math.max(feeding ? mass : 1.0, ringMass);
    // combine the preset's baseline ringdown (its real mass) with the interactive fed-mass
    // slowdown, so a heavy hole ripples slower at rest AND slows further as you feed it.
    // the release ring drops further (REL_RIP_FREQ) so its waves roll out slow + big + felt.
    const ripFreqNow = presetFreqScale * ripFreqScale(freqMass)
      * (isCoarse ? 1.0 : DESKTOP_RIP_FREQ)   // desktop rings bigger/slower (heavier)
      * (ringing ? REL_RIP_FREQ : 1.0);        // release ring rings slower than feeding
    // low-pass the frequency too: clicking clears the ring's low freq, which would otherwise
    // snap the ripple's wavelength short in one frame while the amplitude is still fading -> jolt.
    ripFreqShown += (ripFreqNow - ripFreqShown) * RIP_EASE;
    gl.uniform1f(uRipFreq, ripFreqShown);
    // accumulate the temporal phase incrementally (NOT iTime * freq): a changing frequency
    // only affects the next step, never the whole accumulated phase -- otherwise a large
    // wall-clock iTime turns each freq change into a giant phase jump (the flicker that grew
    // across long holds + switches). wrap at 2pi; RIPPLE_SPEED/DISK_RIP_SPEED are integers, so
    // the wrap is exact (their multiples of 2pi leave sin unchanged) and keeps the args tiny.
    ripPhase += dt * ripFreqShown;
    if (ripPhase > 6.283185307) ripPhase -= 6.283185307;
    gl.uniform1f(uRipPhase, ripPhase);

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

  // the one mass-frequency law: a heavier hole rings as fewer/bigger/slower waves
  // (physical: f ~ 1/M). returns a single frequency scale applied UNIFORMLY to the
  // fabric ripple AND the disk ripple (via iRipFreq in the shader), so they stay
  // consistent. universal -- it's physics, so it holds on desktop and mobile alike.
  function ripFreqScale(m) {
    return 1.0 / (1.0 + RIP_MASS_K * Math.max(0.0, m - 1.0));
  }

  // per-preset ringdown frequency from its real (or representative) mass. log-compressed
  // (MASS_FREQ_ALPHA) so the ~180x mass spread reads as ~3x frequency: heavier black holes
  // wobble + ripple slower (f ~ 1/M, the real ordering) without the giants freezing solid.
  function presetMassFreqScale(name) {
    const m = PRESET_MASS[name] || MASS_REF;
    return Math.pow(MASS_REF / m, MASS_FREQ_ALPHA);
  }

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
      gl.uniform1f(uDriftScale, 1.0); // gyro is off under reduced motion; keep the drift term intact
      gl.uniform1f(uRipFreq, 1.0);    // baseline ripple frequency (no ripple in this static frame anyway)
      gl.uniform1f(uRipPhase, 0.0);
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
    // each new feed clears the lingering release ring so rapid holds don't pile it up
    // ("strange wobble"). ripShown eases it down, no pop. (inflow no longer hard-reset
    // here -- that jumped the streak radius; its fast decay handles accumulation instead.)
    relRip = 0;
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

  // FALLBACK direction from orientation Euler angles (gamma=L/R, beta=fwd/back). only used
  // when devicemotion gives no gravity vector -- beta/gamma gimbal-lock + cross-couple, which
  // is what made the marble "wander off direction"; onMotion's gravity vector is preferred.
  function onOrient(e) {
    if (motionActive) return;                      // devicemotion owns the (truer) direction
    if (e.beta == null || e.gamma == null) return; // no real sensor (desktop): leave the sin-drift on
    gyroActive = true;                             // -> render() fades the autonomous drift out
    if (gyroBeta0 == null) { gyroBeta0 = e.beta; gyroGamma0 = e.gamma; } // capture the neutral hold
    gyroBeta0 += (e.beta - gyroBeta0) * GYRO_RECENTER;     // slowly forget a sustained tilt
    gyroGamma0 += (e.gamma - gyroGamma0) * GYRO_RECENTER;
    const dB = e.beta - gyroBeta0, dG = e.gamma - gyroGamma0;
    gyroTX = clamp1(GYRO_SIGN_X * dG / GYRO_RANGE) * GYRO_MAX; // tilt right -> hole rolls right (downhill)
    gyroTY = clamp1(GYRO_SIGN_Y * dB / GYRO_RANGE) * GYRO_MAX; // tilt forward/back -> rolls down/up
  }

  // device MOTION (mobile, preferred). the GRAVITY vector projected onto the screen (x,y) is
  // the TRUE downhill direction with no gimbal lock -> the marble rolls where it should. and
  // the gravity-removed linear acceleration spikes on a SHAKE -> feeds the hole like a hold.
  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (g && g.x != null && g.y != null) {
      motionActive = true; gyroActive = true;             // onOrient steps aside, drift fades out
      if (gravX0 == null) { gravX0 = g.x; gravY0 = g.y; } // capture the neutral hold pose
      gravX0 += (g.x - gravX0) * GYRO_RECENTER;           // slowly forget a sustained tilt
      gravY0 += (g.y - gravY0) * GYRO_RECENTER;
      gyroTX = clamp1(GYRO_SIGN_X * (g.x - gravX0) / GYRO_G_RANGE) * GYRO_MAX;
      gyroTY = clamp1(GYRO_SIGN_Y * (g.y - gravY0) / GYRO_G_RANGE_Y) * GYRO_MAX;
    }
    const a = e.acceleration; // gravity removed: ~0 at rest + on slow tilts, spikes on a shake
    if (a && a.x != null) {
      const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      if (mag > shakeLevel) shakeLevel = mag;             // peak-hold; render() coasts it down (SHAKE_TAU)
    }
  }
  function clamp1(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }

  // wire up the gyro. iOS 13+ gates DeviceOrientation behind a permission prompt that
  // must be requested from inside a user gesture, so init arms GYRO_GESTURES (completed
  // taps) and the first one calls this; it retries until iOS answers, then disarms them.
  // Android / older iOS have no prompt and are attached directly at init instead.
  function enableGyro() {
    if (gyroRequested || gyroPending || reduceMotion || !isCoarse) return;
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return;
    if (typeof DOE.requestPermission !== 'function') { // Android / older iOS: no prompt
      gyroRequested = true;
      attachMotion();
      return;
    }
    // iOS 13+: the prompt needs transient user activation. mark the request in flight (NOT
    // done) so that if this gesture lacked activation and the promise rejects, the next
    // completed tap can retry instead of being locked out by an early gyroRequested=true.
    gyroPending = true;
    DOE.requestPermission().then(function (s) {
      gyroRequested = true; gyroPending = false;            // iOS answered: stop retrying
      GYRO_GESTURES.forEach(function (ev) { window.removeEventListener(ev, enableGyro); });
      if (s === 'granted') attachMotion();
    }).catch(function () { gyroPending = false; /* no activation: next gesture retries */ });
  }

  // attach both sensor streams: devicemotion (gravity direction + shake feed, preferred) and
  // deviceorientation (Euler fallback). on iOS the single granted Motion permission covers both.
  function attachMotion() {
    window.addEventListener('devicemotion', onMotion);
    window.addEventListener('deviceorientation', onOrient);
  }

  // desktop: arrow keys cycle presets (right/down = next, left/up = previous),
  // throwing the landing wobble in the arrow's direction. when the picker <select>
  // is focused, let it handle arrows natively (its change still cycles + wobbles).
  function onKeyDown(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
    let dir = 0, dx = 0, dy = 0;
    if (e.key === 'ArrowRight') { dir = 1; dx = 1; }
    else if (e.key === 'ArrowLeft') { dir = -1; dx = -1; }
    else if (e.key === 'ArrowDown') { dir = 1; dy = 1; }
    else if (e.key === 'ArrowUp') { dir = -1; dy = -1; }
    else return;
    e.preventDefault();
    cyclePreset(dir, dx, dy, 1.2);
  }

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
