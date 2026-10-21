'use strict';
// End-to-end API test. Run:  node test/flow.test.js   (uses a temporary database)
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'busgo-test-'));
const { server } = require('../server');
const { db } = require('../db');

let base;
async function call(method, url, body, token) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
let passed = 0;
const ok = (name, fn) => fn().then(() => { passed++; console.log('  ✓', name); }, (e) => { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; });

(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  const tomorrow = ymd(new Date(Date.now() + 3 * 86400000)); // >24h ahead so refund tier is deterministic
  let admin, user, user2, sch, booking;

  await ok('login admin + user, wrong password rejected', async () => {
    admin = (await call('POST', '/api/auth/login', { email: 'admin@busgo.com', password: 'admin123' })).data.token;
    user = (await call('POST', '/api/auth/login', { email: 'user@busgo.com', password: 'user123' })).data.token;
    assert(admin && user);
    assert.strictEqual((await call('POST', '/api/auth/login', { email: 'user@busgo.com', password: 'nope' })).status, 401);
  });
  await ok('signup validates and creates account', async () => {
    assert.strictEqual((await call('POST', '/api/auth/signup', { name: 'A', email: 'bad', password: '1' })).status, 400);
    const r = await call('POST', '/api/auth/signup', { name: 'Second User', email: 'second@test.com', phone: '9812345678', password: 'secret1' });
    assert.strictEqual(r.status, 201); user2 = r.data.token;
    assert.strictEqual((await call('POST', '/api/auth/signup', { name: 'Second User', email: 'second@test.com', password: 'secret1' })).status, 409);
  });
  await ok('access control: 401 without token, 403 for non-admin', async () => {
    assert.strictEqual((await call('GET', '/api/bookings')).status, 401);
    assert.strictEqual((await call('GET', '/api/admin/stats', null, user)).status, 403);
    assert.strictEqual((await call('GET', '/api/admin/stats', null, admin)).status, 200);
  });
  await ok('search returns buses; validates input', async () => {
    const r = await call('GET', `/api/buses/search?from=Delhi&to=Roorkee&date=${tomorrow}`);
    assert(r.data.buses.length >= 3, 'expected several buses'); sch = r.data.buses[0];
    assert(sch.availableSeats > 0 && sch.arrivalTime);
    assert.strictEqual((await call('GET', `/api/buses/search?from=Delhi&to=Delhi&date=${tomorrow}`)).status, 400);
    assert.strictEqual((await call('GET', '/api/buses/search?from=Delhi&to=Roorkee&date=2020-01-01')).status, 400);
  });
  const pax = (seats) => seats.map((s, i) => ({ seatNo: s, name: 'Passenger ' + (i + 1), age: 30, gender: 'M' }));
  await ok('book 2 seats -> PENDING hold; double booking blocked', async () => {
    const r = await call('POST', '/api/bookings', { scheduleId: sch.id, date: tomorrow, passengers: pax(['1A', '1B']), phone: '9876543210', email: 'user@busgo.com' }, user);
    assert.strictEqual(r.status, 201, JSON.stringify(r.data)); booking = r.data;
    assert.strictEqual(booking.status, 'PENDING'); assert.strictEqual(booking.total, booking.fare + booking.fee);
    const seats = (await call('GET', `/api/schedules/${sch.id}/seats?date=${tomorrow}`)).data.seats;
    assert.strictEqual(seats.find((s) => s.no === '1A').status, 'held');
    const dup = await call('POST', '/api/bookings', { scheduleId: sch.id, date: tomorrow, passengers: pax(['1B']), phone: '9876543210', email: 'x@y.com' }, user2);
    assert.strictEqual(dup.status, 409);
  });
  await ok('payment: invalid / declined / success paths', async () => {
    const pay = (method, details) => call('POST', `/api/bookings/${booking.id}/pay`, { method, details }, user);
    assert.strictEqual((await pay('UPI', { upiId: 'nope' })).status, 402);
    assert.strictEqual((await pay('CREDIT_CARD', { cardNumber: '4111 1111 1111 1112', expiry: '12/30', cvv: '123', cardName: 'A B' })).status, 402);
    const declined = await pay('DEBIT_CARD', { cardNumber: '4000 0000 0000 0002', expiry: '12/30', cvv: '123', cardName: 'A B' });
    assert.strictEqual(declined.status, 402); assert(/declined/i.test(declined.data.error));
    assert.strictEqual((await pay('NET_BANKING', { bank: 'Fake Bank' })).status, 402);
    assert.strictEqual((await call('POST', `/api/bookings/${booking.id}/pay`, { method: 'UPI', details: { upiId: 'rahul@okhdfcbank' } }, user2)).status, 404);
    const good = await pay('CREDIT_CARD', { cardNumber: '4111 1111 1111 1111', expiry: '12/30', cvv: '123', cardName: 'A B' });
    assert.strictEqual(good.status, 200, JSON.stringify(good.data));
    assert.strictEqual(good.data.status, 'CONFIRMED'); assert.strictEqual(good.data.paymentStatus, 'PAID');
    assert(/1111/.test(good.data.paymentSummary) && !JSON.stringify(good.data).includes('4111 1111'));
    assert.strictEqual((await pay('UPI', { upiId: 'a@b' + 'cd' })).status, 400); // already processed
  });
  await ok('my bookings + other user cannot read my booking', async () => {
    const mine = (await call('GET', '/api/bookings', null, user)).data;
    assert(mine.find((b) => b.pnr === booking.pnr));
    assert.strictEqual((await call('GET', `/api/bookings/${booking.id}`, null, user2)).status, 404);
    assert.strictEqual((await call('GET', `/api/bookings/${booking.id}`, null, admin)).status, 200);
  });
  await ok('cancel confirmed booking refunds 90% and frees seats', async () => {
    const r = await call('POST', `/api/bookings/${booking.id}/cancel`, {}, user);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.refund, Math.round(booking.total * 0.9));
    assert.strictEqual(r.data.booking.status, 'CANCELLED');
    const seats = (await call('GET', `/api/schedules/${sch.id}/seats?date=${tomorrow}`)).data.seats;
    assert.strictEqual(seats.find((s) => s.no === '1A').status, 'available');
    assert.strictEqual((await call('POST', `/api/bookings/${booking.id}/cancel`, {}, user)).status, 400);
  });
  await ok('unpaid hold expires after timeout and releases seats', async () => {
    const r = await call('POST', '/api/bookings', { scheduleId: sch.id, date: tomorrow, passengers: pax(['2A']), phone: '9876543210', email: 'u@x.com' }, user);
    db.prepare('UPDATE bookings SET hold_expires_at=? WHERE id=?').run(Date.now() - 1000, r.data.id);
    const seats = (await call('GET', `/api/schedules/${sch.id}/seats?date=${tomorrow}`)).data.seats;
    assert.strictEqual(seats.find((s) => s.no === '2A').status, 'available');
    assert.strictEqual((await call('POST', `/api/bookings/${r.data.id}/pay`, { method: 'UPI', details: { upiId: 'a@okaxis' } }, user)).status, 410);
  });
  await ok('booking validation (seat count, bad seat, phone)', async () => {
    const mk = (passengers, phone = '9876543210') => call('POST', '/api/bookings', { scheduleId: sch.id, date: tomorrow, passengers, phone, email: 'u@x.com' }, user);
    assert.strictEqual((await mk(pax(['1A', '1B', '1C', '1D', '2A', '2B', '2C']))).status, 400);
    assert.strictEqual((await mk(pax(['99Z']))).status, 400);
    assert.strictEqual((await mk(pax(['3A']), '12345')).status, 400);
    assert.strictEqual((await mk([])).status, 400);
  });
  await ok('admin: bus/route/schedule CRUD, seat blocking, booking cancel', async () => {
    const bus = await call('POST', '/api/admin/buses', { name: 'Test Bus', operator: 'Test Op', busType: 'AC Seater', totalSeats: 20, amenities: 'AC,WiFi' }, admin);
    assert.strictEqual(bus.status, 201);
    const route = await call('POST', '/api/admin/routes', { from: 'Testville', to: 'Demoton', distanceKm: 100 }, admin);
    assert.strictEqual(route.status, 201);
    assert.strictEqual((await call('POST', '/api/admin/routes', { from: 'Testville', to: 'Demoton', distanceKm: 100 }, admin)).status, 409);
    const s = await call('POST', '/api/admin/schedules', { busId: bus.data.id, routeId: route.data.id, departureTime: '23:59', durationMin: 150, price: 250 }, admin);
    assert.strictEqual(s.status, 201); assert.strictEqual(s.data.arrivalTime, '02:29'); assert.strictEqual(s.data.arrivalDayOffset, 1);
    const f = await call('GET', `/api/buses/search?from=Testville&to=Demoton&date=${tomorrow}`);
    assert.strictEqual(f.data.buses[0].availableSeats, 20);
    assert.strictEqual((await call('POST', '/api/admin/blocks', { scheduleId: s.data.id, date: tomorrow, seatNo: '1A' }, admin)).data.blocked, true);
    assert.strictEqual((await call('GET', `/api/buses/search?from=Testville&to=Demoton&date=${tomorrow}`)).data.buses[0].availableSeats, 19);
    assert.strictEqual((await call('POST', '/api/bookings', { scheduleId: s.data.id, date: tomorrow, passengers: pax(['1A']), phone: '9876543210', email: 'u@x.com' }, user)).status, 409);
    const b2 = await call('POST', '/api/bookings', { scheduleId: s.data.id, date: tomorrow, passengers: pax(['1B']), phone: '9876543210', email: 'u@x.com' }, user);
    await call('POST', `/api/bookings/${b2.data.id}/pay`, { method: 'UPI', details: { upiId: 'ravi@oksbi' } }, user);
    assert.strictEqual((await call('DELETE', `/api/admin/schedules/${s.data.id}`, null, admin)).status, 409); // has bookings
    const seatsAdmin = (await call('GET', `/api/admin/schedules/${s.data.id}/seats?date=${tomorrow}`, null, admin)).data.seats;
    assert.strictEqual(seatsAdmin.find((x) => x.no === '1B').passenger.name, 'Passenger 1');
    const c = await call('POST', `/api/admin/bookings/${b2.data.id}/cancel`, {}, admin);
    assert.strictEqual(c.data.refund, b2.data.total);
    assert.strictEqual((await call('PUT', `/api/admin/buses/${bus.data.id}`, { name: 'Test Bus 2', operator: 'Op', busType: 'Volvo AC', totalSeats: 24, amenities: '' }, admin)).data.totalSeats, 24);
    const list = (await call('GET', '/api/admin/bookings?status=CANCELLED', null, admin)).data;
    assert(list.length >= 2);
    const stats = (await call('GET', '/api/admin/stats', null, admin)).data;
    assert(stats.revenue >= 0 && stats.recent.length > 0);
  });
  await ok('static files + security headers served', async () => {
    const r = await fetch(base + '/');
    assert([200, 404].includes(r.status)); assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual((await fetch(base + '/../server.js')).status === 200 && (await (await fetch(base + '/..%2fserver.js')).text()).includes('createServer'), false);
  });

  console.log(`\n${passed} test groups passed${process.exitCode ? ' (with failures above)' : ''}`);
  server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
})();
