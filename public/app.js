// PBAT DOOR TO DOOR — shared browser code (used by every page)

export const $ = (sel, root = document) => root.querySelector(sel);
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export async function api(path, body) {
  try {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'No connection. Check your internet and try again.' } };
  }
}

export function setLoading(btn, on) { btn.disabled = on; btn.classList.toggle('loading', on); }

export function message(el, content, kind = 'err') {
  el.textContent = '';
  el.className = `msg ${kind}${content ? ' show' : ''}`;
  if (!content) return;
  if (typeof content === 'string') el.textContent = content; else el.append(content);
}

export function devCodeNote(el, code) {
  if (!code) return message(el, '');
  const span = document.createElement('span');
  span.append('Test mode (no email service set up yet): your code is ');
  const c = document.createElement('code'); c.textContent = code; span.append(c);
  message(el, span, 'dev');
}

export function showStep(id) { $$('.step').forEach((s) => s.classList.toggle('active', s.id === id)); }

// ---- Site header: one component on every page ---------------------------------
// Logged out: "Log in" + "Join now". Logged in: one profile button with a menu.
// Phones: a menu button opens a drawer with the same links and actions.
const initials = (m) => (m.full_name || '').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  || (m.email ? m.email[0].toUpperCase() : '👤');
const firstName = (m) => (m.full_name || '').split(/\s+/)[0] || 'Account';
const contactOf = (m) => (m.emailVerified ? m.email : prettyPhone(m.phone)) || m.email || prettyPhone(m.phone);

export async function logout(all = false) {
  await api(all ? '/api/auth/logout-all' : '/api/auth/logout', {});
  rememberMember(null);
  location.href = '/';
}

// The header remembers (on this device) who is logged in, so the right buttons show instantly on every page
// instead of "Log in / Join now" flashing first. The server is still asked each time, and the header is corrected
// if anything changed (e.g. logged out on another device).
const ME_KEY = 'pbat-me';
export function cachedMember() {
  try { return JSON.parse(localStorage.getItem(ME_KEY)); } catch { return null; }
}
function rememberMember(m) {
  try {
    if (m) localStorage.setItem(ME_KEY, JSON.stringify({ full_name: m.full_name || '', email: m.email || '', phone: m.phone || '',
      role: m.role || 'volunteer', profileComplete: Boolean(m.profileComplete) }));
    else localStorage.removeItem(ME_KEY);
  } catch {}
}
const sameMember = (a, b) => JSON.stringify(a && [a.full_name, a.email, a.phone, a.role, Boolean(a.profileComplete)])
  === JSON.stringify(b && [b.full_name, b.email, b.phone, b.role, Boolean(b.profileComplete)]);

/** Fill the header for this visitor. Pass the member if the page already loaded it. */
export async function mountNav({ member, page } = {}) {
  if (member === undefined) {
    const cached = cachedMember();
    if (cached && !$('#site-nav')?._shown) renderNav(cached, page);       // instant, from this device
    const { ok, status, data } = await api('/api/me');
    member = ok ? data.member : status === 0 ? cached : null;          // offline: trust what we remembered
    if (ok || status !== 0) rememberMember(member);
    if (cached && sameMember(cached, member) && $('#site-nav')?._shown) return member;   // already right
  } else {
    rememberMember(member);
  }
  return renderNav(member, page);
}

