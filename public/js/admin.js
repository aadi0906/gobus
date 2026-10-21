'use strict';
// Admin panel: dashboard, buses, routes, schedules, seats, bookings, users
(() => {
  const { $, $$, esc, money, state, api, toast, go, view, route, fmtDate, fmtShort, fmtTime, fmtDur, statusBadge, genderLabel, confirmBox, modal } = BG;

  const TABS = [['dashboard', '📊', 'Dashboard'], ['buses', '🚌', 'Buses'], ['routes', '🛣️', 'Routes'], ['schedules', '🕒', 'Schedules'], ['seats', '💺', 'Seats'], ['bookings', '📋', 'Bookings'], ['users', '👥', 'Users']];

  const field = (label, name, value = '', attrs = '', cls = '') =>
    `<label class="field ${cls}"><span>${esc(label)}</span><input class="input" name="${name}" value="${esc(value)}" ${attrs}></label>`;
  const head = (title, sub, btn) => `<div class="admin-head"><div><h1>${esc(title)}</h1><p class="muted">${esc(sub)}</p></div>${btn ? `<button class="btn btn-primary" id="addBtn">＋ ${esc(btn)}</button>` : ''}</div>`;
  const table = (cols, rows, empty = 'Nothing here yet.') =>
    `<div class="table-wrap card"><table class="tbl"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${cols.length}" class="empty">${esc(empty)}</td></tr>`}</tbody></table></div>`;
  const actions = (id) => `<td class="act"><button class="btn btn-outline btn-sm" data-act="edit" data-id="${id}">Edit</button> <button class="btn btn-danger-outline btn-sm" data-act="del" data-id="${id}">Delete</button></td>`;
  const activeBadge = (a) => `<span class="badge ${a ? 'b-green' : 'b-gray'}">${a ? 'Active' : 'Inactive'}</span>`;

  async function remove(url, what, reload) {
    if (!(await confirmBox(`Delete ${what}?`, 'This cannot be undone. If it is in use you will be asked to deactivate it instead.', 'Delete'))) return;
    try { await api(url, { method: 'DELETE' }); toast('Deleted', 'success'); reload(); } catch (e) { toast(e.message, 'error'); }
  }

  // ------------------------------------------------------------ shell
  route(/^\/admin(?:\/(\w+))?$/, async (m) => {
    if (!BG.requireLogin()) return;
    if (state.user.role !== 'admin') return view('<div class="center-msg card"><h2>Access denied</h2><p>This area is for administrators only.</p><a class="btn btn-primary" href="#/">Home</a></div>');
    const tab = TABS.some((t) => t[0] === m[1]) ? m[1] : 'dashboard';
    view(`<div class="admin-layout">
      <nav class="admin-nav card">${TABS.map(([k, ic, l]) => `<a href="#/admin/${k}" class="${k === tab ? 'active' : ''}"><span>${ic}</span>${l}</a>`).join('')}</nav>
      <section id="adminBody" class="admin-body"><div class="center-msg"><div class="spinner"></div></div></section></div>`);
    const pages = { dashboard, buses, routes, schedules, seats, bookings, users };
    await pages[tab]($('#adminBody'));
  });

  // ------------------------------------------------------------ dashboard
  async function dashboard(el) {
    const s = await api('/admin/stats');
    const stat = (ic, label, val, cls = '') => `<div class="stat ${cls}"><span class="ic">${ic}</span><div><small>${label}</small><strong>${val}</strong></div></div>`;
    el.innerHTML = `${head('Dashboard', 'Overview of your bus business')}
      <div class="stat-grid">
        ${stat('💰', 'Net revenue', money(s.revenue), 'hl')}${stat('✅', 'Confirmed bookings', s.confirmed)}${stat('🚌', 'Travelling today', s.travellingToday)}
        ${stat('⏳', 'Awaiting payment', s.pending)}${stat('❌', 'Cancelled', s.cancelled)}${stat('👥', 'Customers', s.users)}
        ${stat('🚍', 'Buses', s.buses)}${stat('🛣️', 'Routes', s.routes)}${stat('🕒', 'Schedules', s.schedules)}
      </div>
      <div class="two-col">
        <div class="card pad"><h3>Top routes</h3>${s.topRoutes.length ? s.topRoutes.map((r) => `<div class="sum-row"><span>${esc(r.from)} → ${esc(r.to)}</span><span><strong>${r.bookings}</strong> bookings · ${money(r.amount)}</span></div>`).join('') : '<p class="muted">No confirmed bookings yet.</p>'}</div>
        <div class="card pad"><h3>Recent bookings</h3>${s.recent.length ? s.recent.map((b) => `<div class="sum-row"><span><a href="#/ticket/${b.id}">${esc(b.pnr)}</a> · ${esc(b.from)} → ${esc(b.to)}</span><span class="badge ${statusBadge(b.status)}">${b.status}</span></div>`).join('') : '<p class="muted">No bookings yet.</p>'}</div>
      </div>`;
  }

  // ------------------------------------------------------------ buses
  async function buses(el) {
    const [list, types] = await Promise.all([api('/admin/buses'), api('/admin/bus-types')]);
    el.innerHTML = head('Buses', 'Manage your fleet and seat capacity', 'Add bus') + table(
      ['Bus', 'Operator', 'Type', 'Seats', 'Amenities', 'Trips', 'Status', ''],
      list.map((b) => `<tr><td><strong>${esc(b.name)}</strong></td><td>${esc(b.operator)}</td><td>${esc(b.busType)}</td><td>${b.totalSeats}</td><td class="small">${esc(b.amenities)}</td><td>${b.schedules}</td><td>${activeBadge(b.active)}</td>${actions(b.id)}</tr>`));
    const form = (b = {}) => `<div class="form-grid">${field('Bus name', 'name', b.name, 'maxlength="60"', 'span2')}${field('Operator / company', 'operator', b.operator, 'maxlength="60"', 'span2')}
      <label class="field"><span>Bus type</span><select class="select" name="busType">${types.map((t) => `<option ${t === b.busType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      ${field('Total seats (4–60)', 'totalSeats', b.totalSeats || 40, 'type="number" min="4" max="60"')}
      ${field('Amenities (comma separated)', 'amenities', b.amenities, 'placeholder="AC,WiFi,Charging Point,Water Bottle,Blanket"', 'span2')}
      <label class="check span2"><input type="checkbox" name="active" ${b.active === false ? '' : 'checked'}> Active (visible to customers)</label></div>
      <p class="muted small">Seat layout is 2 + 2 per row. Seats are auto-numbered 1A, 1B | 1C, 1D, 2A…</p>`;
    $('#addBtn').onclick = () => modal({ title: 'Add bus', body: form(), onSubmit: async (d) => { await api('/admin/buses', { method: 'POST', body: d }); toast('Bus added', 'success'); buses(el); } });
    el.onclick = (e) => {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const b = list.find((x) => x.id === Number(btn.dataset.id));
      if (btn.dataset.act === 'edit') modal({ title: `Edit ${b.name}`, body: form(b), onSubmit: async (d) => { await api(`/admin/buses/${b.id}`, { method: 'PUT', body: d }); toast('Bus updated', 'success'); buses(el); } });
      else remove(`/admin/buses/${b.id}`, b.name, () => buses(el));
    };
  }

  // ------------------------------------------------------------ routes
  async function routes(el) {
    const list = await api('/admin/routes');
    el.innerHTML = head('Routes', 'Cities your buses travel between. Add both directions for a return route.', 'Add route') + table(
      ['From', 'To', 'Distance', 'Trips', ''], list.map((r) => `<tr><td><strong>${esc(r.from)}</strong></td><td>${esc(r.to)}</td><td>${r.distanceKm} km</td><td>${r.schedules}</td>${actions(r.id)}</tr>`));
    const form = (r = {}) => `<div class="form-grid">${field('From city', 'from', r.from, 'maxlength="40"')}${field('To city', 'to', r.to, 'maxlength="40"')}${field('Distance (km)', 'distanceKm', r.distanceKm, 'type="number" min="1" max="5000"', 'span2')}</div>`;
    $('#addBtn').onclick = () => modal({ title: 'Add route', body: form(), onSubmit: async (d) => { await api('/admin/routes', { method: 'POST', body: d }); toast('Route added', 'success'); routes(el); } });
    el.onclick = (e) => {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const r = list.find((x) => x.id === Number(btn.dataset.id));
      if (btn.dataset.act === 'edit') modal({ title: 'Edit route', body: form(r), onSubmit: async (d) => { await api(`/admin/routes/${r.id}`, { method: 'PUT', body: d }); toast('Route updated', 'success'); routes(el); } });
      else remove(`/admin/routes/${r.id}`, `${r.from} → ${r.to}`, () => routes(el));
    };
  }

  // ------------------------------------------------------------ schedules
  async function schedules(el) {
    const [list, busList, routeList] = await Promise.all([api('/admin/schedules'), api('/admin/buses'), api('/admin/routes')]);
    let q = '';
    const rowsHtml = () => list.filter((s) => `${s.from} ${s.to} ${s.busName}`.toLowerCase().includes(q))
      .map((s) => `<tr><td><strong>${esc(s.from)} → ${esc(s.to)}</strong></td><td>${esc(s.busName)}<div class="muted small">${esc(s.busType)}</div></td><td>${fmtTime(s.departureTime)}</td><td>${fmtTime(s.arrivalTime)}${s.arrivalDayOffset ? ` <sup class="plus">+${s.arrivalDayOffset}d</sup>` : ''}</td><td>${fmtDur(s.durationMin)}</td><td>${money(s.price)}</td><td>${activeBadge(s.active)}</td>${actions(s.id)}</tr>`);
    const paint = () => { $('#schBody').innerHTML = table(['Route', 'Bus', 'Departs', 'Arrives', 'Duration', 'Fare', 'Status', ''], rowsHtml()); };
    el.innerHTML = `${head('Schedules', 'A schedule = a bus running on a route at a fixed time every day, with a fare per seat.', 'Add schedule')}
      <input class="input search-in" id="schQ" placeholder="Search route or bus…"><div id="schBody"></div>`;
    paint();
    $('#schQ').oninput = (e) => { q = e.target.value.trim().toLowerCase(); paint(); };
    const form = (s = {}) => `<div class="form-grid">
      <label class="field span2"><span>Route</span><select class="select" name="routeId">${routeList.map((r) => `<option value="${r.id}" ${r.id === s.routeId ? 'selected' : ''}>${esc(r.from)} → ${esc(r.to)} (${r.distanceKm} km)</option>`).join('')}</select></label>
      <label class="field span2"><span>Bus</span><select class="select" name="busId">${busList.map((b) => `<option value="${b.id}" ${b.id === s.busId ? 'selected' : ''}>${esc(b.name)} — ${esc(b.busType)} (${b.totalSeats} seats)</option>`).join('')}</select></label>
      ${field('Departure time', 'departureTime', s.departureTime || '08:00', 'type="time"')}${field('Duration (minutes)', 'durationMin', s.durationMin || 240, 'type="number" min="10" max="3000"')}
      ${field('Fare per seat (₹)', 'price', s.price || 500, 'type="number" min="1"')}
      <label class="check"><input type="checkbox" name="active" ${s.active === false ? '' : 'checked'}> Active</label></div>`;
    $('#addBtn').onclick = () => {
      if (!busList.length || !routeList.length) return toast('Add at least one bus and one route first', 'error');
      modal({ title: 'Add schedule', body: form(), onSubmit: async (d) => { await api('/admin/schedules', { method: 'POST', body: d }); toast('Schedule added', 'success'); schedules(el); } });
    };
    el.onclick = (e) => {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const s = list.find((x) => x.id === Number(btn.dataset.id));
      if (btn.dataset.act === 'edit') modal({ title: 'Edit schedule', body: form(s), onSubmit: async (d) => { await api(`/admin/schedules/${s.id}`, { method: 'PUT', body: d }); toast('Schedule updated', 'success'); schedules(el); } });
      else remove(`/admin/schedules/${s.id}`, 'this schedule', () => schedules(el));
    };
  }

  // ------------------------------------------------------------ seats
  async function seats(el) {
    const list = await api('/admin/schedules');
    const defDate = BG.addDays(BG.today(), 1);
    el.innerHTML = `${head('Seat management', 'View who is sitting where and block seats (e.g. reserved / maintenance) for a trip.')}
      <div class="card pad filter-bar">
        <label class="field grow"><span>Bus schedule</span><select class="select" id="sSch">${list.map((s) => `<option value="${s.id}">${esc(s.from)} → ${esc(s.to)} · ${fmtTime(s.departureTime)} · ${esc(s.busName)}</option>`).join('')}</select></label>
        <label class="field"><span>Travel date</span><input class="input" type="date" id="sDate" value="${defDate}"></label>
        <button class="btn btn-primary" id="sLoad">Load seats</button>
      </div>
      <div class="seat-layout admin-seats"><div class="card seat-card"><div class="legend"><span><i class="seat available mini"></i>Free (click to block)</span><span><i class="seat booked mini"></i>Booked</span><span><i class="seat held mini"></i>Payment pending</span><span><i class="seat blocked mini"></i>Blocked (click to unblock)</span></div><div id="aSeatMap" class="bus-body"><p class="muted center">Choose a schedule and date.</p></div></div>
      <aside class="card pad sticky" id="seatInfo"><h3>Seat details</h3><p class="muted">Click a booked seat to see the passenger.</p></aside></div>`;
    let data = null;
    const load = async () => {
      const id = $('#sSch').value, date = $('#sDate').value;
      if (!id || !date) return;
      data = await api(`/admin/schedules/${id}/seats?date=${date}`);
      const rows = [];
      for (let i = 0; i < data.seats.length; i += 4) rows.push(data.seats.slice(i, i + 4));
      const sb = (s) => (s ? `<button type="button" class="seat ${s.status}" data-seat="${s.no}"><span>${s.no}</span></button>` : '<span class="seat-gap"></span>');
      const booked = data.seats.filter((s) => s.status === 'booked').length;
      $('#aSeatMap').innerHTML = `<div class="bus-front"><span class="wheel">🛞 Driver</span><span class="door">${booked}/${data.seats.length} booked</span></div>${rows.map((r) => `<div class="seat-row">${sb(r[0])}${sb(r[1])}<span class="aisle"></span>${sb(r[2])}${sb(r[3])}</div>`).join('')}`;
    };
    $('#sLoad').onclick = () => load().catch((e) => toast(e.message, 'error'));
    $('#sSch').onchange = () => load().catch((e) => toast(e.message, 'error'));
    $('#sDate').onchange = () => load().catch((e) => toast(e.message, 'error'));
    $('#aSeatMap').onclick = async (e) => {
      const b = e.target.closest('.seat[data-seat]'); if (!b || !data) return;
      const s = data.seats.find((x) => x.no === b.dataset.seat);
      if (s.passenger) {
        $('#seatInfo').innerHTML = `<h3>Seat ${esc(s.no)}</h3><div class="sum-row"><span>Passenger</span><strong>${esc(s.passenger.name)}</strong></div><div class="sum-row"><span>Age / Gender</span><strong>${s.passenger.age} / ${genderLabel[s.passenger.gender]}</strong></div><div class="sum-row"><span>PNR</span><strong>${esc(s.passenger.pnr)}</strong></div><div class="sum-row"><span>Status</span><span class="badge ${s.status === 'booked' ? 'b-green' : 'b-amber'}">${s.status === 'booked' ? 'Paid' : 'Payment pending'}</span></div>`;
        return;
      }
      try {
        const r = await api('/admin/blocks', { method: 'POST', body: { scheduleId: data.schedule.id, date: data.date, seatNo: s.no } });
        $('#seatInfo').innerHTML = `<h3>Seat ${esc(s.no)}</h3><p>${r.blocked ? 'Blocked. Customers cannot book it.' : 'Unblocked and available again.'}</p>`;
        await load();
      } catch (ex) { toast(ex.message, 'error'); }
    };
    if (list.length) load().catch((e) => toast(e.message, 'error'));
  }

  // ------------------------------------------------------------ bookings
  async function bookings(el) {
    el.innerHTML = `${head('Bookings', 'Search, view and cancel customer bookings')}
      <div class="card pad filter-bar">
        <label class="field grow"><span>Search</span><input class="input" id="bQ" placeholder="PNR, email, phone or passenger name"></label>
        <label class="field"><span>Status</span><select class="select" id="bStatus"><option value="">All</option><option>CONFIRMED</option><option>PENDING</option><option>CANCELLED</option></select></label>
        <label class="field"><span>Travel date</span><input class="input" type="date" id="bDate"></label>
        <button class="btn btn-primary" id="bGo">Search</button>
      </div><div id="bBody"></div>`;
    let list = [];
    const load = async () => {
      const qs = new URLSearchParams({ q: $('#bQ').value.trim(), status: $('#bStatus').value, date: $('#bDate').value });
      list = await api(`/admin/bookings?${qs}`);
      $('#bBody').innerHTML = table(['PNR', 'Customer', 'Trip', 'Travel date', 'Seats', 'Amount', 'Status', ''], list.map((b) => `<tr>
        <td><a href="#/ticket/${b.id}"><strong>${esc(b.pnr)}</strong></a></td><td>${esc(b.userName)}<div class="muted small">${esc(b.contactPhone)}</div></td>
        <td>${esc(b.from)} → ${esc(b.to)}<div class="muted small">${fmtTime(b.departureTime)} · ${esc(b.busName)}</div></td><td>${fmtShort(b.travelDate)}</td>
        <td>${esc(b.passengers.map((p) => p.seatNo).join(', '))}</td><td>${money(b.total)}${b.refundAmount ? `<div class="muted small">refunded ${money(b.refundAmount)}</div>` : ''}</td>
        <td><span class="badge ${statusBadge(b.status)}">${b.status}</span></td>
        <td class="act">${b.status === 'CONFIRMED' || b.status === 'PENDING' ? `<button class="btn btn-danger-outline btn-sm" data-cancel="${b.id}">Cancel</button>` : ''}</td></tr>`), 'No bookings match your search.');
    };
    $('#bGo').onclick = () => load().catch((e) => toast(e.message, 'error'));
    $('#bQ').onkeydown = (e) => { if (e.key === 'Enter') $('#bGo').click(); };
    $('#bStatus').onchange = $('#bDate').onchange = () => $('#bGo').click();
    el.onclick = async (e) => {
      const btn = e.target.closest('[data-cancel]'); if (!btn) return;
      const b = list.find((x) => x.id === Number(btn.dataset.cancel));
      const msg = b.status === 'CONFIRMED' ? `The customer will get a <strong>full refund of ${money(b.total)}</strong>.` : 'The unpaid seat hold will be released.';
      if (!(await confirmBox(`Cancel booking ${b.pnr}?`, msg, 'Cancel booking'))) return;
      try { await api(`/admin/bookings/${b.id}/cancel`, { method: 'POST' }); toast('Booking cancelled', 'success'); load(); } catch (ex) { toast(ex.message, 'error'); }
    };
    await load();
  }

  // ------------------------------------------------------------ users
  async function users(el) {
    const list = await api('/admin/users');
    el.innerHTML = head('Users', 'Registered accounts') + table(['Name', 'Email', 'Phone', 'Role', 'Bookings', 'Joined'],
      list.map((u) => `<tr><td><strong>${esc(u.name)}</strong></td><td>${esc(u.email)}</td><td>${esc(u.phone || '–')}</td><td><span class="badge ${u.role === 'admin' ? 'b-blue' : 'b-gray'}">${u.role}</span></td><td>${u.bookings}</td><td>${esc(BG.fmtStamp(u.createdAt))}</td></tr>`));
  }
})();
