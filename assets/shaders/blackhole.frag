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
uniform sampler2D iChannel0;   // the lens plane: the "404" text, warped near the hole

out vec4 outColor;

// ---------------------------------------------------------------- tunables --
const float HOLE_RADIUS   = 0.06;    // shadow radius as a fraction of screen height
const float LENS_DEPTH    = 1000.0;    // how hard the background text bends
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
#define N_STEPS 36                    // geodesic integration steps per near-field pixel
#define B_CRIT 2.5980762              // critical impact parameter (shadow radius), in r_s

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
#define PRESET QUASAR

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
    vec2 g   = sph * 40.0;
    vec2 id  = floor(g);
    float h  = hash21(id);
    if (h < 0.92) return vec3(0.0);
    vec2 f   = fract(g) - 0.5;
    vec2 off = (vec2(hash21(id + 17.3), hash21(id + 31.7)) - 0.5) * 0.7;
    float spark = smoothstep(0.10, 0.0, length(f - off));
    float tw    = 0.7 + 0.3 * sin(iTime * (0.5 + 2.0 * hash21(id + 5.1)) + 40.0 * h);
    vec3 tint   = mix(vec3(1.0, 0.82, 0.60), vec3(0.75, 0.85, 1.0), hash21(id + 2.9));
    return tint * spark * tw * ((h - 0.92) / 0.08);
}

