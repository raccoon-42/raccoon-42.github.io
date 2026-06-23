#version 300 es
precision highp float;
precision highp int;

// Geodesic-traced black hole for the 404 page.
//
// Ported to WebGL2 from blackhole.glsl in https://github.com/s0xDk/ghostty-blackhole
// (MIT License, Copyright (c) 2026 s13k), itself after Eric Bruneton's
// "Real-time High-Quality Rendering of Non-Rotating Black Holes".
// Each pixel's null geodesic is integrated numerically (Binet-form photon
// acceleration a = -(3/2) h^2 x / r^5), reproducing exact Schwarzschild bending:
// shadow, lensing, photon ring, and a Shakura-Sunyaev accretion disk.
//
// Changes for the web: the Ghostty size "modes" (pomodoro / Claude token fill,
// driven by the cursor color) and the lensed terminal background are removed.
// The hole is fixed, centered, and constant-size, over a procedural lensed
// starfield. The physics is unchanged.

uniform vec3      iResolution;
uniform float     iTime;
uniform vec2      iCursor;      // eased pull of the hole center toward the cursor (uv offset; 0 = none). set in blackhole.js
uniform float     iDiskTime;    // disk-streak clock: like iTime but sped up on click/hold (set in blackhole.js)
uniform float     iMass;        // hole size multiplier; grows as you "feed" it (set in blackhole.js; 1 = baseline)
uniform float     iFlare;       // disk luminosity multiplier; rises as you feed (1 = baseline). set in blackhole.js
uniform float     iInflow;      // feeding: drives the inward pull (disk matter spirals inward toward the shadow). set in blackhole.js
uniform float     iRipple;      // 0 normally; >0 while the hole wobbles -> a radial wave shakes the lensed text (spacetime fabric). set in blackhole.js
uniform float     iDiskWob;     // transient tilt added to the disk inclination so it nods/sloshes when the hole shakes or moves (0 at rest). set in blackhole.js
uniform float     iDriftScale;  // 1 = autonomous sin-drift on; faded to 0 on mobile when the gyroscope drives the drift instead. set in blackhole.js
uniform float     iRipFreq;     // ripple frequency scale (1 = baseline). <1 makes the fabric + disk ring as fewer/bigger/slower waves -- a heavier hole rings lower. set in blackhole.js
uniform float     iRipPhase;    // accumulated ripple time-phase = integral of iRipFreq dt (wrapped). use THIS, not iTime, for the ripple's temporal term: a changing frequency must not jump the phase (which iTime*freq does, worse as iTime grows). set in blackhole.js
uniform float     iCamZoom;    // manual CAMERA zoom: scales the screen->scene mapping around the hole, so the hole, disk, lensing AND background all zoom together (1 = none, >1 = zoom in / everything bigger). a FOV change, distinct from iMass (which grows the hole itself). set in blackhole.js
uniform vec2      iCamPan;     // manual CAMERA pan (uv): subtracted from uv so the WHOLE composed scene -- hole, disk, lensing AND background -- slides 1:1 on screen (zoom-independent). distinct from iCursor, which only moves the hole over a fixed background. set in blackhole.js (middle-mouse drag)
uniform sampler2D iChannel0;   // the lens plane: the "404" text, warped near the hole

out vec4 outColor;

