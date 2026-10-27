// PBAT DOOR TO DOOR: scroll motion for the home page.
// Everything here is decoration: the page works and reads fine without it,
// and it switches itself off for people who ask their device for reduced motion.
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function startMotion() {
  document.documentElement.classList.add('motion');
  progressBar();
  scrollSpy();
  if (reduce) { document.querySelectorAll('.timeline li').forEach((li) => li.classList.add('lit')); document.querySelector('.timeline')?.style.setProperty('--fill', '100%'); document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in')); return; }
  reveal();
  typewriter();
  countUp();
  ticker();
  heroParallax();
  timelineFill();
}

// Thin bar at the top showing how far down the page you are.
function progressBar() {
  const bar = document.querySelector('.progress'); if (!bar) return;
  const update = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
  };
  addEventListener('scroll', update, { passive: true }); addEventListener('resize', update); update();
}

// Sections and cards fade/slide in as they enter the screen; siblings follow one after another.
export function reveal(root = document) {
  const items = [...root.querySelectorAll('.reveal:not(.in)')];
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const el = e.target, sibs = [...el.parentElement.children].filter((c) => c.classList.contains('reveal'));
      el.style.transitionDelay = `${Math.min(sibs.indexOf(el), 6) * 80}ms`;
      el.classList.add('in'); io.unobserve(el);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  items.forEach((el) => io.observe(el));
  // Safety net: anything already above the bottom of the screen (e.g. after jumping to a section) shows at once.
  const sweep = () => root.querySelectorAll('.reveal:not(.in)').forEach((el) => {
    if (el.getBoundingClientRect().top < innerHeight) { el.classList.add('in'); io.unobserve(el); }
  });
  let t; addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(sweep, 120); }, { passive: true });
  addEventListener('hashchange', () => setTimeout(sweep, 600));
}

// The highlighted end of the headline types, pauses, deletes and types the next phrase.
function typewriter() {
  const el = document.querySelector('[data-type-words]'); if (!el) return;
  const words = el.dataset.typeWords.split('|');
  el.textContent = ''; el.classList.add('typing');
  let w = 0, i = 0, deleting = false;
  const tick = () => {
    const word = words[w];
    i += deleting ? -1 : 1;
    el.textContent = word.slice(0, i);
    let wait = deleting ? 45 : 85;
    if (!deleting && i === word.length) { deleting = true; wait = 2200; }
    else if (deleting && i === 0) { deleting = false; w = (w + 1) % words.length; wait = 350; }
    setTimeout(tick, wait);
  };
  setTimeout(tick, 500);
}

// Stat numbers count up from zero the first time they appear.
function countUp() {
  const els = document.querySelectorAll('[data-count]');
  const fmt = (el, v) => {
    const dec = Number(el.dataset.decimals || 0);
    const n = v.toLocaleString('en-NG', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    el.textContent = `${el.dataset.prefix || ''}${n}${el.dataset.suffix || ''}`;
  };
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    const el = e.target, end = Number(el.dataset.count), t0 = performance.now(), dur = 1400;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur), eased = 1 - Math.pow(1 - p, 3);
      fmt(el, end * eased); if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step); io.unobserve(el);
  }), { threshold: 0.6 });
  els.forEach((el) => { fmt(el, 0); io.observe(el); });
}

// Slogan strip: drifts on its own and speeds up while you scroll (direction follows the scroll).
function ticker() {
  const track = document.querySelector('.ticker-track'); if (!track) return;
  track.innerHTML += track.innerHTML;                 // two copies for a seamless loop
  let x = 0, boost = 0, last = scrollY, dir = 1;
  addEventListener('scroll', () => {
    const d = scrollY - last; last = scrollY;
    if (d) dir = d > 0 ? 1 : -1;
    boost = Math.min(18, boost + Math.abs(d) * 0.12);
  }, { passive: true });
  const loop = () => {
    const half = track.scrollWidth / 2;
    x -= (0.6 + boost) * dir; boost *= 0.92;
    if (x <= -half) x += half; if (x > 0) x -= half;
    track.style.transform = `translate3d(${x}px,0,0)`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// The portrait drifts slightly slower than the page for a little depth.
function heroParallax() {
  const fig = document.querySelector('.hero .portrait'); if (!fig) return;
  addEventListener('scroll', () => {
    if (scrollY < innerHeight) fig.style.transform = `translate3d(0, ${scrollY * 0.08}px, 0)`;
  }, { passive: true });
}

// About timeline: a gold line fills down the timeline as you scroll, lighting each milestone it passes.
function timelineFill() {
  const tl = document.querySelector('.timeline'); if (!tl) return;
  const items = [...tl.querySelectorAll('li')];
  const update = () => {
    const r = tl.getBoundingClientRect(), mark = innerHeight * 0.62;
    const p = Math.max(0, Math.min(1, (mark - r.top) / r.height));
    tl.style.setProperty('--fill', `${p * 100}%`);
    items.forEach((li) => li.classList.toggle('lit', li.getBoundingClientRect().top + 10 < mark));
  };
  addEventListener('scroll', update, { passive: true }); addEventListener('resize', update); update();
}

// Header highlights the section you're reading (Home at the top).
function scrollSpy() {
  const links = [...document.querySelectorAll('.nav-links a')];
  const byId = Object.fromEntries(links.map((a) => [a.getAttribute('href').split('#')[1] || 'top', a]));
  const sections = ['movement', 'about', 'works', 'gallery'].map((id) => document.getElementById(id)).filter(Boolean);
  const update = () => {
    const mark = innerHeight * 0.35;
    let current = 'top';
    for (const s of sections) if (s.getBoundingClientRect().top < mark) current = s.id;
    if (current !== 'top' && sections.find((s) => s.id === current).getBoundingClientRect().bottom < mark) current = 'none';
    links.forEach((a) => a.removeAttribute('aria-current'));
    (byId[current] || (current === 'top' ? byId.top : null))?.setAttribute('aria-current', 'page');
  };
  addEventListener('scroll', update, { passive: true }); update();
}