// ------------------------------------------------------------------- image --
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2  res    = iResolution.xy;
    vec2  uv     = fragCoord / res;
    float aspect = res.x / res.y;
    float t      = iTime * DRIFT_SPEED;

    DiskLook L = PRESET;
    L.star = STAR_OVERRIDE;

    float rin  = max(L.inner, 1.6);
    float rout = max(L.outer, rin + 0.5);

    // fixed, centered hole (no pomodoro / token modes)
    float I      = INTENSITY;
    float sz     = 1.0;
    vec2  center = vec2(0.5, 0.5) + DRIFT_AMT * lissa(t * 0.15) + iCursor;

    float rh     = HOLE_RADIUS * sz;       // shadow radius in screen units
    float dil    = mix(1.0, DILATION_MIN, I);
    float shield = 1.0;                     // full-screen effect (nav clickability handled in JS)

    // aspect-corrected frame centered on the hole (y in units of screen height)
    vec2  p    = (uv - center) * vec2(aspect, 1.0);
    float plen = length(p);

    // screen <-> world mapping: shadow's angular size is B_CRIT r_s, wanted rh
    // wide on screen, so 1 screen unit = W Schwarzschild radii.
    float W  = B_CRIT / max(rh, 1e-4);
    vec2  pr = rot(vec2(p.x, -p.y), L.roll) * W;
    float b  = length(pr);                  // ray impact parameter, in r_s

    // fade lensing a few disk diameters out so a drifting hole doesn't shimmer
    float window = exp(-pow(plen / (7.0 * rh), 2.0));

    float bmax = rout + 3.0;                // rays beyond this can't touch the disk
    float Z0   = max(14.0, rout + 5.0);     // camera distance

    // ================= far field: analytic weak deflection ==================
    // escaped rays are projected back onto the lens plane; the displacement is
    // faded by window so a distant pixel reads the text undistorted
    if (b >= bmax) {
        float u    = Z0 * inversesqrt(Z0 * Z0 + b * b);
        float defl = (2.0 / (W * W)) / max(plen, 1e-4)
                   * (1.29 * u + 0.07) * max(LENS_DEPTH - 2.14 * u + 0.75, 0.0)
                   * window * shield;
        vec2  dir  = p / max(plen, 1e-5);
        vec3  term;
        // mild chromatic aberration near the handoff circle
        float ab = 0.035 * smoothstep(1.0, 2.0, b / bmax);
        for (int i = 0; i < 3; i++) {
            float k   = 1.0 + (float(i) - 1.0) * ab;
            vec2  sp  = p - dir * defl * k;
            sp.x += WARP_LEAN * p.y * window * shield;  // lean (matches the near field)
            vec2  suv = mirrorUV(center + sp / vec2(aspect, 1.0));
            term[i]   = texture(iChannel0, suv)[i];
        }
        vec3 d = normalize(vec3(-(pr / b) * (2.0 / b), -1.0));
        fragColor = vec4(term + stars(d) * L.star * window * shield, 1.0);
        return;
    }

    // ====================== near field: trace the geodesic ==================
    // Parallel rays from a distant camera at +z. Hole at the origin, r_s = 1.
    // Integrate x'' = -(3/2) h^2 x / r^5 (exact Schwarzschild photon bending).
    vec3  x  = vec3(pr, Z0);
    vec3  v  = vec3(0.0, 0.0, -1.0);
    float h2 = dot(pr, pr);

    float ci = cos(L.incl), si = sin(L.incl);
    vec3  n  = vec3(0.0, si, ci);           // disk-plane normal
    vec3  e2 = vec3(0.0, ci, -si);          // in-plane axis completing (x, e2, n)
    float sdir = L.speed < 0.0 ? -1.0 : 1.0;
    float spd  = abs(L.speed);

    vec3  emitc = vec3(0.0);                // accumulated disk light (HDR)
    float trans = 1.0;                      // transmittance toward the background
    bool  captured = false;
    float sPrev = dot(x, n);
    vec3  xPrev = x;

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
                float band = smoothstep(rin, rin * 1.25, rc)
                           * (1.0 - smoothstep(rout * 0.70, rout, rc));

                float phi   = atan(dot(xc, e2), xc.x);
                float turns = phi / 6.2831853;
                float kep   = pow(rin / rc, 1.5);
                float gloc  = sqrt(max(1.0 - 1.5 / rc, 0.02));
                // true Keplerian advection rate (inner orbits faster), signed
                float rateS = kep * spd * gloc * dil * sdir;
                // two copies advected by that rate but offset half a cycle; the
                // crossfade weight is 0 at each copy's reset, hiding the renewal
                float ph1   = fract(t / DISK_CYCLE);
                float ph2   = fract(t / DISK_CYCLE + 0.5);
                float wx    = 1.0 - abs(2.0 * ph1 - 1.0);
                float sw1   = rc * L.wind * 0.12 - rateS * ph1 * DISK_CYCLE;
                float sw2   = rc * L.wind * 0.12 - rateS * ph2 * DISK_CYCLE;
                float st1   = vnoiseWrapY(vec2(rc * 2.8, turns * 19.0 + sw1 * 3.0), 19.0) * 0.65 +
                              vnoiseWrapY(vec2(rc * 1.0, turns * 9.0  + sw1 * 1.5 + 7.0), 9.0) * 0.35;
                float st2   = vnoiseWrapY(vec2(rc * 2.8, turns * 19.0 + sw2 * 3.0), 19.0) * 0.65 +
                              vnoiseWrapY(vec2(rc * 1.0, turns * 9.0  + sw2 * 1.5 + 7.0), 9.0) * 0.35;
                float streaks = mix(st2, st1, wx);
                streaks = 0.35 + L.contr * streaks * streaks;

                // relativistic Doppler + gravitational shift
                vec3  gasdir = normalize(cross(n, xc)) * sdir;
                float beta   = clamp(inversesqrt(max(2.0 * (rc - 1.0), 0.2)), 0.0, 0.99);
                float g      = gloc / max(1.0 + beta * dot(gasdir, normalize(v)), 0.05);
                g = mix(1.0, g, L.dopp);

                float xpr   = max(1.0 - sqrt(rin / rc), 0.0);
                float tprof = pow(rin / rc, 0.75) * pow(xpr, 0.25) / 0.488;
                vec3  cbb   = blackbody(L.temp * tprof * g);
                float boost = pow(g, L.beam);

                float density = band * streaks;
                emitc += trans * cbb * (L.gain * 2.2 * density * tprof * tprof * boost);
                trans *= 1.0 - clamp(L.opac * density, 0.0, 1.0);
            }
        }
        sPrev = s;
        xPrev = x;
    }
    if (!captured && dot(x, x) < 4.0) captured = true;

    // ---- background: where did the escaped ray come from? ----
    vec3 bg = vec3(0.0);
    if (!captured) {
        vec3 d = normalize(v);
        bg += stars(d) * L.star * window * shield;
        if (d.z < -0.05) {
            // project the straight exit ray onto the lens plane at z = -LENS_DEPTH
            float tpl = (-LENS_DEPTH - x.z) / d.z;
            vec3  hp  = x + d * tpl;
            vec2  q   = rot(hp.xy, -L.roll) / W;
            vec2  sp  = vec2(q.x, -q.y);
            // only the displacement is faded by window, never the color: no seam
            vec2  samp = p + (sp - p) * window * shield;
            // lean the warp so it isn't mirror-symmetric; same shear + window as
            // the far field, so the two stay continuous across the handoff ring
            samp.x += WARP_LEAN * p.y * window * shield;
            vec2  suv = mirrorUV(center + samp / vec2(aspect, 1.0));
            // rays bent past ~90deg never reach the plane; fade to the starfield
            float toward = smoothstep(0.05, 0.35, -d.z);
            bg += texture(iChannel0, suv).rgb * toward;
        }
    }

    // disk light is HDR; tonemap it over the background
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
