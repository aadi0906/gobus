'use strict';
// BusGo server — plain Node.js (no frameworks, no npm packages). Node >= 22.13
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const { db, tx } = require('./db');
const { charge, BANKS } = require('./payment');

const PORT = Number(process.env.PORT) || 3000;
const HOLD_MINUTES = 10;           // seats are held this long while the user pays
const FEE_RATE = 0.02;             // convenience fee
const MAX_SEATS = 6;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- secrets / JWT
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), '.jwt_secret');
  try { return fs.readFileSync(f, 'utf8'); } catch (_) { /* create below */ }
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const JWT_SECRET = loadSecret();
const b64u = (b) => Buffer.from(b).toString('base64url');

function signToken(user) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ id: user.id, exp: Math.floor(Date.now() / 1000) + 7 * 86400 }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const expect = crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch (_) { return null; }
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(pw, salt, 64)).toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  const got = await scrypt(pw, salt, 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ---------------------------------------------------------------- tiny HTTP framework
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const created = (data) => ({ __status: 201, data });

const routes = [];
function add(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, opts, handler });
}
const get = (p, o, h) => add('GET', p, o, h);
const post = (p, o, h) => add('POST', p, o, h);
const put = (p, o, h) => add('PUT', p, o, h);
const del = (p, o, h) => add('DELETE', p, o, h);
const USER = { auth: true };
const ADMIN = { auth: true, admin: true };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (_) { reject(bad('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function authenticate(req) {
  const h = req.headers.authorization || '';
  const payload = h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
  if (!payload) throw new HttpError(401, 'Please login to continue');
  const u = db.prepare('SELECT id,name,email,phone,role FROM users WHERE id=?').get(payload.id);
  if (!u) throw new HttpError(401, 'Account not found');
  return { ...u };
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; connect-src 'self'",
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS });
  res.end(body);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp' };

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (path.extname(rel)) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        res.writeHead(e2 ? 404 : 200, { 'Content-Type': MIME['.html'], ...SEC_HEADERS });
        res.end(e2 ? 'Not found' : idx);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC_HEADERS });
    res.end(buf);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }
  try {
    let matched = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (m) { matched = { r, m }; break; }
    }
    if (!matched) throw new HttpError(404, 'API route not found');
    const { r, m } = matched;
    req.params = {};
    r.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
    req.query = Object.fromEntries(url.searchParams);
    req.body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    if (r.opts.auth) {
      req.user = authenticate(req);
      if (r.opts.admin && req.user.role !== 'admin') throw new HttpError(403, 'Admin access only');
    }
    const out = await r.handler(req);
    if (out && out.__status) sendJson(res, out.__status, out.data); else sendJson(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    if (/UNIQUE constraint failed/.test(String(e.message))) return sendJson(res, 409, { error: 'Already exists / seat already taken' });
    if (/FOREIGN KEY constraint failed/.test(String(e.message))) return sendJson(res, 409, { error: 'This item is in use. Deactivate it instead of deleting.' });
    console.error(e);
    sendJson(res, 500, { error: 'Something went wrong on the server' });
  }
}

// ---------------------------------------------------------------- helpers
const pad = (n) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function arrival(dep, dur) {
  const [h, m] = dep.split(':').map(Number);
  const t = h * 60 + m + dur;
  return { time: `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`, dayOffset: Math.floor(t / 1440) };
}
const departureAt = (date, dep) => new Date(`${date}T${dep}:00`);
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00`);
  return !isNaN(d) && todayStr(d) === s;
}
function seatLabels(total) {
  const out = [];
  for (let r = 1; out.length < total; r++) for (const c of 'ABCD') if (out.length < total) out.push(`${r}${c}`);
  return out;
}
const str = (v, min, max, label) => {
  const s = String(v ?? '').trim();
  if (s.length < min || s.length > max) throw bad(`${label} must be ${min}-${max} characters`);
  return s;
};
const int = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be a number between ${min} and ${max}`);
  return n;
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const SCH_SQL = `SELECT s.id, s.departure_time, s.duration_min, s.price, s.active,
  bu.id AS bus_id, bu.name AS bus_name, bu.operator, bu.bus_type, bu.total_seats, bu.amenities, bu.active AS bus_active,
  r.id AS route_id, r.from_city, r.to_city, r.distance_km
  FROM schedules s JOIN buses bu ON bu.id = s.bus_id JOIN routes r ON r.id = s.route_id`;