function renderNav(member, page) {
  const nav = $('#site-nav'); if (!nav) return member;
  nav._shown = true;
  document.documentElement.classList.add('nav-ready');
  const auth = $('#nav-auth'), drawer = $('#nav-drawer'), toggle = $('#nav-toggle');
  // highlight "Home" on the home page (top of page only)
  const homeLink = $('.nav-links a[href="/"]', nav);
  if (homeLink && location.pathname === '/' && !location.hash) homeLink.setAttribute('aria-current', 'page');
  const links = $$('.nav-links a', nav).map((a) => `<a href="${a.getAttribute('href')}">${a.textContent}</a>`).join('');

  if (member) {
    auth.innerHTML = `
      <div class="user-menu">
        <button class="user-btn" type="button" aria-haspopup="menu" aria-expanded="false">
          <span class="user-avatar">${escHtml(initials(member))}</span>
          <span class="user-name">${escHtml(firstName(member))}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="user-pop" role="menu" hidden>
          <div class="user-head"><strong>${escHtml(member.full_name || 'New member')}</strong><span>${escHtml(contactOf(member))}</span></div>
          <a role="menuitem" href="/volunteer">Volunteer area</a>
          ${member.role && member.role !== 'volunteer' ? '<a role="menuitem" href="/coordinator">Coordinator view</a>' : ''}
          <a role="menuitem" href="/account">My account</a>
          <a role="menuitem" href="/account#edit">${member.profileComplete ? 'Edit my details' : 'Complete my profile'}</a>
          <hr>
          <button role="menuitem" type="button" data-logout>Log out</button>
        </div>
      </div>`;
    drawer.innerHTML = `
      <div class="drawer-user"><span class="user-avatar">${escHtml(initials(member))}</span>
        <div><strong>${escHtml(member.full_name || 'New member')}</strong><span>${escHtml(contactOf(member))}</span></div></div>
      <a href="/volunteer">Volunteer area</a>${member.role && member.role !== 'volunteer' ? '<a href="/coordinator">Coordinator view</a>' : ''}
      <a href="/account">My account</a>${links}
      <button type="button" class="drawer-logout" data-logout>Log out</button>`;
    const btn = $('.user-btn', auth), pop = $('.user-pop', auth);
    const setOpen = (open) => { pop.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(pop.hidden); });
    pop.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
    if (!nav._menuWired) {
      nav._menuWired = true;
      document.addEventListener('click', (e) => { const p = $('.user-pop', nav); if (p && !auth.contains(e.target)) { p.hidden = true; $('.user-btn', nav)?.setAttribute('aria-expanded', 'false'); } });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const p = $('.user-pop', nav); if (p) { p.hidden = true; $('.user-btn', nav)?.setAttribute('aria-expanded', 'false'); } } });
    }
  } else {
    const onLogin = page === 'login';
    auth.innerHTML = onLogin ? '' : `<a class="nav-link" href="/login">Log in</a><a class="btn small" href="/join">Join now</a>`;
    drawer.innerHTML = `${links}${onLogin ? '' : '<a href="/join" class="btn block">Join the movement</a><a href="/login" class="btn ghost block">Log in</a>'}`;
  }
  $$('[data-logout]', nav).forEach((b) => b.addEventListener('click', () => logout()));

  if (nav._wired) return member;
  nav._wired = true;
  // phone menu
  const setDrawer = (open) => {
    drawer.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); nav.classList.toggle('open', open);
  };
  toggle.addEventListener('click', () => setDrawer(drawer.hidden));
  drawer.addEventListener('click', (e) => { if (e.target.closest('a')) setDrawer(false); });
  window.addEventListener('resize', () => { if (window.innerWidth > 760) setDrawer(false); });

  // shadow once the page scrolls
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  return member;
}
export const initNav = () => mountNav();

// Small confirmation message at the bottom of the screen.
export function toast(text) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = text; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

// Images: try each source in data-sources ("a|b|c"); show initials if all fail.
export function loadImages(root = document) {
  $$('img[data-sources]', root).forEach((img) => {
    const sources = img.dataset.sources.split('|').filter(Boolean);
    let i = 0;
    const holder = img.closest('.ph');
    const next = () => {
      if (i >= sources.length) { holder?.classList.add('missing'); return; }
      img.src = sources[i++];
    };
    img.addEventListener('error', next);
    next();
  });
}

