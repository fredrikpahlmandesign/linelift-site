/* Page behaviour: reveals, and the scroll model for the pinned acts.
   The scroll listener records a value; a rAF loop lerps toward it and
   writes one custom property (--p, 0..1) per pinned act, plus the active
   step. CSS does the rest. Step changes are announced to the fluid. */
document.getElementById('year').textContent = new Date().getFullYear();

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const revealItems = document.querySelectorAll('.reveal');

if (reducedMotion || !('IntersectionObserver' in window)) {
  revealItems.forEach((item) => item.classList.add('visible'));
} else {
  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        obs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.14 });
  revealItems.forEach((item) => observer.observe(item));
}

// The hero video is decorative: with reduced motion on, show the poster only.
const heroVideo = document.querySelector('.device-screen');
if (heroVideo && reducedMotion) {
  heroVideo.removeAttribute('autoplay');
  heroVideo.pause();
}

// ---------- pinned acts ----------
(function () {
  const pins = Array.from(document.querySelectorAll('.pin')).map((el) => ({
    el,
    steps: parseInt(el.dataset.steps || '0', 10),
    stepEls: Array.from(el.querySelectorAll('.step, .shot')),
    active: -1,
    top: 0, height: 0
  }));
  if (!pins.length) return;

  function measure() {
    pins.forEach((p) => { p.top = p.el.offsetTop; p.height = p.el.offsetHeight; });
  }
  measure();
  window.addEventListener('resize', measure);
  window.addEventListener('load', measure);

  let target = window.scrollY, current = target;
  window.addEventListener('scroll', () => { target = window.scrollY; }, { passive: true });

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function setStep(p, idx) {
    if (idx === p.active) return;
    p.active = idx;
    p.stepEls.forEach((s) => s.classList.toggle('is-active', parseInt(s.dataset.step, 10) === idx));
    const stepEl = p.el.querySelector('.step[data-step="' + idx + '"]');
    if (stepEl && stepEl.dataset.pigment) {
      window.dispatchEvent(new CustomEvent('linelift:splat', { detail: {
        pigment: stepEl.dataset.pigment, side: stepEl.dataset.side, y: 0.5 + (Math.random() - 0.5) * 0.3,
        n: 6, force: 210, radius: 0.004, strength: 0.34
      } }));
    }
  }

  function tick() {
    current = reducedMotion ? target : current + (target - current) * 0.14;
    const vh = window.innerHeight;
    for (const p of pins) {
      const span = Math.max(p.height - vh, 1);
      const raw = (current - p.top) / span;
      const prog = clamp01(raw);
      if (raw > -0.5 && raw < 1.5) p.el.style.setProperty('--p', prog.toFixed(4));
      if (p.steps) {
        // Steps are spread over the middle 80% of the act so the first and
        // last hold while the act pins and unpins.
        const s = clamp01((prog - 0.05) / 0.9);
        setStep(p, Math.min(p.steps - 1, Math.floor(s * p.steps)));
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