function schView(s, extra = {}) {
  const a = arrival(s.departure_time, s.duration_min);
  return {
    id: s.id, busId: s.bus_id, busName: s.bus_name, operator: s.operator, busType: s.bus_type,
    amenities: s.amenities ? s.amenities.split(',').map((x) => x.trim()).filter(Boolean) : [],
    totalSeats: s.total_seats, routeId: s.route_id, from: s.from_city, to: s.to_city, distanceKm: s.distance_km,
    departureTime: s.departure_time, arrivalTime: a.time, arrivalDayOffset: a.dayOffset,
    durationMin: s.duration_min, price: s.price, active: !!s.active && !!s.bus_active, ...extra,
  };
}

function releaseExpired() {
  const ids = db.prepare("SELECT id FROM bookings WHERE status='PENDING' AND hold_expires_at < ?").all(Date.now()).map((r) => r.id);
  if (!ids.length) return;
  tx(() => {
    for (const id of ids) {
      db.prepare("UPDATE bookings SET status='EXPIRED', hold_expires_at=NULL WHERE id=? AND status='PENDING'").run(id);
      db.prepare("UPDATE booking_seats SET status='CANCELLED' WHERE booking_id=? AND status='HELD'").run(id);
    }
  });
}
setInterval(() => { try { releaseExpired(); } catch (e) { console.error(e); } }, 30000).unref();

function seatStatuses(scheduleId, date) {
  const taken = db.prepare("SELECT seat_no, status FROM booking_seats WHERE schedule_id=? AND travel_date=? AND status IN ('HELD','BOOKED')").all(scheduleId, date);
  const blocked = db.prepare('SELECT seat_no FROM blocked_seats WHERE schedule_id=? AND travel_date=?').all(scheduleId, date);
  const map = new Map();
  taken.forEach((t) => map.set(t.seat_no, t.status === 'BOOKED' ? 'booked' : 'held'));
  blocked.forEach((b) => map.set(b.seat_no, 'blocked'));
  return map;
}

function getSchedule(id) {
  const s = db.prepare(`${SCH_SQL} WHERE s.id=?`).get(id);
  if (!s) throw new HttpError(404, 'Bus schedule not found');
  return s;
}

function genPnr() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const b = crypto.randomBytes(8);
    let s = 'BG';
    for (let i = 0; i < 8; i++) s += chars[b[i] % chars.length];
    if (!db.prepare('SELECT 1 FROM bookings WHERE pnr=?').get(s)) return s;
  }
}

const BK_SQL = `SELECT b.*, s.departure_time, s.duration_min, bu.name AS bus_name, bu.operator, bu.bus_type, bu.amenities,
  r.from_city, r.to_city, u.name AS user_name, u.email AS user_email
  FROM bookings b JOIN schedules s ON s.id=b.schedule_id JOIN buses bu ON bu.id=s.bus_id
  JOIN routes r ON r.id=s.route_id JOIN users u ON u.id=b.user_id`;

function fmtBooking(b) {
  const seats = db.prepare("SELECT seat_no, passenger_name, age, gender FROM booking_seats WHERE booking_id=? ORDER BY id").all(b.id)
    .map((s) => ({ seatNo: s.seat_no, name: s.passenger_name, age: s.age, gender: s.gender }));
  const a = arrival(b.departure_time, b.duration_min);
  const dep = departureAt(b.travel_date, b.departure_time);
  return {
    id: b.id, pnr: b.pnr, status: b.status, paymentStatus: b.payment_status, paymentMethod: b.payment_method,
    paymentRef: b.payment_ref, paymentSummary: b.payment_summary,
    from: b.from_city, to: b.to_city, travelDate: b.travel_date, departureTime: b.departure_time,
    arrivalTime: a.time, arrivalDayOffset: a.dayOffset, durationMin: b.duration_min,
    busName: b.bus_name, operator: b.operator, busType: b.bus_type,
    amenities: b.amenities ? b.amenities.split(',').map((x) => x.trim()).filter(Boolean) : [],
    fare: b.fare, fee: b.fee, total: b.total, refundAmount: b.refund_amount,
    contactPhone: b.contact_phone, contactEmail: b.contact_email, passengers: seats,
    holdExpiresAt: b.status === 'PENDING' ? b.hold_expires_at : null,
    createdAt: b.created_at, cancelledAt: b.cancelled_at, isPast: dep < new Date(), serverNow: Date.now(),
    userName: b.user_name, userEmail: b.user_email,
  };
}

