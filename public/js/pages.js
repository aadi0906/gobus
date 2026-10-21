'use strict';
// Customer-facing pages: home/search, results, seats, passengers, payment, ticket, my bookings, login/signup
(() => {
  const { $, $$, esc, money, state, api, toast, go, view, loading, route, onLeave, fmtDate, fmtShort, fmtTime, fmtDur, genderLabel, statusBadge } = BG;

  const AMENITY_ICON = { AC: '❄️', WiFi: '📶', 'Charging Point': '🔌', 'Water Bottle': '💧', Blanket: '🛏️', Snacks: '🍪', 'Reading Light': '💡' };
  const amenityChips = (list) => list.map((a) => `<span class="chip" title="${esc(a)}">${AMENITY_ICON[a] || '✓'} ${esc(a)}</span>`).join('');
  const arrLabel = (o) => `${fmtTime(o.arrivalTime)}${o.arrivalDayOffset ? `<sup class="plus">+${o.arrivalDayOffset}d</sup>` : ''}`;
  const refundPct = (travelDate, dep) => {
    const hrs = (new Date(`${travelDate}T${dep}:00`) - Date.now()) / 3600000;
    return hrs >= 24 ? 0.9 : hrs >= 12 ? 0.75 : hrs >= 4 ? 0.5 : 0;
  };

  // =========================================================== HOME
  route(/^\/$/, async () => {
    let last = {};
    try { last = JSON.parse(BG.store.get('bg_last') || '{}'); } catch (_) { /* ignore */ }
    const t = BG.today();
    const date = last.date && last.date >= t ? last.date : BG.addDays(t, 1);
    view(`
    <section class="hero">
      <div class="hero-text">
        <span class="eyebrow">Simple &amp; secure bus booking</span>
        <h1>Your seat is just <em>a few taps</em> away</h1>
        <p>Compare buses, pick your exact seat and get an instant e-ticket — all in one place.</p>
        <ul class="hero-points"><li>✓ Live seat availability</li><li>✓ UPI, Cards &amp; Net Banking</li><li>✓ Easy cancellation &amp; refund</li></ul>
      </div>
      <form class="search-card" id="searchForm" novalidate>
        <h2>Where are you going?</h2>
        <div class="search-grid">
          <label class="sfield"><span>From</span><input name="from" list="cityList" autocomplete="off" placeholder="Leaving from" value="${esc(last.from || '')}"></label>
          <button type="button" class="swap" id="swapBtn" aria-label="Swap cities" title="Swap">⇄</button>
          <label class="sfield"><span>To</span><input name="to" list="cityList" autocomplete="off" placeholder="Going to" value="${esc(last.to || '')}"></label>
          <label class="sfield"><span>Travel date</span><input type="date" name="date" min="${t}" value="${date}"></label>
          <button class="btn btn-primary btn-lg" type="submit">Search buses</button>
        </div>
        <datalist id="cityList">${state.cities.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        <div class="quick-dates"><button type="button" data-d="0">Today</button><button type="button" data-d="1">Tomorrow</button><button type="button" data-d="2">Day after</button></div>
        <div class="form-error" id="sErr" hidden></div>
      </form>
    </section>
    <section class="section"><h2 class="sec-title">Popular routes</h2><div class="route-grid" id="popular"><div class="muted">Loading routes…</div></div></section>
    <section class="section features">
      <div class="feature"><span>🔒</span><h3>Secure payments</h3><p>UPI, debit &amp; credit cards and net banking.</p></div>
      <div class="feature"><span>💺</span><h3>Choose your seat</h3><p>See the live seat map and pick exactly where you sit.</p></div>
      <div class="feature"><span>🎫</span><h3>Instant e-ticket</h3><p>Get your ticket with QR code immediately. No printout needed.</p></div>
      <div class="feature"><span>↩️</span><h3>Easy cancellation</h3><p>Cancel online and get your refund automatically.</p></div>
    </section>`);

    const form = $('#searchForm');
    $('#swapBtn').onclick = () => { const a = form.from.value; form.from.value = form.to.value; form.to.value = a; };
    $$('.quick-dates button').forEach((b) => { b.onclick = () => { form.date.value = BG.addDays(BG.today(), Number(b.dataset.d)); }; });
    form.onsubmit = (e) => {
      e.preventDefault();
      const from = form.from.value.trim(), to = form.to.value.trim(), d = form.date.value;
      const err = $('#sErr');
      const msg = !from || !to ? 'Please enter both From and To cities' : from.toLowerCase() === to.toLowerCase() ? 'From and To cities cannot be the same'
        : !d ? 'Please choose a travel date' : d < BG.today() ? 'Travel date cannot be in the past' : '';
      err.hidden = !msg; err.textContent = msg;
      if (msg) return;
      BG.store.set('bg_last', JSON.stringify({ from, to, date: d }));
      go(`/search?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${d}`);
    };
    try {
      const pop = await api('/popular-routes');
      $('#popular').innerHTML = pop.map((r) => `<button class="route-card" data-from="${esc(r.from)}" data-to="${esc(r.to)}"><strong>${esc(r.from)} <i>→</i> ${esc(r.to)}</strong><small>from ${money(r.price)}</small></button>`).join('') || '<div class="muted">No routes yet.</div>';
      $$('.route-card').forEach((c) => { c.onclick = () => { form.from.value = c.dataset.from; form.to.value = c.dataset.to; form.requestSubmit(); }; });
    } catch (_) { $('#popular').innerHTML = ''; }
  });

  // =========================================================== SEARCH RESULTS
  route(/^\/search$/, async (m, q) => {
    const { from, to, date } = q;
    if (!from || !to || !date) return go('/');
    loading('Finding the best buses…');
    let data;
    try { data = await api(`/buses/search?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${date}`); }
    catch (e) { return view(`<div class="center-msg card"><h2>Can't search</h2><p>${esc(e.message)}</p><a class="btn btn-primary" href="#/">Change search</a></div>`); }

    const f = { types: new Set(), slot: '', sort: 'time' };
    const types = [...new Set(data.buses.map((b) => b.busType))];
    const nav = (d) => `#/search?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${d}`;
    const slotOf = (t) => { const h = Number(t.slice(0, 2)); return h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 21 ? 'evening' : 'night'; };

    view(`
    <div class="results-head card">
      <div><h1 class="r-title">${esc(data.from)} <i>→</i> ${esc(data.to)}</h1><div class="muted">${fmtDate(date)} · <span id="count"></span></div></div>
      <div class="date-nav">
        <a class="btn btn-outline btn-sm ${date <= BG.today() ? 'disabled' : ''}" ${date <= BG.today() ? 'aria-disabled="true" tabindex="-1"' : ''} href="${date <= BG.today() ? nav(date) : nav(BG.addDays(date, -1))}">← Prev day</a>
        <a class="btn btn-outline btn-sm" href="${nav(BG.addDays(date, 1))}">Next day →</a>
        <a class="btn btn-ghost btn-sm" href="#/">Modify search</a>
      </div>
    </div>
    <div class="results-layout">
      <aside class="filters card">
        <h3>Filters</h3>
        <div class="f-group"><h4>Bus type</h4>${types.map((t) => `<label class="check"><input type="checkbox" data-type="${esc(t)}"> ${esc(t)}</label>`).join('') || '<span class="muted">–</span>'}</div>
        <div class="f-group"><h4>Departure time</h4>
          ${[['morning', '🌅 Morning (5am–12pm)'], ['afternoon', '☀️ Afternoon (12–5pm)'], ['evening', '🌆 Evening (5–9pm)'], ['night', '🌙 Night (9pm–5am)']].map(([k, l]) => `<label class="check"><input type="radio" name="slot" value="${k}"> ${l}</label>`).join('')}
          <label class="check"><input type="radio" name="slot" value="" checked> Any time</label></div>
        <div class="f-group"><h4>Sort by</h4><select id="sort" class="select"><option value="time">Earliest departure</option><option value="price">Lowest price</option><option value="seats">Most seats left</option><option value="duration">Shortest trip</option></select></div>
      </aside>
      <div id="busList" class="bus-list"></div>
    </div>`);

    const paint = () => {
      let list = data.buses.filter((b) => (!f.types.size || f.types.has(b.busType)) && (!f.slot || slotOf(b.departureTime) === f.slot));
      const sorters = { time: (a, b) => a.departureTime.localeCompare(b.departureTime), price: (a, b) => a.price - b.price, seats: (a, b) => b.availableSeats - a.availableSeats, duration: (a, b) => a.durationMin - b.durationMin };
      list = list.sort(sorters[f.sort]);
      $('#count').textContent = `${list.length} bus${list.length === 1 ? '' : 'es'} found`;
      $('#busList').innerHTML = list.map((b) => `
      <article class="bus-card card">
        <div class="bus-main">
          <h3>${esc(b.busName)} <span class="badge b-blue">${esc(b.busType)}</span></h3>
          <div class="muted">${esc(b.operator)}</div>
          <div class="chips">${amenityChips(b.amenities)}</div>
        </div>
        <div class="bus-times">
          <div class="tm"><strong>${fmtTime(b.departureTime)}</strong><small>${esc(b.from)}</small></div>
          <div class="dur"><span>${fmtDur(b.durationMin)}</span><i></i></div>
          <div class="tm"><strong>${arrLabel(b)}</strong><small>${esc(b.to)}</small></div>
        </div>
        <div class="bus-side">
          <div class="price">${money(b.price)}<small>/ seat</small></div>
          <div class="seats-left ${b.availableSeats <= 5 ? 'low' : ''}">${b.availableSeats ? `${b.availableSeats} seats left` : 'Sold out'}</div>
          ${b.availableSeats ? `<a class="btn btn-primary" href="#/seats/${b.id}?date=${date}">Select seats</a>` : '<button class="btn btn-outline" disabled>Sold out</button>'}
        </div>
      </article>`).join('') || `<div class="center-msg card"><h3>No buses found</h3><p class="muted">${data.buses.length ? 'Try removing some filters.' : 'No buses on this route/date. Try another date or route.'}</p></div>`;
    };
    $$('[data-type]').forEach((c) => { c.onchange = () => { c.checked ? f.types.add(c.dataset.type) : f.types.delete(c.dataset.type); paint(); }; });
    $$('[name=slot]').forEach((r) => { r.onchange = () => { f.slot = r.value; paint(); }; });
    $('#sort').onchange = (e) => { f.sort = e.target.value; paint(); };
    paint();
  });

  // =========================================================== SEAT SELECTION
  route(/^\/seats\/(\d+)$/, async (m, q) => {
    const id = m[1], date = q.date;
    if (!date) return go('/');
    loading('Loading seat map…');
    const data = await api(`/schedules/${id}/seats?date=${date}`);
    const sch = data.schedule, max = data.maxSeats;
    const free = new Set(data.seats.filter((s) => s.status === 'available').map((s) => s.no));
    let selected = [];
    try {
      const prev = JSON.parse(BG.session.get('bg_pending') || 'null');
      if (prev && String(prev.scheduleId) === id && prev.date === date) selected = prev.seats.filter((s) => free.has(s));
    } catch (_) { /* ignore */ }

    const rows = [];
    for (let i = 0; i < data.seats.length; i += 4) rows.push(data.seats.slice(i, i + 4));
    const seatBtn = (s) => s ? `<button type="button" class="seat ${s.status}" data-seat="${s.no}" ${s.status === 'available' ? '' : 'disabled'} aria-label="Seat ${s.no}, ${s.status}" aria-pressed="false"><span>${s.no}</span></button>` : '<span class="seat-gap"></span>';
    const back = `#/search?from=${encodeURIComponent(sch.from)}&to=${encodeURIComponent(sch.to)}&date=${date}`;

    view(`
    <div class="crumbs"><a href="${back}">← Back to buses</a></div>
    <div class="seat-layout">
      <section class="card seat-card">
        <h2>Select your seats</h2><p class="muted">You can book up to ${max} seats at a time.</p>
        <div class="legend"><span><i class="seat available mini"></i>Available</span><span><i class="seat sel mini"></i>Selected</span><span><i class="seat booked mini"></i>Booked</span><span><i class="seat blocked mini"></i>Unavailable</span></div>
        <div class="bus-body" id="seatMap">
          <div class="bus-front"><span class="wheel">🛞 Driver</span><span class="door">Door</span></div>
          ${rows.map((r) => `<div class="seat-row">${seatBtn(r[0])}${seatBtn(r[1])}<span class="aisle"></span>${seatBtn(r[2])}${seatBtn(r[3])}</div>`).join('')}
        </div>
      </section>
      <aside class="card summary sticky">
        <h3>${esc(sch.busName)} <span class="badge b-blue">${esc(sch.busType)}</span></h3>
        <div class="muted">${esc(sch.operator)}</div>
        <div class="trip-mini">
          <div><strong>${fmtTime(sch.departureTime)}</strong><small>${esc(sch.from)}</small></div><i>→</i>
          <div><strong>${arrLabel(sch)}</strong><small>${esc(sch.to)}</small></div>
        </div>
        <div class="muted">${fmtDate(date)} · ${fmtDur(sch.durationMin)}</div>
        <hr>
        <div class="sum-row"><span>Selected seats</span><strong id="selList">–</strong></div>
        <div class="sum-row"><span>Fare (<span id="selN">0</span> × ${money(sch.price)})</span><strong id="fare">${money(0)}</strong></div>
        <div class="sum-row muted"><span>Convenience fee</span><span id="fee">${money(0)}</span></div>
        <div class="sum-row total"><span>Total</span><strong id="total">${money(0)}</strong></div>
        <button class="btn btn-primary btn-block btn-lg" id="continueBtn" disabled>Continue</button>
      </aside>
    </div>`);

    const paint = () => {
      $$('.seat[data-seat]').forEach((b) => { const on = selected.includes(b.dataset.seat); b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on); });
      const fare = sch.price * selected.length, fee = Math.round(fare * state.config.feeRate);
      $('#selList').textContent = selected.length ? [...selected].sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b)).join(', ') : '–';
      $('#selN').textContent = selected.length; $('#fare').textContent = money(fare); $('#fee').textContent = money(fee); $('#total').textContent = money(fare + fee);
      $('#continueBtn').disabled = !selected.length;
    };
    $('#seatMap').onclick = (e) => {
      const b = e.target.closest('.seat[data-seat]');
      if (!b || b.disabled) return;
      const no = b.dataset.seat;
      if (selected.includes(no)) selected = selected.filter((s) => s !== no);
      else if (selected.length >= max) return toast(`You can select up to ${max} seats only`, 'error');
      else selected.push(no);
      paint();
    };
    $('#continueBtn').onclick = () => {
      BG.session.set('bg_pending', JSON.stringify({ scheduleId: id, date, seats: selected, schedule: sch }));
      go('/passengers');
    };
    paint();
  });

  // =========================================================== PASSENGER DETAILS
  route(/^\/passengers$/, async () => {
    let p = null;
    try { p = JSON.parse(BG.session.get('bg_pending') || 'null'); } catch (_) { /* ignore */ }
    if (!p || !p.seats || !p.seats.length) return go('/');
    if (!BG.requireLogin()) return;
    const sch = p.schedule;
    const seats = [...p.seats].sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b));
    const fare = sch.price * seats.length, fee = Math.round(fare * state.config.feeRate);
    const u = state.user;

    view(`
    <div class="crumbs"><a href="#/seats/${p.scheduleId}?date=${p.date}">← Change seats</a></div>
    <div class="steps-bar"><span class="done">1 Seats</span><span class="active">2 Passengers</span><span>3 Payment</span><span>4 E-ticket</span></div>
    <form class="seat-layout" id="paxForm" novalidate>
      <section>
        <div class="card"><h2>Passenger details</h2>
          ${seats.map((s, i) => `
          <fieldset class="pax">
            <legend>Passenger ${i + 1} <span class="badge b-blue">Seat ${s}</span></legend>
            <div class="form-row">
              <label class="field grow"><span>Full name</span><input class="input" name="name${i}" maxlength="60" autocomplete="off" placeholder="As on ID proof" ${i === 0 ? `value="${esc(u.name)}"` : ''}></label>
              <label class="field w90"><span>Age</span><input class="input" name="age${i}" type="number" min="1" max="120" inputmode="numeric" placeholder="Age"></label>
              <label class="field w140"><span>Gender</span><select class="select" name="gender${i}"><option value="">Select</option><option value="M">Male</option><option value="F">Female</option><option value="O">Other</option></select></label>
            </div>
          </fieldset>`).join('')}
        </div>
        <div class="card"><h2>Contact details</h2><p class="muted">Your e-ticket details will be shown here and on My Bookings.</p>
          <div class="form-row">
            <label class="field grow"><span>Mobile number</span><input class="input" name="phone" inputmode="numeric" maxlength="10" placeholder="10-digit mobile" value="${esc(u.phone || '')}"></label>
            <label class="field grow"><span>Email</span><input class="input" name="email" type="email" placeholder="you@example.com" value="${esc(u.email)}"></label>
          </div>
        </div>
      </section>
      <aside class="card summary sticky">
        <h3>${esc(sch.from)} <i>→</i> ${esc(sch.to)}</h3>
        <div class="muted">${fmtDate(p.date)} · ${fmtTime(sch.departureTime)}</div>
        <div class="muted">${esc(sch.busName)} (${esc(sch.busType)})</div><hr>
        <div class="sum-row"><span>Seats</span><strong>${seats.join(', ')}</strong></div>
        <div class="sum-row"><span>Fare (${seats.length} × ${money(sch.price)})</span><strong>${money(fare)}</strong></div>
        <div class="sum-row muted"><span>Convenience fee (${Math.round(state.config.feeRate * 100)}%)</span><span>${money(fee)}</span></div>
        <div class="sum-row total"><span>Total payable</span><strong>${money(fare + fee)}</strong></div>
        <div class="form-error" id="pErr" hidden></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit" id="goPay">Proceed to payment</button>
        <p class="muted small center">Seats are held for ${state.config.holdMinutes} minutes after this step.</p>
      </aside>
    </form>`);

    $('#paxForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, err = $('#pErr');
      const show = (m) => { err.textContent = m; err.hidden = false; err.scrollIntoView({ block: 'nearest' }); };
      err.hidden = true;
      const passengers = [];
      for (let i = 0; i < seats.length; i++) {
        const name = f[`name${i}`].value.trim(), age = Number(f[`age${i}`].value), gender = f[`gender${i}`].value;
        if (name.length < 2) return show(`Enter the name for passenger ${i + 1}`);
        if (!Number.isInteger(age) || age < 1 || age > 120) return show(`Enter a valid age for passenger ${i + 1}`);
        if (!gender) return show(`Select gender for passenger ${i + 1}`);
        passengers.push({ seatNo: seats[i], name, age, gender });
      }
      const phone = f.phone.value.trim(), email = f.email.value.trim();
      if (!/^[6-9]\d{9}$/.test(phone)) return show('Enter a valid 10-digit mobile number');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return show('Enter a valid email address');
      const btn = $('#goPay'); btn.disabled = true; btn.textContent = 'Reserving seats…';
      try {
        const b = await api('/bookings', { method: 'POST', body: { scheduleId: Number(p.scheduleId), date: p.date, passengers, phone, email } });
        BG.session.del('bg_pending');
        go(`/pay/${b.id}`);
      } catch (ex) {
        btn.disabled = false; btn.textContent = 'Proceed to payment';
        if (ex.status === 409) { toast(ex.message, 'error'); go(`/seats/${p.scheduleId}?date=${p.date}`); } else show(ex.message);
      }
    };
  });

  // =========================================================== PAYMENT
  route(/^\/pay\/(\d+)$/, async (m) => {
    if (!BG.requireLogin()) return;
    loading();
    const b = await api(`/bookings/${m[1]}`);
    if (b.status === 'CONFIRMED') return go(`/ticket/${b.id}`);
    if (b.status !== 'PENDING') return view(`<div class="center-msg card"><h2>Booking ${b.status === 'CANCELLED' ? 'cancelled' : 'expired'}</h2><p>The seats were released. Please search again.</p><a class="btn btn-primary" href="#/">Search buses</a></div>`);

    const offset = b.serverNow - Date.now();
    const methods = [['UPI', 'UPI', '📱', 'Pay using any UPI app'], ['DEBIT_CARD', 'Debit Card', '💳', 'Visa, Mastercard, RuPay'], ['CREDIT_CARD', 'Credit Card', '💳', 'Visa, Mastercard, Amex'], ['NET_BANKING', 'Net Banking', '🏦', 'All major banks']];
    let method = 'UPI', busy = false;

    view(`
    <div class="steps-bar"><span class="done">1 Seats</span><span class="done">2 Passengers</span><span class="active">3 Payment</span><span>4 E-ticket</span></div>
    <div class="timer-bar" id="timerBar">⏱ Complete payment in <strong id="timer">--:--</strong> to keep your seats</div>
    <div class="seat-layout">
      <section class="card pay-card">
        <h2>Choose payment method</h2>
        <div class="demo-note">🧪 <strong>Demo mode:</strong> no real money is charged. Test card <code>4111 1111 1111 1111</code>, any future expiry, any CVV. UPI: any ID like <code>test@okhdfcbank</code>.</div>
        <div class="pay-layout">
          <div class="pay-tabs" role="tablist">${methods.map(([k, l, ic, sub]) => `<button type="button" class="pay-tab ${k === method ? 'active' : ''}" data-m="${k}" role="tab"><span class="ic">${ic}</span><span><strong>${l}</strong><small>${sub}</small></span></button>`).join('')}</div>
          <div class="pay-panel" id="payPanel">
            <div data-panel="UPI">
              <label class="field"><span>UPI ID</span><input class="input" id="upiId" placeholder="mobile@okhdfcbank" autocomplete="off"></label>
              <div class="chips upi-chips">${['@okhdfcbank', '@oksbi', '@okaxis', '@ybl', '@paytm'].map((s) => `<button type="button" class="chip btn-chip" data-suffix="${s}">${s}</button>`).join('')}</div>
              <p class="muted small">You will get a collect request on your UPI app. Approve it to pay.</p>
            </div>
            <div data-panel="CARD" hidden>
              <label class="field"><span>Card number</span><input class="input" id="cardNumber" inputmode="numeric" autocomplete="off" placeholder="1234 5678 9012 3456" maxlength="23"></label>
              <div class="form-row">
                <label class="field grow"><span>Expiry (MM/YY)</span><input class="input" id="expiry" inputmode="numeric" autocomplete="off" placeholder="MM/YY" maxlength="5"></label>
                <label class="field grow"><span>CVV</span><input class="input" id="cvv" type="password" inputmode="numeric" autocomplete="off" placeholder="•••" maxlength="4"></label>
              </div>
              <label class="field"><span>Name on card</span><input class="input" id="cardName" autocomplete="off" placeholder="As printed on card"></label>
              <p class="muted small">🔒 Card details are used only for this payment and are never stored.</p>
            </div>
            <div data-panel="NET_BANKING" hidden>
              <div class="bank-grid">${state.config.banks.map((bk, i) => `<label class="bank"><input type="radio" name="bank" value="${esc(bk)}" ${i === 0 ? 'checked' : ''}><span>🏦 ${esc(bk)}</span></label>`).join('')}</div>
              <p class="muted small">You will be redirected to your bank to complete the payment.</p>
            </div>
            <div class="form-error" id="payErr" hidden></div>
            <button class="btn btn-primary btn-block btn-lg" id="payBtn">Pay ${money(b.total)} securely</button>
          </div>
        </div>
      </section>
      <aside class="card summary sticky">
        <h3>${esc(b.from)} <i>→</i> ${esc(b.to)}</h3>
        <div class="muted">${fmtDate(b.travelDate)} · ${fmtTime(b.departureTime)}</div>
        <div class="muted">${esc(b.busName)} (${esc(b.busType)})</div><hr>
        ${b.passengers.map((x) => `<div class="sum-row"><span>${esc(x.name)} <small class="muted">(${genderLabel[x.gender][0]}, ${x.age})</small></span><span class="badge b-blue">${esc(x.seatNo)}</span></div>`).join('')}<hr>
        <div class="sum-row"><span>Fare</span><span>${money(b.fare)}</span></div>
        <div class="sum-row muted"><span>Convenience fee</span><span>${money(b.fee)}</span></div>
        <div class="sum-row total"><span>Total</span><strong>${money(b.total)}</strong></div>
        <div class="muted small">PNR: <strong>${esc(b.pnr)}</strong></div>
      </aside>
    </div>`);

    // countdown
    const tick = () => {
      const left = Math.max(0, Math.floor((b.holdExpiresAt - (Date.now() + offset)) / 1000));
      $('#timer').textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
      $('#timerBar').classList.toggle('urgent', left < 60);
      if (left === 0 && !busy) { clearInterval(timer); expired(); }
    };
    const timer = setInterval(tick, 1000);
    onLeave(() => clearInterval(timer));
    const expired = () => view('<div class="center-msg card"><h2>⏱ Time is up</h2><p>Your seat hold expired and the seats were released.</p><a class="btn btn-primary" href="#/">Search again</a></div>');

    tick();
    const panelFor = (k) => (k === 'DEBIT_CARD' || k === 'CREDIT_CARD' ? 'CARD' : k);
    $$('.pay-tab').forEach((t) => {
      t.onclick = () => {
        method = t.dataset.m;
        $$('.pay-tab').forEach((x) => x.classList.toggle('active', x === t));
        $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== panelFor(method); });
        $('#payErr').hidden = true;
      };
    });
    $$('[data-suffix]').forEach((c) => {
      c.onclick = () => { const i = $('#upiId'); i.value = `${i.value.split('@')[0]}${c.dataset.suffix}`; i.focus(); };
    });
    $('#cardNumber').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 '); };
    $('#expiry').oninput = (e) => { let v = e.target.value.replace(/\D/g, '').slice(0, 4); if (v.length > 2) v = `${v.slice(0, 2)}/${v.slice(2)}`; e.target.value = v; };
    $('#cvv').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); };

    $('#payBtn').onclick = async () => {
      const err = $('#payErr'), btn = $('#payBtn');
      err.hidden = true;
      let details;
      if (method === 'UPI') details = { upiId: $('#upiId').value.trim() };
      else if (method === 'NET_BANKING') details = { bank: ($('[name=bank]:checked') || {}).value };
      else details = { cardNumber: $('#cardNumber').value, expiry: $('#expiry').value, cvv: $('#cvv').value, cardName: $('#cardName').value };
      busy = true; btn.disabled = true; btn.innerHTML = '<span class="spinner sm"></span> Processing… please do not refresh';
      try {
        await api(`/bookings/${b.id}/pay`, { method: 'POST', body: { method, details } });
        clearInterval(timer);
        toast('Payment successful! Your ticket is confirmed.', 'success');
        go(`/ticket/${b.id}`);
      } catch (ex) {
        busy = false; btn.disabled = false; btn.textContent = `Pay ${money(b.total)} securely`;
        if (ex.status === 410) return expired();
        err.textContent = ex.message; err.hidden = false;
      }
    };
  });

  // =========================================================== E-TICKET
  let qrLoading = null;
  const loadQr = () => {
    if (window.QRCode) return Promise.resolve(true);
    if (!qrLoading) qrLoading = new Promise((res) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = () => res(true); s.onerror = () => res(false);
      document.head.append(s);
    });
    return qrLoading;
  };

  route(/^\/ticket\/(\d+)$/, async (m) => {
    if (!BG.requireLogin()) return;
    loading('Loading ticket…');
    const b = await api(`/bookings/${m[1]}`);
    if (b.status === 'PENDING') return go(`/pay/${b.id}`);
    const mine = b.userEmail === state.user.email;
    const canCancel = mine && b.status === 'CONFIRMED' && !b.isPast;
    const seatsTxt = b.passengers.map((p) => p.seatNo).join(', ');
    const ok = b.status === 'CONFIRMED';

    view(`
    <div class="crumbs no-print"><a href="#/bookings">← My bookings</a></div>
    <article class="ticket ${ok ? '' : 'void'}">
      ${ok ? '' : `<div class="stamp">${esc(b.status)}</div>`}
      <header class="ticket-head">
        <div><div class="t-label">E-TICKET</div><h1>${esc(b.from)} <i>→</i> ${esc(b.to)}</h1></div>
        <span class="badge ${statusBadge(b.status)} lg">${esc(b.status)}</span>
      </header>
      <div class="ticket-body">
        <div class="t-left">
          <div class="t-times">
            <div><small>Departure</small><strong>${fmtTime(b.departureTime)}</strong><span>${fmtDate(b.travelDate)}</span></div>
            <div class="t-mid">${fmtDur(b.durationMin)}<i></i></div>
            <div><small>Arrival</small><strong>${arrLabel(b)}</strong><span>${esc(b.to)}</span></div>
          </div>
          <div class="t-grid">
            <div><small>Bus</small><strong>${esc(b.busName)}</strong><span>${esc(b.operator)} · ${esc(b.busType)}</span></div>
            <div><small>Seats</small><strong>${esc(seatsTxt)}</strong><span>${b.passengers.length} passenger${b.passengers.length > 1 ? 's' : ''}</span></div>
            <div><small>Contact</small><strong>${esc(b.contactPhone)}</strong><span>${esc(b.contactEmail)}</span></div>
            <div><small>Booked on</small><strong>${BG.fmtStamp(b.createdAt)}</strong><span>${esc(b.paymentSummary || '')}</span></div>
          </div>
          <table class="tbl small"><thead><tr><th>#</th><th>Passenger</th><th>Age</th><th>Gender</th><th>Seat</th></tr></thead>
            <tbody>${b.passengers.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${p.age}</td><td>${genderLabel[p.gender]}</td><td><span class="badge b-blue">${esc(p.seatNo)}</span></td></tr>`).join('')}</tbody></table>
        </div>
        <div class="t-tear"></div>
        <div class="t-right">
          <div class="t-label">PNR</div><div class="pnr">${esc(b.pnr)}</div>
          <div id="qr" class="qr"></div>
          <div class="t-amt"><small>Amount paid</small><strong>${money(b.total)}</strong>
            ${b.status === 'CANCELLED' ? `<span class="refund">Refunded: ${money(b.refundAmount)}</span>` : `<span class="muted">Fare ${money(b.fare)} + fee ${money(b.fee)}</span>`}
            ${b.paymentRef ? `<span class="muted">Txn: ${esc(b.paymentRef)}</span>` : ''}</div>
        </div>
      </div>
      <footer class="ticket-foot">Carry a valid photo ID. Please arrive 15 minutes before departure and show this e-ticket (PNR / QR) to the conductor.</footer>
    </article>
    <div class="ticket-actions no-print">
      ${ok ? '<button class="btn btn-primary" id="printBtn">🖨️ Print / Save as PDF</button>' : ''}
      ${canCancel ? '<button class="btn btn-danger-outline" id="cancelBtn">Cancel ticket</button>' : ''}
      <a class="btn btn-outline" href="#/">Book another trip</a>
    </div>`);

    if (ok) loadQr().then((loaded) => {
      const el = $('#qr');
      if (!loaded || !el || !window.QRCode) { if (el) el.remove(); return; }
      new window.QRCode(el, { text: `BUSGO|${b.pnr}|${b.from}-${b.to}|${b.travelDate} ${b.departureTime}|${seatsTxt}`, width: 112, height: 112, correctLevel: window.QRCode.CorrectLevel.M });
    }); else { const el = $('#qr'); if (el) el.remove(); }

    const pb = $('#printBtn'); if (pb) pb.onclick = () => window.print();
    const cb = $('#cancelBtn');
    if (cb) cb.onclick = async () => {
      const pct = refundPct(b.travelDate, b.departureTime), refund = Math.round(b.total * pct);
      const yes = await BG.confirmBox('Cancel this ticket?',
        `Refund policy: 90% if &gt;24h before departure, 75% if &gt;12h, 50% if &gt;4h, otherwise no refund.<br><br>You will receive <strong>${money(refund)}</strong> (${Math.round(pct * 100)}%) back to your original payment method.`, 'Yes, cancel ticket');
      if (!yes) return;
      try {
        const r = await api(`/bookings/${b.id}/cancel`, { method: 'POST' });
        toast(`Ticket cancelled. Refund of ${money(r.refund)} initiated.`, 'success');
        BG.render();
      } catch (ex) { toast(ex.message, 'error'); }
    };
  });

  // =========================================================== MY BOOKINGS
  route(/^\/bookings$/, async () => {
    if (!BG.requireLogin()) return;
    loading('Loading your bookings…');
    const all = await api('/bookings');
    const groups = {
      upcoming: all.filter((b) => (b.status === 'CONFIRMED' && !b.isPast) || b.status === 'PENDING'),
      past: all.filter((b) => b.status === 'CONFIRMED' && b.isPast),
      cancelled: all.filter((b) => b.status === 'CANCELLED'),
    };
    let tab = groups.upcoming.length || !all.length ? 'upcoming' : groups.past.length ? 'past' : 'cancelled';
    view(`<h1 class="page-title">My bookings</h1>
      <div class="tabs" id="bTabs">${[['upcoming', 'Upcoming'], ['past', 'Completed'], ['cancelled', 'Cancelled']].map(([k, l]) => `<button class="tab" data-tab="${k}">${l} <span class="count">${groups[k].length}</span></button>`).join('')}</div>
      <div id="bList" class="bk-list"></div>`);
    const paint = () => {
      $$('#bTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
      const list = groups[tab];
      $('#bList').innerHTML = list.map((b) => `
        <a class="bk-card card" href="#/${b.status === 'PENDING' ? 'pay' : 'ticket'}/${b.id}">
          <div class="bk-route"><strong>${esc(b.from)} <i>→</i> ${esc(b.to)}</strong><span class="muted">${esc(b.busName)} · ${esc(b.busType)}</span></div>
          <div class="bk-meta"><div><small>Date</small><strong>${fmtShort(b.travelDate)}</strong></div><div><small>Departs</small><strong>${fmtTime(b.departureTime)}</strong></div>
            <div><small>Seats</small><strong>${esc(b.passengers.map((p) => p.seatNo).join(', '))}</strong></div><div><small>Amount</small><strong>${money(b.total)}</strong></div></div>
          <div class="bk-end"><span class="badge ${statusBadge(b.status)}">${b.status === 'PENDING' ? 'PAYMENT PENDING' : esc(b.status)}</span><span class="muted small">PNR ${esc(b.pnr)}</span><span class="link">${b.status === 'PENDING' ? 'Pay now →' : 'View ticket →'}</span></div>
        </a>`).join('') || `<div class="center-msg card"><h3>No ${tab} bookings</h3><p class="muted">${tab === 'upcoming' ? 'Ready for your next trip?' : 'Nothing here yet.'}</p><a class="btn btn-primary" href="#/">Book a bus</a></div>`;
    };
    $('#bTabs').onclick = (e) => { const t = e.target.closest('.tab'); if (t) { tab = t.dataset.tab; paint(); } };
    paint();
  });

  // =========================================================== LOGIN / SIGNUP
  const safeNext = (n) => (n && n.startsWith('/') && !n.startsWith('//') ? n : null);

  route(/^\/login$/, async (m, q) => {
    if (state.user) return go('/');
    view(`<div class="auth-wrap"><form class="card auth-card" id="loginForm" novalidate>
      <h1>Welcome back</h1><p class="muted">Login to book tickets and manage your trips.</p>
      <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="username" placeholder="you@example.com"></label>
      <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="current-password" placeholder="Your password"></label>
      <div class="form-error" id="aErr" hidden></div>
      <button class="btn btn-primary btn-block btn-lg" type="submit">Login</button>
      <p class="center muted">New to BusGo? <a href="#/signup${q.next ? `?next=${encodeURIComponent(q.next)}` : ''}">Create an account</a></p>
      <div class="demo-note">Demo logins — <button type="button" class="linkbtn" data-demo="user">Customer</button> · <button type="button" class="linkbtn" data-demo="admin">Admin</button></div>
    </form></div>`);
    const f = $('#loginForm');
    $$('[data-demo]').forEach((b) => { b.onclick = () => { const a = b.dataset.demo === 'admin'; f.email.value = a ? 'admin@busgo.com' : 'user@busgo.com'; f.password.value = a ? 'admin123' : 'user123'; }; });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#aErr'), btn = $('[type=submit]', f);
      err.hidden = true;
      if (!f.email.value.trim() || !f.password.value) { err.textContent = 'Enter your email and password'; err.hidden = false; return; }
      btn.disabled = true;
      try {
        const r = await api('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
        BG.setSession(r.token, r.user);
        toast(`Welcome, ${r.user.name.split(' ')[0]}!`, 'success');
        go(safeNext(q.next) || (r.user.role === 'admin' ? '/admin' : '/'));
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    };
  });

  route(/^\/signup$/, async (m, q) => {
    if (state.user) return go('/');
    view(`<div class="auth-wrap"><form class="card auth-card" id="signupForm" novalidate>
      <h1>Create your account</h1><p class="muted">It takes less than a minute.</p>
      <label class="field"><span>Full name</span><input class="input" name="name" autocomplete="name" placeholder="Your name"></label>
      <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" placeholder="you@example.com"></label>
      <label class="field"><span>Mobile (optional)</span><input class="input" name="phone" inputmode="numeric" maxlength="10" placeholder="10-digit mobile"></label>
      <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="new-password" placeholder="At least 6 characters"></label>
      <div class="form-error" id="aErr" hidden></div>
      <button class="btn btn-primary btn-block btn-lg" type="submit">Sign up</button>
      <p class="center muted">Already registered? <a href="#/login${q.next ? `?next=${encodeURIComponent(q.next)}` : ''}">Login</a></p>
    </form></div>`);
    const f = $('#signupForm');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#aErr'), btn = $('[type=submit]', f);
      err.hidden = true;
      const v = { name: f.name.value.trim(), email: f.email.value.trim(), phone: f.phone.value.trim(), password: f.password.value };
      const msg = v.name.length < 2 ? 'Enter your name' : !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email) ? 'Enter a valid email' : v.phone && !/^[6-9]\d{9}$/.test(v.phone) ? 'Enter a valid 10-digit mobile number' : v.password.length < 6 ? 'Password must be at least 6 characters' : '';
      if (msg) { err.textContent = msg; err.hidden = false; return; }
      btn.disabled = true;
      try {
        const r = await api('/auth/signup', { method: 'POST', body: v });
        BG.setSession(r.token, r.user);
        toast('Account created. Welcome to BusGo!', 'success');
        go(safeNext(q.next) || '/');
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    };
  });
})();
