/* Line Lift site: one persistent WebGL2 fluid under the whole page.
   Stable fluids (Stam): velocity and dye fields ping-ponged between
   framebuffers, advected each frame; scroll velocity injects pigment.
   Sim resolution is independent of screen resolution: that is the
   performance dial. Desktop 256 / 1024, mobile 128 / 512.

   Rules held here: the scroll listener only records a value, a rAF loop
   lerps toward it; the sim pauses on visibilitychange; reduced motion
   gets one composed frame; no WebGL2 (or no float render targets) gets
   the CSS poster in .fluid-fallback. Content never depends on any of it. */
(function () {
  'use strict';

  const canvas = document.getElementById('fluid');
  const fallback = document.querySelector('.fluid-fallback');
  if (!canvas) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 760;

  const config = {
    simRes: isMobile ? 128 : 256,
    dyeRes: isMobile ? 512 : 1024,
    pressureIterations: isMobile ? 12 : 20,
    dprCap: isMobile ? 1.5 : 2,
    densityDissipation: 0.985,  // dye lingers like a wet wash
    velocityDissipation: 0.985,
    pressure: 0.8,
    curl: 9,
    splatRadius: 0.0035
  };

  // The ground colours the dye sits on. Near black for the drop, paper after.
  const GROUND_DARK = [0.078, 0.067, 0.059];   // #14110f
  const GROUND_PAPER = [0.961, 0.937, 0.890];  // #f5efe3

  const gl = canvas.getContext('webgl2', { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  const floatOK = gl && gl.getExtension('EXT_color_buffer_float');
  if (!gl || !floatOK) { showFallback(); return; }

  function showFallback() {
    canvas.hidden = true;
    if (fallback) fallback.hidden = false;
    document.documentElement.classList.add('no-fluid');
  }

  // ---------- shaders ----------
  const VERT = `#version 300 es
  precision highp float;
  in vec2 aPosition;
  out vec2 vUv; out vec2 vL; out vec2 vR; out vec2 vT; out vec2 vB;
  uniform vec2 texelSize;
  void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }`;

  const FRAG = {
    clear: `#version 300 es
    precision mediump float; precision mediump sampler2D;
    in vec2 vUv; uniform sampler2D uTexture; uniform float value; out vec4 o;
    void main () { o = value * texture(uTexture, vUv); }`,

    splat: `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv; uniform sampler2D uTarget; uniform float aspectRatio;
    uniform vec3 color; uniform vec2 point; uniform float radius; out vec4 o;
    void main () {
      vec2 p = vUv - point.xy; p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      vec3 base = texture(uTarget, vUv).xyz;
      o = vec4(base + splat, 1.0);
    }`,

    advection: `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv; uniform sampler2D uVelocity; uniform sampler2D uSource;
    uniform vec2 texelSize; uniform float dt; uniform float dissipation; out vec4 o;
    void main () {
      vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
      vec4 result = texture(uSource, coord);
      float decay = 1.0 + dissipation * dt;
      o = result / decay;
    }`,

    divergence: `#version 300 es
    precision mediump float; precision mediump sampler2D;
    in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
    uniform sampler2D uVelocity; out vec4 o;
    void main () {
      float L = texture(uVelocity, vL).x; float R = texture(uVelocity, vR).x;
      float T = texture(uVelocity, vT).y; float B = texture(uVelocity, vB).y;
      vec2 C = texture(uVelocity, vUv).xy;
      if (vL.x < 0.0) { L = -C.x; } if (vR.x > 1.0) { R = -C.x; }
      if (vT.y > 1.0) { T = -C.y; } if (vB.y < 0.0) { B = -C.y; }
      float div = 0.5 * (R - L + T - B);
      o = vec4(div, 0.0, 0.0, 1.0);
    }`,

    curl: `#version 300 es
    precision mediump float; precision mediump sampler2D;
    in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
    uniform sampler2D uVelocity; out vec4 o;
    void main () {
      float L = texture(uVelocity, vL).y; float R = texture(uVelocity, vR).y;
      float T = texture(uVelocity, vT).x; float B = texture(uVelocity, vB).x;
      float vorticity = R - L - T + B;
      o = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }`,

    vorticity: `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
    uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt; out vec4 o;
    void main () {
      float L = texture(uCurl, vL).x; float R = texture(uCurl, vR).x;
      float T = texture(uCurl, vT).x; float B = texture(uCurl, vB).x;
      float C = texture(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001;
      force *= curl * C; force.y *= -1.0;
      vec2 velocity = texture(uVelocity, vUv).xy;
      velocity += force * dt;
      velocity = min(max(velocity, -1000.0), 1000.0);
      o = vec4(velocity, 0.0, 1.0);
    }`,

    pressure: `#version 300 es
    precision mediump float; precision mediump sampler2D;
    in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
    uniform sampler2D uPressure; uniform sampler2D uDivergence; out vec4 o;
    void main () {
      float L = texture(uPressure, vL).x; float R = texture(uPressure, vR).x;
      float T = texture(uPressure, vT).x; float B = texture(uPressure, vB).x;
      float divergence = texture(uDivergence, vUv).x;
      float pressure = (L + R + B + T - divergence) * 0.25;
      o = vec4(pressure, 0.0, 0.0, 1.0);
    }`,

    gradientSubtract: `#version 300 es
    precision mediump float; precision mediump sampler2D;
    in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
    uniform sampler2D uPressure; uniform sampler2D uVelocity; out vec4 o;
    void main () {
      float L = texture(uPressure, vL).x; float R = texture(uPressure, vR).x;
      float T = texture(uPressure, vT).x; float B = texture(uPressure, vB).x;
      vec2 velocity = texture(uVelocity, vUv).xy;
      velocity.xy -= vec2(R - L, T - B);
      o = vec4(velocity, 0.0, 1.0);
    }`,

    // Display: pigment as a translucent layer over the ground, so it reads
    // as light bloom on the dark opening and as paint on the paper. Paper
    // grain is a cheap hash so the wash is not perfectly smooth.
    display: `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv; uniform sampler2D uDye; uniform vec3 uGround; uniform float uOpacity; uniform vec2 uRes; out vec4 o;
    float hash (vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main () {
      vec3 c = texture(uDye, vUv).rgb;
      float den = max(c.r, max(c.g, c.b));
      vec3 pig = den > 0.0005 ? c / den : vec3(0.0);
      float a = (1.0 - exp(-den * 1.7)) * 0.9;   // soft saturation: a wash never goes fully opaque
      // Pigment concentrates at the edges of a wash: darken where density is mid-range.
      float edge = smoothstep(0.02, 0.35, a) * (1.0 - smoothstep(0.35, 1.0, a)) * 0.18;
      vec3 paint = mix(uGround, pig * (1.0 - edge), a * uOpacity);
      float grain = (hash(floor(gl_FragCoord.xy * 0.5)) - 0.5) * 0.035;
      o = vec4(paint + grain * (0.4 + 0.6 * a), 1.0);
    }`
  };

  // ---------- GL plumbing ----------
  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
    return s;
  }
  const vert = compile(gl.VERTEX_SHADER, VERT);
  function program(fragSrc) {
    const frag = compile(gl.FRAGMENT_SHADER, fragSrc);
    const p = gl.createProgram(); gl.attachShader(p, vert); gl.attachShader(p, frag); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(p)); return null; }
    const uniforms = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; uniforms[name] = gl.getUniformLocation(p, name); }
    return { p, u: uniforms };
  }
  const P = {};
  for (const k in FRAG) { P[k] = program(FRAG[k]); if (!P[k]) { showFallback(); return; } }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  function blit(target) {
    if (target == null) { gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
    else { gl.viewport(0, 0, target.width, target.height); gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  function createFBO(w, h, internalFormat, format, type, filter) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture, fbo, width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; }
    };
  }
  function createDoubleFBO(w, h, internalFormat, format, type, filter) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, filter);
    let fbo2 = createFBO(w, h, internalFormat, format, type, filter);
    if (!fbo1 || !fbo2) return null;
    return {
      width: w, height: h, texelSizeX: fbo1.texelSizeX, texelSizeY: fbo1.texelSizeY,
      get read() { return fbo1; }, set read(v) { fbo1 = v; },
      get write() { return fbo2; }, set write(v) { fbo2 = v; },
      swap() { const t = fbo1; fbo1 = fbo2; fbo2 = t; }
    };
  }

  function getResolution(resolution) {
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    const min = Math.round(resolution), max = Math.round(resolution * aspect);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { width: max, height: min } : { width: min, height: max };
  }

  let dye, velocity, divergence, curl, pressure;
  function initFramebuffers() {
    const sim = getResolution(config.simRes), d = getResolution(config.dyeRes);
    dye = createDoubleFBO(d.width, d.height, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    velocity = createDoubleFBO(sim.width, sim.height, gl.RG16F, gl.RG, gl.HALF_FLOAT, gl.LINEAR);
    divergence = createFBO(sim.width, sim.height, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
    curl = createFBO(sim.width, sim.height, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
    pressure = createDoubleFBO(sim.width, sim.height, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
    if (!dye || !velocity || !divergence || !curl || !pressure) { showFallback(); return false; }
    return true;
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, config.dprCap);
    const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true; }
    return false;
  }
  resizeCanvas();
  if (!initFramebuffers()) return;

  // ---------- sim steps ----------
  function step(dt) {
    gl.disable(gl.BLEND);
    gl.useProgram(P.curl.p);
    gl.uniform2f(P.curl.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(P.curl.u.uVelocity, velocity.read.attach(0));
    blit(curl);

    gl.useProgram(P.vorticity.p);
    gl.uniform2f(P.vorticity.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(P.vorticity.u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(P.vorticity.u.uCurl, curl.attach(1));
    gl.uniform1f(P.vorticity.u.curl, config.curl);
    gl.uniform1f(P.vorticity.u.dt, dt);
    blit(velocity.write); velocity.swap();

    gl.useProgram(P.divergence.p);
    gl.uniform2f(P.divergence.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(P.divergence.u.uVelocity, velocity.read.attach(0));
    blit(divergence);

    gl.useProgram(P.clear.p);
    gl.uniform1i(P.clear.u.uTexture, pressure.read.attach(0));
    gl.uniform1f(P.clear.u.value, config.pressure);
    blit(pressure.write); pressure.swap();

    gl.useProgram(P.pressure.p);
    gl.uniform2f(P.pressure.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(P.pressure.u.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.pressureIterations; i++) {
      gl.uniform1i(P.pressure.u.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    gl.useProgram(P.gradientSubtract.p);
    gl.uniform2f(P.gradientSubtract.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(P.gradientSubtract.u.uPressure, pressure.read.attach(0));
    gl.uniform1i(P.gradientSubtract.u.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    gl.useProgram(P.advection.p);
    gl.uniform2f(P.advection.u.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    const velId = velocity.read.attach(0);
    gl.uniform1i(P.advection.u.uVelocity, velId);
    gl.uniform1i(P.advection.u.uSource, velId);
    gl.uniform1f(P.advection.u.dt, dt);
    gl.uniform1f(P.advection.u.dissipation, state.velocityDissipation);
    blit(velocity.write); velocity.swap();

    gl.uniform1i(P.advection.u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(P.advection.u.uSource, dye.read.attach(1));
    gl.uniform1f(P.advection.u.dissipation, state.densityDissipation);
    blit(dye.write); dye.swap();
  }

  function render() {
    gl.useProgram(P.display.p);
    gl.uniform1i(P.display.u.uDye, dye.read.attach(0));
    gl.uniform3f(P.display.u.uGround, state.ground[0], state.ground[1], state.ground[2]);
    gl.uniform1f(P.display.u.uOpacity, 0.8);
    gl.uniform2f(P.display.u.uRes, gl.drawingBufferWidth, gl.drawingBufferHeight);
    blit(null);
  }

  // x, y in 0..1 (y up), dx/dy in sim velocity units, color as 0..1 rgb.
  function splat(x, y, dx, dy, color, radius) {
    gl.useProgram(P.splat.p);
    gl.uniform1i(P.splat.u.uTarget, velocity.read.attach(0));
    gl.uniform1f(P.splat.u.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(P.splat.u.point, x, y);
    gl.uniform3f(P.splat.u.color, dx, dy, 0);
    gl.uniform1f(P.splat.u.radius, correctRadius(radius || config.splatRadius));
    blit(velocity.write); velocity.swap();

    gl.uniform1i(P.splat.u.uTarget, dye.read.attach(0));
    gl.uniform3f(P.splat.u.color, color[0], color[1], color[2]);
    blit(dye.write); dye.swap();
  }
  function correctRadius(r) { const aspect = canvas.width / canvas.height; return aspect > 1 ? r * aspect : r; }

  function hexToRgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  // Pigment intensity: how much dye one splat lays down.
  function pig(hex, k) { const c = hexToRgb(hex); return [c[0] * k, c[1] * k, c[2] * k]; }

  // ---------- scroll model ----------
  // The listener writes a target; the rAF loop lerps toward it. Nothing
  // animates inside the scroll handler.
  const state = {
    scrollTarget: window.scrollY, scroll: window.scrollY, scrollVel: 0,
    ground: GROUND_DARK.slice(), pigment: '#8C1F3C',
    densityDissipation: 0.12, velocityDissipation: 0.55,
    calm: 0, running: true, frozen: false
  };
  window.addEventListener('scroll', () => { state.scrollTarget = window.scrollY; }, { passive: true });

  // Sections declare the pigment they splat with. The nearest one to the
  // viewport centre is the "current" pigment, used for scroll injection.
  const pigmentSections = Array.from(document.querySelectorAll('[data-pigment]'));
  function currentPigment() {
    const mid = window.innerHeight * 0.5; let best = null, bestD = Infinity;
    for (const s of pigmentSections) {
      const r = s.getBoundingClientRect(); const c = r.top + r.height / 2; const d = Math.abs(c - mid);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best ? best.dataset.pigment : '#8C1F3C';
  }

  // Entering a feature act splats its own colour where the section sits.
  if (!reducedMotion && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const s = e.target; io.unobserve(s);
        const color = pig(s.dataset.pigment, 0.32);
        const side = s.dataset.splatSide === 'left' ? 0.22 : s.dataset.splatSide === 'right' ? 0.78 : 0.5;
        const r = s.getBoundingClientRect();
        const y = 1 - Math.min(Math.max((r.top + r.height * 0.45) / window.innerHeight, 0.1), 0.9);
        burst(side, y, color, 6, 170, 0.0035);
      });
    }, { threshold: 0.35 });
    pigmentSections.forEach((s) => { if (s.dataset.splat !== 'none') io.observe(s); });
  }

  function burst(x, y, color, n, force, radius) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const f = force * (0.6 + Math.random() * 0.8);
      splat(x + (Math.random() - 0.5) * 0.05, y + (Math.random() - 0.5) * 0.05, Math.cos(a) * f, Math.sin(a) * f, color, radius);
    }
  }

  // Pinned acts cannot use the observer (their steps do not scroll), so
  // script.js announces step changes and the fluid splats on them.
  window.addEventListener('linelift:splat', (e) => {
    if (reducedMotion || !e.detail) return;
    const d = e.detail;
    const x = d.side === 'left' ? 0.2 : d.side === 'right' ? 0.8 : 0.5;
    burst(x, d.y == null ? 0.5 : d.y, pig(d.pigment, d.strength || 0.32), d.n || 6, d.force || 190, d.radius || 0.0035);
  });

  // Act 1: the drop. A droplet falls (CSS) and its impact seeds the sim.
  const drop = document.querySelector('.drop');
  function theDrop() {
    document.documentElement.classList.add('fluid-ready');
    const impact = () => {
      const x = 0.5, y = 0.52;
      burst(x, y, pig('#8C1F3C', 0.55), 10, 480, 0.005);      // Alizarin Crimson
      setTimeout(() => burst(x + 0.06, y - 0.04, pig('#2746A8', 0.38), 7, 300, 0.0045), 260);   // French Ultramarine
      setTimeout(() => burst(x - 0.08, y + 0.03, pig('#D9992B', 0.34), 6, 240, 0.0045), 620);   // Indian Yellow
      document.documentElement.classList.add('bloomed');
    };
    if (drop) {
      drop.addEventListener('animationend', impact, { once: true });
      drop.classList.add('falling');
      setTimeout(() => { if (!document.documentElement.classList.contains('bloomed')) impact(); }, 2200);
    } else impact();
  }

  // Reduced motion: one composed frame. Run the opening choreography for
  // ~90 steps without presenting, render once, and stop.
  function composedFrame() {
    document.documentElement.classList.add('fluid-ready', 'bloomed');
    burst(0.5, 0.52, pig('#8C1F3C', 0.55), 10, 420, 0.005);
    burst(0.58, 0.48, pig('#2746A8', 0.38), 7, 260, 0.0045);
    burst(0.42, 0.56, pig('#D9992B', 0.34), 6, 200, 0.0045);
    for (let i = 0; i < 90; i++) step(0.016);
    state.frozen = true;   // the loop keeps presenting (ground follows scroll) but never advects
    requestAnimationFrame(frame);
  }

  // ---------- main loop ----------
  let last = performance.now();
  let lastInjectY = 0;
  function frame(now) {
    if (!state.running) return;
    let dt = Math.min((now - last) / 1000, 0.0333); last = now;
    if (resizeCanvas()) initFramebuffers();

    // Lerp the scroll, derive a velocity in viewport heights per second.
    const prev = state.scroll;
    state.scroll += (state.scrollTarget - state.scroll) * 0.12;
    const vh = window.innerHeight;
    const vel = (state.scroll - prev) / vh / dt;
    state.scrollVel = state.scrollVel * 0.85 + vel * 0.15;

    // Ground: near black for the drop, paper from a third of a viewport on.
    const t = state.scroll / vh;
    const g = smooth(clamp01((t - 1.45) / 0.75));
    for (let i = 0; i < 3; i++) state.ground[i] = GROUND_DARK[i] + (GROUND_PAPER[i] - GROUND_DARK[i]) * g;
    document.documentElement.classList.toggle('on-dark', g < 0.55);

    // The download act: the fluid calms to stillness.
    const docH = document.documentElement.scrollHeight - vh;
    const endT = clamp01((state.scroll - (docH - vh * 1.6)) / (vh * 1.2));
    state.calm = endT;
    state.velocityDissipation = 0.55 + endT * 4.0;
    state.densityDissipation = 0.12 + endT * 0.5;

    // Scroll injects pigment: fast scroll smears with your velocity, slow
    // scroll blooms. Injection points ride along the sides so the text
    // column stays readable.
    const speed = Math.abs(state.scrollVel);
    if (!state.frozen && speed > 0.05 && endT < 0.6 && Math.abs(state.scroll - lastInjectY) > vh * 0.04) {
      lastInjectY = state.scroll;
      const color = pig(currentPigment(), Math.min(0.04 + speed * 0.09, 0.2));
      const n = speed > 1.2 ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const side = Math.random() < 0.5 ? 0.06 + Math.random() * 0.18 : 0.76 + Math.random() * 0.18;
        const y = 0.15 + Math.random() * 0.7;
        const dir = state.scrollVel > 0 ? 1 : -1;
        splat(side, y, (Math.random() - 0.5) * 120, dir * Math.min(speed, 3) * 260, color, 0.0025 + Math.random() * 0.002);
      }
    }

    if (!state.frozen) step(dt);
    render();
    requestAnimationFrame(frame);
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smooth(v) { return v * v * (3 - 2 * v); }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { state.running = false; }
    else { state.running = true; last = performance.now(); requestAnimationFrame(frame); }
  });

  if (reducedMotion) { composedFrame(); return; }
  requestAnimationFrame(frame);
  setTimeout(theDrop, 350);
})();