// ---------------------------------------------------------------- tunables --
const float HOLE_RADIUS   = 0.06;    // shadow radius as a fraction of screen height
const float LENS_DEPTH    = 1000.0;    // how hard the background text bends
const float TEX_MARGIN    = 0.30;    // HORIZONTAL padding only: the text plane is rendered this much wider than the viewport each side, so rays bent off-screen left/right sample real text instead of the mirror seam. (VERTICALLY the texture is an exact line-period multiple and tiles seamlessly via WRAP_T=REPEAT -- see texSample + buildTextTexture.) matched in blackhole.js.
const float INTENSITY     = 0.06;    // 0 = fast disk, 1 = slow/dilated, massive feel
const float DRIFT_AMT     = 0.045;   // hole wander: makes the bent text ripple
const float DILATION_MIN  = 0.20;    // disk pattern rate at full INTENSITY
const float STAR_OVERRIDE = 0.0;     // text field is the background now, no procedural stars
const float DRIFT_SPEED   = 1.0;
const float WARP_LEAN     = 0.5;     // shear the text warp so it leans with the tilted hole (0 = mirror-symmetric)
// disk streak motion. a static streak noise advected by the per-radius Keplerian
// rate winds into ever-finer spirals that alias to a static blur within ~a minute
// (looks like the disk "freezes"). real disks don't, because their turbulence is
// continuously renewed. so advect at the true Keplerian rate but cross-dissolve
// two copies offset by half a cycle (van Wijk / flow-map): each only shears for a
// cycle before being renewed, hidden at the crossfade. shears like a real disk,
// never winds, never pops.
const float DISK_CYCLE     = 8.0;    // seconds per renewal cycle (lower = crisper + more boil, higher = more shear)
const float INFALL_K       = 2.5;    // feeding: how fast the disk's matter spirals inward toward the shadow (0 = orbit only)
const float TEMP_BLUE      = 0.12;   // feeding: how much hotter/bluer the disk runs as accretion rises (real: higher rate -> higher temp)
const float DOPP_COLOR     = 2.0;    // exaggerate the Doppler/grav shift on color so red (receding) / blue (approaching) shows at this temp
// gravitational ripple: while the hole wobbles (iRipple > 0) a radial wave runs
// through the lensed text, like the spacetime fabric shaking from the impact.
const float RIPPLE_AMP     = 0.06;   // ripple displacement of the sampled fabric (screen-height units) -- this is the main "how violent" knob
const float RIPPLE_FREQ    = 30.0;   // ripple spatial frequency (fewer, bigger wave rings = more visible slosh)
const float RIPPLE_SPEED   = 7.0;    // how fast the rings propagate outward
const float RIPPLE_FALL    = 0.9;    // how fast the ripple fades with distance from the hole (lower = reaches further out, more even across presets)
// the accretion disk ripples too (same iRipple envelope): a radial wave runs
// through the disk, shifting its streaks in/out and pulsing brightness in rings.
const float DISK_RIP_FREQ  = 0.9;    // disk ripple rings per r_s of radius (fewer = bigger, more visible rings)
const float DISK_RIP_SPEED = 2.0;    // how fast the disk rings travel outward (kept well below RIPPLE_SPEED so the ring ripples slower than the fabric)
const float DISK_RIP_SHIFT = 0.7;    // radial wobble of the bright ring in/out (r_s) -- the main visible knob
const float DISK_RIP_BRIGHT= 0.4;    // brightness pulse of the disk rings
#define N_STEPS 36                    // geodesic integration steps per near-field pixel
#define B_CRIT 2.5980762              // critical impact parameter (shadow radius), in r_s

// inner-ring anti-aliasing. the accretion disk is PROCEDURAL (computed per ray, no texture to
// mipmap), so when zoomed OUT its thin inner edge falls between pixel centers and drops out
// (the background text is fine -- it's a real texture w/ mipmaps + anisotropy). fix = brute-force
// supersample the DISK only: trace extra jittered rays per pixel and average their emission +
// transmittance. NEAR-FIELD ONLY (gated by b<bmax) so the far field pays nothing -- and crucially
// the disk path has NO texture() fetch, so this branchy/supersampled flow keeps NVIDIA's implicit
// mip-LOD derivatives defined (the bg fetch stays single-sampled + in uniform flow, deferred to the
// end -- do NOT move a texture() in here). cost ~ (DISK_AA+1)x the geodesic for near-hole pixels,
// which is a tiny on-screen region exactly when zoomed out (the case that needs it). 0 = off.
#define DISK_AA 3                     // extra jittered disk rays/pixel (max 4 = AA_OFF length)
// grazing-edge widening for the inner ring's lensed TOP arc (where supersampling alone isn't
// enough). widens the inner-edge ramp by 1/|cos(incidence)| at the disk crossing, capped.
#define INNER_AA_MAX 8.0              // max widening of the grazing inner edge (1.0 = off)
#define INNER_AA_EPS 0.05             // floor on |cos(incidence)| so the widening stays bounded
// rotated-grid sub-pixel offsets (pixels); paired with the center sample (the canonical trace)
const vec2 AA_OFF[4] = vec2[4](
    vec2( 0.375, -0.125), vec2(-0.125, -0.375),
    vec2(-0.375,  0.125), vec2( 0.125,  0.375)
);