// ---- 6-digit code boxes -------------------------------------------------------
export function createOtp(container, onComplete) {
  container.innerHTML = '';
  const boxes = Array.from({ length: 6 }, (_, i) => {
    const inp = document.createElement('input');
    inp.inputMode = 'numeric'; inp.maxLength = 1;
    inp.autocomplete = i === 0 ? 'one-time-code' : 'off';
    inp.setAttribute('aria-label', `Digit ${i + 1}`);
    container.append(inp);
    return inp;
  });
  const value = () => boxes.map((b) => b.value).join('');
  const fill = (str) => {
    const d = str.replace(/\D/g, '').slice(0, 6).split('');
    boxes.forEach((b, i) => (b.value = d[i] || ''));
    boxes[Math.min(d.length, 5)].focus();
    if (d.length === 6) onComplete(value());
  };
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      container.classList.remove('error');
      if (box.value.length > 1) return fill(box.value);
      box.value = box.value.replace(/\D/g, '');
      if (box.value && i < 5) boxes[i + 1].focus();
      if (value().length === 6) onComplete(value());
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) { boxes[i - 1].focus(); boxes[i - 1].value = ''; }
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < 5) boxes[i + 1].focus();
    });
    box.addEventListener('paste', (e) => { e.preventDefault(); fill(e.clipboardData.getData('text')); });
    box.addEventListener('focus', () => box.select());
  });
  return {
    value,
    clear() { boxes.forEach((b) => (b.value = '')); boxes[0].focus(); },
    shake() { container.classList.remove('error'); void container.offsetWidth; container.classList.add('error'); },
    focus() { boxes[0].focus(); },
  };
}

// Countdown on a "Resend" button.
export function cooldown(btn, seconds, label = 'Resend code') {
  clearInterval(btn._timer);
  let left = seconds;
  const tick = () => {
    if (left <= 0) { clearInterval(btn._timer); btn.disabled = false; btn.textContent = label; return; }
    btn.disabled = true; btn.textContent = `Resend in ${left--}s`;
  };
  tick(); btn._timer = setInterval(tick, 1000);
}

// +2348031234567 -> 0803 123 4567
export const prettyPhone = (p) => { const m = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(p || ''); return m ? `0${m[1]} ${m[2]} ${m[3]}` : (p || ''); };

// ---- Profile form (used by Join and by Edit details) ---------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Date of birth is typed as DD/MM/YYYY and sent to the server as YYYY-MM-DD.
const isoToDmy = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
export function dmyToIso(dmy) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(dmy).trim());
  if (!m) return '';
  const [d, mo, y] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function autoFormatDob(input) {
  input.addEventListener('input', (e) => {
    if (e.inputType && e.inputType.startsWith('delete')) return;   // let backspace work naturally
    const d = input.value.replace(/\D/g, '').slice(0, 8);
    input.value = d.length > 4 ? `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`
      : d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
  });
}