function refundPct(b) {
  const hrs = (departureAt(b.travel_date, b.departure_time) - Date.now()) / 3600000;
  if (hrs >= 24) return 0.9;
  if (hrs >= 12) return 0.75;
  if (hrs >= 4) return 0.5;
  return 0;
}

function cancelBooking(b, { full }) {
  if (b.status === 'CANCELLED' || b.status === 'EXPIRED') throw bad('This booking is already cancelled');
  let refund = 0;
  if (b.status === 'CONFIRMED') {
    refund = full ? b.total : Math.round(b.total * refundPct(b));
  }
  tx(() => {
    db.prepare(`UPDATE bookings SET status='CANCELLED', refund_amount=?, payment_status=?, hold_expires_at=NULL, cancelled_at=datetime('now') WHERE id=?`)
      .run(refund, b.status === 'CONFIRMED' && refund > 0 ? 'REFUNDED' : b.payment_status, b.id);
    db.prepare("UPDATE booking_seats SET status='CANCELLED' WHERE booking_id=?").run(b.id);
  });
  return refund;
}

function loadOwnedBooking(req, id) {
  const b = db.prepare(`${BK_SQL} WHERE b.id=?`).get(id);
  if (!b || (b.user_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Booking not found');
  return b;
}

// ---------------------------------------------------------------- AUTH
const loginFails = new Map();
function throttle(key) {
  const e = loginFails.get(key);
  if (e && e.count >= 8 && e.until > Date.now()) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
}
function noteFail(key) {
  const e = loginFails.get(key);
  if (!e || e.until < Date.now()) loginFails.set(key, { count: 1, until: Date.now() + 10 * 60000 });
  else e.count++;
}

post('/api/auth/signup', async (req) => {
  const name = str(req.body.name, 2, 60, 'Name');
  const email = str(req.body.email, 5, 120, 'Email').toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address');
  const phone = String(req.body.phone || '').trim();
  if (phone && !/^[6-9]\d{9}$/.test(phone)) throw bad('Enter a valid 10-digit mobile number');
  const password = String(req.body.password || '');
  if (password.length < 6 || password.length > 100) throw bad('Password must be at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'This email is already registered. Please login.');
  const hash = await hashPassword(password);
  const r = db.prepare("INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,'user')").run(name, email, phone || null, hash);
  const user = { id: Number(r.lastInsertRowid), name, email, phone: phone || null, role: 'user' };
  return created({ token: signToken(user), user });
});

post('/api/auth/login', async (req) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const key = `${req.socket.remoteAddress}|${email}`;
  throttle(key);
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const ok = u && (await checkPassword(String(req.body.password || ''), u.password_hash));
  if (!ok) { noteFail(key); throw new HttpError(401, 'Incorrect email or password'); }
  loginFails.delete(key);
  const user = { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role };
  return { token: signToken(user), user };
});

get('/api/auth/me', USER, (req) => ({ user: req.user }));

// ---------------------------------------------------------------- PUBLIC: search, seats
get('/api/config', () => ({ banks: BANKS, holdMinutes: HOLD_MINUTES, maxSeats: MAX_SEATS, feeRate: FEE_RATE, today: todayStr() }));

get('/api/cities', () => {
  const rows = db.prepare(`SELECT DISTINCT c AS city FROM (SELECT r.from_city AS c FROM routes r JOIN schedules s ON s.route_id=r.id WHERE s.active=1
    UNION SELECT r.to_city FROM routes r JOIN schedules s ON s.route_id=r.id WHERE s.active=1) ORDER BY c`).all();
  return rows.map((r) => r.city);
});

get('/api/popular-routes', () =>
  db.prepare(`SELECT r.from_city AS "from", r.to_city AS "to", MIN(s.price) AS price,
    (SELECT COUNT(*) FROM bookings b JOIN schedules s2 ON s2.id=b.schedule_id WHERE s2.route_id=r.id) AS n
    FROM routes r JOIN schedules s ON s.route_id=r.id AND s.active=1 GROUP BY r.id ORDER BY n DESC, r.id LIMIT 8`).all().map((x) => ({ ...x })));

get('/api/buses/search', (req) => {
  releaseExpired();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const date = String(req.query.date || '');
  if (!from || !to) throw bad('Please enter From and To cities');
  if (from.toLowerCase() === to.toLowerCase()) throw bad('From and To cities cannot be the same');
  if (!validDate(date)) throw bad('Please choose a valid travel date');
  if (date < todayStr()) throw bad('Travel date cannot be in the past');
  const rows = db.prepare(`${SCH_SQL} WHERE s.active=1 AND bu.active=1 AND LOWER(r.from_city)=LOWER(?) AND LOWER(r.to_city)=LOWER(?) ORDER BY s.departure_time`).all(from, to);
  const now = new Date();
  const out = [];
  for (const s of rows) {
    if (departureAt(date, s.departure_time) <= now) continue; // already left
    const taken = db.prepare("SELECT COUNT(*) AS c FROM booking_seats WHERE schedule_id=? AND travel_date=? AND status IN ('HELD','BOOKED')").get(s.id, date).c;
    const blocked = db.prepare('SELECT COUNT(*) AS c FROM blocked_seats WHERE schedule_id=? AND travel_date=?').get(s.id, date).c;
    out.push(schView(s, { availableSeats: Math.max(0, s.total_seats - taken - blocked) }));
  }
  return { from, to, date, buses: out };
});

get('/api/schedules/:id/seats', (req) => {
  releaseExpired();
  const s = getSchedule(Number(req.params.id));
  const date = String(req.query.date || '');
  if (!validDate(date)) throw bad('Invalid date');
  const st = seatStatuses(s.id, date);
  const seats = seatLabels(s.total_seats).map((no) => ({ no, status: st.get(no) || 'available' }));
  return { schedule: schView(s), date, seats, maxSeats: MAX_SEATS };
});

// ---------------------------------------------------------------- BOOKINGS
post('/api/bookings', USER, (req) => {
  releaseExpired();
  const { scheduleId, date, passengers } = req.body;
  const s = getSchedule(Number(scheduleId));
  if (!s.active || !s.bus_active) throw bad('This bus is not available right now');
  if (!validDate(date) || date < todayStr()) throw bad('Please choose a valid travel date');
  if (date > todayStr(new Date(Date.now() + 90 * 86400000))) throw bad('Bookings open only 90 days in advance');
  if (departureAt(date, s.departure_time) <= new Date()) throw bad('This bus has already departed');
  if (!Array.isArray(passengers) || passengers.length < 1 || passengers.length > MAX_SEATS) throw bad(`Select 1 to ${MAX_SEATS} seats`);

  const valid = new Set(seatLabels(s.total_seats));
  const seen = new Set();
  const people = passengers.map((p, i) => {
    const seatNo = String(p.seatNo || '');
    if (!valid.has(seatNo)) throw bad(`Invalid seat ${seatNo}`);
    if (seen.has(seatNo)) throw bad(`Seat ${seatNo} selected twice`);
    seen.add(seatNo);
    if (!['M', 'F', 'O'].includes(p.gender)) throw bad(`Select gender for passenger ${i + 1}`);
    return { seatNo, name: str(p.name, 2, 60, `Passenger ${i + 1} name`), age: int(p.age, 1, 120, `Passenger ${i + 1} age`), gender: p.gender };
  });
  const phone = String(req.body.phone || '').trim();
  if (!/^[6-9]\d{9}$/.test(phone)) throw bad('Enter a valid 10-digit mobile number');
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address');

  const fare = s.price * people.length;
  const fee = Math.round(fare * FEE_RATE);
  const pnr = genPnr();
  try {
    return created(tx(() => {
      const st = seatStatuses(s.id, date);
      for (const p of people) if (st.has(p.seatNo)) throw new HttpError(409, `Seat ${p.seatNo} was just taken. Please choose another seat.`);
      const r = db.prepare(`INSERT INTO bookings (pnr,user_id,schedule_id,travel_date,fare,fee,total,status,contact_phone,contact_email,hold_expires_at)
        VALUES (?,?,?,?,?,?,?,'PENDING',?,?,?)`).run(pnr, req.user.id, s.id, date, fare, fee, fare + fee, phone, email, Date.now() + HOLD_MINUTES * 60000);
      const id = Number(r.lastInsertRowid);
      const ins = db.prepare("INSERT INTO booking_seats (booking_id,schedule_id,travel_date,seat_no,passenger_name,age,gender,status) VALUES (?,?,?,?,?,?,?,'HELD')");
      people.forEach((p) => ins.run(id, s.id, date, p.seatNo, p.name, p.age, p.gender));
      return fmtBooking(db.prepare(`${BK_SQL} WHERE b.id=?`).get(id));
    }));
  } catch (e) {
    if (/UNIQUE constraint failed/.test(String(e.message))) throw new HttpError(409, 'One of the seats was just taken. Please choose again.');
    throw e;
  }
});

post('/api/bookings/:id/pay', USER, async (req) => {
  releaseExpired();
  const b = loadOwnedBooking(req, Number(req.params.id));
  if (b.user_id !== req.user.id) throw new HttpError(403, 'Not your booking');
  if (b.status === 'EXPIRED') throw new HttpError(410, 'Seat hold expired. Please select seats again.');
  if (b.status !== 'PENDING') throw bad('This booking is already processed');
  // extend hold a little so a slow bank response cannot lose the seats mid-payment
  db.prepare('UPDATE bookings SET hold_expires_at=MAX(hold_expires_at, ?) WHERE id=?').run(Date.now() + 2 * 60000, b.id);

  const method = String(req.body.method || '');
  const result = await charge({ method, amount: b.total, details: req.body.details || {} });
  if (!result.ok) throw new HttpError(402, result.message);

  tx(() => {
    db.prepare(`UPDATE bookings SET status='CONFIRMED', payment_status='PAID', payment_method=?, payment_ref=?, payment_summary=?, hold_expires_at=NULL WHERE id=?`)
      .run(method, result.ref, result.summary, b.id);
    db.prepare("UPDATE booking_seats SET status='BOOKED' WHERE booking_id=? AND status='HELD'").run(b.id);
  });
  return fmtBooking(db.prepare(`${BK_SQL} WHERE b.id=?`).get(b.id));
});

post('/api/bookings/:id/cancel', USER, (req) => {
  const b = loadOwnedBooking(req, Number(req.params.id));
  if (b.user_id !== req.user.id) throw new HttpError(403, 'Not your booking');
  if (b.status === 'CONFIRMED' && departureAt(b.travel_date, b.departure_time) <= new Date()) throw bad('This bus has already departed');
  const refund = cancelBooking(b, { full: false });
  return { booking: fmtBooking(db.prepare(`${BK_SQL} WHERE b.id=?`).get(b.id)), refund };
});

get('/api/bookings', USER, (req) => {
  releaseExpired();
  return db.prepare(`${BK_SQL} WHERE b.user_id=? AND b.status!='EXPIRED' ORDER BY b.travel_date DESC, b.id DESC`).all(req.user.id).map(fmtBooking);
});

get('/api/bookings/:id', USER, (req) => {
  releaseExpired();
  const b = loadOwnedBooking(req, Number(req.params.id));
  return fmtBooking(b);
});

// ---------------------------------------------------------------- ADMIN
get('/api/admin/stats', ADMIN, () => {
  const one = (sql, ...p) => db.prepare(sql).get(...p).c;
  return {
    revenue: db.prepare("SELECT COALESCE(SUM(total - refund_amount),0) AS c FROM bookings WHERE payment_status IN ('PAID','REFUNDED')").get().c,
    confirmed: one("SELECT COUNT(*) AS c FROM bookings WHERE status='CONFIRMED'"),
    cancelled: one("SELECT COUNT(*) AS c FROM bookings WHERE status='CANCELLED'"),
    pending: one("SELECT COUNT(*) AS c FROM bookings WHERE status='PENDING'"),
    travellingToday: one("SELECT COUNT(*) AS c FROM bookings WHERE status='CONFIRMED' AND travel_date=?", todayStr()),
    users: one("SELECT COUNT(*) AS c FROM users WHERE role='user'"),
    buses: one('SELECT COUNT(*) AS c FROM buses'),
    routes: one('SELECT COUNT(*) AS c FROM routes'),
    schedules: one('SELECT COUNT(*) AS c FROM schedules'),
    topRoutes: db.prepare(`SELECT r.from_city AS "from", r.to_city AS "to", COUNT(*) AS bookings, SUM(b.total) AS amount
      FROM bookings b JOIN schedules s ON s.id=b.schedule_id JOIN routes r ON r.id=s.route_id
      WHERE b.status='CONFIRMED' GROUP BY r.id ORDER BY bookings DESC LIMIT 5`).all().map((x) => ({ ...x })),
    recent: db.prepare(`${BK_SQL} WHERE b.status!='EXPIRED' ORDER BY b.id DESC LIMIT 6`).all().map(fmtBooking),
  };
});

// ---- buses
const BUS_TYPES = ['Volvo AC', 'AC Seater', 'Non-AC Seater', 'AC Sleeper'];
function busInput(b) {
  const type = String(b.busType || '');
  if (!BUS_TYPES.includes(type)) throw bad('Choose a valid bus type');
  return {
    name: str(b.name, 2, 60, 'Bus name'), operator: str(b.operator, 2, 60, 'Operator'), type,
    seats: int(b.totalSeats, 4, 60, 'Total seats'), amenities: String(b.amenities || '').slice(0, 200), active: b.active === false || b.active === 0 ? 0 : 1,
  };
}
const busRow = (b) => ({ id: b.id, name: b.name, operator: b.operator, busType: b.bus_type, totalSeats: b.total_seats, amenities: b.amenities, active: !!b.active, schedules: b.n });
const BUS_LIST = 'SELECT bu.*, (SELECT COUNT(*) FROM schedules s WHERE s.bus_id=bu.id) AS n FROM buses bu';

get('/api/admin/bus-types', ADMIN, () => BUS_TYPES);
get('/api/admin/buses', ADMIN, () => db.prepare(`${BUS_LIST} ORDER BY bu.id DESC`).all().map(busRow));
post('/api/admin/buses', ADMIN, (req) => {
  const b = busInput(req.body);
  const r = db.prepare('INSERT INTO buses (name,operator,bus_type,total_seats,amenities,active) VALUES (?,?,?,?,?,?)').run(b.name, b.operator, b.type, b.seats, b.amenities, b.active);
  return created(busRow(db.prepare(`${BUS_LIST} WHERE bu.id=?`).get(Number(r.lastInsertRowid))));
});
put('/api/admin/buses/:id', ADMIN, (req) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM buses WHERE id=?').get(id)) throw new HttpError(404, 'Bus not found');
  const b = busInput(req.body);
  const valid = new Set(seatLabels(b.seats));
  const used = db.prepare(`SELECT DISTINCT bs.seat_no FROM booking_seats bs JOIN schedules s ON s.id=bs.schedule_id
    WHERE s.bus_id=? AND bs.status IN ('HELD','BOOKED') AND bs.travel_date>=?`).all(id, todayStr());
  if (used.some((u) => !valid.has(u.seat_no))) throw new HttpError(409, 'Cannot reduce seats: upcoming bookings exist on seats that would be removed');
  db.prepare('UPDATE buses SET name=?,operator=?,bus_type=?,total_seats=?,amenities=?,active=? WHERE id=?').run(b.name, b.operator, b.type, b.seats, b.amenities, b.active, id);
  return busRow(db.prepare(`${BUS_LIST} WHERE bu.id=?`).get(id));
});
del('/api/admin/buses/:id', ADMIN, (req) => {
  db.prepare('DELETE FROM buses WHERE id=?').run(Number(req.params.id));
  return { ok: true };
});

// ---- routes
function routeInput(b) {
  const from = str(b.from, 2, 40, 'From city'), to = str(b.to, 2, 40, 'To city');
  if (from.toLowerCase() === to.toLowerCase()) throw bad('From and To cannot be the same');
  return { from, to, km: int(b.distanceKm, 1, 5000, 'Distance (km)') };
}
const routeRow = (r) => ({ id: r.id, from: r.from_city, to: r.to_city, distanceKm: r.distance_km, schedules: r.n });
const ROUTE_LIST = 'SELECT r.*, (SELECT COUNT(*) FROM schedules s WHERE s.route_id=r.id) AS n FROM routes r';
get('/api/admin/routes', ADMIN, () => db.prepare(`${ROUTE_LIST} ORDER BY r.from_city, r.to_city`).all().map(routeRow));
post('/api/admin/routes', ADMIN, (req) => {
  const r = routeInput(req.body);
  const x = db.prepare('INSERT INTO routes (from_city,to_city,distance_km) VALUES (?,?,?)').run(r.from, r.to, r.km);
  return created(routeRow(db.prepare(`${ROUTE_LIST} WHERE r.id=?`).get(Number(x.lastInsertRowid))));
});
put('/api/admin/routes/:id', ADMIN, (req) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM routes WHERE id=?').get(id)) throw new HttpError(404, 'Route not found');
  const r = routeInput(req.body);
  db.prepare('UPDATE routes SET from_city=?,to_city=?,distance_km=? WHERE id=?').run(r.from, r.to, r.km, id);
  return routeRow(db.prepare(`${ROUTE_LIST} WHERE r.id=?`).get(id));
});
del('/api/admin/routes/:id', ADMIN, (req) => {
  db.prepare('DELETE FROM routes WHERE id=?').run(Number(req.params.id));
  return { ok: true };
});

