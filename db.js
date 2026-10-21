'use strict';
// SQLite database (Node's built-in node:sqlite — no npm packages needed)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(dir, 'busgo.db'));

db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS buses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  operator TEXT NOT NULL,
  bus_type TEXT NOT NULL,
  total_seats INTEGER NOT NULL CHECK (total_seats BETWEEN 4 AND 60),
  amenities TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_city TEXT NOT NULL,
  to_city TEXT NOT NULL,
  distance_km INTEGER NOT NULL DEFAULT 0,
  UNIQUE (from_city, to_city)
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bus_id INTEGER NOT NULL REFERENCES buses(id),
  route_id INTEGER NOT NULL REFERENCES routes(id),
  departure_time TEXT NOT NULL,          -- HH:MM
  duration_min INTEGER NOT NULL,
  price INTEGER NOT NULL,                -- INR per seat
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pnr TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  schedule_id INTEGER NOT NULL REFERENCES schedules(id),
  travel_date TEXT NOT NULL,             -- YYYY-MM-DD
  fare INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','CANCELLED','EXPIRED')),
  payment_status TEXT NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID','PAID','REFUNDED')),
  payment_method TEXT,
  payment_ref TEXT,
  payment_summary TEXT,
  refund_amount INTEGER NOT NULL DEFAULT 0,
  contact_phone TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  hold_expires_at INTEGER,               -- epoch ms, only for PENDING
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);

CREATE TABLE IF NOT EXISTS booking_seats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  schedule_id INTEGER NOT NULL,
  travel_date TEXT NOT NULL,
  seat_no TEXT NOT NULL,
  passenger_name TEXT NOT NULL,
  age INTEGER NOT NULL,
  gender TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD','BOOKED','CANCELLED'))
);
-- A seat can only be HELD/BOOKED once per bus-trip. This is what prevents double booking.
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_seat
  ON booking_seats(schedule_id, travel_date, seat_no) WHERE status IN ('HELD','BOOKED');

CREATE TABLE IF NOT EXISTS blocked_seats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id),
  travel_date TEXT NOT NULL,
  seat_no TEXT NOT NULL,
  UNIQUE (schedule_id, travel_date, seat_no)
);
`);

// ---------- helpers ----------
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw e;
  }
}

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// ---------- seed demo data (only on an empty database) ----------
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const addUser = db.prepare('INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,?)');
  addUser.run('Admin', 'admin@busgo.com', '9999999999', hashPasswordSync('admin123'), 'admin');
  addUser.run('Demo User', 'user@busgo.com', '9876543210', hashPasswordSync('user123'), 'user');

  const buses = [
    ['Himalayan Express', 'Himalayan Travels', 'Volvo AC', 40, 'AC,WiFi,Charging Point,Water Bottle,Blanket'],
    ['Ganga Deluxe', 'Ganga Yatra', 'AC Seater', 40, 'AC,Charging Point,Water Bottle'],
    ['Doon Darshan', 'Doon Roadlines', 'Non-AC Seater', 44, 'Charging Point,Reading Light'],
    ['Royal Sleeper', 'Royal Cruiser', 'AC Sleeper', 32, 'AC,WiFi,Charging Point,Blanket,Reading Light'],
    ['Pink City Rider', 'Jaipur Express Lines', 'Volvo AC', 40, 'AC,WiFi,Charging Point,Snacks'],
    ['Shivalik Super', 'Shivalik Tours', 'AC Seater', 36, 'AC,Charging Point'],
    ['City Link', 'Uttar Roadways', 'Non-AC Seater', 44, 'Reading Light'],
    ['Night Rider', 'Night Rider Travels', 'AC Sleeper', 32, 'AC,Charging Point,Blanket,Water Bottle'],
  ];
  const addBus = db.prepare('INSERT INTO buses (name,operator,bus_type,total_seats,amenities) VALUES (?,?,?,?,?)');
  buses.forEach((b) => addBus.run(...b));

  const pairs = [
    ['Delhi', 'Roorkee', 180], ['Delhi', 'Dehradun', 250], ['Delhi', 'Haridwar', 220],
    ['Delhi', 'Jaipur', 280], ['Delhi', 'Chandigarh', 250], ['Delhi', 'Agra', 230],
    ['Delhi', 'Lucknow', 555], ['Roorkee', 'Dehradun', 70], ['Roorkee', 'Haridwar', 35],
    ['Dehradun', 'Chandigarh', 170], ['Haridwar', 'Rishikesh', 25], ['Jaipur', 'Ahmedabad', 660],
    ['Mumbai', 'Pune', 150], ['Mumbai', 'Ahmedabad', 530],
  ];
  const addRoute = db.prepare('INSERT INTO routes (from_city,to_city,distance_km) VALUES (?,?,?)');
  pairs.forEach(([a, b, km]) => { addRoute.run(a, b, km); addRoute.run(b, a, km); });

  const rate = { 'Non-AC Seater': 1.2, 'AC Seater': 1.8, 'Volvo AC': 2.2, 'AC Sleeper': 2.6 };
  const speed = { 'Non-AC Seater': 42, 'AC Seater': 50, 'Volvo AC': 55, 'AC Sleeper': 50 };
  const times = ['05:30', '08:15', '11:00', '14:30', '18:00', '21:30', '23:15'];
  const allBuses = db.prepare('SELECT * FROM buses').all();
  const allRoutes = db.prepare('SELECT * FROM routes').all();
  const addSch = db.prepare('INSERT INTO schedules (bus_id,route_id,departure_time,duration_min,price) VALUES (?,?,?,?,?)');
  allRoutes.forEach((r, i) => {
    const n = r.distance_km > 400 ? 3 : 4;
    for (let k = 0; k < n; k++) {
      const bus = allBuses[(i + k * 2) % allBuses.length];
      const dep = r.distance_km > 400 ? ['18:00', '20:30', '22:00'][k] : times[(i + k * 2) % times.length];
      const duration = Math.round((r.distance_km / speed[bus.bus_type]) * 60 / 5) * 5 + 15;
      const price = Math.max(60, Math.round((r.distance_km * rate[bus.bus_type]) / 10) * 10);
      addSch.run(bus.id, r.id, dep, duration, price);
    }
  });
  console.log('Demo data created. Admin: admin@busgo.com / admin123  |  User: user@busgo.com / user123');
}
seed();

module.exports = { db, tx, hashPasswordSync };