// `v` is the member (or {}); the contact they signed in with is verified and shown locked.
export function renderProfileFields(container, opts, v = {}) {
  const field = (name, label, input, { full = false, optional = false, verified = false } = {}) => `
    <div class="field${full ? ' full' : ''}" data-field="${name}">
      <label for="f-${name}">${label}${optional ? ' <span class="opt">(optional)</span>' : ''}${verified ? ' <span class="verified">✓ Verified</span>' : ''}</label>
      ${input}
      <div class="err"></div>
    </div>`;
  const text = (name, attrs = '') => `<input id="f-${name}" name="${name}" value="${esc(name === 'phone' ? prettyPhone(v.phone) : v[name])}" ${attrs}>`;
  const select = (name, list, placeholder) => `
    <select id="f-${name}" name="${name}">
      <option value="">${placeholder}</option>
      ${list.map((o) => `<option${o === v[name] ? ' selected' : ''}>${esc(o)}</option>`).join('')}
    </select>`;
  const chosen = new Set(v.interests || []);

  container.innerHTML = `
    <fieldset>
      <legend>Your details</legend>
      <div class="grid">
        ${field('full_name', 'Full name', text('full_name', 'autocomplete="name" placeholder="e.g. Amina Bello"'), { full: true })}
        ${field('phone', 'Phone number', text('phone', `type="tel" autocomplete="tel" inputmode="tel" placeholder="0803 123 4567"${v.phoneVerified ? ' readonly' : ''}`), { optional: !v.phoneVerified, verified: v.phoneVerified })}
        ${field('email', 'Email address', text('email', `type="email" autocomplete="email" inputmode="email" placeholder="you@example.com"${v.emailVerified ? ' readonly' : ''}`), { optional: !v.emailVerified, verified: v.emailVerified })}
        ${field('gender', 'Gender', select('gender', opts.genders, 'Select…'), { optional: true })}
        ${field('date_of_birth', 'Date of birth', `<input id="f-date_of_birth" name="date_of_birth" inputmode="numeric" autocomplete="bday" placeholder="DD / MM / YYYY" maxlength="10" value="${esc(isoToDmy(v.date_of_birth))}">`, { optional: true })}
      </div>
    </fieldset>
    <fieldset>
      <legend>Where you vote</legend>
      <div class="near-box">
        <button type="button" class="btn small ghost near-btn">📍 Find polling units near me</button>
        <span class="near-status"></span>
        <div class="near-list"></div>
      </div>
      <div class="grid">
        ${field('state', 'State', select('state', opts.states, 'Select your state…'))}
        ${field('lga', 'Local government area (LGA)', `<select id="f-lga" name="lga" disabled><option value="">Choose your state first</option></select>`)}
        ${field('ward', 'Ward', `<select id="f-ward" name="ward" disabled><option value="">Choose your LGA first</option></select>`, { optional: true })}
        ${field('polling_unit', 'Polling unit', `<select id="f-polling_unit" name="polling_unit" disabled><option value="">Choose your ward first</option></select>`, { optional: true })}
        ${field('address', 'Address', text('address', 'autocomplete="street-address"'), { full: true, optional: true })}
      </div>
    </fieldset>
    <fieldset>
      <legend>How you'd like to help</legend>
      <div class="grid">
        ${field('occupation', 'Occupation', text('occupation', 'placeholder="e.g. Teacher, trader, student"'), { full: true, optional: true })}
        <div class="field full" data-field="interests">
          <label>Areas you can help with <span class="opt">(choose any)</span></label>
          <div class="chips">
            ${opts.interests.map((i) => `<label><input type="checkbox" name="interests" value="${esc(i)}"${chosen.has(i) ? ' checked' : ''}> ${esc(i)}</label>`).join('')}
          </div>
        </div>
      </div>
    </fieldset>`;
  autoFormatDob($('#f-date_of_birth', container));
  enhanceSelects(container);
  setupPlaces(container, v);
}

export function readProfileFields(container) {
  const get = (n) => $(`[name="${n}"]`, container)?.value ?? '';
  return {
    email: get('email'),
    full_name: get('full_name'), phone: get('phone'), gender: get('gender'), date_of_birth: dmyToIso(get('date_of_birth')) || (get('date_of_birth') ? 'invalid' : ''),
    state: get('state'), lga: get('lga'), ward: get('ward'), polling_unit: get('polling_unit'),
    address: get('address'), occupation: get('occupation'),
    interests: $$('[name="interests"]:checked', container).map((c) => c.value),
  };
}