// ---- schedules (a bus running on a route at a time, every day)
function schInput(b) {
  const busId = int(b.busId, 1, 1e9, 'Bus'), routeId = int(b.routeId, 1, 1e9, 'Route');
  if (!db.prepare('SELECT 1 FROM buses WHERE id=?').get(busId)) throw bad('Bus not found');
  if (!db.prepare('SELECT 1 FROM routes WHERE id=?').get(routeId)) throw bad('Route not found');
  const dep = String(b.departureTime || '');
  if (!HHMM_RE.test(dep)) throw bad('Departure time must be HH:MM');
  return { busId, routeId, dep, dur: int(b.durationMin, 10, 3000, 'Duration (minutes)'), price: int(b.price, 1, 100000, 'Price'), active: b.active === false || b.active === 0 ? 0 : 1 };
}
get('/api/admin/schedules', ADMIN, () => db.prepare(`${SCH_SQL} ORDER BY r.from_city, r.to_city, s.departure_time`).all().map((s) => schView(s)));
post('/api/admin/schedules', ADMIN, (req) => {
  const s = schInput(req.body);
  const x = db.prepare('INSERT INTO schedules (bus_id,route_id,departure_time,duration_min,price,active) VALUES (?,?,?,?,?,?)').run(s.busId, s.routeId, s.dep, s.dur, s.price, s.active);
  return created(schView(getSchedule(Number(x.lastInsertRowid))));
});
put('/api/admin/schedules/:id', ADMIN, (req) => {
  const id = Number(req.params.id);
  getSchedule(id);
  const s = schInput(req.body);
  db.prepare('UPDATE schedules SET bus_id=?,route_id=?,departure_time=?,duration_min=?,price=?,active=? WHERE id=?').run(s.busId, s.routeId, s.dep, s.dur, s.price, s.active, id);
  return schView(getSchedule(id));
});
del('/api/admin/schedules/:id', ADMIN, (req) => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM bookings WHERE schedule_id=?').get(id)) throw new HttpError(409, 'This schedule has bookings. Deactivate it instead of deleting.');
  db.prepare('DELETE FROM blocked_seats WHERE schedule_id=?').run(id);
  db.prepare('DELETE FROM schedules WHERE id=?').run(id);
  return { ok: true };
});