// the disk's whole look in one bundle
struct DiskLook {
    float temp, incl, roll, inner, outer, opac, dopp, beam,
          gain, contr, wind, speed, expo, star;
};
//                                    temp    incl  roll   inner outer opac  dopp  beam gain contr wind speed expo  star
const DiskLook INFERNO   = DiskLook( 5500.0, 1.50,  0.35, 1.8,  8.0, 0.90, 0.60, 2.5, 2.2, 1.6, 7.0, 5.0, 1.40, 0.0);
const DiskLook GARGANTUA = DiskLook( 4500.0, 1.52,  0.10, 2.2,  7.0, 0.85, 0.35, 2.0, 1.4, 0.5, 7.0, 5.0, 1.20, 0.0);
const DiskLook QUASAR    = DiskLook(15000.0, 1.30,  0.35, 3.0, 14.0, 0.35, 1.00, 4.0, 1.2, 1.3, 8.0, 5.0, 0.80, 0.0);
const DiskLook FACEON    = DiskLook( 6500.0, 0.30,  0.00, 3.0, 10.0, 0.50, 0.80, 2.5, 1.0, 1.1, 7.0, 5.0, 1.00, 0.0);
const DiskLook M87       = DiskLook( 3800.0, 0.55, -0.30, 2.2,  6.0, 0.45, 0.90, 3.5, 1.6, 0.4, 3.0, 2.5, 1.10, 0.0);
const DiskLook BLAZAR    = DiskLook(18000.0, 1.05,  0.55, 3.0, 16.0, 0.30, 1.00, 5.0, 1.0, 1.5, 9.0, 6.0, 0.75, 0.0);
const DiskLook PURELENS  = DiskLook( 5500.0, 1.50,  0.35, 1.8,  8.0, 0.00, 1.00, 2.5, 0.0, 1.6, 7.0, 5.0, 1.00, 0.6);
const DiskLook ZEN       = DiskLook( 7000.0, 1.45,  0.15, 3.5,  7.0, 0.40, 0.50, 2.0, 0.5, 0.3, 3.0, 1.5, 0.70, 0.0);

// >>> pick the look here <<<
#define PRESET M87

// ------------------------------------------------------------------- noise --
float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
}

// value noise whose y lattice wraps every perY cells, so the disk's angular
// streaks tile seamlessly across the atan branch cut
float vnoiseWrapY(vec2 p, float perY) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float y0 = mod(i.y, perY), y1 = mod(i.y + 1.0, perY);
    return mix(mix(hash21(vec2(i.x, y0)), hash21(vec2(i.x + 1.0, y0)), f.x),
               mix(hash21(vec2(i.x, y1)), hash21(vec2(i.x + 1.0, y1)), f.x),
               f.y);
}