// Mirrors the server's rules so people get instant feedback.
export function checkProfile(p, v = {}) {
  const e = {};
  if (p.full_name.trim().split(/\s+/).filter(Boolean).length < 2) e.full_name = 'Enter your first and last name.';
  if (!v.emailVerified && p.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p.email.trim())) e.email = 'Enter a valid email address, or leave it blank.';
  const digits = p.phone.replace(/[^\d+]/g, '');
  if (!v.phoneVerified && digits && !/^(\+?234|0)[789]\d{9}$/.test(digits)) e.phone = 'Enter a valid Nigerian phone number (e.g. 0803 123 4567), or leave it blank.';
  if (!p.date_of_birth) { /* optional */ }
  else if (p.date_of_birth === 'invalid') e.date_of_birth = 'Enter a real date as DD/MM/YYYY, e.g. 28/11/2000.';
  else {
    const dob = new Date(p.date_of_birth + 'T00:00:00'); const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    if (now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())) age--;
    if (age < 18) e.date_of_birth = 'You must be 18 or older to join.';
    else if (age > 120) e.date_of_birth = 'Check the year of your date of birth.';
  }
  if (!p.state) e.state = 'Choose your state.';
  if (p.lga.trim().length < 2) e.lga = 'Choose your local government area.';
  return e;
}

export function showFieldErrors(container, errors = {}) {
  $$('.field', container).forEach((f) => {
    const msg = errors[f.dataset.field];
    f.classList.toggle('invalid', Boolean(msg));
    const el = $('.err', f); if (el) el.textContent = msg || '';
  });
  const first = $('.field.invalid input:not([type=checkbox]), .field.invalid select', container);
  if (first) first.focus();
  return Object.keys(errors).length === 0;
}

// ---- Custom dropdowns -------------------------------------------------------
// Turns every <select> in `root` into a styled, keyboard-friendly dropdown.
// The real <select> stays in the page (hidden) and keeps the value, so forms work as before.
const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
let openDd = null;
document.addEventListener('mousedown', (e) => { if (openDd && !openDd.wrap.contains(e.target)) openDd.close(); });

export function enhanceSelects(root = document) {
  $$('select', root).forEach((select) => {
    if (select.closest('.dd')) return;
    const options = [...select.options];
    const placeholder = options.find((o) => o.value === '')?.textContent || 'Select…';
    const items = options.filter((o) => o.value !== '');
    const searchable = items.length > 8;
    const id = `${select.id || 'dd'}-list`;

    const wrap = document.createElement('div'); wrap.className = 'dd';
    select.parentNode.insertBefore(wrap, select); wrap.append(select);
    select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');

    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'dd-btn';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', id);
    const label = select.id && $(`label[for="${select.id}"]`, root);
    if (label) { label.htmlFor = ''; label.addEventListener('click', () => btn.focus()); btn.setAttribute('aria-label', label.textContent.trim()); }

    const pop = document.createElement('div'); pop.className = 'dd-pop';
    const search = searchable ? Object.assign(document.createElement('input'), { className: 'dd-search', placeholder: 'Search…', type: 'text', autocomplete: 'off' }) : null;
    const list = document.createElement('ul'); list.className = 'dd-list'; list.id = id; list.setAttribute('role', 'listbox');
    if (search) pop.append(search);
    pop.append(list); wrap.append(btn, pop);

    let visible = items, active = -1;
    const paintButton = () => {
      const cur = select.selectedOptions[0];
      btn.innerHTML = '';
      const span = document.createElement('span');
      if (cur && cur.value) span.textContent = cur.textContent; else { span.textContent = placeholder; span.className = 'ph-text'; }
      btn.append(span); btn.insertAdjacentHTML('beforeend', CHEVRON);
    };
    const paintList = () => {
      list.innerHTML = '';
      if (!visible.length) { list.innerHTML = '<li class="empty">No matches</li>'; return; }
      visible.forEach((o, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option'); li.textContent = o.textContent;
        li.setAttribute('aria-selected', String(o.value === select.value));
        if (i === active) li.classList.add('active');
        li.addEventListener('mousemove', () => { if (active !== i) { active = i; highlight(); } });
        li.addEventListener('click', () => choose(o));
        list.append(li);
      });
    };
    const highlight = () => {
      [...list.children].forEach((li, i) => li.classList.toggle('active', i === active));
      const li = list.children[active];   // scroll only the list, never the page
      if (li) {
        if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop;
        else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
      }
    };
    const choose = (o) => {
      select.value = o.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      wrap.closest('.field')?.classList.remove('invalid');
      paintButton(); close(); btn.focus({ preventScroll: true });
    };
    const open = () => {
      if (openDd && openDd.wrap !== wrap) openDd.close();
      visible = items; active = Math.max(0, items.findIndex((o) => o.value === select.value));
      if (search) search.value = '';
      paintList();
      const below = window.innerHeight - btn.getBoundingClientRect().bottom;
      wrap.classList.toggle('up', below < 320 && btn.getBoundingClientRect().top > below);
      wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
      openDd = { wrap, close };
      highlight();
      if (search) search.focus({ preventScroll: true });
    };
    function close() {
      wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
      if (openDd?.wrap === wrap) openDd = null;
    }
    const onKey = (e) => {
      const isOpen = wrap.classList.contains('open');
      if (!isOpen && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); return open(); }
      if (!isOpen) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(visible.length - 1, active + 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); highlight(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (visible[active]) choose(visible[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
      else if (e.key === 'Tab') close();
      else if (!search && e.key.length === 1) {   // type-ahead for short lists: letters typed in quick succession
        clearTimeout(wrap._tt); wrap._typed = (wrap._typed || '') + e.key.toLowerCase();
        wrap._tt = setTimeout(() => (wrap._typed = ''), 900);
        const q = wrap._typed, names = visible.map((o) => o.textContent.toLowerCase());
        let i = names.findIndex((n) => n.startsWith(q)); if (i < 0) i = names.findIndex((n) => n.includes(q));
        if (i >= 0) { active = i; highlight(); }
      }
    };
    btn.addEventListener('click', () => (wrap.classList.contains('open') ? close() : open()));
    btn.addEventListener('keydown', onKey);
    if (search) {
      search.addEventListener('keydown', onKey);
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        visible = items.filter((o) => o.textContent.toLowerCase().includes(q));
        active = visible.length ? 0 : -1; paintList();
      });
    }
    // Let showFieldErrors focus the dropdown like any other field.
    select.focus = () => btn.focus();
    paintButton();
  });
}