// ---- seats (view who sits where, block / unblock seats)
get('/api/admin/schedules/:id/seats', ADMIN, (req) => {
  releaseExpired();
  const s = getSchedule(Number(req.params.id));
  const date = String(req.query.date || '');
  if (!validDate(date)) throw bad('Invalid date');
  const st = seatStatuses(s.id, date);
  const who = new Map(db.prepare(`SELECT bs.seat_no, bs.passenger_name, bs.age, bs.gender, b.pnr, bs.status FROM booking_seats bs JOIN bookings b ON b.id=bs.booking_id
    WHERE bs.schedule_id=? AND bs.travel_date=? AND bs.status IN ('HELD','BOOKED')`).all(s.id, date).map((r) => [r.seat_no, r]));
  const seats = seatLabels(s.total_seats).map((no) => {
    const w = who.get(no);
    return { no, status: st.get(no) || 'available', passenger: w ? { name: w.passenger_name, age: w.age, gender: w.gender, pnr: w.pnr } : null };
  });
  return { schedule: schView(s), date, seats };
});
post('/api/admin/blocks', ADMIN, (req) => {
  const s = getSchedule(Number(req.body.scheduleId));
  const date = String(req.body.date || '');
  const seatNo = String(req.body.seatNo || '');
  if (!validDate(date)) throw bad('Invalid date');
  if (!seatLabels(s.total_seats).includes(seatNo)) throw bad('Invalid seat');
  const existing = db.prepare('SELECT id FROM blocked_seats WHERE schedule_id=? AND travel_date=? AND seat_no=?').get(s.id, date, seatNo);
  if (existing) { db.prepare('DELETE FROM blocked_seats WHERE id=?').run(existing.id); return { blocked: false }; }
  if (db.prepare("SELECT 1 FROM booking_seats WHERE schedule_id=? AND travel_date=? AND seat_no=? AND status IN ('HELD','BOOKED')").get(s.id, date, seatNo)) throw new HttpError(409, 'This seat already has a booking');
  db.prepare('INSERT INTO blocked_seats (schedule_id,travel_date,seat_no) VALUES (?,?,?)').run(s.id, date, seatNo);
  return { blocked: true };
});

