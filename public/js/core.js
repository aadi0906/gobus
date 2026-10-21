'use strict';
// Core helpers: API client, router, navbar, toast, modal. Everything lives on window.BG
window.BG = (() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

  const mkStore = (area) => ({
    get(k) { try { return window[area].getItem(k); } catch (_) { return null; } },
    set(k, v) { try { window[area].setItem(k, v); } catch (_) { /* private mode */ } },
    del(k) { try { window[area].removeItem(k); } catch (_) { /* ignore */ } },
  });
  const store = mkStore('localStorage');
  const session = mkStore('sessionStorage');

  const state = { user: null, token: store.get('bg_token'), config: { holdMinutes: 10, maxSeats: 6, feeRate: 0.02, banks: [] }, cities: [] };

  // ---------- dates / formatting
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
  const fmtDate = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const fmtShort = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  const fmtTime = (t) => { const [h, m] = t.split(':').map(Number); return `${pad(h % 12 || 12)}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`; };
  const fmtDur = (m) => `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
  const fmtStamp = (s) => { const d = new Date(`${s.replace(' ', 'T')}Z`); return isNaN(d) ? s : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const genderLabel = { M: 'Male', F: 'Female', O: 'Other' };
  const statusBadge = (st) => ({ CONFIRMED: 'b-green', PENDING: 'b-amber', CANCELLED: 'b-red', EXPIRED: 'b-gray' }[st] || 'b-gray');

  // ---------- API
  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (_) { throw new Error('Cannot reach the server. Check your connection.'); }
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401 && state.token) logout(true);
      const err = new Error(data.error || 'Request failed');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- toast + modal
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), 4200);
  }

  function formData(form) {
    const o = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') o[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
      else o[el.name] = el.value;
    }
    return o;
  }

  function modal({ title, body, submitText = 'Save', cancelText = 'Cancel', onSubmit, danger = false }) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<form class="modal" novalidate role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h3>${esc(title)}</h3><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="modal-body">${body}</div><div class="form-error" hidden></div>
      <div class="modal-foot"><button type="button" class="btn btn-ghost" data-close>${esc(cancelText)}</button>
      ${onSubmit ? `<button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="submit">${esc(submitText)}</button>` : ''}</div></form>`;
    document.body.append(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
    const form = $('form', ov);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('[type=submit]', form);
      const err = $('.form-error', form);
      err.hidden = true;
      if (btn) btn.disabled = true;
      try {
        const r = onSubmit ? await onSubmit(formData(form), form) : undefined;
        if (r !== false) close();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      finally { if (btn) btn.disabled = false; }
    });
    const first = $('input:not([type=hidden]),select', form);
    if (first) first.focus();
    return { close, el: ov };
  }

  const confirmBox = (title, message, okText = 'Yes', danger = true) =>
    new Promise((resolve) => {
      let done = false;
      const m = modal({ title, body: `<p>${message}</p>`, submitText: okText, cancelText: 'No, go back', danger, onSubmit: () => { done = true; resolve(true); } });
      const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); } });
      obs.observe(document.body, { childList: true });
    });

  // ---------- auth / session
  function setSession(token, user) {
    state.token = token; state.user = user;
    store.set('bg_token', token);
    renderNav();
  }
  function logout(expired = false) {
    state.token = null; state.user = null; store.del('bg_token');
    renderNav();
    if (expired) toast('Session expired. Please login again.', 'error');
    go('/login');
  }
  function requireLogin() {
    if (state.user) return true;
    go(`/login?next=${encodeURIComponent(location.hash.slice(1) || '/')}`);
    return false;
  }

  // ---------- router
  const routes = [];
  const leaveFns = [];
  const route = (re, fn) => routes.push([re, fn]);
  const onLeave = (fn) => leaveFns.push(fn);
  const go = (path) => { location.hash = `#${path}`; };
  const view = (html) => { $('#app').innerHTML = html; };
  const loading = (msg = 'Loading…') => view(`<div class="center-msg"><div class="spinner"></div><p>${esc(msg)}</p></div>`);
  const showError = (e, back = '/') => view(`<div class="center-msg card"><h2>Oops</h2><p>${esc(e.message || e)}</p><a class="btn btn-primary" href="#${back}">Go back</a></div>`);

  async function render() {
    while (leaveFns.length) { try { leaveFns.pop()(); } catch (_) { /* ignore */ } }
    $$('.overlay').forEach((o) => o.remove());
    const h = location.hash.slice(1) || '/';
    const [path, qs] = h.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    window.scrollTo(0, 0);
    document.body.classList.remove('nav-open');
    setActiveLink(path);
    for (const [re, fn] of routes) {
      const m = re.exec(path);
      if (m) {
        try { await fn(m, query); } catch (e) { if (e.status !== 401) showError(e); }
        return;
      }
    }
    view('<div class="center-msg card"><h2>Page not found</h2><a class="btn btn-primary" href="#/">Home</a></div>');
  }

  // ---------- navbar
  function renderNav() {
    const u = state.user;
    $('#nav').innerHTML = `<div class="container nav-in">
      <a class="brand" href="#/" aria-label="BusGo home">${logoSvg()}<span>Bus<b>Go</b></span></a>
      <button class="burger" id="burger" aria-label="Menu"><span></span><span></span><span></span></button>
      <nav class="nav-links" id="navlinks">
        <a href="#/" data-nav="/">Book Tickets</a>
        ${u ? '<a href="#/bookings" data-nav="/bookings">My Bookings</a>' : ''}
        ${u && u.role === 'admin' ? '<a href="#/admin" data-nav="/admin">Admin Panel</a>' : ''}
        <span class="nav-sep"></span>
        ${u ? `<span class="nav-user"><span class="avatar">${esc(u.name.trim()[0].toUpperCase())}</span><span class="nav-name">${esc(u.name.split(' ')[0])}</span></span><button class="btn btn-outline btn-sm" id="logoutBtn">Logout</button>`
            : '<a class="btn btn-ghost btn-sm" href="#/login">Login</a><a class="btn btn-primary btn-sm" href="#/signup">Sign up</a>'}
      </nav></div>`;
    $('#burger').onclick = () => document.body.classList.toggle('nav-open');
    const lo = $('#logoutBtn');
    if (lo) lo.onclick = () => { logout(); toast('Logged out', 'info'); };
    setActiveLink((location.hash.slice(1) || '/').split('?')[0]);
  }
  function setActiveLink(path) {
    $$('#nav [data-nav]').forEach((a) => {
      const p = a.dataset.nav;
      a.classList.toggle('active', p === '/' ? path === '/' || path.startsWith('/search') || path.startsWith('/seats') : path.startsWith(p));
    });
  }
  function logoSvg() {
    return '<svg width="30" height="30" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#e4572e"/><path d="M13 41V22a6 6 0 0 1 6-6h26a6 6 0 0 1 6 6v19z" fill="#fff"/><rect x="18" y="21" width="28" height="11" rx="2.5" fill="#14213d"/><circle cx="23" cy="45" r="4.2" fill="#14213d"/><circle cx="41" cy="45" r="4.2" fill="#14213d"/></svg>';
  }

  async function init() {
    try {
      const [config, cities] = await Promise.all([api('/config'), api('/cities')]);
      state.config = config; state.cities = cities;
    } catch (_) { /* pages will show errors when they need data */ }
    if (state.token) {
      try { state.user = (await api('/auth/me')).user; } catch (_) { state.token = null; store.del('bg_token'); }
    }
    renderNav();
    window.addEventListener('hashchange', render);
    render();
  }

  return { $, $$, esc, money, store, session, state, today, addDays, ymd, fmtDate, fmtShort, fmtTime, fmtDur, fmtStamp, genderLabel, statusBadge,
    api, toast, modal, confirmBox, formData, setSession, logout, requireLogin, route, onLeave, go, view, loading, showError, init, render, renderNav };
})();