// ---- State > LGA > ward > polling unit (INEC lists) + "near me" ------------------
const geo = { index: null, states: {} };
async function loadState(state) {
  if (!state) return null;
  if (geo.states[state]) return geo.states[state];
  try {
    if (!geo.index) geo.index = await (await fetch('/geo/index.json')).json();
    const slug = geo.index[state]; if (!slug) return null;
    geo.states[state] = await (await fetch(`/geo/${slug}.json`)).json();
    return geo.states[state];
  } catch { return null; }
}
const puValue = (p) => `${p[0]} (${p[1]})`;

function setOptions(container, name, items, { value = '', placeholder = 'Select…', disabled = false } = {}) {
  const field = $(`[data-field="${name}"]`, container);
  const old = $('.dd', field) || $('select', field) || $('input', field);
  const sel = document.createElement('select'); sel.id = `f-${name}`; sel.name = name; sel.disabled = disabled;
  sel.append(new Option(placeholder, ''));
  for (const it of items) { const o = new Option(it.label ?? it, it.value ?? it); if ((it.value ?? it) === value) o.selected = true; sel.append(o); }
  if (value && !items.some((it) => (it.value ?? it) === value)) { const o = new Option(value, value); o.selected = true; sel.append(o); }  // keep a saved value
  old.replaceWith(sel);
  const label = $('label', field); if (label) label.htmlFor = sel.id;
  if (!disabled) enhanceSelects(field);
  else { const wrap = document.createElement('div'); wrap.className = 'dd'; sel.replaceWith(wrap); wrap.append(sel);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'dd-btn'; b.disabled = true;
    b.innerHTML = `<span class="ph-text">${placeholder}</span>`; wrap.append(b); }
}
function textInput(container, name, value, placeholder) {      // fallback if the lists can't load
  const field = $(`[data-field="${name}"]`, container);
  const old = $('.dd', field) || $('select', field) || $('input', field);
  const inp = document.createElement('input'); inp.id = `f-${name}`; inp.name = name; inp.value = value || ''; inp.placeholder = placeholder;
  old.replaceWith(inp);
}

