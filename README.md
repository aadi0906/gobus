# BusGo – Bus Ticket Booking App

Full-stack bus booking app: **Node.js + built-in SQLite + vanilla JS**. No npm packages, no build step.

## Features
- Bus search (From / To / Date), filters and sorting
- Live seat map, seat selection (max 6), double-booking protection
- Passenger details, 10-minute seat hold, payment screen (UPI, Debit Card, Credit Card, Net Banking)
- E-ticket with PNR + QR, print / save as PDF
- My Bookings, cancellation with refund policy
- Login / Signup (hashed passwords, token auth)
- Admin panel: dashboard, buses, routes, schedules, seat blocking/viewing, bookings (cancel), users

## Run
Requires **Node.js 22.13 or newer** (SQLite is built in).
```
node server.js        # or: npm start
```
Open http://localhost:3000

Demo logins (created on first start):
- Admin: `admin@busgo.com` / `admin123`
- Customer: `user@busgo.com` / `user123`

Node 22.5–22.12: run `node --experimental-sqlite server.js`.

Other commands: `npm test` (API tests), `npm run reset-db` (wipe data), `PORT=8080 node server.js`.

## Payments are SIMULATED
No real money moves. Test card `4111 1111 1111 1111` (any future expiry, any CVV); card ending `0002` is declined;
UPI `anything@okhdfcbank` works, `fail@upi` is declined. Card numbers/CVV are never stored.
For real payments, replace `charge()` in `payment.js` with Razorpay / PayU / Cashfree / Stripe (use their hosted checkout) and verify payments server-side via webhook.

## Structure
```
server.js     API + static server (auth, search, booking, payment, admin)
db.js         SQLite schema + demo data
payment.js    payment gateway adapter (simulated)
public/       index.html, css/style.css, js/{core,pages,admin,main}.js
test/         end-to-end API test
```

## Before going live
Set `JWT_SECRET` env var, change demo passwords, serve over HTTPS (reverse proxy), integrate a real gateway,
add email/SMS ticket delivery. The QR code library loads from cdnjs (needs internet; ticket works without it).