// ---- bookings
get('/api/admin/bookings', ADMIN, (req) => {
  releaseExpired();
  const where = ["b.status!='EXPIRED'"], p = [];
  if (['PENDING', 'CONFIRMED', 'CANCELLED'].includes(req.query.status)) { where.push('b.status=?'); p.push(req.query.status); }
  if (validDate(req.query.date)) { where.push('b.travel_date=?'); p.push(req.query.date); }
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push(`(b.pnr LIKE ? OR u.email LIKE ? OR b.contact_phone LIKE ? OR EXISTS (SELECT 1 FROM booking_seats bs WHERE bs.booking_id=b.id AND bs.passenger_name LIKE ?))`);
    const like = `%${q.replace(/[%_]/g, '')}%`;
    p.push(like, like, like, like);
  }
  return db.prepare(`${BK_SQL} WHERE ${where.join(' AND ')} ORDER BY b.id DESC LIMIT 200`).all(...p).map(fmtBooking);
});
post('/api/admin/bookings/:id/cancel', ADMIN, (req) => {
  const b = db.prepare(`${BK_SQL} WHERE b.id=?`).get(Number(req.params.id));
  if (!b) throw new HttpError(404, 'Booking not found');
  const refund = cancelBooking(b, { full: true });
  return { booking: fmtBooking(db.prepare(`${BK_SQL} WHERE b.id=?`).get(b.id)), refund };
});

get('/api/admin/users', ADMIN, () => db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.role,u.created_at AS createdAt,
  (SELECT COUNT(*) FROM bookings b WHERE b.user_id=u.id AND b.status='CONFIRMED') AS bookings FROM users u ORDER BY u.id DESC LIMIT 200`).all().map((x) => ({ ...x })));

// ---------------------------------------------------------------- start
const server = http.createServer(handle);
if (require.main === module) {
  server.listen(PORT, () => console.log(`\n  BusGo is running  ->  http://localhost:${PORT}\n`));
}
module.exports = { server, HoldMinutes: HOLD_MINUTES };