async function fillFrom(container, sel) {   // sel: {state, lga, ward, polling_unit}
  const data = await loadState(sel.state);
  if (!data) {
    textInput(container, 'lga', sel.lga, 'e.g. Bwari'); textInput(container, 'ward', sel.ward, 'e.g. Kubwa');
    textInput(container, 'polling_unit', sel.polling_unit, 'Name or code'); return;
  }
  const L = data.lgas.find((l) => l.n === sel.lga);
  setOptions(container, 'lga', data.lgas.map((l) => l.n), { value: sel.lga, placeholder: 'Select your LGA…' });
  if (!L) {
    setOptions(container, 'ward', [], { placeholder: 'Choose your LGA first', disabled: true });
    setOptions(container, 'polling_unit', [], { placeholder: 'Choose your ward first', disabled: true }); return;
  }
  const W = L.w.find((w) => w.n === sel.ward);
  setOptions(container, 'ward', L.w.map((w) => w.n), { value: sel.ward, placeholder: `Select your ward (${L.w.length})…` });
  if (!W) { setOptions(container, 'polling_unit', [], { value: sel.polling_unit, placeholder: 'Choose your ward first', disabled: !sel.polling_unit }); return; }
  setOptions(container, 'polling_unit', W.p.map((p) => ({ value: puValue(p), label: `${p[1]} · ${p[0]}` })),
    { value: sel.polling_unit, placeholder: `Select your polling unit (${W.p.length})…` });
}

function setupPlaces(container, v) {
  const current = () => ({
    state: $('[name="state"]', container).value, lga: $('[name="lga"]', container)?.value || '',
    ward: $('[name="ward"]', container)?.value || '', polling_unit: $('[name="polling_unit"]', container)?.value || '',
  });
  if (v.state) fillFrom(container, v);
  container.addEventListener('change', (e) => {
    const n = e.target.name; const c = current();
    if (n === 'state') fillFrom(container, { state: c.state });
    if (n === 'lga') fillFrom(container, { state: c.state, lga: c.lga });
    if (n === 'ward') fillFrom(container, { state: c.state, lga: c.lga, ward: c.ward });
  });

  const btn = $('.near-btn', container), status = $('.near-status', container), list = $('.near-list', container);
  btn.addEventListener('click', () => {
    if (!navigator.geolocation) { status.textContent = "Your browser can't share your location."; return; }
    btn.disabled = true; status.textContent = 'Finding your location…'; list.innerHTML = '';
    // Try precise GPS first; indoors or on laptops that can be slow or fail, so fall back to the
    // quicker approximate location (WiFi / mobile network) before giving up.
    const getPos = (opts) => new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, opts));
    getPos({ enableHighAccuracy: true, timeout: 10000, maximumAge: 120000 })
      .catch((err) => (err.code === 1 ? Promise.reject(err)
        : (status.textContent = 'Still looking… using your approximate location', getPos({ enableHighAccuracy: false, timeout: 20000, maximumAge: 600000 }))))
      .then(async (pos) => {
      status.textContent = 'Looking up polling units…';
      const { ok, data } = await api(`/api/geo/near?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}`);
      btn.disabled = false;
      if (!ok || !data.results.length) { status.textContent = 'No polling units found near you. Choose from the lists below.'; return; }
      status.textContent = 'Tap your polling unit:';
      for (const r of data.results) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'near-item';
        const dist = r.metres < 1000 ? `${r.metres} m` : `${(r.metres / 1000).toFixed(1)} km`;
        b.innerHTML = '<strong></strong><span></span><em></em>';
        b.querySelector('strong').textContent = r.name;
        b.querySelector('span').textContent = `${r.ward}, ${r.lga}, ${r.state}`;
        b.querySelector('em').textContent = dist;
        b.addEventListener('click', async () => {
          const st = $('[name="state"]', container); st.value = r.state;
          st.closest('.dd')?.querySelector('.dd-btn span')?.replaceChildren(document.createTextNode(r.state));
          st.closest('.dd')?.querySelector('.dd-btn span')?.classList.remove('ph-text');
          await fillFrom(container, { state: r.state, lga: r.lga, ward: r.ward, polling_unit: puValue([r.name, r.code]) });
          list.innerHTML = ''; status.textContent = `✓ ${r.name} selected`;
          ['state', 'lga', 'ward', 'polling_unit'].forEach((f) => $(`[data-field="${f}"]`, container)?.classList.remove('invalid'));
        });
        list.append(b);
      }
    }).catch((err) => {
      btn.disabled = false;
      const ios = /iPhone|iPad/.test(navigator.userAgent), mac = /Macintosh/.test(navigator.userAgent) && !ios;
      const how = ios ? 'On iPhone: Settings → Privacy & Security → Location Services → turn it on, then Safari Websites → "While Using the App".'
        : mac ? 'On Mac: System Settings → Privacy & Security → Location Services → turn on for your browser (Safari or Chrome).'
        : 'Turn on Location (GPS) in your phone settings and allow this site to use your location.';
      status.textContent = err?.code === 1
        ? `Location permission was declined. To use this, allow location for this website (tap the "aA" or lock icon by the address). Or choose from the lists below.`
        : `Couldn't get your location. ${how} Or choose from the lists below.`;
    });
  });
}

