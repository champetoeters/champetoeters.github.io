/* =============================================================================
   CHAMPETOETERS — 3D padel courts · TC Leiemeers, Kuurne

   Geometry comes from site/data/venue.json (OSM-derived). Court 2 really does
   sit ~90 deg to Courts 1 and 3 — do not "tidy" them into a row. Courts 4 and 5
   really are 130 m west, across Bondgenotenlaan and INDOORS, which is why the
   resting shot frames the whole site and not just the outdoor cluster.

   The playing surface is drawn, not photographed: this module requests no
   image asset of any kind. Neighbouring tennis courts and the clubhouse are
   deliberately not built (BRIEF §0) — the one exception is the hall around
   Courts 4 and 5, without which they read as courts in a field. See `buildHalls`.

   Public API (BRIEF §7):
     window.Courts3D.mount(canvasEl, { venue, teams, courtNames })
       courtNames: { 'court-1': 'Baan 1', … } from courts.json — optional, but
       the venue numbering is NOT the display numbering, so pass it.
     window.Courts3D.setActiveCourt('court-1'…'court-5'|null)
     window.Courts3D.setMatch(courtId, matchData)
     window.Courts3D.pause() / resume() / destroy()
   ============================================================================= */
(function () {
  'use strict';

  var SELF_SRC = (document.currentScript && document.currentScript.src) || '';
  function rel(p) { return SELF_SRC ? new URL(p, SELF_SRC).href : p; }
  var THREE_URL = rel('../vendor/three.module.js');

  /* 2048 x 1024 over 20 x 10 m = 102 px/m, so a 5 cm line is ~5 texels wide. */
  var SURF_W = 2048, SURF_H = 1024;

  var P = {
    courtA: '#3E68B4',
    line: '#EAF1FA',
    ball: '#C6DC63'
  };

  /* Court deck heights, in metres above the tarmac.

     ⚠ These separations are load-bearing, not styling. The tarmac is a single
     4000 m quad; depth interpolated across a primitive that large is coarse
     enough that near-coplanar slabs above it flip in and out of the depth test
     between frames. Measured at 4 mm spacing: ~15% of frames rendered the
     court surface black. The tarmac is now out of the depth buffer entirely
     (nothing is ever below it) and everything above it is spaced in
     centimetres — ≥50 mm apart, which clears one depth quantum at this framing
     even on a 16-bit depth buffer. Do not tighten these back up. */
  var Y_CONTACT = 0.01, Y_APRON = 0.08, Y_SURFACE = 0.18,
      Y_BALLSHADOW = 0.23, Y_RING = 0.30, KERB_H = 0.34;

  /* ------------------------------------------------------------------ utils */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function dampTo(cur, tgt, lambda, dt) { return tgt + (cur - tgt) * Math.exp(-lambda * dt); }
  function wrapPi(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  /* deterministic RNG so every reload renders the identical scene */
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  function mm(q) { try { return window.matchMedia(q); } catch (e) { return null; } }

  /* Idle redraw cadence. `still` (capture) always draws every frame — falling
     quiet there strands a half-finished frame in the buffer forever. */
  var IDLE_MS = 1000 / 30;

  /* Resolution is PINNED at min(devicePixelRatio, 2) for the life of the page
     (BRIEF §4 rule 6). There is no adaptive controller: this scene is ~4k
     triangles and holds the frame budget without one, and a controller that
     steps resolution at hover start or end is itself the visible flicker the
     client reported (BRIEF §0, final list 5).

     `?dpr=<n>` overrides it. Headless Chromium rasterises WebGL on SwiftShader
     (CPU), so screenshots need to be able to pin the drawing buffer explicitly.
     Invisible to visitors (BRIEF §0.8). */
  function dprOverride() {
    try {
      var q = new URLSearchParams(window.location.search).get('dpr');
      if (q == null || q === '') return 0;
      var n = parseFloat(q);
      return (isFinite(n) && n > 0) ? clamp(n, 0.25, 4) : 0;
    } catch (e) { return 0; }
  }

  /* `?still=1` — capture aid, kept separate from `?dpr=`. A screenshot of a
     canvas being redrawn can land mid-frame; stilling the scene plus a
     preserved drawing buffer means a capture always reads the last complete
     frame. It would make an FPS measurement meaningless, hence the split. */
  function stillMode() {
    try {
      var q = new URLSearchParams(window.location.search).get('still');
      return q != null && q !== '' && q !== '0';
    } catch (e) { return false; }
  }

  var FALLBACK_VENUE = {
    courts: [
      { id: 'court-1', name: 'Court 1', surface: 'blue', center: [-5.54, -2.47], yaw: -1.8582 },
      { id: 'court-2', name: 'Court 2', surface: 'blue', center: [5.2, 11.73], yaw: 2.8434 },
      { id: 'court-3', name: 'Court 3', surface: 'green', center: [5.8, -5.69], yaw: 1.2592 },
      { id: 'court-4', name: 'Court 4', surface: 'blue', center: [-133.58, 42.24], yaw: -0.4119, indoor: true },
      { id: 'court-5', name: 'Court 5', surface: 'blue', center: [-127.56, 56.0], yaw: -0.4119, indoor: true }
    ],
    halls: [{
      name: 'Indoorhal Bondgenotenlaan', height: 8, courts: ['court-4', 'court-5'],
      points: [[-136.23, 69.3], [-111.92, 58.68], [-124.91, 28.94], [-149.22, 39.56], [-136.23, 69.3]]
    }]
  };

  /* ======================================================== canvas textures */

  function cv(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* The playing surface: flat acrylic blue, one soft rake of light, and the
     markings. No photograph — the client rejected it as low-resolution and it
     is not fixable at source (BRIEF §0). */
  function makeCourtTexture(THREE) {
    var W = SURF_W, H = SURF_H, ppm = W / 20;
    var c = cv(W, H), x = c.getContext('2d');

    x.fillStyle = P.courtA;
    x.fillRect(0, 0, W, H);

    /* bottom-left in shade, a wide lift through the top-right */
    var lg = x.createLinearGradient(0, H, W, 0);
    lg.addColorStop(0.00, 'rgba(10,22,62,0.20)');
    lg.addColorStop(0.45, 'rgba(10,22,62,0.00)');
    lg.addColorStop(0.78, 'rgba(170,202,244,0.11)');
    lg.addColorStop(1.00, 'rgba(10,22,62,0.10)');
    x.fillStyle = lg;
    x.fillRect(0, 0, W, H);

    /* MARKINGS — the padel rulebook, and nothing beyond it (BRIEF §0, item 4):
         · the net across the middle,
         · one service line per side, 6.95 m from the net (3.05 m from the back
           wall) and running the full 10 m width,
         · one central service line per side, from the net to the service line,
           splitting the service area into two boxes.
       There is NO baseline, no line at the back wall, no sideline inside the
       court, and nothing at all in the back 3.05 m. Lines are white and 5 cm.
       Local +x runs along the 20 m axis, +z across the 10 m axis. */
    var SERVICE = 6.95;
    function mx(wx) { return (wx + 10) / 20 * W; }
    function my(wz) { return (wz + 5) / 10 * H; }
    x.lineCap = 'butt';
    x.strokeStyle = P.line;
    x.lineWidth = Math.max(3, 0.05 * ppm);
    x.beginPath();
    x.moveTo(mx(0), my(-5)); x.lineTo(mx(0), my(5));
    x.moveTo(mx(-SERVICE), my(-5)); x.lineTo(mx(-SERVICE), my(5));
    x.moveTo(mx(SERVICE), my(-5)); x.lineTo(mx(SERVICE), my(5));
    /* both central service lines, meeting under the net */
    x.moveTo(mx(-SERVICE), my(0)); x.lineTo(mx(SERVICE), my(0));
    x.stroke();

    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  /* Perimeter apron just outside the playing area. */
  function makeApronTexture(THREE) {
    var S = 256, c = cv(S, S), x = c.getContext('2d'), r = rng(99);
    x.fillStyle = '#0C1230'; x.fillRect(0, 0, S, S);
    for (var i = 0; i < 900; i++) {
      x.fillStyle = 'rgba(' + (r() > 0.5 ? '96,124,176,' : '3,7,26,') + (0.03 + r() * 0.10) + ')';
      x.fillRect(r() * S, r() * S, 1 + r() * 3, 1 + r() * 3);
    }
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }

  /* Net: a dark veil under a pale top tape. Deliberately not a mesh grid — a
     10 m net is ~60 screen pixels tall here, so a grid only minifies into a
     crawling moiré. */
  function makeNetTexture(THREE) {
    var W = 8, H = 128, c = cv(W, H), x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0.00, 'rgba(18,32,70,0.66)');
    g.addColorStop(1.00, 'rgba(10,18,48,0.44)');
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
    x.fillStyle = 'rgba(228,238,250,0.95)';
    x.fillRect(0, 0, W, 16);
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 1;
    return t;
  }

  /* Soft blob — the hard-sun ball shadows. */
  function makeBlobTexture(THREE) {
    var S = 64, c = cv(S, S), x = c.getContext('2d');
    var g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    return new THREE.CanvasTexture(c);
  }

  /* Soft contact shadow under a court box — one small unlit quad per court
     instead of a shadow-map lookup over the whole tarmac. */
  function makeContactTexture(THREE) {
    /* stacked insets rather than ctx.filter='blur()' — no feature dependency */
    var W = 256, H = 160, c = cv(W, H), x = c.getContext('2d');
    x.clearRect(0, 0, W, H);
    x.fillStyle = 'rgba(0,0,0,0.085)';
    for (var i = 0; i < 16; i++) {
      var p = 14 + i * 2.6;
      roundRect(x, p, p * 0.72, W - p * 2, H - p * 1.44, Math.max(4, 30 - i));
      x.fill();
    }
    return new THREE.CanvasTexture(c);
  }

  /* Accent ring drawn under the active court. */
  function makeRingTexture(THREE) {
    var S = 512, c = cv(S, S), x = c.getContext('2d');
    x.clearRect(0, 0, S, S);
    var pad = 26, rad = 46;
    function rr(lw, col) {
      x.beginPath();
      var a = pad, b = S - pad;
      x.moveTo(a + rad, a);
      x.arcTo(b, a, b, b, rad); x.arcTo(b, b, a, b, rad);
      x.arcTo(a, b, a, a, rad); x.arcTo(a, a, b, a, rad);
      x.closePath();
      x.lineWidth = lw; x.strokeStyle = col; x.stroke();
    }
    rr(26, 'rgba(198,220,99,0.07)');
    rr(11, 'rgba(198,220,99,0.20)');
    rr(3.5, 'rgba(224,244,140,0.95)');
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* Tileable mottle for the tarmac. It must recede — it is the ground the
     courts sit on, not a second subject. */
  var GROUND_TINT = 0xa9bcd8;

  function makeGroundTexture(THREE) {
    var S = 256, c = cv(S, S), x = c.getContext('2d'), r = rng(7);
    x.fillStyle = '#0A1026'; x.fillRect(0, 0, S, S);
    for (var i = 0; i < 90; i++) {
      var bx = r() * S, by = r() * S, br = 12 + r() * 70;
      var g = x.createRadialGradient(bx, by, 0, bx, by, br);
      var up = r() > 0.55;
      g.addColorStop(0, (up ? 'rgba(70,94,146,' : 'rgba(2,5,20,') + (0.05 + r() * 0.13) + ')');
      g.addColorStop(1, up ? 'rgba(70,94,146,0)' : 'rgba(2,5,20,0)');
      x.fillStyle = g; x.beginPath(); x.arc(bx, by, br, 0, 6.2832); x.fill();
    }
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(70, 70);
    t.anisotropy = 1;
    return t;
  }

  /* ===================================================== geometry utilities */

  function withSize(THREE, g, w, h) {
    var n = g.attributes.position.count, arr = new Float32Array(n * 2);
    for (var i = 0; i < n; i++) { arr[i * 2] = w; arr[i * 2 + 1] = h; }
    g.setAttribute('aSize', new THREE.BufferAttribute(arr, 2));
    return g;
  }

  function mergeGeos(THREE, geos) {
    if (!geos.length) return null;
    var list = geos.map(function (g) { return g.index ? g.toNonIndexed() : g; });
    var names = Object.keys(list[0].attributes);
    var total = 0;
    list.forEach(function (g) { total += g.attributes.position.count; });
    var out = new THREE.BufferGeometry();
    names.forEach(function (name) {
      var item = list[0].attributes[name].itemSize;
      var arr = new Float32Array(total * item), off = 0;
      list.forEach(function (g) {
        var a = g.attributes[name];
        if (a) { arr.set(a.array, off); off += a.array.length; }
        else { off += g.attributes.position.count * item; }
      });
      out.setAttribute(name, new THREE.BufferAttribute(arr, item));
    });
    for (var i = 0; i < list.length; i++) {
      if (list[i] !== geos[i]) list[i].dispose();
      geos[i].dispose();
    }
    out.computeBoundingSphere();
    return out;
  }

  /* plane spans local X (w) and Y (h), normal +Z */
  function plane(THREE, w, h, px, py, pz, rotY) {
    var g = new THREE.PlaneGeometry(w, h);
    if (rotY) g.rotateY(rotY);
    g.translate(px, py, pz);
    return g;
  }
  function boxAt(THREE, w, h, d, px, py, pz) {
    var g = new THREE.BoxGeometry(w, h, d);
    g.translate(px, py, pz);
    return g;
  }

  /* ================================================================ shaders */

  var SRGB_FN = 'vec3 sr(vec3 c){ return c*c; }\n';
  /* No sin(): this runs on every fragment of the sky, the glass and every lit
     surface, and the hash is indistinguishable as grain. */
  var HASH_FN = 'float h21(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056,0.00583715)))); }\n';

  var SKY_VS = [
    'varying vec3 vDir;',
    'void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
  ].join('\n');

  /* deep cobalt zenith -> a narrow bright horizon band -> dark land below. The
     bright band is what the glass reflects; keep it. */
  var SKY_FS = [
    'precision mediump float;',
    'uniform vec3 uSun; uniform vec2 uRes; uniform float uGrain;',
    SRGB_FN, HASH_FN,
    'varying vec3 vDir;',
    'void main(){',
    '  vec3 d = normalize(vDir);',
    '  float h = d.y;',
    '  vec3 zen = sr(vec3(0.075,0.132,0.315));',
    '  vec3 hzn = sr(vec3(0.470,0.585,0.735));',
    '  vec3 grd = sr(vec3(0.088,0.122,0.235));',
    '  vec3 c = mix(hzn, zen, smoothstep(0.005, 0.42, h));',
    '  c = mix(grd, c, smoothstep(-0.015, 0.008, h));',
    '  float sd = max(dot(d, uSun), 0.0);',
    '  c += sr(vec3(0.66,0.74,0.84)) * pow(sd, 7.0) * 0.60 * smoothstep(-0.02,0.06,h);',
    '  c += sr(vec3(1.0,0.96,0.86)) * pow(sd, 900.0) * 3.2;',
    '  vec2 sp = gl_FragCoord.xy / uRes;',
    '  c += (h21(gl_FragCoord.xy) - 0.5) * uGrain * 1.4;',
    '  vec2 vd = sp - 0.5; c *= 1.0 - smoothstep(0.1764, 1.21, dot(vd,vd)) * 0.46;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  /* Glass: fresnel + analytic sky reflection + a lit border edge.
     MeshPhysicalMaterial.transmission needs a second scene render per frame,
     which the mobile budget will not pay for; this fakes it in one pass. */
  var GLASS_VS = [
    'attribute vec2 aSize;',
    'varying vec3 vW; varying vec3 vN; varying vec2 vUv; varying vec2 vSz; varying float vLy;',
    'void main(){',
    '  vUv = uv; vSz = aSize; vLy = position.y;',
    '  vec4 wp = modelMatrix * vec4(position,1.0);',
    '  vW = wp.xyz;',
    '  vN = normalize(mat3(modelMatrix) * normal);',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  var GLASS_FS = [
    'precision mediump float;',
    'uniform vec3 uTint; uniform vec3 uEdge; uniform vec3 uAccent; uniform vec3 uSun;',
    'uniform float uActive; uniform float uDim; uniform float uTime; uniform float uPxW;',
    'uniform vec2 uRes; uniform float uGrain;',
    SRGB_FN, HASH_FN,
    'varying vec3 vW; varying vec3 vN; varying vec2 vUv; varying vec2 vSz; varying float vLy;',
    /* must track SKY_FS or the panes reflect a sky that is not there */
    'vec3 envCol(vec3 d){',
    '  float h = d.y;',
    '  vec3 zen = sr(vec3(0.075,0.132,0.315));',
    '  vec3 hzn = sr(vec3(0.470,0.585,0.735));',
    '  vec3 grd = sr(vec3(0.055,0.080,0.165));',
    '  vec3 c = mix(hzn, zen, smoothstep(0.005,0.42,h));',
    '  c = mix(grd, c, smoothstep(-0.05,0.03,h));',
    '  float sd = max(dot(d, uSun),0.0);',
    '  c += sr(vec3(1.0,0.97,0.88)) * pow(sd, 180.0) * 3.4;',
    '  c += sr(vec3(0.68,0.76,0.86)) * pow(sd, 6.0) * 0.42;',
    '  return c;',
    '}',
    'void main(){',
    '  vec3 N = normalize(vN);',
    '  vec3 V = normalize(cameraPosition - vW);',
    '  if (dot(N,V) < 0.0) N = -N;',
    '  float ndv = clamp(dot(N,V), 0.0, 1.0);',
    '  float fres = pow(1.0 - ndv, 2.3);',
    /* The panes are vertical and the camera sits high, so the true mirror ray
       points down at the dark tarmac and the glass vanishes. Bend the sample
       up into the bright horizon band: a cheat, and the whole reason glass
       reads as glass at this framing. */
    '  vec3 R = reflect(-V, N);',
    '  R.y = abs(R.y) * 0.30 + 0.075;',
    '  vec3 env = envCol(normalize(R));',
    '  float g = clamp(vLy / 3.0, 0.0, 1.0);',
    '  vec3 tint = mix(uTint * 1.50, uTint * 0.44, g);',
    '  vec3 col = tint + env * (1.15 + 1.70 * fres);',
    '  col += env * 0.42 * g * g;',
    '  float sw = sin((vW.x * 0.6 + vW.z * 0.35) - uTime * 0.30);',
    '  col += sr(vec3(0.84,0.90,1.0)) * 0.075 * pow(max(sw,0.0), 8.0);',
    /* Specular edge sized in SCREEN PIXELS: uPxW is world-units-per-pixel at
       unit depth, so `dpx` is the world size of one pixel here. A fixed world
       width is sub-pixel at the idle framing and simply disappears. */
    '  vec2 mn = min(vUv, 1.0 - vUv) * vSz;',
    '  float dEdge = min(mn.x, mn.y);',
    '  float dpx = length(cameraPosition - vW) * uPxW;',
    '  float ew = max(0.055, dpx * 2.7);',
    '  float e = 1.0 - smoothstep(0.0, ew, dEdge);',
    '  e = e * e * (3.0 - 2.0 * e);',
    '  float halo = 1.0 - smoothstep(0.0, max(0.24, dpx * 9.0), dEdge);',
    '  vec3 ec = mix(uEdge, uAccent, uActive);',
    '  col += ec * (e * (1.05 + 1.75 * uActive) + halo * halo * (0.20 + 0.55 * uActive));',
    '  float a = (0.26 + 0.64 * fres) + e * 1.05 + halo * halo * 0.18;',
    '  a *= mix(0.55, 1.0, uDim);',
    '  col *= uDim;',
    '  vec2 sp = gl_FragCoord.xy / uRes;',
    '  col += (h21(gl_FragCoord.xy) - 0.5) * uGrain;',
    '  vec2 vd = sp - 0.5; col *= 1.0 - smoothstep(0.1764, 1.21, dot(vd,vd)) * 0.46;',
    '  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));',
    '}'
  ].join('\n');

  /* Film treatment injected into every stock material, so grain + vignette are
     global without a second full-screen pass. Runs on every lit fragment in
     the frame: squared radius (no sqrt), hash instead of sin. */
  var FILM_SNIPPET = [
    '{',
    '  vec2 _sp = gl_FragCoord.xy / uRes - 0.5;',
    '  float _n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056,0.00583715))));',
    '  gl_FragColor.rgb += (_n - 0.5) * uGrain;',
    '  gl_FragColor.rgb *= 1.0 - smoothstep(0.1764, 1.21, dot(_sp,_sp)) * 0.46;',
    '}'
  ].join('\n');

  function applyFilm(mat, film) {
    mat.onBeforeCompile = function (shader) {
      shader.uniforms.uRes = film.uRes;
      shader.uniforms.uGrain = film.uGrain;
      shader.fragmentShader =
        'uniform vec2 uRes;\nuniform float uGrain;\n' +
        shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          '#include <dithering_fragment>\n' + FILM_SNIPPET
        );
    };
    mat.customProgramCacheKey = function () { return 'film1'; };
    return mat;
  }

  /* ============================================================ scene build */

  var COURT_L = 20, COURT_W = 10, GLASS_H = 3, FENCE_H = 4;

  /* ================================================================ street */
  /* The client identifies the courts by the street they sit on, so the street
     is drawn: the Bondgenotenlaan, along the north-west side of the site. The
     polyline is the OSM way from `venue.json → roads`, in the scene's metre
     frame — nothing here is placed by eye, and re-running tools/genvenue.py
     moves the road with the data.

     (An earlier build laid walkways BETWEEN the enclosures. That was a
     misreading of "the path" — it meant this street — and it is gone.) */

  /* Flat on the tarmac. The heights are cosmetic only: like the tarmac, the
     road is out of the depth buffer entirely and ordered by renderOrder, so it
     cannot fight anything for depth. See the deck-height note above. */
  var Y_ROAD = 0.04, Y_ROAD_MARK = 0.05, Y_ROAD_LABEL = 0.06;

  /* One step up from the rendered tarmac and no further — at night a road is
     a slightly paler band, not a light source. Deliberately not the accent
     green, which stays reserved for the active court. */
  var ROAD_COLOR = 0x1b2547, ROAD_MARK = 0x4c5c85;
  var DASH_STEP = 7.4, DASH_LEN = 2.6, DASH_W = 0.14, JOINT_SEGS = 8;

  var ROAD_LBL_W = 1024, ROAD_LBL_H = 168;   // texture
  var ROAD_LBL_M = 26;                       // world metres, long side

  function venueRoads(venue) {
    var list = (venue && venue.roads) || [];
    return list.filter(function (r) { return r && r.points && r.points.length > 1; });
  }

  /* Point + unit tangent at arc length `s` along a polyline. */
  function alongRoad(pts, s) {
    var acc = 0;
    for (var i = 0; i + 1 < pts.length; i++) {
      var a = pts[i], b = pts[i + 1];
      var dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
      if (L < 1e-6) continue;
      if (acc + L >= s || i + 2 === pts.length) {
        var t = clamp((s - acc) / L, 0, 1);
        return { x: a[0] + dx * t, z: a[1] + dz * t, tx: dx / L, tz: dz / L };
      }
      acc += L;
    }
    return null;
  }
  function roadLength(pts) {
    var L = 0;
    for (var i = 0; i + 1 < pts.length; i++) {
      L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    }
    return L;
  }
  /* Arc length of the point on the road closest to (cx,cz) — where the street
     runs past the courts, and so where its name belongs. */
  function roadAnchor(pts, cx, cz) {
    var acc = 0, best = 1e9, at = 0;
    for (var i = 0; i + 1 < pts.length; i++) {
      var a = pts[i], b = pts[i + 1];
      var dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
      var L = Math.sqrt(L2);
      if (L < 1e-6) continue;
      var t = clamp(((cx - a[0]) * dx + (cz - a[1]) * dz) / L2, 0, 1);
      var d = Math.hypot(a[0] + dx * t - cx, a[1] + dz * t - cz);
      if (d < best) { best = d; at = acc + t * L; }
      acc += L;
    }
    return at;
  }

  /* Centre of the courts, used to anchor the street name. */
  function courtsCentre(venue) {
    var cs = (venue && venue.courts) || [], sx = 0, sz = 0;
    if (!cs.length) return [0, 0];
    cs.forEach(function (c) { sx += c.center[0]; sz += c.center[1]; });
    return [sx / cs.length, sz / cs.length];
  }

  /* Where the name goes: in the GAP between the indoor and outdoor clusters —
     dead centre of the resting frame, on the one stretch of road nothing ever
     stands in front of, so the plate is whole and readable (client ask). With
     a single cluster (no indoor courts) there is no gap: fall back to sliding
     the plate along the road just past the courts' own footprint. */
  function roadLabelAt(venue, rd) {
    var pts = rd.points, total = roadLength(pts);
    var cs = (venue && venue.courts) || [];
    var xi = 0, zi = 0, ni = 0, xo = 0, zo = 0, no = 0;
    cs.forEach(function (c) {
      if (c.indoor) { xi += c.center[0]; zi += c.center[1]; ni++; }
      else { xo += c.center[0]; zo += c.center[1]; no++; }
    });
    var s;
    if (ni && no) {
      s = roadAnchor(pts, (xi / ni + xo / no) / 2, (zi / ni + zo / no) / 2);
    } else {
      var ctr = courtsCentre(venue);
      var s0 = roadAnchor(pts, ctr[0], ctr[1]);
      var p = alongRoad(pts, s0);
      if (!p) return s0;
      var dir = p.tx > 0 ? 1 : -1, past = 0;
      cs.forEach(function (c) {
        courtCorners(c).forEach(function (q) {
          var t = ((q[0] - p.x) * p.tx + (q[1] - p.z) * p.tz) * dir;
          if (t > past) past = t;
        });
      });
      s = s0 + dir * (past + 5.0 + ROAD_LBL_M / 2);
    }
    return clamp(s, ROAD_LBL_M / 2, Math.max(ROAD_LBL_M / 2, total - 1));
  }

  /* The ribbon: one quad per segment plus a small disc at every interior
     joint. Mitring five vertices would be exact and invisible — at 3.5 m wide
     and 20 m away the disc closes the wedge to the pixel. */
  function buildRoadRibbon(THREE, roads, film) {
    var pos = [];
    function tri(ax, az, bx, bz, cx, cz, y) {
      pos.push(ax, y, az, bx, y, bz, cx, y, cz);
    }
    roads.forEach(function (rd) {
      var w = (rd.width || 3.5) / 2, pts = rd.points, i;
      for (i = 0; i + 1 < pts.length; i++) {
        var a = pts[i], b = pts[i + 1];
        var dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
        if (L < 1e-6) continue;
        var nx = -dz / L * w, nz = dx / L * w;
        tri(a[0] + nx, a[1] + nz, a[0] - nx, a[1] - nz, b[0] - nx, b[1] - nz, Y_ROAD);
        tri(a[0] + nx, a[1] + nz, b[0] - nx, b[1] - nz, b[0] + nx, b[1] + nz, Y_ROAD);
      }
      for (i = 1; i + 1 < pts.length; i++) {
        for (var k = 0; k < JOINT_SEGS; k++) {
          var a0 = k / JOINT_SEGS * 6.2832, a1 = (k + 1) / JOINT_SEGS * 6.2832;
          tri(pts[i][0], pts[i][1],
            pts[i][0] + Math.cos(a0) * w, pts[i][1] + Math.sin(a0) * w,
            pts[i][0] + Math.cos(a1) * w, pts[i][1] + Math.sin(a1) * w, Y_ROAD);
        }
      }
    });
    if (!pos.length) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeBoundingSphere();
    /* Same contract as the tarmac it lies on: no depth at all, ordered by
       renderOrder. -8 puts it above the tarmac (-9) and below every court
       slab, so there is nothing for it to z-fight with. */
    var mesh = new THREE.Mesh(g, applyFilm(new THREE.MeshBasicMaterial({
      color: ROAD_COLOR, side: THREE.DoubleSide,
      depthWrite: false, depthTest: false
    }), film));
    mesh.renderOrder = -8;
    return mesh;
  }

  /* Centre-line dashes. Skipped where the name plate lies, so the two never
     print over one another. */
  function buildRoadMarks(THREE, roads, film, skip) {
    var pos = [];
    roads.forEach(function (rd, ri) {
      var pts = rd.points, total = roadLength(pts), s;
      var sk = skip && skip[ri];
      for (s = DASH_STEP; s < total - DASH_LEN; s += DASH_STEP) {
        if (sk != null && Math.abs(s - sk) < ROAD_LBL_M * 0.62) continue;
        var p = alongRoad(pts, s);
        if (!p) continue;
        var hx = p.tx * DASH_LEN / 2, hz = p.tz * DASH_LEN / 2;
        var nx = -p.tz * DASH_W / 2, nz = p.tx * DASH_W / 2;
        var x0 = p.x - hx, z0 = p.z - hz, x1 = p.x + hx, z1 = p.z + hz;
        pos.push(x0 + nx, Y_ROAD_MARK, z0 + nz, x0 - nx, Y_ROAD_MARK, z0 - nz,
          x1 - nx, Y_ROAD_MARK, z1 - nz);
        pos.push(x0 + nx, Y_ROAD_MARK, z0 + nz, x1 - nx, Y_ROAD_MARK, z1 - nz,
          x1 + nx, Y_ROAD_MARK, z1 + nz);
      }
    });
    if (!pos.length) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeBoundingSphere();
    var mesh = new THREE.Mesh(g, applyFilm(new THREE.MeshBasicMaterial({
      color: ROAD_MARK, side: THREE.DoubleSide,
      depthWrite: false, depthTest: false
    }), film));
    /* Opaque, not transparent: a transparent mark would be sorted into the
       pass that runs AFTER the courts and, with no depth test, would print
       over them. */
    mesh.renderOrder = -7;
    return mesh;
  }

  /* The street name, painted flat on the asphalt along the bearing of the
     road. Quieter and smaller than the BAAN plates — it names the place, it is
     not one of the three subjects. */
  function makeRoadLabelTexture(THREE, name) {
    var c = cv(ROAD_LBL_W, ROAD_LBL_H), x = c.getContext('2d');
    x.clearRect(0, 0, ROAD_LBL_W, ROAD_LBL_H);
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    if ('letterSpacing' in x) x.letterSpacing = '11px';
    x.font = '700 86px ' + FONT;
    var t = String(name || '').toUpperCase();
    /* dark halo so the name survives crossing off the asphalt onto tarmac */
    x.lineWidth = 13;
    x.lineJoin = 'round';
    x.strokeStyle = 'rgba(6,11,30,0.80)';
    x.strokeText(t, ROAD_LBL_W / 2, ROAD_LBL_H / 2 + 3);
    x.fillStyle = '#B9CBE6';
    x.fillText(t, ROAD_LBL_W / 2, ROAD_LBL_H / 2 + 3);
    if ('letterSpacing' in x) x.letterSpacing = '0px';
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  function buildRoadLabel(THREE, rd, s) {
    var p = alongRoad(rd.points, s);
    if (!p) return null;
    /* Read the road in whichever direction runs left-to-right for the resting
       camera, which sits to the south-west: +x is screen-right there. */
    var tx = p.tx, tz = p.tz;
    if (tx < 0) { tx = -tx; tz = -tz; }
    var h = ROAD_LBL_M * (ROAD_LBL_H / ROAD_LBL_W);
    var g = new THREE.PlaneGeometry(ROAD_LBL_M, h);
    g.rotateX(-Math.PI / 2);
    /* local +x -> (tx,tz): rotation about +y by atan2(-tz,tx) */
    g.rotateY(Math.atan2(-tz, tx));
    g.translate(p.x, Y_ROAD_LABEL, p.z);
    var mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      map: makeRoadLabelTexture(THREE, rd.name),
      transparent: true, opacity: 0.82, depthWrite: false, fog: false
    }));
    /* Transparent, so it is drawn after the courts — but it keeps the depth
       TEST, which is what hides it behind any enclosure standing in front of
       it. Nothing writes depth at road height, so it never fights the ribbon. */
    mesh.renderOrder = 4;
    return mesh;
  }

  function buildRoads(THREE, venue, film) {
    var roads = venueRoads(venue);
    if (!roads.length) return null;
    var G = new THREE.Group();
    G.name = 'roads';
    var anchors = roads.map(function (rd) { return roadLabelAt(venue, rd); });
    var ribbon = buildRoadRibbon(THREE, roads, film);
    if (ribbon) G.add(ribbon);
    var marks = buildRoadMarks(THREE, roads, film, anchors);
    if (marks) G.add(marks);
    roads.forEach(function (rd, i) {
      if (!rd.name) return;
      var lb = buildRoadLabel(THREE, rd, anchors[i]);
      if (lb) G.add(lb);
    });
    return G;
  }

  function buildCourtGroup(THREE, def, idx, shared) {
    var G = new THREE.Group();
    G.name = def.id;
    var hw = COURT_W / 2, hl = COURT_L / 2;

    /* Contact shadow on the tarmac, pushed away from the sun. The group is
       rotated by -yaw, so the world-space sun offset comes back into local
       space through R_y(+yaw). */
    var cs = new THREE.Mesh(
      plane(THREE, COURT_L + 13, COURT_W + 10, 0, 0, 0).rotateX(-Math.PI / 2),
      shared.contactMat
    );
    var ox = -shared.sunXZ.x * 2.8, oz = -shared.sunXZ.y * 2.8;
    var cy = Math.cos(def.yaw), sy = Math.sin(def.yaw);
    cs.position.set(ox * cy + oz * sy, Y_CONTACT, -ox * sy + oz * cy);
    cs.renderOrder = 1;
    G.add(cs);

    /* Apron slab. Deliberately does not sample the shadow map: it is a dark
       border strip where a post shadow would be invisible anyway. */
    var apron = new THREE.Mesh(
      plane(THREE, COURT_L + 2.4, COURT_W + 2.4, 0, 0, 0).rotateX(-Math.PI / 2),
      shared.apronMat
    );
    apron.position.y = Y_APRON;
    apron.receiveShadow = false;
    G.add(apron);

    /* playing surface */
    var surf = new THREE.Mesh(
      plane(THREE, COURT_L, COURT_W, 0, 0, 0).rotateX(-Math.PI / 2),
      shared.courtMats[idx]
    );
    surf.position.y = Y_SURFACE;
    surf.receiveShadow = true;
    G.add(surf);

    /* accent ring */
    var ring = new THREE.Mesh(
      plane(THREE, 27, 17, 0, 0, 0).rotateX(-Math.PI / 2),
      shared.ringMats[idx]
    );
    ring.position.y = Y_RING;
    ring.renderOrder = 2;
    G.add(ring);

    /* glass panes: 2 back walls + 4 corner returns */
    var gg = [];
    gg.push(withSize(THREE, plane(THREE, COURT_W, GLASS_H, -hl, GLASS_H / 2, 0, Math.PI / 2), COURT_W, GLASS_H));
    gg.push(withSize(THREE, plane(THREE, COURT_W, GLASS_H, hl, GLASS_H / 2, 0, Math.PI / 2), COURT_W, GLASS_H));
    [-1, 1].forEach(function (sx) {
      [-1, 1].forEach(function (sz) {
        gg.push(withSize(THREE, plane(THREE, 4, GLASS_H, sx * 8, GLASS_H / 2, sz * hw), 4, GLASS_H));
      });
    });
    var glass = new THREE.Mesh(mergeGeos(THREE, gg), shared.glassMats[idx]);
    glass.renderOrder = 6;
    G.add(glass);

    /* No mesh fencing and no floodlight masts. Both read as scaffolding at
       this framing and the fencing cost real fill rate for a grey haze; the
       glass, the posts and the top rail carry the enclosure. */
    var sg = [];
    var postXZ = [
      [-hl, -hw], [-hl, 0], [-hl, hw], [hl, -hw], [hl, 0], [hl, hw],
      [-6, -hw], [-6, hw], [6, -hw], [6, hw]
    ];
    postXZ.forEach(function (p) {
      sg.push(boxAt(THREE, 0.052, FENCE_H, 0.052, p[0], FENCE_H / 2, p[1]));
    });
    /* Top rail only — a mid course sat on the glass head and doubled every
       horizontal; the pane's own specular edge draws that line in light. */
    sg.push(boxAt(THREE, COURT_L + 0.1, 0.05, 0.055, 0, FENCE_H, -hw));
    sg.push(boxAt(THREE, COURT_L + 0.1, 0.05, 0.055, 0, FENCE_H, hw));
    sg.push(boxAt(THREE, 0.055, 0.05, COURT_W, -hl, FENCE_H, 0));
    sg.push(boxAt(THREE, 0.055, 0.05, COURT_W, hl, FENCE_H, 0));
    /* kerb — tall enough to contain the raised deck */
    sg.push(boxAt(THREE, COURT_L + 0.2, KERB_H, 0.10, 0, KERB_H / 2, -hw));
    sg.push(boxAt(THREE, COURT_L + 0.2, KERB_H, 0.10, 0, KERB_H / 2, hw));
    sg.push(boxAt(THREE, 0.10, KERB_H, COURT_W, -hl, KERB_H / 2, 0));
    sg.push(boxAt(THREE, 0.10, KERB_H, COURT_W, hl, KERB_H / 2, 0));
    sg.push(boxAt(THREE, 0.075, 0.95, 0.075, 0, Y_SURFACE + 0.475, -hw - 0.06));
    sg.push(boxAt(THREE, 0.075, 0.95, 0.075, 0, Y_SURFACE + 0.475, hw + 0.06));
    var steel = new THREE.Mesh(mergeGeos(THREE, sg), shared.steelMat);
    /* The frame casts nothing. A 52 mm post is ~1.5 shadow-map texels wide, so
       a hard single-tap lookup returns a dotted stair-stepped line metres long
       — which reads as scratches in the paint. The net is the one caster whose
       shadow the map can resolve. */
    steel.castShadow = false;
    G.add(steel);

    var net = new THREE.Mesh(
      plane(THREE, COURT_W, 0.92, 0, Y_SURFACE + 0.46, 0, Math.PI / 2), shared.netMat);
    net.castShadow = true;
    net.renderOrder = 5;
    G.add(net);

    /* tennis balls + long hard-sun shadows (poster signature) */
    var r = rng(2200 + idx * 613);
    var balls = [], shadows = [];
    var sunXZ = shared.sunXZ, len = shared.ballShadowLen;
    var sunAngle = Math.atan2(sunXZ.y, sunXZ.x);
    for (var b = 0; b < 6; b++) {
      var bx = (r() - 0.5) * 17, bz = (r() - 0.5) * 8.2;
      var bg = new THREE.SphereGeometry(0.075, 8, 6);
      bg.translate(bx, Y_SURFACE + 0.075, bz);
      balls.push(bg);
      var sq = new THREE.PlaneGeometry(len, 0.26);
      sq.rotateX(-Math.PI / 2);
      sq.rotateY(sunAngle);
      sq.translate(bx - sunXZ.x * len * 0.40, Y_BALLSHADOW, bz - sunXZ.y * len * 0.40);
      shadows.push(sq);
    }
    G.add(new THREE.Mesh(mergeGeos(THREE, balls), shared.ballMat));
    var bs = new THREE.Mesh(mergeGeos(THREE, shadows), shared.ballShadowMat);
    bs.renderOrder = 3;
    G.add(bs);

    G.position.set(def.center[0], 0, def.center[1]);
    G.rotation.y = -def.yaw;
    return G;
  }

  /* `venue.json` also carries the neighbouring tennis courts and the clubhouse.
     The client asked for them out (BRIEF §0) — deleted, not hidden, and not a
     toggle. The data stays because it is the OSM record of the site. */

  /* ================================================================== halls
     Baan 4 and Baan 5 are INDOORS, in the hall across Bondgenotenlaan. Nothing
     else on this site is built (see the note above) and this is not that
     decision reopening: without SOME marker those two courts read as standing
     in a field, which is worse than wrong — it is confusing.

     The marker is a flat floor slab in the building's footprint, NOT walls.
     Walls were tried, open-topped with the far side culled, and the client
     killed them for two reasons that are really one reason: an 8 m wall
     in front of a 10 m-deep bay hides most of the near court at any sane
     elevation, and one-side-culled walls read as "transparent from the inside"
     the moment the camera crosses them in a fly-in. A pale slab under the pair
     says "different ground, one building" without ever standing between the
     camera and a court, and it frees the indoor fly-in to use the same low
     dropped eye as the outdoor courts. */

  var HALL_FLOOR = 0x5b6785;

  /* The resting vantage, FIXED by the client (2026-08-05 evening): from the
     south, square to Bondgenotenlaan, so the street runs level across the frame
     behind the site. Derived, not tuned: the road's chord past the site runs
     (31.4,-26.8) → (-111.1,16.2), its south-pointing normal is (0.289, 0.957),
     and the camera sits along (sin az, cos az) — az = atan2(0.289, 0.957).
     An aspect-driven azimuth solver used to live here; it filled the panel
     better but pointed wherever it liked, and the client chose the view. */
  var REST_AZ = 0.293;

  function hallList(venue) {
    return ((venue && venue.halls) || []).filter(function (h) {
      return h && h.points && h.points.length > 2;
    });
  }

  /* Signed area tells us the winding the data happens to have; the shell is
     emitted with a known one so BackSide means "far wall" and not "near wall".
     venue.json is generated, but it is generated from a polygon whose direction
     is nobody's contract. */
  function ringOf(h) {
    var p = h.points.slice();
    if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p.pop();
    var a = 0;
    for (var i = 0; i < p.length; i++) {
      var q = p[(i + 1) % p.length];
      a += p[i][0] * q[1] - q[0] * p[i][1];
    }
    return a < 0 ? p.reverse() : p;
  }

  function buildHalls(THREE, venue, film) {
    var halls = hallList(venue);
    if (!halls.length) return null;

    var G = new THREE.Group();
    halls.forEach(function (h) {
      var ring = ringOf(h);
      var shape = new THREE.Shape(ring.map(function (p) {
        return new THREE.Vector2(p[0], p[1]);
      }));
      var g = new THREE.ShapeGeometry(shape);
      /* Shape lives in xy; lay it flat so shape-y becomes world z. */
      g.rotateX(Math.PI / 2);
      g.computeBoundingSphere();
      /* Same contract as the road it sits beside: unlit, no depth, ordered.
         -8 puts it above the tarmac (-9) and below every court slab, and the
         two never overlap the road ribbon in plan, so nothing can z-fight. */
      var mesh = new THREE.Mesh(g, applyFilm(new THREE.MeshBasicMaterial({
        color: HALL_FLOOR, side: THREE.DoubleSide,
        depthWrite: false, depthTest: false
      }), film));
      mesh.position.y = Y_ROAD;
      mesh.renderOrder = -8;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      G.add(mesh);
    });
    return G;
  }

  /* ================================================================= labels */

  function roundRect(x, a, b, w, h, r) {
    x.beginPath();
    x.moveTo(a + r, b);
    x.arcTo(a + w, b, a + w, b + h, r);
    x.arcTo(a + w, b + h, a, b + h, r);
    x.arcTo(a, b + h, a, b, r);
    x.arcTo(a, b, a + w, b, r);
    x.closePath();
  }

  var LBL_W = 720, LBL_H = 310;
  /* The card's width in METRES, used when the framing is wide enough that a
     fixed pixel size would swamp the courts. A shade over one court's length, so
     a resting card reads as belonging to the court under it. */
  var LBL_M = 26;
  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

  /* ------------------------------------------------------------ Dutch copy */
  /* The site is Dutch and the schedule beside this canvas reads BAAN 1/2/3.
     Those names live in `courts.json` and they are NOT the venue court
     numbers: the client renamed the courts, so court-3 is Baan 2 and the
     perpendicular show court, court-2, is Baan 3. The caller passes that map
     in as `opts.courtNames` ({id: name}) and it wins over everything.

     Without it we fall back to the number in `venue.json` — that file is the
     OSM record and is not ours to rename. */
  function courtLabel(def, names) {
    var id = def && def.id;
    if (names && id && names[id]) return String(names[id]).toUpperCase();
    var n = /(\d+)/.exec(String(def.name || id || ''));
    return n ? 'BAAN ' + n[1] : String(def.name || id || '').toUpperCase();
  }

  /* Round names arrive from `schedule.json` in English. Translate from the
     language-neutral `round` code and borrow only the group LETTER from the
     label; an unrecognised code prints nothing rather than English. */
  var ROUND_NL = { group: 'Poule', qf: 'Knock-out', sf: 'Halve finale', final: 'Finale' };
  function roundNL(md) {
    var base = ROUND_NL[md.round];
    if (!base) return '';
    if (md.round !== 'group') return base;
    var g = /([A-Za-z])\s*$/.exec(String(md.roundLabel || ''));
    return g ? base + ' ' + g[1].toUpperCase() : base;
  }

  function drawLabel(canvas, def, match, active, names) {
    var x = canvas.getContext('2d');
    x.clearRect(0, 0, LBL_W, LBL_H);
    var sp = ('letterSpacing' in x);

    var title = courtLabel(def, names);

    /* Resting state: the court name and nothing else, big enough to read on a
       390 px phone without zooming. */
    if (!active) {
      x.textBaseline = 'middle';
      x.textAlign = 'center';
      if (sp) x.letterSpacing = '5px';
      x.font = '700 54px ' + FONT;
      /* pill sized to the word, so it reads as a label and not as a button */
      var w = clamp(Math.ceil(x.measureText(title).width) + 116, 300, LBL_W - 40);
      var h = 122, ax = (LBL_W - w) / 2, ay = (LBL_H - h) / 2;
      roundRect(x, ax, ay, w, h, 61);
      x.fillStyle = 'rgba(8,15,40,0.86)'; x.fill();
      x.strokeStyle = 'rgba(196,218,244,0.52)'; x.lineWidth = 3; x.stroke();
      x.fillStyle = '#EDF3FA';
      x.fillText(title, LBL_W / 2 + 2, LBL_H / 2 + 2);
      if (sp) x.letterSpacing = '0px';
      x.textAlign = 'left';
      return;
    }

    /* Active state: the court and the tie currently on it. */
    roundRect(x, 6, 6, LBL_W - 12, LBL_H - 12, 36);
    x.fillStyle = 'rgba(8,15,40,0.92)'; x.fill();
    x.strokeStyle = 'rgba(198,220,99,0.85)'; x.lineWidth = 4; x.stroke();

    x.fillStyle = '#C6DC63';
    roundRect(x, 34, 42, 8, LBL_H - 84, 4); x.fill();

    x.textBaseline = 'alphabetic';
    if (sp) x.letterSpacing = '4px';
    x.font = '700 52px ' + FONT;
    x.fillStyle = '#F5F9FD';
    x.fillText(title, 68, 104);
    if (sp) x.letterSpacing = '0px';

    x.strokeStyle = 'rgba(180,205,235,0.28)'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(68, 140); x.lineTo(LBL_W - 44, 140); x.stroke();

    if (match) {
      var cx = 68;
      if (match.time) {
        x.font = '700 32px ' + FONT;
        x.fillStyle = '#C6DC63';
        x.fillText(match.time, cx, 192);
        cx += x.measureText(match.time).width + 28;
      }
      if (match.round) {
        x.font = '500 30px ' + FONT;
        x.fillStyle = 'rgba(206,222,242,0.78)';
        x.fillText(match.round, cx, 192);
      }
      x.font = '700 33px ' + FONT;
      x.fillStyle = '#EFF5FC';
      var a = match.a || '', b = match.b || '';
      if (a) x.fillText(a.length > 28 ? a.slice(0, 27) + '…' : a, 68, 240);
      if (b) {
        x.fillStyle = 'rgba(206,222,242,0.72)';
        x.font = '500 29px ' + FONT;
        /* `vs`, not `tegen`: the timetable beside this canvas prints the same
           tie with `vs`, and the two must not disagree. */
        x.fillText('vs  ' + (b.length > 25 ? b.slice(0, 24) + '…' : b), 68, 278);
      }
    } else {
      x.font = '500 31px ' + FONT;
      x.fillStyle = 'rgba(188,210,238,0.62)';
      x.fillText('Nog geen wedstrijd', 68, 202);
    }
  }

  function normaliseMatch(md, teams) {
    if (!md) return null;
    function label(t) {
      if (t == null) return '';
      if (typeof t === 'string') {
        if (teams) {
          for (var i = 0; i < teams.length; i++) {
            if (teams[i].id !== t) continue;
            return (teams[i].players || []).join(' & ') ||
              teams[i].label || teams[i].name || teams[i].id;
          }
        }
        return t;
      }
      if (t.players && t.players.length) return t.players.join(' & ');
      return t.name || t.label || t.id || '';
    }
    var list = md.teams || md.sides || [];
    var time = md.time || (md.start ? (md.end ? md.start + '–' + md.end : md.start) : '');
    return {
      time: time,
      round: roundNL(md),
      a: md.teamA != null ? label(md.teamA) : label(list[0]),
      b: md.teamB != null ? label(md.teamB) : label(list[1])
    };
  }

  /* =============================================================== fallback */

  /* Corners of the 20x10 playing area; `pad` inflates all four sides — pass
     the apron overhang (1.2 m) when the shot must CONTAIN the court rather
     than crop into it, because the built group is wider than the court. */
  function courtCorners(c, pad) {
    var hl = 10 + (pad || 0), hw = 5 + (pad || 0);
    var d = [Math.cos(c.yaw), Math.sin(c.yaw)], p = [-d[1], d[0]], out = [];
    [[1, 1], [1, -1], [-1, -1], [-1, 1]].forEach(function (s) {
      out.push([
        c.center[0] + d[0] * hl * s[0] + p[0] * hw * s[1],
        c.center[1] + d[1] * hl * s[0] + p[1] * hw * s[1]
      ]);
    });
    return out;
  }



  /* ================================================================ engine  */

  var app = null;

  function Engine(canvas, opts) {
    var self = this;
    this.canvas = canvas;
    this.venue = (opts && opts.venue) || FALLBACK_VENUE;
    if (!this.venue.courts || !this.venue.courts.length) this.venue = FALLBACK_VENUE;
    this.teams = (opts && opts.teams) || null;
    /* { 'court-1': 'Baan 1', … } straight out of courts.json — the display
       names the schedule beside this canvas prints. See courtLabel(). */
    this.courtNames = (opts && opts.courtNames) || null;

    this.destroyed = false;
    this.ready = false;
    this.running = false;
    this.visible = false;
    this.paused = false;
    this.contextLost = false;
    this.docHidden = document.hidden === true;
    this.activeId = null;
    this.matches = {};
    this.pendingActive = undefined;
    this.w = 0; this.h = 0;
    this.rafId = 0; this.lastT = 0; this.time = 0; this.lastDraw = 0;
    this.dirty = true;
    this.painted = false;   // has one complete, correctly framed frame landed
    this.moving = false;    // is anything actually in transition right now
    this.anyActive = 0;
    /* Fixed for the life of the page: opts.dpr, then ?dpr=, then the display. */
    this.dprPin = (opts && +opts.dpr > 0) ? clamp(+opts.dpr, 0.25, 4) : dprOverride();
    this.dpr = this.dprPin || Math.min(window.devicePixelRatio || 1, 2);
    this._onFrame = this._frame.bind(this);

    /* `still` rides the reduced-motion path: no idle drift, redraw only when
       something actually changed. */
    this.still = (opts && opts.still) || stillMode();
    this.reduceMQ = mm('(prefers-reduced-motion: reduce)');
    this.reduce = !!(this.reduceMQ && this.reduceMQ.matches) || this.still;
    this._onReduce = function () {
      self.reduce = !!(self.reduceMQ && self.reduceMQ.matches) || self.still;
      self.dirty = true;
    };
    if (this.reduceMQ) {
      if (this.reduceMQ.addEventListener) this.reduceMQ.addEventListener('change', this._onReduce);
      else if (this.reduceMQ.addListener) this.reduceMQ.addListener(this._onReduce);
    }

    canvas.classList.add('c3d-canvas');

    this._io = ('IntersectionObserver' in window)
      ? new IntersectionObserver(function (entries) {
        self.visible = entries[entries.length - 1].isIntersecting;
        self._sync();
      }, { threshold: 0.01 })
      : null;
    if (this._io) this._io.observe(canvas); else this.visible = true;

    this._ro = ('ResizeObserver' in window)
      ? new ResizeObserver(function () { self._resize(); })
      : null;
    if (this._ro) this._ro.observe(canvas);

    this._onWinResize = function () { self._resize(); };
    window.addEventListener('resize', this._onWinResize, { passive: true });

    this._onVis = function () { self.docHidden = document.hidden === true; self._sync(); };
    document.addEventListener('visibilitychange', this._onVis);

    this._onLost = function (ev) { ev.preventDefault(); self.contextLost = true; self._stop(); };
    this._onRestored = function () {
      self.contextLost = false;
      if (self.renderer) {
        try { self.renderer.resetState(); } catch (e) {}
        self.renderer.shadowMap.needsUpdate = true;
      }
      self.dirty = true;
      self._sync();
    };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);

    var loadThree = function (attempt) {
      import(THREE_URL).then(function (THREE) {
        if (self.destroyed) return;
        self._init(THREE);
      })['catch'](function (err) {
        if (attempt < 2) { setTimeout(function () { loadThree(attempt + 1); }, 800); return; }
        if (window.console) console.warn('[Courts3D] three.js failed to load:', err);
        self._unavailable();
      });
    };
    loadThree(0);
  }

  /* No SVG plan any more (client: the real scene is the only mode). This runs
     only if WebGL genuinely cannot start after retries — vanishingly rare on
     anything modern — and simply hides the dead canvas instead of faking a map. */
  Engine.prototype._unavailable = function () {
    if (this.destroyed) return;
    this.canvas.classList.add('is-unavailable');
    if (window.console) console.warn('[Courts3D] WebGL unavailable; 3D panel hidden.');
    this.ready = true;
  };

  Engine.prototype._init = function (THREE) {
    var self = this;
    this.THREE = THREE;

    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        /* MSAA is the most expensive thing in the pipeline and buys almost
           nothing once the drawing buffer is ≥1.6x the CSS size — the
           downsample is the antialiasing. Keep it only for 1x displays. */
        antialias: this.dpr < 1.6,
        alpha: false,
        stencil: false,
        depth: true,
        preserveDrawingBuffer: this.still,   // capture mode only
        powerPreference: 'high-performance'
      });
    } catch (e) {
      if (!this._rendererRetried) {
        this._rendererRetried = true;
        setTimeout(function () { if (!self.destroyed) self._init(THREE); }, 800);
      } else {
        this._unavailable();
      }
      return;
    }
    this.renderer = renderer;
    renderer.setPixelRatio(this.dpr);
    renderer.setSize(2, 2, false);
    renderer.setClearColor(0x111d40, 1);
    renderer.shadowMap.enabled = true;
    /* One hard tap instead of PCF's 3x3: a low sun on hard acrylic throws hard
       shadows anyway, so this is cheaper AND closer to the poster. */
    renderer.shadowMap.type = THREE.BasicShadowMap;
    /* Rendered once. The only caster is the net, and it lifts together with
       the surface it falls on, so a court lift does not move its shadow by one
       pixel — re-rendering the map per frame during a fly-in cost real time
       and changed nothing. */
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;

    var scene = new THREE.Scene();
    this.scene = scene;
    /* Pushed out past the courts: haze over a ~60 m site washed ground, courts
       and steel into one mid-blue band. It only softens the far tarmac now.

       ⚠ Scaled to the site, not typed. The two indoor courts put the far corner
       ~150 m from the near one, so the wide shot sits far enough back that the
       old fixed 190 m near plane started INSIDE the site and fogged Baan 4 and
       5 into the background. The numbers below are the old 190/780 expressed as
       multiples of the bounding radius the three outdoor courts had (~26 m), so
       the outdoor-only framing is unchanged to the metre.

       The far plane is capped under the camera's own far plane (1100 m): the
       tarmac is a 4000 m quad, so the fog has to have finished washing it out
       BEFORE the clip, or the wide shot shows the edge of the world. */
    var sb = this._bounds();
    scene.fog = new THREE.Fog(0x1c2c55, sb.r * 7.88, Math.min(sb.r * 32.35, 1000));

    var film = this.film = {
      uRes: { value: new THREE.Vector2(2, 2) },
      uGrain: { value: 0.072 },
      uPxW: { value: 0.001 }
    };

    /* --- one strong, low sun ------------------------------------------- */
    /* The sun rides the resting vantage: it was composed at 2.30 against the
       old -0.62 rest azimuth — 2.92 rad around from the camera, low and almost
       opposite, so the courts rim-light and the net shadows fall toward the
       viewer. When the rest view became the fixed south vantage (REST_AZ) the
       sun kept that same 2.92 offset; a sun left at 2.30 lit the new shot flat
       from the side. */
    var sunAz = REST_AZ + 2.92, sunEl = 0.62;
    var sunDir = new THREE.Vector3(
      Math.cos(sunEl) * Math.sin(sunAz),
      Math.sin(sunEl),
      Math.cos(sunEl) * Math.cos(sunAz)
    ).normalize();
    this.sunDir = sunDir;

    var key = new THREE.DirectionalLight(0xfff4e4, 16.5);
    key.position.copy(sunDir).multiplyScalar(130);
    key.target.position.set(1.6, 0, 1.3);
    scene.add(key.target);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    var sc = key.shadow.camera;
    /* Tight on the OUTDOOR courts: they fit inside a 23 m radius of the light
       target, +6 m for the longest thing the low sun throws. 2048 texels over
       64 m is 3.1 cm each.

       Deliberately NOT widened to take in Baan 4 and 5. Stretching this box
       over the whole 160 m site would put 2048 texels across 200 m — 10 cm each,
       four times coarser, and the net shadows on the outdoor courts (the only
       shadows in the scene, and the ones actually in shot) would go to mush. The
       indoor pair is under a roof in real life; casting sun onto it would be the
       wrong picture anyway. buildHalls takes the hall out of the rig too. */
    sc.left = -32; sc.right = 32; sc.top = 32; sc.bottom = -32;
    sc.near = 50; sc.far = 260;
    sc.updateProjectionMatrix();
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.03;
    scene.add(key);

    scene.add(new THREE.HemisphereLight(0x87abda, 0x080e26, 1.15));
    var fill = new THREE.DirectionalLight(0x6a8ec4, 0.42);
    fill.position.set(-sunDir.x * 60, 42, -sunDir.z * 60);
    scene.add(fill);

    /* --- sky ------------------------------------------------------------ */
    var skyMat = new THREE.ShaderMaterial({
      uniforms: { uSun: { value: sunDir }, uRes: film.uRes, uGrain: film.uGrain },
      vertexShader: SKY_VS,
      fragmentShader: SKY_FS,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });
    var sky = new THREE.Mesh(new THREE.SphereGeometry(600, 20, 12), skyMat);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    scene.add(sky);

    /* --- ground ---------------------------------------------------------- */
    /* Unlit on purpose: a flat plane with a constant normal and no shadow map
       resolves to albedo x a constant under this rig, so per-fragment lighting
       over the largest surface in the frame buys nothing.

       ⚠ Out of the depth buffer entirely, and drawn first. Nothing in the
       scene is ever below the tarmac, so it never has to occlude anything —
       and as a single 4000 m quad its interpolated depth is too coarse to sit
       under near-coplanar slabs without flickering. See the deck constants. */
    var ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      applyFilm(new THREE.MeshBasicMaterial({
        map: makeGroundTexture(THREE), color: GROUND_TINT,
        depthWrite: false, depthTest: false
      }), film)
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = false;
    ground.renderOrder = -9;
    scene.add(ground);

    /* --- the street ------------------------------------------------------ */
    /* Laid straight after the tarmac and before anything a court owns. */
    var roads = buildRoads(THREE, this.venue, film);
    if (roads) scene.add(roads);

    /* --- the indoor hall -------------------------------------------------- */
    /* After the road, before the courts: the two courts it contains have to
       draw over their own floor, and the shell is opaque. */
    var halls = buildHalls(THREE, this.venue, film);
    if (halls) scene.add(halls);

    /* --- shared materials ------------------------------------------------ */
    var sunXZ = new THREE.Vector2(sunDir.x, sunDir.z).normalize();
    var ballShadowLen = clamp(0.150 / Math.tan(sunEl), 0.18, 0.7);

    /* One surface texture for all five courts; Court 3's deeper shade is a
       material tint. The stored base colour survives the active/dim animation. */
    var courtTex = makeCourtTexture(THREE);
    var courtMats = this.venue.courts.map(function (c) {
      var m = applyFilm(new THREE.MeshLambertMaterial({
        map: courtTex, color: 0xffffff
      }), film);
      /* Indoors is a cooler, flatter light than a low September sun, and the two
         courts inside the hall would otherwise be the brightest things in the
         frame while sitting in a shell that casts no light. */
      m.userData.base = new THREE.Color(
        c.indoor ? 0x9fb0cf : c.surface === 'green' ? 0xc4d0e8 : 0xffffff);
      return m;
    });
    var glassMats = this.venue.courts.map(function () {
      return new THREE.ShaderMaterial({
        uniforms: {
          uTint: { value: new THREE.Color(0x2b4f8c) },
          uEdge: { value: new THREE.Color(0xcfe2f8) },
          uAccent: { value: new THREE.Color(P.ball) },
          uSun: { value: sunDir },
          uActive: { value: 0 },
          uDim: { value: 1 },
          uTime: { value: 0 },
          uRes: film.uRes,
          uGrain: film.uGrain,
          uPxW: film.uPxW
        },
        vertexShader: GLASS_VS,
        fragmentShader: GLASS_FS,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false
      });
    });
    var ringTex = makeRingTexture(THREE);
    var ringMats = this.venue.courts.map(function () {
      return new THREE.MeshBasicMaterial({
        map: ringTex, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false
      });
    });

    var apronTex = makeApronTexture(THREE);
    apronTex.repeat.set(7, 3.5);

    var shared = {
      contactMat: new THREE.MeshBasicMaterial({
        map: makeContactTexture(THREE), transparent: true, opacity: 0.78,
        depthWrite: false, color: 0x02060f, fog: false
      }),
      apronMat: applyFilm(new THREE.MeshLambertMaterial({ map: apronTex, color: 0xffffff }), film),
      courtMats: courtMats,
      glassMats: glassMats,
      ringMats: ringMats,
      steelMat: applyFilm(new THREE.MeshLambertMaterial({ color: 0x1a2a54 }), film),
      netMat: applyFilm(new THREE.MeshLambertMaterial({
        map: makeNetTexture(THREE), color: 0x9fb6da,
        transparent: true, depthWrite: false, side: THREE.DoubleSide
      }), film),
      ballMat: applyFilm(new THREE.MeshLambertMaterial({ color: 0xc6dc63 }), film),
      ballShadowMat: new THREE.MeshBasicMaterial({
        map: makeBlobTexture(THREE), transparent: true, opacity: 0.55,
        depthWrite: false, color: 0x081027, fog: false
      }),
      sunXZ: sunXZ,
      ballShadowLen: ballShadowLen
    };
    this.courtMats = courtMats;
    this.glassMats = glassMats;
    this.ringMats = ringMats;

    /* --- courts ---------------------------------------------------------- */
    this.courtGroups = [];
    this.courtState = [];
    this.venue.courts.forEach(function (def, i) {
      var g = buildCourtGroup(THREE, def, i, shared);
      scene.add(g);
      self.courtGroups.push(g);
      self.courtState.push({ def: def, a: 0, target: 0,
        az: wrapPi(Math.atan2(Math.cos(def.yaw), Math.sin(def.yaw)) + 0.9) });
    });
    /* The indoor bays share one hall and sit 10.9 m apart, so the fly-in has to
       pick which SIDE of the hall to stand on: approached from its own side the
       active bay lands foreshortened at the bottom edge while its dimmed
       neighbour fills the middle of the frame — the shot reads as being about
       the wrong court. So an indoor fly-in stands across the sibling bay: the
       dim one becomes the foreground and the lit subject holds the centre.
       Outdoor courts have no sibling in the shot and keep the one composed
       azimuth. */
    this.courtState.forEach(function (st) {
      if (!st.def.indoor) return;
      var sib = null;
      self.courtState.forEach(function (o) {
        if (o.def.indoor && o.def.id !== st.def.id) sib = o.def;
      });
      if (!sib) return;
      var dx = st.def.center[0] - sib.center[0];
      var dz = st.def.center[1] - sib.center[1];
      if (Math.sin(st.az) * dx + Math.cos(st.az) * dz > 0) st.az = wrapPi(st.az + Math.PI);
    });

    /* --- labels -----------------------------------------------------------
       Each card gets its OWN resting height, stepped in the order the courts are
       listed. The courts are 10–15 m apart and a resting card is wider than that
       once the whole site is in frame, so at one common height the three outdoor
       cards printed on top of each other and so did the indoor pair. Stepping
       them separates the cards vertically on screen, without moving a card off
       the court it names.

       The indoor pair steps DOWN the listed order, not up: from the fixed south
       vantage Baan 4 is the far bay, and a farther base already projects higher
       on screen — giving the near bay the taller lift walked the two cards back
       into each other. The step order encodes the view; if REST_AZ ever crosses
       the road to the north side, flip it with it. */
    var lifts = {};
    var nOut = 0, nIn = 0;
    this.venue.courts.forEach(function (c) {
      lifts[c.id] = c.indoor ? 5.4 + (1 - nIn++) * 3.6 : 5.4 + (nOut++) * 3.6;
    });
    this.labels = this.venue.courts.map(function (def) {
      var c = cv(LBL_W, LBL_H);
      drawLabel(c, def, null, false, self.courtNames);
      var tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      var m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false, fog: false, opacity: 0.9
        })
      );
      m.renderOrder = 20;
      m.frustumCulled = false;
      scene.add(m);
      return { canvas: c, tex: tex, mesh: m, def: def, lift: lifts[def.id],
               drawnActive: false };
    });

    /* --- camera ------------------------------------------------------------ */
    var b = this._bounds();
    this.bounds = b;
    /* Exact framing beats a bounding sphere: three 20x10 boxes in an L are far
       from spherical, so keep the real corner cloud and solve for distance. */
    this.fitAll = [];
    this.fitOne = [];
    this.venue.courts.forEach(function (c) {
      var own = [];
      courtCorners(c).forEach(function (p) {
        [0, 4.6].forEach(function (y) {
          own.push(p[0], y, p[1]);
        });
      });
      self.fitOne.push(own);
      /* The whole-site shot must CONTAIN the courts, aprons included; the
         fly-in (fitOne) keeps the bare corners — cropping into the apron and
         fence tops is that shot's look. */
      courtCorners(c, 1.2).forEach(function (p) {
        [0, 4.6].forEach(function (y) {
          self.fitAll.push(p[0], y, p[1]);
        });
      });
    });
    /* The hall floor is part of the resting shot, so it is part of the fit —
       at ground level only, since the slab has no height. Only the courts get
       a fitOne — flying to a hall is not something anything asks for. */
    hallList(this.venue).forEach(function (h) {
      h.points.forEach(function (p) { self.fitAll.push(p[0], 0, p[1]); });
    });

    this.focus = new THREE.Vector3(b.cx, 1.2, b.cz);
    /* near is as far out as the closest fly-in allows: depth precision goes
       straight into how well the court deck separates from the tarmac. */
    this.camera = new THREE.PerspectiveCamera(40, 1, 6, 1100);
    this.baseAz = this._restAzimuth();
    this.az = this.baseAz;
    this.el = 0.72;
    this.dist = 120;
    this.pxToWorldAt1 = 0.001;
    this._tmpV = new THREE.Vector3();
    this._tmpP = new THREE.Vector3();

    this.ready = true;
    this._resize();
    if (this.pendingActive !== undefined) {
      var pa = this.pendingActive;
      this.pendingActive = undefined;
      this.setActive(pa);
    }
    Object.keys(this.matches).forEach(function (id) { self._applyMatch(id); });
    this._sync();
    this._renderOnce();
  };

  /* Run the camera forward to where it would come to rest, so the first frame
     anyone sees is already framed. Cheap: no drawing, ~90 integration steps. */
  Engine.prototype._settle = function () {
    for (var i = 0; i < 90; i++) this._update(1 / 30);
  };

  /* Smallest camera distance along the current view axis that still contains
     every point of `pts` inside the frustum. No allocation. */
  Engine.prototype._fitDistance = function (pts, fx, fy, fz, az, el, margin) {
    var ce = Math.cos(el), se = Math.sin(el);
    var dx = ce * Math.sin(az), dy = se, dz = ce * Math.cos(az);   // focus -> camera
    var rx = dz, ry = 0, rz = -dx;                                  // right = up x dir
    var rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    var ux = -(rz * dy);          // up' = dir x right, expanded for ry = 0
    var uy = rz * dx - rx * dz;
    var uz = rx * dy;
    var ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;

    var tV = Math.tan(this.camera.fov * Math.PI / 360);
    var tH = tV * this.camera.aspect;
    var need = 0;
    for (var i = 0; i < pts.length; i += 3) {
      var vx = pts[i] - fx, vy = pts[i + 1] - fy, vz = pts[i + 2] - fz;
      var px = vx * rx + vz * rz;
      var py = vx * ux + vy * uy + vz * uz;
      var pz = vx * dx + vy * dy + vz * dz;
      var a = pz + Math.abs(px) / tH;
      var b = pz + Math.abs(py) / tV;
      if (a > need) need = a;
      if (b > need) need = b;
    }
    return need * margin;
  };

  /* Every point the resting shot has to contain: the court corners, plus the
     hall footprint. The hall is not decoration around Baan 4 and 5 — it is
     bigger than they are, and leaving it out of the fit cropped its near corner
     off the bottom of the panel. */
  Engine.prototype._sitePoints = function () {
    var all = [];
    this.venue.courts.forEach(function (c) {
      courtCorners(c).forEach(function (p) { all.push(p); });
    });
    hallList(this.venue).forEach(function (h) {
      h.points.forEach(function (p) { all.push([p[0], p[1]]); });
    });
    return all;
  };

  Engine.prototype._bounds = function () {
    var all = this._sitePoints();
    var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    all.forEach(function (p) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
    });
    var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, r = 0;
    all.forEach(function (p) { r = Math.max(r, Math.hypot(p[0] - cx, p[1] - cz)); });
    return { cx: cx, cz: cz, r: r + 5 };
  };

  /* Resting azimuth: the fixed south view (see REST_AZ). Still a method and
     still called per resize, because it USED to be an aspect-driven solve and
     the call sites are the contract; if a future panel needs a solved azimuth
     again, this is where it goes back in. */
  Engine.prototype._restAzimuth = function () {
    return REST_AZ;
  };

  /* -------------------------------------------------------------- sizing   */
  Engine.prototype._resize = function () {
    if (!this.ready || !this.renderer) return;
    var w = Math.round(this.canvas.clientWidth || 0);
    var h = Math.round(this.canvas.clientHeight || 0);
    if (w < 2 || h < 2) return;
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = (w / h) < 1 ? 50 : 38;
    this.camera.updateProjectionMatrix();
    this.film.uRes.value.set(w * this.dpr, h * this.dpr);
    this.pxToWorldAt1 = 2 * Math.tan(this.camera.fov * Math.PI / 360) / h;
    this.film.uPxW.value = this.pxToWorldAt1;
    this.portrait = (w / h) < 1;
    /* Lower than a plan view on purpose: from higher up you look down INTO the
       boxes and read open trays. */
    this.baseEl = this.portrait ? 0.64 : 0.62;
    /* After the aspect, the fov and baseEl: the azimuth search reads all three. */
    this.baseAz = this._restAzimuth();
    this.dirty = true;
    /* Until the first frame is on screen the camera has never been solved for
       the real aspect ratio — `_init` may well have run while the panel was
       still zero-sized. Re-settle rather than let the visitor watch a second
       of the scene flying into frame; the mobile timetable panel is sticky, so
       that flight is now the first thing they see. */
    if (!this.painted) this._settle();
    if (!this.running) { this._update(1 / 60); this._renderOnce(); }
  };

  /* -------------------------------------------------------------- run/stop */
  Engine.prototype._sync = function () {
    var should = this.ready && !this.destroyed && !this.paused && !this.docHidden &&
      this.visible && !this.contextLost && !!this.renderer;
    if (should && !this.running) this._start();
    else if (!should && this.running) this._stop();
  };
  Engine.prototype._start = function () {
    if (this.running) return;
    this.running = true;
    this.lastT = 0;
    this.rafId = requestAnimationFrame(this._onFrame);
  };
  Engine.prototype._stop = function () {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  };

  /* -------------------------------------------------------------- the loop */
  Engine.prototype._frame = function (now) {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this._onFrame);
    if (this.w < 2 || this.h < 2) { this._resize(); return; }
    var dt = this.lastT ? Math.min((now - this.lastT) / 1000, 0.05) : 0.016;
    this.lastT = now;
    this._update(dt);
    /* Full rate whenever something is genuinely in transition. At rest the only
       motion left is a 48-second drift, and presenting a fresh canvas 60 times
       a second to advance that by a fraction of a pixel is the most expensive
       thing the scene does when nobody is doing anything: the draw is 0.4 ms
       but every one of them costs a full canvas composite. */
    var draw = this.dirty || this.still;
    if (!draw && !this.reduce && (now - this.lastDraw) >= IDLE_MS) draw = true;
    if (draw) { this.lastDraw = now; this._renderOnce(); }
  };

  Engine.prototype._update = function (dt) {
    var i, st, moving = false;
    this.time += dt;

    var anyT = 0;
    for (i = 0; i < this.courtState.length; i++) {
      st = this.courtState[i];
      var na = dampTo(st.a, st.target, 7.5, dt);
      if (Math.abs(na - st.a) > 0.0004) moving = true;
      st.a = Math.abs(na - st.target) < 0.001 ? st.target : na;
      if (st.target > anyT) anyT = st.target;
    }
    var prevAny = this.anyActive;
    this.anyActive = dampTo(this.anyActive, anyT, 7.5, dt);
    if (Math.abs(this.anyActive - prevAny) > 0.0004) moving = true;

    for (i = 0; i < this.courtState.length; i++) {
      st = this.courtState[i];
      var b = 1 + 0.34 * st.a - 0.62 * this.anyActive * (1 - st.a);
      var cm = this.courtMats[i];
      cm.color.copy(cm.userData.base).multiplyScalar(b);
      var u = this.glassMats[i].uniforms;
      u.uActive.value = st.a;
      u.uDim.value = clamp(b, 0.35, 1.4);
      u.uTime.value = this.reduce ? 0 : this.time;
      this.ringMats[i].opacity = st.a * 0.95;
      this.courtGroups[i].position.y = st.a * 0.7;
    }

    /* ---- camera ---- */
    var bb = this.bounds;
    var baseEl = this.baseEl || 0.72;
    var fx = bb.cx, fz = bb.cz, tAz = this.baseAz, tEl = baseEl;
    var best = null;
    for (i = 0; i < this.courtState.length; i++) {
      if (!best || this.courtState[i].a > best.a) best = this.courtState[i];
    }
    if (best && best.a > 0.001) {
      var k = best.a, def = best.def;
      var cAz = best.az;   /* composed per court at init — indoor bays flip
                              across the hall, see the courtState block */
      fx += (def.center[0] - bb.cx) * k;
      fz += (def.center[1] - bb.cz) * k;
      tAz = this.baseAz + wrapPi(cAz - this.baseAz) * k;
      /* The eye DROPS into the enclosure — that low angle is the shot, it puts
         the glass and the fence between you and the court. Indoors too, now
         that the hall is a floor slab instead of walls: there is nothing left
         to see over. */
      tEl = baseEl - 0.16 * k;
    }

    var wobble = this.reduce ? 0 : Math.sin(this.time * 0.13) * 0.085 * (1 - this.anyActive * 0.8);
    var wobbleY = this.reduce ? 0 : Math.sin(this.time * 0.093 + 1.3) * 0.028 * (1 - this.anyActive * 0.8);

    /* ~12% inside a clean fit, so the fence tops run off the edges and the
       frames read as an enclosure rather than a lattice. It used to be ~16%:
       the extra sliver is the Bondgenotenlaan, which runs past the far side of
       the courts and was cropped away entirely. The courts stay the subject —
       this is a few per cent, not a step back to a site plan.
       Also near the closest the scene can be framed and still hold the mobile
       budget: the court surfaces are the largest lit, textured,
       shadow-receiving thing in the frame, so cost scales with how much of the
       screen they cover.

       ⚠ That crop only works while the subject is ONE cluster, where what falls
       off the edge is fence top. Framing the whole site it was cutting Baan 1 and
       Baan 4 in half, because at the edges of a wide frame there is nothing but
       court. So `wide` closes the crop as the framed radius grows: unchanged up
       to a 30 m radius (the outdoor cluster on its own, the shot the client
       signed off), fully contained past 50 m — the whole-site radius since the
       hall moved to its display position. The single-court fly-in keeps the
       tight crop: nothing about it changed.

       The whole-site fit is solved at the WOBBLED azimuth, not the target: in
       the wide strip the camera rests ~50 m from a 90 m site, and there the
       ±0.085 rad idle swing moves a far corner several metres — more than any
       sane fixed margin. Solving against the swung camera makes containment
       exact by construction; the wobble is a 48-second drift, well inside what
       the distance damping tracks, and the ceiling stays a real margin. */
    var tight = this.portrait ? 0.88 : 0.89;
    var wide = clamp((bb.r - 30) / 20, 0, 1);
    var margin = tight + (1.04 - tight) * wide;
    var elNow = clamp(tEl, 0.13, 1.32);
    var dAll = this._fitDistance(this.fitAll, bb.cx, 1.2, bb.cz,
      tAz + wobble, clamp(elNow + wobbleY, 0.13, 1.32), margin);
    var dNeed = dAll;
    if (best && best.a > 0.001) {
      var oi = this.courtState.indexOf(best);
      var dOne = this._fitDistance(this.fitOne[oi], best.def.center[0], 1.6,
        best.def.center[1], tAz, elNow, tight + 0.06);
      dNeed = dAll + (dOne - dAll) * best.a;
    }

    this.focus.x = dampTo(this.focus.x, fx, 3.4, dt);
    this.focus.z = dampTo(this.focus.z, fz, 3.4, dt);
    this.focus.y = dampTo(this.focus.y, 1.2 + this.anyActive * 1.1, 3.4, dt);
    this.dist = dampTo(this.dist, dNeed, 3.0, dt);
    this.az += wrapPi(tAz - this.az) * (1 - Math.exp(-3.2 * dt));
    this.el = dampTo(this.el, tEl, 3.2, dt);

    var az = this.az + wobble;
    var el = clamp(this.el + wobbleY, 0.13, 1.32);
    var ce = Math.cos(el), se = Math.sin(el);
    this.camera.position.set(
      this.focus.x + this.dist * ce * Math.sin(az),
      this.focus.y + this.dist * se,
      this.focus.z + this.dist * ce * Math.cos(az)
    );
    this.camera.lookAt(this.focus);

    /* ---- labels: billboarded, sized between world and screen ----
       A card pinned to a constant PIXEL size was right while the whole scene was
       one 50 m cluster. It does not survive framing the whole site: at the
       resting distance a 20 m court is ~35 px wide in the timetable's panel, and
       five 344 px name plates over it covered the courts completely and each
       other besides.

       So the card is a fixed WORLD width — LBL_M metres, a little over one court
       — clamped into a pixel band. Zoomed onto one court the world size exceeds
       the ceiling and it pins to exactly the old 268/344 px, so the active state
       is unchanged to the pixel. Pulled back to the whole site it rides the
       floor instead and reads as a marker on a site plan, which is what the shot
       has become. */
    var maxPx = this.w < 520 ? 268 : 344;
    var minPx = this.w < 520 ? 92 : 116;
    this.camera.updateMatrixWorld();
    for (i = 0; i < this.labels.length; i++) {
      var L = this.labels[i], cs = this.courtState[i];
      var wantActive = cs.a > 0.5;
      if (wantActive !== L.drawnActive) {
        drawLabel(L.canvas, L.def, this.matches[L.def.id] || null, wantActive,
          this.courtNames);
        L.tex.needsUpdate = true;
        L.drawnActive = wantActive;
      }
      var kL = 0.80 + 0.20 * cs.a;
      L.mesh.position.set(
        L.def.center[0],
        L.lift + cs.a * 4.2 + this.courtGroups[i].position.y,
        L.def.center[1]
      );
      /* Distance decides the pixel size, and the pixel size decides the clamp
         that keeps the card in frame — so measure the distance first. */
      var d = this._tmpV.copy(L.mesh.position).sub(this.camera.position).length();
      var px = clamp(LBL_M / (this.pxToWorldAt1 * Math.max(d, 1)), minPx, maxPx);

      /* Keep the card inside the frame: when a court goes active the camera
         pushes in AND the card rises, which on a phone-width panel walked it
         off the top edge. */
      var halfNdc = px * kL * (LBL_H / LBL_W) / this.h;
      var pv = this._tmpP.copy(L.mesh.position).project(this.camera);
      var limY = 1 - halfNdc - 0.03;
      if (pv.y > limY) {
        pv.y = limY;
        L.mesh.position.copy(pv.unproject(this.camera));
        d = this._tmpV.copy(L.mesh.position).sub(this.camera.position).length();
      }
      var sc2 = px * this.pxToWorldAt1 * d * kL;
      L.mesh.scale.set(sc2, sc2 * (LBL_H / LBL_W), 1);
      L.mesh.quaternion.copy(this.camera.quaternion);
      var op = 0.82 + 0.18 * cs.a - this.anyActive * (1 - cs.a) * 0.62;
      L.mesh.material.opacity = clamp(op, 0, 1);
      L.mesh.visible = op > 0.03;
    }

    /* `dirty` is sticky until something actually paints — as a straight
       assignment it swallowed one-shot redraw requests raised between draws.
       `_renderOnce` clears it, so "requested" and "painted" live in one place. */
    this.moving = moving;
    if (moving) this.dirty = true;
  };

  Engine.prototype._renderOnce = function () {
    if (!this.renderer || !this.scene || !this.camera || this.contextLost) return;
    if (this.w < 2 || this.h < 2) return;
    this.dirty = false;
    try {
      this.renderer.render(this.scene, this.camera);
      /* Reveal only once a complete, framed frame exists. Before this the
         canvas is transparent and the panel shows its own ground colour, which
         beats a second of half-built scene sliding into place. */
      if (!this.painted) {
        this.painted = true;
        this.canvas.classList.add('is-ready');
      }
    } catch (e) {
      if (window.console) console.warn('[Courts3D] render failed', e);
      this._stop();
    }
  };

  /* --------------------------------------------------------------- public  */
  Engine.prototype.setActive = function (id) {
    this.activeId = id || null;
    if (!this.ready) { this.pendingActive = id; return; }
    if (!this.courtState) { this.pendingActive = id; return; }
    for (var i = 0; i < this.courtState.length; i++) {
      this.courtState[i].target = (this.courtState[i].def.id === this.activeId) ? 1 : 0;
    }
    this.dirty = true;
    this._sync();
    if (!this.running) { this._update(1 / 60); this._renderOnce(); }
  };

  Engine.prototype._applyMatch = function (courtId) {
    if (!this.labels) return;
    for (var i = 0; i < this.labels.length; i++) {
      if (this.labels[i].def.id !== courtId) continue;
      drawLabel(this.labels[i].canvas, this.labels[i].def,
        this.matches[courtId] || null, this.courtState[i].a > 0.5, this.courtNames);
      this.labels[i].drawnActive = this.courtState[i].a > 0.5;
      this.labels[i].tex.needsUpdate = true;
      this.dirty = true;
      if (!this.running) this._renderOnce();
      return;
    }
  };

  Engine.prototype.setMatch = function (courtId, md) {
    if (!courtId) return;
    var n = normaliseMatch(md, this.teams);
    if (n) this.matches[courtId] = n; else delete this.matches[courtId];
    this._applyMatch(courtId);
  };

  Engine.prototype.pause = function () { this.paused = true; this._sync(); };
  Engine.prototype.resume = function () { this.paused = false; this._sync(); };

  Engine.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stop();
    if (this._io) this._io.disconnect();
    if (this._ro) this._ro.disconnect();
    if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
    if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
    if (this._onLost) this.canvas.removeEventListener('webglcontextlost', this._onLost);
    if (this._onRestored) this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    if (this.reduceMQ) {
      if (this.reduceMQ.removeEventListener) this.reduceMQ.removeEventListener('change', this._onReduce);
      else if (this.reduceMQ.removeListener) this.reduceMQ.removeListener(this._onReduce);
    }
    if (this.scene) {
      var seen = [];
      this.scene.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        var m = o.material;
        if (!m) return;
        (Array.isArray(m) ? m : [m]).forEach(function (mat) {
          if (seen.indexOf(mat) !== -1) return;
          seen.push(mat);
          if (mat.map) mat.map.dispose();
          mat.dispose();
        });
      });
    }
    if (this.renderer) {
      this.renderer.dispose();
      try { this.renderer.forceContextLoss(); } catch (e) {}
    }
    this.canvas.classList.remove('c3d-canvas', 'is-hidden', 'is-ready', 'is-unavailable');
    this.scene = null; this.renderer = null; this.camera = null;
  };

  Engine.prototype.stats = function () {
    if (!this.renderer) return { webgl: false };
    var r = this.renderer.info.render;
    return {
      webgl: true,
      triangles: r.triangles,
      calls: r.calls,
      dpr: this.dpr,
      dprPinned: !!this.dprPin,
      still: !!this.still,
      /* a regression to a photographic texture would show up here */
      surface: 'drawn',
      running: this.running,
      moving: !!this.moving,
      reduce: this.reduce,
      size: this.w + 'x' + this.h
    };
  };

  /* =============================================================== the API */
  window.Courts3D = {
    mount: function (canvasEl, opts) {
      if (!canvasEl) return null;
      if (app) app.destroy();
      app = new Engine(canvasEl, opts || {});
      return app;
    },
    setActiveCourt: function (id) { if (app) app.setActive(id || null); },
    setMatch: function (courtId, md) { if (app) app.setMatch(courtId, md); },
    pause: function () { if (app) app.pause(); },
    resume: function () { if (app) app.resume(); },
    destroy: function () { if (app) { app.destroy(); app = null; } },
    stats: function () { return app ? app.stats() : { webgl: false }; },
    get instance() { return app; }
  };
})();