vec2 rot(vec2 v, float a) {
    float c = cos(a), s = sin(a);
    return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

// mirrored repeat keeps lensed samples on-screen without edge smearing
vec2 mirrorUV(vec2 u) { return 1.0 - abs(1.0 - mod(u, 2.0)); }

// map a screen-uv sample (0..1 = the screen) onto the lens-plane texture.
// HORIZONTAL: the text is padded TEX_MARGIN past the viewport each side, so off-screen
//   samples read real text; mirror at the (off-screen) padded edge.
// VERTICAL: the texture is sized to an exact whole number of line-spacing periods, so
//   it tiles SEAMLESSLY -- pass y straight through and let WRAP_T = REPEAT continue the
//   rows (no mirror fold, no row-spacing jump). this is the "stitched top edge" fix.
vec2 texSample(vec2 s) {
    float u = (s.x + TEX_MARGIN) / (1.0 + 2.0 * TEX_MARGIN);
    // horizontal mirror is done by the HARDWARE (WRAP_S = MIRRORED_REPEAT), NOT here: we must
    // pass the raw, monotonic u so the GPU computes the mip-LOD from a derivative that does NOT
    // collapse at the fold. mirroring in-shader (1 - abs(1 - mod(u,2))) makes the coordinate
    // symmetric at each fold, so a quad straddling it sees ~0 horizontal derivative -> false LOD 0
    // -> a crisp vertical line at mid zoom. MIRRORED_REPEAT applies the same fold AFTER LOD, so no line.
    return vec2(u, s.y);                       // vertical: raw too, WRAP_T = REPEAT tiles it
}

// unit Lissajous wander: incommensurate sines, never visibly repeats
vec2 lissa(float t) {
    return vec2(0.75 * sin(t * 0.37) + 0.25 * sin(t * 0.83 + 1.0),
                0.70 * sin(t * 0.54 + 2.1) + 0.30 * sin(t * 1.07));
}

// blackbody color from temperature in Kelvin (Tanner Helland fit, normalized)
vec3 blackbody(float T) {
    float t = clamp(T, 1500.0, 40000.0) / 100.0;
    float r = t <= 66.0 ? 1.0
                        : clamp(1.292936 * pow(t - 60.0, -0.1332047), 0.0, 1.0);
    float g = t <= 66.0 ? clamp(0.3900816 * log(t) - 0.6318414, 0.0, 1.0)
                        : clamp(1.1298909 * pow(t - 60.0, -0.0755148), 0.0, 1.0);
    float b = t >= 66.0 ? 1.0
                        : (t <= 19.0 ? 0.0
                                     : clamp(0.5432068 * log(t - 10.0) - 1.1962540, 0.0, 1.0));
    return vec3(r, g, b);
}

// sparse procedural starfield indexed by ray direction; sampled with the bent
// ray, so stars smear into arcs around the hole for free
vec3 stars(vec3 d) {
    vec2 sph = vec2(atan(d.x, -d.z), asin(clamp(d.y, -1.0, 1.0)));
    vec2 g   = sph * 55.0;
    vec2 id  = floor(g);
    float h  = hash21(id);
    if (h < 0.86) return vec3(0.0);
    vec2 f   = fract(g) - 0.5;
    vec2 off = (vec2(hash21(id + 17.3), hash21(id + 31.7)) - 0.5) * 0.7;
    float spark = smoothstep(0.10, 0.0, length(f - off));
    float tw    = 0.7 + 0.3 * sin(iTime * (0.5 + 2.0 * hash21(id + 5.1)) + 40.0 * h);
    vec3 tint   = mix(vec3(1.0, 0.82, 0.60), vec3(0.75, 0.85, 1.0), hash21(id + 2.9));
    return tint * spark * tw * ((h - 0.92) / 0.08);
}

// one geodesic ray: integrate the photon path and accumulate the accretion-disk emission it
// pierces. PROCEDURAL ONLY (no texture() fetch), so it's safe to call inside the branchy /
// supersampled near-field flow. returns the disk emission (HDR); outs the transmittance toward the
// background and the ray's final state (xOut/vOut/capturedOut) so the caller can sample the
// background from the CENTER ray. same math as before, just hoisted out of mainImage so the disk
// can be supersampled by tracing this N times at jittered ray origins.
vec3 traceRay(vec2 pr0, DiskLook L, vec3 n, vec3 e2, float sdir, float spd,
              float rin, float rout, float dil, float Z0,
              out float transOut, out vec3 xOut, out vec3 vOut, out bool capturedOut) {
    vec3  x  = vec3(pr0, Z0);
    vec3  v  = vec3(0.0, 0.0, -1.0);
    float h2 = dot(pr0, pr0);
    bool  captured = false;
    float sPrev = dot(x, n);
    vec3  xPrev = x;
    vec3  emitc = vec3(0.0);
    float trans = 1.0;

    for (int i = 0; i < N_STEPS; i++) {
        float r2 = dot(x, x);
        if (r2 < 1.0) { captured = true; break; }   // through the horizon
        if (x.z < -Z0 && v.z < 0.0) break;          // escaped out the back
        if (r2 > 4.0 * Z0 * Z0) break;              // flung far sideways
        float r  = sqrt(r2);
        float dt = clamp(0.16 * r, 0.03, 1.5);
        // leapfrog (kick-drift-kick) keeps near-critical orbits stable
        vec3 a = -1.5 * h2 * x / (r2 * r2 * r);
        v += a * (0.5 * dt);
        x += v * dt;
        r2 = dot(x, x);
        r  = sqrt(r2);
        a  = -1.5 * h2 * x / (r2 * r2 * r);
        v += a * (0.5 * dt);

        // ---- thin-disk crossing: the ray pierced the disk plane ----
        float s = dot(x, n);
        if (s * sPrev < 0.0 && trans > 0.02) {
            float tc = sPrev / (sPrev - s);
            vec3  xc = mix(xPrev, x, tc);
            float rc = length(xc);
            if (rc > rin && rc < rout) {
                // disk ripple: a radial wave (same iRipple envelope as the fabric, but
                // slower) wobbles the bright ring's radius in/out + pulses its brightness
                float diskRip = iRipple * sin(rc * DISK_RIP_FREQ * iRipFreq - iRipPhase * DISK_RIP_SPEED);
                float rcW   = rc - diskRip * DISK_RIP_SHIFT;   // visually wobbled radius (physics stays on rc)
                // the TOP arc of the inner ring is the disk's far side lensed up and over the
                // shadow, where the ray GRAZES the disk plane: there one screen pixel spans a huge
                // radial range, so the fixed-width inner edge goes sub-pixel and flickers even with
                // supersampling (extreme magnification would need ~20+ rays). widen the inner-edge
                // ramp by the crossing obliquity (1/|cos| of the ray vs the disk normal) so its
                // ON-SCREEN width can't collapse. face-on crossings (|cos|~1, the sharp front edge)
                // are untouched -> the front inner edge stays crisp; only the grazing arc softens.
                float obliq = abs(dot(normalize(v), n));        // ~cos(incidence) at the crossing
                float widen = clamp(1.0 / max(obliq, INNER_AA_EPS), 1.0, INNER_AA_MAX);
                float band = smoothstep(rin, rin + rin * 0.25 * widen, rcW)
                           * (1.0 - smoothstep(rout * 0.70, rout, rcW));

                float phi   = atan(dot(xc, e2), xc.x);
                float turns = phi / 6.2831853;
                float kep   = pow(rin / rc, 1.5);
                float gloc  = sqrt(max(1.0 - 1.5 / rc, 0.02));
                // true Keplerian advection rate (inner orbits faster), signed
                float rateS = kep * spd * gloc * dil * sdir;
                // two copies advected by that rate but offset half a cycle; the
                // crossfade weight is 0 at each copy's reset, hiding the renewal
                float ph1   = fract(iDiskTime / DISK_CYCLE);
                float ph2   = fract(iDiskTime / DISK_CYCLE + 0.5);
                float wx    = 1.0 - abs(2.0 * ph1 - 1.0);
                float sw1   = rc * L.wind * 0.12 - rateS * ph1 * DISK_CYCLE;
                float sw2   = rc * L.wind * 0.12 - rateS * ph2 * DISK_CYCLE;
                // feeding drifts the streak pattern inward in radius -> matter spirals
                // into the shadow (procedural noise, so no seam/flicker). 0 when not fed.
                // (streaks follow the wobbled radius too, so the texture ripples with the ring)
                float rcN   = rcW + iInflow * INFALL_K;
                float st1   = vnoiseWrapY(vec2(rcN * 2.8, turns * 19.0 + sw1 * 3.0), 19.0) * 0.65 +
                              vnoiseWrapY(vec2(rcN * 1.0, turns * 9.0  + sw1 * 1.5 + 7.0), 9.0) * 0.35;
                float st2   = vnoiseWrapY(vec2(rcN * 2.8, turns * 19.0 + sw2 * 3.0), 19.0) * 0.65 +
                              vnoiseWrapY(vec2(rcN * 1.0, turns * 9.0  + sw2 * 1.5 + 7.0), 9.0) * 0.35;
                float streaks = mix(st2, st1, wx);
                streaks = 0.35 + L.contr * streaks * streaks;

                // relativistic Doppler + gravitational shift
                vec3  gasdir = normalize(cross(n, xc)) * sdir;
                float beta   = clamp(inversesqrt(max(2.0 * (rc - 1.0), 0.2)), 0.0, 0.99);
                float g      = gloc / max(1.0 + beta * dot(gasdir, normalize(v)), 0.05);
                g = mix(1.0, g, L.dopp);

                float xpr   = max(1.0 - sqrt(rin / rc), 0.0);
                float tprof = pow(rin / rc, 0.75) * pow(xpr, 0.25) / 0.488;
                vec3  cbb   = blackbody(L.temp * tprof * pow(g, DOPP_COLOR));
                float boost = pow(g, L.beam);

                float density = band * streaks * max(0.0, 1.0 + diskRip * DISK_RIP_BRIGHT);
                emitc += trans * cbb * (L.gain * 2.2 * density * tprof * tprof * boost);
                trans *= 1.0 - clamp(L.opac * density, 0.0, 1.0);
            }
        }
        sPrev = s;
        xPrev = x;
    }
    if (!captured && dot(x, x) < 4.0) captured = true;

    transOut = trans; xOut = x; vOut = v; capturedOut = captured;
    return emitc;
}

// ------------------------------------------------------------------- image --
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2  res    = iResolution.xy;
    vec2  uv     = fragCoord / res;
    float aspect = res.x / res.y;
    float t      = iTime * DRIFT_SPEED;

    DiskLook L = PRESET;
    L.star = STAR_OVERRIDE;
    L.temp *= 1.0 + (iFlare - 1.0) * TEMP_BLUE;   // accretion heats the disk -> bluer when fed
    L.incl += iDiskWob;                           // the disk nods/sloshes when the hole shakes or moves (0 at rest)

    // disk inner edge is floored at the ISCO = 3 r_s (innermost stable circular orbit for a
    // non-spinning hole = 6M, and r_s = 2M = 1 here). inside it there are no stable orbits, so
    // the Keplerian velocity field + the zero-torque temperature boundary (tprof) below are only
    // valid from here out. presets that asked for a tighter disk (M87/GARGANTUA 2.2, INFERNO/
    // PURELENS 1.8) were implicitly Kerr (spin shrinks the ISCO); we render Schwarzschild, so we
    // pin them to the a=0 ISCO for self-consistency. (Kerr lensing is the documented realism ceiling.)
    float rin  = max(L.inner, 3.0);
    float rout = max(L.outer, rin + 0.5);

    // fixed, centered hole (no pomodoro / token modes)
    float I      = INTENSITY;
    float sz     = iMass;   // 1 = baseline; >1 = fed/heavier, grows shadow + disk + lensing together
    vec2  center = vec2(0.5, 0.5) + DRIFT_AMT * iDriftScale * lissa(t * 0.15) + iCursor;

    float rh     = HOLE_RADIUS * sz;       // shadow radius in screen units
    float dil    = mix(1.0, DILATION_MIN, I);
    float shield = 1.0;                     // full-screen effect (nav clickability handled in JS)

    // aspect-corrected frame centered on the hole (y in units of screen height).
    // dividing by iCamZoom is a CAMERA zoom: a pixel maps to a smaller scene offset, so the
    // shadow, disk, lensing + the sampled background ALL scale together around the hole.
    vec2  p    = (uv - iCamPan - center) * vec2(aspect, 1.0) / iCamZoom;
    float plen = length(p);

    // CAMERA-FIXED background position. the zoom must pivot on a FIXED screen point, NOT on the
    // moving hole -- otherwise at iCamZoom > 1 the far-bg coord (center + p/A = center*(1-1/zoom) +
    // (uv-pan)/zoom) picks up `center`, so pulling/drifting the hole DRAGS the whole background
    // ("camera moves" on a mobile pinch-zoomed hold). bgBase pivots the zoom on the screen center
    // (0.5) instead, so the background stays put while the hole drifts. the lensing displacement
    // (sp - p), still hole-relative, is added on top at the fetch sites. reduces to uv - iCamPan at
    // iCamZoom = 1, so the resting/un-zoomed scene is byte-identical to before.
    vec2  bgBase = vec2(0.5) + (uv - iCamPan - vec2(0.5)) / iCamZoom;

    // screen <-> world mapping: shadow's angular size is B_CRIT r_s, wanted rh
    // wide on screen, so 1 screen unit = W Schwarzschild radii.
    float W  = B_CRIT / max(rh, 1e-4);
    vec2  pr = rot(vec2(p.x, -p.y), L.roll) * W;
    float b  = length(pr);                  // ray impact parameter, in r_s

    // fade lensing a few disk diameters out so a drifting hole doesn't shimmer
    float window = exp(-pow(plen / (7.0 * rh), 2.0));

    // gravitational ripple: a radial wave through the lensed text while the hole
    // wobbles. added identically to the far + near background sample (no seam).
    // banded between the shadow and a few diameters out; propagates outward.
    // band it from just outside the shadow (so it tracks the hole as it grows) on
    // out across the field, propagating outward
    // temporal term uses the accumulated iRipPhase (NOT iTime*iRipFreq): a changing
    // frequency must only affect the next step, else a large iTime turns each freq
    // change into a giant phase jump -> the high-frequency wobble after long waits.
    // fade the ripple from the shadow EDGE over a reach that grows with the hole size
    // (sz = iMass), so a big/fed shadow ripples across its visible rim instead of the
    // wave dying right at the edge -- the "large hole has no visible ripple" case (worst
    // on mobile, where the shadow eats most of the screen). floored + capped on sz.
    // CAMERA-ZOOM INVARIANCE: do the wave spacing, fade reach and displacement in SCREEN space
    // (multiply the scene radius by iCamZoom), so a pinch/zoom-in keeps the SAME on-screen ripple
    // instead of stretching the rings into one slow bulge with an oversized throw -- that was the
    // "fabric ripple stops when you zoom in". the band stays in scene units (smoothstep(rh,1.5rh,
    // plen) is unchanged by the shared iCamZoom scale, so it still tracks the shadow edge). every
    // term reduces to the original at iCamZoom = 1.
    float plenS    = plen * iCamZoom;                       // screen-space radius (height units)
    float ripReach = clamp(sz, 1.0, 3.0) / RIPPLE_FALL;    // now in screen-height units
    float rip = iRipple * RIPPLE_AMP / max(iCamZoom, 1e-4) // /zoom keeps the on-screen throw constant
              * sin(plenS * RIPPLE_FREQ * iRipFreq - iRipPhase * RIPPLE_SPEED)
              * smoothstep(rh, 1.5 * rh, plen) * exp(-max(plenS - rh * iCamZoom, 0.0) / ripReach);
    vec2  ripOff = (p / max(plen, 1e-5)) * rip;

    float bmax = rout + 3.0;                // rays beyond this can't touch the disk
    float Z0   = max(14.0, rout + 5.0);     // camera distance
    const float BAND = 1.5;                 // far<->near UV blend width (r_s) just INSIDE bmax

    // ================= background UV: analytic far field (EVERY pixel) =======
    // The analytic weak-deflection UV is the BASE for every pixel; the near field
    // blends its geodesic UV on top (wn, below). The actual texture() fetch is
    // DEFERRED to the end, in UNIFORM control flow -- so no quad fetches the
    // background inside a divergent branch and NVIDIA's implicit LOD derivative
    // stays defined. The old hard far/near branch had a texture() on EACH side: a
    // quad straddling the handoff mixed two unrelated UVs -> garbage derivative ->
    // the speckle ring. No branch wraps the fetch now, so there is no seam.
    float u    = Z0 * inversesqrt(Z0 * Z0 + b * b);
    float defl = (2.0 / (W * W)) / max(plen, 1e-4)
               * (1.29 * u + 0.07) * max(LENS_DEPTH - 2.14 * u + 0.75, 0.0)
               * window * shield;
    vec2  dir  = p / max(plen, 1e-5);
    // chromatic aberration on the lensed text near the handoff circle (per-channel UV split).
    // DELIBERATE AESTHETIC, not physics: real gravitational lensing is achromatic (deflection is
    // wavelength-independent in GR), so this fringe is a cinematic camera-lens touch kept on purpose
    // (Ali's call, eyes-open). set the 0.035 to 0 to remove it. ab is 0 for b <= bmax (smoothstep
    // starts at b/bmax = 1), so the split lives ONLY in the far field where wn = 0 -> no seam.
    float ab = 0.035 * smoothstep(1.0, 2.0, b / bmax);
    vec2  suvFar[3];
    for (int i = 0; i < 3; i++) {
        float k   = 1.0 + (float(i) - 1.0) * ab;
        vec2  sp  = p - dir * defl * k;
        sp.x += WARP_LEAN * p.y * window * shield;  // lean (matches the near field)
        sp += ripOff;                               // shake the fabric (matches the near field)
        // sp - p is the lensing-only displacement (0 when undistorted); add it to the camera-fixed
        // base so the hole's pull/drift can't drag the bg at zoom > 1. == center + sp/A at zoom = 1.
        suvFar[i] = texSample(bgBase + (sp - p) / vec2(aspect, 1.0));
    }
    float bbf  = max(b, 1e-4);                       // floor so dFar is finite at the center
    vec3  dFar = normalize(vec3(-(pr / bbf) * (2.0 / bbf), -1.0));

    // shared accumulators. Far-field defaults: no disk, transparent, escaped.
    // suvNear / bgVisNear / dNear default to the far field so wn = 0 is an exact no-op.
    vec3  emitc     = vec3(0.0);            // accumulated disk light (HDR)
    float trans     = 1.0;                  // transmittance toward the background
    bool  captured  = false;
    vec2  suvNear   = suvFar[1];            // geodesic background UV
    float bgVisNear = 1.0;                  // near background visibility (captured / past-90deg -> 0)
    vec3  dNear     = dFar;
    // wn: weight of the geodesic UV. 0 at/outside bmax, ramps to 1 a BAND inside it, so the
    // geodesic UV is faded to the analytic UV BEFORE the handoff -> the blended UV is continuous.
    float wn = smoothstep(bmax, bmax - BAND, b);

    if (b < bmax) {
        // ====================== near field: trace the geodesic ==================
        // Parallel rays from a distant camera at +z. Hole at the origin, r_s = 1.
        // Integrate x'' = -(3/2) h^2 x / r^5 (exact Schwarzschild photon bending).
        float ci = cos(L.incl), si = sin(L.incl);
        vec3  n  = vec3(0.0, si, ci);           // disk-plane normal
        vec3  e2 = vec3(0.0, ci, -si);          // in-plane axis completing (x, e2, n)
        float sdir = L.speed < 0.0 ? -1.0 : 1.0;
        float spd  = abs(L.speed);

        // center ray: drives BOTH the disk emission and the background sample (x/v below)
        vec3  x, v;
        emitc = traceRay(pr, L, n, e2, sdir, spd, rin, rout, dil, Z0, trans, x, v, captured);

#if DISK_AA > 0
        // brute-force disk anti-aliasing: extra jittered rays, averaged, so the thin inner edge
        // doesn't drop out between pixels when zoomed out. disk-only -> no texture() -> NVIDIA-safe.
        // one screen pixel = vec2(aspect,1)/(res*iCamZoom) in p, which is 1/(res.y*iCamZoom) per axis.
        vec3  eSum = emitc;
        float tSum = trans;
        for (int s = 0; s < DISK_AA; s++) {
            vec2  pJ  = p + AA_OFF[s] / (res.y * iCamZoom);
            vec2  prJ = rot(vec2(pJ.x, -pJ.y), L.roll) * W;
            float tj; vec3 xj, vj; bool cj;
            eSum += traceRay(prJ, L, n, e2, sdir, spd, rin, rout, dil, Z0, tj, xj, vj, cj);
            tSum += tj;
        }
        emitc = eSum / float(DISK_AA + 1);
        trans = tSum / float(DISK_AA + 1);
#endif

        // ---- background: where did the escaped (center) ray come from? ----
        if (!captured) {
            vec3 d = normalize(v);
            dNear  = d;
            if (d.z < -0.05) {
                // project the straight exit ray onto the lens plane at z = -LENS_DEPTH
                float tpl = (-LENS_DEPTH - x.z) / d.z;
                vec3  hp  = x + d * tpl;
                vec2  q   = rot(hp.xy, -L.roll) / W;
                vec2  sp  = vec2(q.x, -q.y);
                // only the displacement is faded by window, never the color: no seam
                vec2  samp = p + (sp - p) * window * shield;
                // lean the warp so it isn't mirror-symmetric; same shear + window as
                // the far field, so the two stay continuous across the handoff
                samp.x += WARP_LEAN * p.y * window * shield;
                samp += ripOff;                              // shake the fabric (matches the far field)
                // camera-fixed base + lensing-only displacement (samp - p), as in the far field
                suvNear   = texSample(bgBase + (samp - p) / vec2(aspect, 1.0));
                // rays bent past ~90deg never reach the plane; fade to the starfield
                bgVisNear = smoothstep(0.05, 0.35, -d.z);
            } else {
                bgVisNear = 0.0;                             // bent past ~90deg: no plane hit
            }
        } else {
            bgVisNear = 0.0;                                 // fell through the horizon: no background
        }
    }

    // ============== unified background fetch (UNIFORM control flow) ==========
    // ONE set of fetches for every pixel, so the fetch is never inside a divergent branch
    // -> the auto-LOD derivative is DEFINED (no seam ring). Plain texture(), so mipmaps +
    // anisotropic filtering are kept (full quality + zoom-out anti-shimmer). Three fetches keep the
    // far-field per-channel chromatic split; in the near field the three UVs collapse to suvNear.
    vec2  uvR  = mix(suvFar[0], suvNear, wn);
    vec2  uvG  = mix(suvFar[1], suvNear, wn);
    vec2  uvB  = mix(suvFar[2], suvNear, wn);
    vec3 bgText;
    bgText.r = texture(iChannel0, uvR).r;
    bgText.g = texture(iChannel0, uvG).g;
    bgText.b = texture(iChannel0, uvB).b;
    float vis  = mix(1.0, bgVisNear, wn);        // far = 1, near = bgVisNear, blended in the band
    vec3  star = mix(stars(dFar), stars(dNear), wn) * L.star * shield;
    vec3  bg   = bgText * vis + star;

    // feeding brightens the disk (accretion flare); HDR, then tonemap over the bg
    emitc *= iFlare;
    vec3 col = bg * trans + (vec3(1.0) - exp(-emitc * L.expo));
    fragColor = vec4(col, 1.0);
}

void main() {
    // flip y so the math matches Ghostty's top-down fragCoord convention
    vec2 fc = vec2(gl_FragCoord.x, iResolution.y - gl_FragCoord.y);
    vec4 c;
    mainImage(c, fc);
    outColor = vec4(c.rgb, 1.0);
}
