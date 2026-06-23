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
  const DISK_SPEED_FLOOR = 0.2; // floor on the disk's real-time rate. by Omega ~ 1/M every real-time rate (swirl + inflow) slows with mass: heavier PRESETS orbit slower at rest (presetFreqScale, log-compressed 1/M, shared with the ringdown) AND feeding grows the hole self-similarly (feedPow(MASS_SIZE_K)) for a further 1/M. rate = presetFreqScale/feedPow(MASS_SIZE_K*DISK_SLOW_POW), floored here so a fed giant can't freeze the disk solid. (replaced DISK_SPEED_K/MAX, which SPED the whirl up on feed -- wrong: that's accretion rate, which doesn't change orbital speed)
  const DISK_SLOW_POW = 1.0; // PHYSICALLY HONEST setting. feeding zooms the hole, so at a fixed screen pixel the physical radius is fixed while M grows -> the disk genuinely SPEEDS UP ~sqrt(M) (Omega = sqrt(M/r^3)), while a single gas blob at fixed r/r_s correctly slows ~1/M. the 1/M clock at pow=1 produces BOTH at once -> nothing to "fix". pow>1 over-slows the on-screen swirl into an UNphysical slowdown (was 2.0, to match a heavier=slower hunch that only holds for following one blob, not a fixed screen -- reverted as a fudge). raise only to buy that aesthetic back on purpose
  const FEED_TAP = 0.15; // size the hole gains per press (a tap of mass)
  const FEED_RATE = 0.8;  // extra size per second while a press is held (pouring mass in)
  const MASS_MAX = 4.0;  // hard cap on the size multiplier (how big it can ever get)
  const MASS_COLLAPSE_DUR = 0.34; // release collapse: how long (s) the swift snap back to baseline takes (lower = faster "phiiuuuv")
  const MASS_COLLAPSE_EXP = 3.6;  // shape of that snap: an accelerating e^x curve (0 = linear; higher = more back-loaded -- hangs, then rushes home)
  const MASS_EASE = 0.045; // while held, how smoothly the visible size follows the accumulated mass (the gentle pour-in feel; release uses the collapse animation). lowered from 0.08 so the initial tap's FEED_TAP bump swells IN gradually instead of the disk popping large on the first click/touch
  const MASS_SIZE_K = 0.5; // the event horizon largens exponentially with mass: size = e^(K*(mass-1)) (higher = the zoom accelerates sooner/harder)
  const MASS_LUM_K = 0.7; // feeding brightens + heats the disk (bluer, via the shader's TEMP_BLUE): flare = e^(K*(mass-1)) (lower = reaches white more gradually)
  const FLARE_ZOOM_COMP = 0.0; // PHYSICALLY HONEST setting (off). a real zoom CONSERVES surface brightness, so as the hole grows the bright disk covers more of the frame and it genuinely brightens -- that is correct, not a surge to cancel. >0 divides the flare by feedPow(MASS_SIZE_K*this) to dim per-pixel and tame that brightening (an aesthetic choice; was 1.0, reverted). raise only if the honest brighten-on-feed reads as too much
  const VIEW_FIT = 0.8;  // responsive base size: zoom the hole out on narrow/portrait screens so the event horizon has margin (mobile); wide screens clamp to 1.0 (unaffected)
  const VIEW_MIN = 0.33; // floor for that base size (never smaller than this fraction)
  const VIEW_MAX = 0.6;  // ceiling: wide/desktop screens cap here (was 1.0) so the hole isn't too zoomed -- leaves room to see beyond the event horizon
  const ZOOM_MIN = 0.02;  // floor on the camera zoom (only a guard: iCamZoom divides p, so 0 would blow up). effectively infinite zoom-OUT
  const WHEEL_ZOOM_K = 0.0015; // desktop wheel: camZoom *= e^(-deltaY*K) per notch (~100px notch -> ~1.16x). scroll up = zoom IN (no upper cap), scroll down = zoom OUT (floored at ZOOM_MIN)
  const KEY_ZOOM_STEP = 1.18;  // desktop arrow keys: up = camZoom * this (zoom IN), down = / this (zoom OUT). left/right cycle presets
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
  let prog, uRes, uTime, uCursor, uDiskTime, uMass, uFlare, uInflow, uRipple, uDiskWob, uDriftScale, uRipFreq, uRipPhase, uCamZoom, uCamPan, tex, raf = 0, startT = 0;
  let pullX = 0, pullY = 0, tgtPullX = 0, tgtPullY = 0; // hole's drift toward the pointer (uv offset)
  let velX = 0, velY = 0, pointerActive = false, pressed = false, pullTouch = false; // pull momentum + press state (touch = faster follow)
  let dragging = false;                                 // desktop: mouse button held -> grab the hole with the touch-style spring (momentum + coast); released = hover-drift again
  let diskTime = 0, lastMs = 0;                        // disk-streak warped clock (speed follows mass)
  let mass = 1.0, massTarget = 1.0, prevMass = 1.0;    // hole size: accumulates when fed, snaps back on release
  let relT = 0, relM0 = 1.0, collapsing = false;       // release collapse: the swift accelerating snap from fed mass back to baseline
  let relRip = 0, wasFeeding = false;                  // release ripple: the fabric keeps rippling after a feed (long, fades), the hole itself does not pulse
  let ripShown = 0;                                    // low-passed ripple actually sent to the shader (no single-frame steps -> no click jolt)
  let ripPhase = 0;                                    // accumulated ripple time-phase (integral of the freq scale); used instead of iTime so a changing freq can't jump the phase
  let ripFreqShown = 1.0;                              // low-passed frequency scale sent to the shader, so the ripple's wavelength can't snap in one frame (e.g. a click clearing the ring)
  let feedSilence = 0;                                 // 1 = feed ripple muted during a collapse; eases back to 0 so an interrupting click doesn't jolt the ring
  let prevHoleX = 0, prevHoleY = 0;                    // last hole-center offset, for the disk's motion-driven nod
  let shakeLevel = 0, shaking = false;                 // smoothed shake intensity (linear accel) + whether it's feeding the hole like a hold
  let motionRequested = false, motionPending = false;  // iOS motion permission answered (one-shot) / request in flight
  const MOTION_GESTURES = ['pointerup', 'touchend', 'click']; // iOS: completed-gesture events that reliably carry the activation requestPermission() needs
  let driftScale = 1.0;                                // autonomous sin-drift scale (always on; kept as a uniform the shader reads)
  let baseScale = 1.0, szEff = 1.0;                    // responsive base size (per viewport) x the fed size
  let camZoom = 1.0;                                    // manual +/- CAMERA zoom (FOV: scales the whole scene -- hole, disk, lensing, background -- together); via iCamZoom; persisted in localStorage
  let panX = 0, panY = 0;                               // manual CAMERA pan in uv (middle-mouse drag): slides the WHOLE scene 1:1 on screen; via iCamPan. session-only (re-centers on reload, since there's no reset button)
  let panning = false, panLastX = 0, panLastY = 0;     // middle (wheel) button held -> 1:1 view pan; last client pos to diff against
  let inflowPhase = 0;                                 // accumulated infall (grows while held, drives the disk's inward spiral)
  let cfg = null;            // shader constants parsed from the frag (kept in sync)
  let navItems = [];         // nav links + their natural-position uv, for click tracking
  let fragSource = '';       // the raw shader source (preset is swapped in per selection)
  let presetScale = 1.0;     // per-preset size normalization so each look fills the frame similarly
  let presetFreqScale = 1.0; // per-preset ringdown frequency factor from its mass (1 = lightest/fastest, smaller = heavier/slower)
  let currentPreset = '';    // the active preset name (kept in sync between the picker + swipe)
  let presetSelect = null;   // the picker <select>, so swipe can keep it in sync
  let swTouch = false, swX = 0, swY = 0, swT = 0, swPullX = 0, swPullY = 0; // touch swipe tracking (+ pull at gesture start, to undo it on a swipe)
  const pointers = new Map();                               // active touch pointers (pointerId -> {x,y}) for pinch detection
  let multiTouch = false, pinchDist = 0, pinchZoom0 = 1.0;  // pinch-to-zoom: 2 fingers drive camZoom; suppress single-finger feed/pull/swipe while >=2 down
  let touchFeedTimer = 0;                                   // a single touch defers its feed by TOUCH_FEED_DELAY so a 2nd finger (pinch) cancels it BEFORE any feed/flare happens
  const TOUCH_FEED_DELAY = 70;                              // ms to wait; a deliberate hold still feeds (just imperceptibly later), a pinch never does
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
      x: 0.5 + cfg.driftAmt * driftScale * (0.75 * Math.sin(s * 0.37) + 0.25 * Math.sin(s * 0.83 + 1.0)) + pullX + wobX,
      y: 0.5 + cfg.driftAmt * driftScale * (0.70 * Math.sin(s * 0.54 + 2.1) + 0.30 * Math.sin(s * 1.07)) + pullY + wobY,
    };
  }

  // move each transparent nav link onto its bent label, so it stays clickable
  // wherever the lensing puts it (nav sits in the analytic far field).
  function navUpdate(time) {
    if (!cfg || !navItems.length) return;
    const W = window.innerWidth, H = window.innerHeight, aspect = W / H;
    const cz = camZoom; // camera zoom scales each link's offset-from-center + its bend (see below)
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
      // camera zoom moves each link's anchor outward from center by (cz-1) and scales its
      // bend by cz (matches the shader's p/iCamZoom). reduces to dx*H, dy*H when cz = 1.
      // camera pan then slides every link 1:1 with the scene (matches uv - iCamPan).
      const tx = ((cz - 1) * px + cz * dx) * H + panX * W;
      const ty = ((cz - 1) * py + cz * dy) * H + panY * H;
      it.el.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px)';
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
    uCamZoom = gl.getUniformLocation(prog, 'iCamZoom');
    uCamPan = gl.getUniformLocation(prog, 'iCamPan');
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
    // a switched-in hole arrives fresh in SIZE/FEED state (clear a stuck size, a stray collapse,
    // accumulated inflow), but the SPACETIME FABRIC RIPPLE is KEPT and adopted by the new hole
    // (Ali: "keep the fabric, adopt it to the new black hole"): relRip + ripShown + ripPhase keep
    // running so the wave carries across the swipe with no reset/dip, and ripFreqShown is NOT
    // snapped -- render eases it toward the NEW preset's frequency so the wavelength morphs into
    // the new hole's. its reach/size adapt for free too (the shader reads the new szEff).
    mass = 1.0; massTarget = 1.0; prevMass = 1.0; relM0 = 1.0;
    collapsing = false; relT = 0; feedSilence = 0; inflowPhase = 0; diskTime = 0;
    // intentionally NOT reset: relRip, ripShown, ripFreqShown, ripPhase (the fabric ripple persists + adopts)
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
    const amp = Math.min(WOBBLE_AMP * presetScale * (0.75 + Math.random() * 0.6) * (strength || 1), 0.26); // cap so it stays in frame (raised so a hard swipe reads bigger)
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
    // backstop: pointer events can DROP a pointerup under heavy load (an extreme pinch-zoom
    // janks the frame), leaving a stale id in `pointers` -> every later single touch then
    // reads as a 2nd finger -> beginPinch -> single-finger feed/pull/swipe stop working
    // ("touch goes away"). TouchEvent.touches is the authoritative live set, so when it
    // reaches 0 (all fingers physically up) we hard-reset the pinch state.
    window.addEventListener('touchend', syncTouches);
    window.addEventListener('touchcancel', syncTouches);
    document.addEventListener('mouseleave', onMouseLeave); // desktop: end the pull when the cursor leaves
    // a long press is a feed gesture here, not a context menu / text selection;
    // suppress the menu the browser would otherwise pop (Android especially)
    window.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('keydown', onKeyDown); // desktop: arrow keys switch the black hole
    // shake-to-feed: Android exposes devicemotion with no prompt, so attach it now.
    // iOS 13+ requires a permission request from a user gesture -> we arm the COMPLETED-
    // gesture events and let the first one trigger the prompt (a bare pointerdown/
    // touchstart often lacks the activation Safari needs).
    if (!reduceMotion && isCoarse) {
      const DME = window.DeviceMotionEvent;
      if (DME && typeof DME.requestPermission !== 'function') {
        motionRequested = true;
        attachMotion(); // Android / older iOS: no prompt
      } else if (DME) {
        MOTION_GESTURES.forEach(function (ev) { window.addEventListener(ev, enableMotion); });
      }
    }
    addPresetPicker(initial);
    loadZoom();
    if (!isCoarse) {
      window.addEventListener('wheel', onWheel, { passive: false }); // desktop wheel zoom; mobile uses pinch
      // middle-button autoscroll (Chrome/Windows) fires off mousedown, which pointerdown's
      // preventDefault doesn't reliably stop -- suppress it here so a pan-drag doesn't fight it.
      // skip links/controls so their native middle-click (open in new tab) still works.
      window.addEventListener('mousedown', function (e) {
        if (e.button === 1 && !(e.target.closest && e.target.closest('.bh-preset, a, button, select, input'))) e.preventDefault();
      });
    }
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

    // real-time rate of the disk = a 1/M slowdown from BOTH masses, multiplied:
    //  - per-PRESET mass: heavier presets orbit slower at rest (presetFreqScale, the SAME
    //    log-compressed 1/M the ringdown uses -- orbital Omega and QNM frequency both go as 1/M).
    //  - FED mass: feeding grows the hole self-similarly (feedPow) for a further 1/M, steepened by
    //    DISK_SLOW_POW so the slowdown beats the zoom's apparent inner-material speedup (else it
    //    looked like feeding FASTENED the swirl -- the zoom wins over a plain 1/M). see that const.
    // floored on the product so a fed giant can't freeze. accumulated incrementally (not iTime*rate)
    // so a smoothly-changing rate never jumps the phase.
    const rtScale = Math.max(DISK_SPEED_FLOOR, presetFreqScale / feedPow(MASS_SIZE_K * DISK_SLOW_POW));
    diskTime += dt * rtScale;
    const wrapT = cfg.diskCycle * 16.0;          // keep the disk clock TINY so feeding can't accumulate it into precision/aliasing flicker; 16 is an integer x cycle, so fract(t/cycle) (the only thing the disk reads) is unchanged -> invisible wrap
    while (diskTime > wrapT) diskTime -= wrapT;  // while-loop: a big feed burst can overshoot by more than one wrap in a frame

    // feeding is mostly a brightness flare + a subtle swell (not a zoom). the
    // responsive base size keeps the whole disk on-screen on narrow viewports.
    szEff = baseScale * presetScale * feedPow(MASS_SIZE_K);
    const flare = feedPow(MASS_LUM_K) / feedPow(MASS_SIZE_K * FLARE_ZOOM_COMP); // intended flare, minus the zoom's brightness surge (see FLARE_ZOOM_COMP)

    // infall phase grows while feeding, eases out on release; drives the disk's inward spiral.
    // the inflow is a real-time rate too, so it gets the SAME 1/M slowdown as the swirl (a fed/
    // heavier hole's matter also drifts in slower in wall-clock) -- keeps the two self-consistent.
    if (feeding) inflowPhase += dt * INFLOW_SPEED * rtScale;
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
    gl.uniform2f(uCursor, pullX + wobX, pullY + wobY);
    gl.uniform1f(uDiskTime, diskTime);
    gl.uniform1f(uDriftScale, driftScale);
    gl.uniform1f(uMass, szEff);
    gl.uniform1f(uCamZoom, camZoom);
    gl.uniform2f(uCamPan, panX, panY);
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
    // a still-significant release ring keeps OWNING the frequency even if a new feed has started
    // (no `!feeding`): otherwise reclicking mid-fade snapped the wavelength from the ring's low
    // frequency (a few big rings) up to the feed frequency (many small rings) -- the "sudden
    // appearance of full rings" flicker. while the ring lasts, feed + ring share its low frequency
    // (coherent, no beating); as relRip decays past the threshold the frequency eases to the feed's.
    const ringing = relRip > 0.02; // a post-collapse release ring is still the active driver
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
      gl.uniform1f(uCamZoom, camZoom);
      gl.uniform2f(uCamPan, panX, panY);
      gl.uniform1f(uFlare, feedPow(MASS_LUM_K) / feedPow(MASS_SIZE_K * FLARE_ZOOM_COMP));
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
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (panning) {                            // middle-button camera pan: slide the whole view 1:1 with the mouse
      if ((e.buttons & 4) === 0) { panning = false; return; } // button released without a pointerup we saw -> stop
      panX += (e.clientX - panLastX) / window.innerWidth;
      panY += (e.clientY - panLastY) / window.innerHeight;
      panLastX = e.clientX; panLastY = e.clientY;
      if (reduceMotion) start();
      return;
    }
    if (multiTouch) {                         // pinch in progress: spread/squeeze the fingers to zoom, no pull
      if (pointers.size >= 2) {
        const pts = Array.from(pointers.values());
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        camZoom = Math.max(ZOOM_MIN, pinchZoom0 * d / pinchDist); // no upper cap -> infinite zoom-in; persisted on release
        if (reduceMotion) start();
      }
      return;
    }
    tgtPullX = (e.clientX / window.innerWidth - 0.5) * CURSOR_PULL;
    tgtPullY = (e.clientY / window.innerHeight - 0.5) * CURSOR_PULL;
    pointerActive = true;
    // touch always uses the heavy spring; a mouse uses the slow hover-drift UNTIL the button
    // is held (dragging) -- then it grabs the hole with that same spring (momentum + coast).
    pullTouch = (e.pointerType !== 'mouse') || dragging;
  }

  // a second finger landed: add a pinch-zoom ON TOP of whatever the first finger was doing.
  // KEY: don't touch `pressed` -- an active feed keeps pouring in while you zoom (feed + zoom
  // together). and don't move the hole: freeze its position (pointerActive/pullTouch off, kill
  // the drift momentum) but leave pullX/pullY exactly where they are, so adding/lifting the 2nd
  // finger never teleports it. the pull stays frozen for the rest of the touch (multiTouch holds
  // until ALL fingers lift -- see onPointerUp), so the hole can't jump to the other finger either.
  function beginPinch() {
    multiTouch = true;
    clearTimeout(touchFeedTimer);          // a still-deferred 1st-finger feed: a fast pinch stays a fresh (non-feeding) zoom
    pointerActive = false; pullTouch = false; swTouch = false;
    velX = 0; velY = 0;
    const pts = Array.from(pointers.values());
    pinchDist = Math.max(Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), 1e-3);
    pinchZoom0 = camZoom;
  }
  // press = feed: a tap of mass; holding pours more in (render()). the disk speed
  // follows mass, so feeding also energizes the streaks. nav stays in sync via mass.
  // a press on a control (the preset picker, a link, a button) shouldn't feed.
  // mouse feeds immediately; a touch DEFERS its feed (startTouchFeed) so a second finger
  // can turn the gesture into a pinch before any feed happens. a touch also starts swipe
  // tracking (a horizontal/vertical swipe cycles presets).
  function onPointerDown(e) {
    swTouch = false;
    if (e.target.closest && e.target.closest('.bh-preset, a, button, select, input')) return;
    if (e.pointerType === 'mouse') {
      if (e.button === 1) {                 // middle (wheel) button: start a 1:1 camera pan -- no feed, no hole-grab
        e.preventDefault();                 // suppress the browser's middle-click autoscroll
        panning = true; panLastX = e.clientX; panLastY = e.clientY;
        return;
      }
      dragging = true;     // grab: onPointerMove now drives the spring (set before so it picks up dragging)
      onPointerMove(e);
      pressed = true;
      massTarget = Math.min(massTarget + FEED_TAP, MASS_MAX);
      // NOTE: don't clear relRip here. a still-fading release ring is left to decay on its own
      // (relTau) so reclicking can't make it vanish/snap -- the new feed's ripple just sums with
      // it, and the frequency stays tied to the ring while it lasts (see `ringing` in render).
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) { clearTimeout(touchFeedTimer); beginPinch(); return; } // 2nd finger: pinch-zoom, never feeds
    swTouch = true; swX = e.clientX; swY = e.clientY; swT = e.timeStamp; swPullX = pullX; swPullY = pullY;
    onPointerMove(e); // pull tracks the finger right away; feeding waits (deferred below)
    clearTimeout(touchFeedTimer);
    touchFeedTimer = setTimeout(startTouchFeed, TOUCH_FEED_DELAY);
  }
  // fires TOUCH_FEED_DELAY after a single touch lands: if it's still one finger (not a
  // pinch, not lifted), begin feeding. a very fast tap that releases before this simply
  // doesn't feed (the deferral is what keeps a pinch from ever feeding).
  function startTouchFeed() {
    if (multiTouch || pointers.size !== 1) return; // a 2nd finger or a lift beat the timer
    pressed = true;
    massTarget = Math.min(massTarget + FEED_TAP, MASS_MAX);
    // don't clear relRip (see the note in onPointerDown): a lingering release ring decays on its own
  }
  // release: stop the spin-up. touch/pen also ends the pull so it coasts to a
  // stop; mouse keeps following its cursor (the desktop pull ends on mouseleave).
  // a quick, axis-dominant touch swipe (horizontal OR vertical) cycles presets:
  // left/up = next, right/down = previous. the throw follows the swipe vector.
  function onPointerUp(e) {
    if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);
    if (panning && e.pointerType === 'mouse') { panning = false; return; } // middle button up: end the pan, no feed-release/swipe
    if (multiTouch) {                          // lifting a finger out of a pinch
      if (pointers.size < 2) { try { localStorage.setItem('bh-zoom', String(camZoom)); } catch (err) { /* private mode / file:// */ } }
      if (pointers.size === 0) {
        multiTouch = false;                    // LAST finger up: release the feed (collapse) + re-enable single-finger gestures
        pressed = false; pointerActive = false;
      }
      // size >= 1: stay frozen. an active feed keeps pouring (pressed untouched), the hole holds
      // its position (no pull), and a 2nd finger still zooms -- dropping to one finger never
      // teleports it or stops the feed. only all-up ends the gesture.
      return;
    }
    clearTimeout(touchFeedTimer);
    pressed = false;
    if (e.pointerType === 'mouse') {
      // release the grab: drop pointerActive so the spring coasts on its last velocity (the
      // mobile-style throw). the next hover move re-activates and flips pullTouch back to drift.
      if (dragging) { dragging = false; pointerActive = false; }
    } else {
      pointerActive = false;
    }
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
        // power curve (not linear): a flick barely nudges, a long hard swipe throws
        // it MUCH harder, so the swipe's force is felt -- not a near-flat response.
        const swn = Math.min(amaj / span, 0.6) / 0.6;          // 0..1: swipe length, capped
        const strength = 0.6 + Math.pow(swn, 1.8) * 2.6;       // ~0.6 (gentle) .. 3.2 (full swipe)
        cyclePreset(major < 0 ? 1 : -1, dx, dy, strength); // left/up = next, right/down = previous
      }
      swTouch = false;
    }
  }
  function onMouseLeave() { pointerActive = false; pressed = false; dragging = false; panning = false; }

  // all fingers are physically up (touches.length === 0): clear any stale pinch/feed state
  // a dropped pointerup may have left behind, so single-finger gestures work again. only acts
  // at the safe all-up moment, so it can't clobber a live gesture; the swipe state (swTouch) is
  // left for the trailing pointerup to consume.
  function syncTouches(e) {
    if (e.touches.length === 0 && (pointers.size || multiTouch)) {
      pointers.clear();
      multiTouch = false;
      pressed = false;
      pointerActive = false;
      clearTimeout(touchFeedTimer);
    }
  }

  // device MOTION (mobile): the gravity-removed linear acceleration spikes on a SHAKE,
  // which feeds the hole like a hold (the tilt-roll "marble" was dropped as untunable;
  // shake is binary -- a hard shake pours mass in, stopping collapses like a release).
  function onMotion(e) {
    const a = e.acceleration; // gravity removed: ~0 at rest, spikes on a shake/flick
    if (a && a.x != null) {
      const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      if (mag > shakeLevel) shakeLevel = mag;             // peak-hold; render() coasts it down (SHAKE_TAU)
    }
  }

  // wire up devicemotion (shake feed). iOS 13+ gates it behind a permission prompt that
  // must be requested from inside a user gesture, so init arms MOTION_GESTURES (completed
  // taps) and the first one calls this; it retries until iOS answers, then disarms them.
  // Android / older iOS have no prompt and are attached directly at init instead.
  function enableMotion() {
    if (motionRequested || motionPending || reduceMotion || !isCoarse) return;
    const DME = window.DeviceMotionEvent;
    if (!DME) return;
    if (typeof DME.requestPermission !== 'function') { // Android / older iOS: no prompt
      motionRequested = true;
      attachMotion();
      return;
    }
    // iOS 13+: the prompt needs transient user activation. mark the request in flight (NOT
    // done) so that if this gesture lacked activation and the promise rejects, the next
    // completed tap can retry instead of being locked out by an early motionRequested=true.
    motionPending = true;
    DME.requestPermission().then(function (s) {
      motionRequested = true; motionPending = false;        // iOS answered: stop retrying
      MOTION_GESTURES.forEach(function (ev) { window.removeEventListener(ev, enableMotion); });
      if (s === 'granted') attachMotion();
    }).catch(function () { motionPending = false; /* no activation: next gesture retries */ });
  }

  function attachMotion() {
    window.addEventListener('devicemotion', onMotion);
  }

  // desktop: left/right arrows cycle presets (right = next, left = previous), throwing the
  // landing wobble in the arrow's direction; up/down arrows CAMERA-zoom (up = in, down = out).
  // when the picker <select> is focused, let it handle arrows natively (its change still cycles).
  function onKeyDown(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowUp') { e.preventDefault(); setZoom(camZoom * KEY_ZOOM_STEP); return; }   // up = zoom in (no upper cap)
    if (e.key === 'ArrowDown') { e.preventDefault(); setZoom(camZoom / KEY_ZOOM_STEP); return; } // down = zoom out (floored at ZOOM_MIN)
    let dir = 0, dx = 0, dy = 0;
    if (e.key === 'ArrowRight') { dir = 1; dx = 1; }
    else if (e.key === 'ArrowLeft') { dir = -1; dx = -1; }
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

  // apply + persist a manual zoom level (multiplies szEff). clamped; redraws the static
  // frame under reduced motion (the live loop picks it up on its own next frame).
  function setZoom(z) {
    camZoom = Math.max(ZOOM_MIN, z); // no upper bound -> infinite zoom-in
    try { localStorage.setItem('bh-zoom', String(camZoom)); } catch (e) { /* private mode / file:// */ }
    if (reduceMotion) start();
  }

  // restore the last CAMERA-zoom level from a previous visit (desktop wheel / mobile pinch
  // both persist it on change). a guard against junk/zero so iCamZoom never divides by 0.
  function loadZoom() {
    try { const z = parseFloat(localStorage.getItem('bh-zoom')); if (isFinite(z) && z > 0) camZoom = Math.max(ZOOM_MIN, z); } catch (e) { /* ignore */ }
  }

  // desktop: the mouse wheel CAMERA-zooms the whole scene (mobile pinch-zooms instead).
  // scroll up = zoom in (no upper cap), scroll down = zoom out. preventDefault stops the
  // page from scrolling under the full-screen canvas. deltaMode is normalized so line/page
  // wheels (Firefox, some mice) zoom by a comparable amount to pixel wheels.
  function onWheel(e) {
    e.preventDefault();
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 16;                       // lines -> ~px
    else if (e.deltaMode === 2) d *= window.innerHeight;  // pages -> ~px
    setZoom(camZoom * Math.exp(-d * WHEEL_ZOOM_K));       // up (d<0) zooms in; setZoom floors + persists
  }

  fetch('/assets/shaders/blackhole.frag', { cache: 'no-cache' }) // always revalidate so shader edits aren't served stale
    .then(function (r) { return r.text(); })
    .then(init)
    .catch(function (e) { console.error('blackhole: failed to load shader', e); });
})();