// ---- Site footer (same on every page) -----------------------------------------------
// Put <footer class="site" id="site-footer"></footer> on a page and call mountFooter().
export async function mountFooter() {
  const box = document.getElementById('site-footer'); if (!box) return;
  const [{ SITE, fillSite }, { renderSocial }] = await Promise.all([import('/site-info.js'), import('/social.js')]);
  box.innerHTML = `
    <div class="wrap foot-grid">
      <div class="foot-col foot-about">
        <a class="foot-brand" href="/"><img src="/images/icon-192.png" alt="PBAT Door to Door" width="36" height="36"><b>PBAT DOOR TO DOOR</b></a>
        <p>A nationwide volunteer movement taking President Bola Ahmed Tinubu's record to every ward and polling unit.</p>
        <div class="foot-social" data-social="icons"></div>
      </div>
      <nav class="foot-col" aria-label="Explore">
        <h4>Explore</h4>
        <a href="/">Home</a><a href="/#movement">The movement</a><a href="/#about">The President</a><a href="/#works">His works</a><a href="/#gallery">Gallery</a><a href="/join">Join the movement</a>
      </nav>
      <nav class="foot-col" aria-label="About this site">
        <h4>About this site</h4>
        <a href="/privacy">Privacy policy</a><a href="/terms">Terms of use</a><a href="/contact">Contact us</a><a href="/contact#official">Official accounts</a>
      </nav>
      <div class="foot-col">
        <h4>Contact</h4>
        <a data-site-mail="email"></a>
        <span data-site-if="phone"><span data-site="phone"></span></span>
      </div>
    </div>
    <div class="wrap foot-legal">
      <span>© ${new Date().getFullYear()} <span data-site="name"></span>. Published by the <span data-site="name"></span>, <span data-site="address"></span>.</span>
    </div>`;
  fillSite(box);
  renderSocial(box);
}

// ---- Offline support ------------------------------------------------------------
// The service worker (/sw.js) saves pages, styles and photos on the phone so the site keeps working
// with poor or no signal. Registered on every page that loads this file.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  window.addEventListener('offline', () => toast("You're offline. Pages you've opened before still work."));
  window.addEventListener('online', () => toast('Back online.'));
}

// Paint the header straight away from what this device remembers; each page then confirms it with the server.
{ const m = cachedMember(); if (m && document.getElementById('nav-auth') && !location.pathname.startsWith('/login')) renderNav(m); }
