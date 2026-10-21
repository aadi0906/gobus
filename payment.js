'use strict';
/**
 * Payment gateway ADAPTER (simulated).
 *
 * This validates UPI / Debit Card / Credit Card / Net Banking input and pretends to
 * charge it. NO real money moves. To go live, replace `charge()` with a call to a real
 * gateway (Razorpay, PayU, Cashfree, Stripe...) — the rest of the app does not change.
 * With a real gateway, card/UPI details are entered on the gateway's own hosted
 * checkout, so card numbers never touch your server (PCI-DSS).
 *
 * Test behaviour in this simulator:
 *   UPI        : any valid id like name@okhdfc ... ids starting with "fail@" are declined
 *   Cards      : any Luhn-valid number (e.g. 4111 1111 1111 1111); numbers ending 0002 are declined
 *   Net Banking: pick any bank
 * Card numbers / CVV are NEVER stored — only the last 4 digits.
 */
const crypto = require('crypto');

const BANKS = ['State Bank of India', 'HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Punjab National Bank',
  'Kotak Mahindra Bank', 'Bank of Baroda', 'Canara Bank', 'Yes Bank', 'IDFC FIRST Bank'];
const METHODS = ['UPI', 'DEBIT_CARD', 'CREDIT_CARD', 'NET_BANKING'];

function luhn(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = Number(num[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

function validate(method, d = {}) {
  if (!METHODS.includes(method)) return 'Please choose a payment method';
  if (method === 'UPI') {
    if (!/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(String(d.upiId || '').trim())) return 'Enter a valid UPI ID (e.g. name@okhdfcbank)';
  } else if (method === 'NET_BANKING') {
    if (!BANKS.includes(d.bank)) return 'Please select your bank';
  } else {
    const num = String(d.cardNumber || '').replace(/\s+/g, '');
    if (!/^\d{13,19}$/.test(num) || !luhn(num)) return 'Invalid card number';
    const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(String(d.expiry || '').trim());
    if (!m) return 'Enter expiry as MM/YY';
    const mm = Number(m[1]), yy = 2000 + Number(m[2]);
    const now = new Date();
    if (mm < 1 || mm > 12 || yy < now.getFullYear() || (yy === now.getFullYear() && mm < now.getMonth() + 1)) return 'Card has expired';
    if (!/^\d{3,4}$/.test(String(d.cvv || ''))) return 'Invalid CVV';
    if (String(d.cardName || '').trim().length < 2) return 'Enter the name on the card';
  }
  return null;
}

function summarise(method, d) {
  if (method === 'UPI') return `UPI • ${String(d.upiId).trim()}`;
  if (method === 'NET_BANKING') return `Net Banking • ${d.bank}`;
  const num = String(d.cardNumber).replace(/\s+/g, '');
  return `${method === 'DEBIT_CARD' ? 'Debit' : 'Credit'} Card • •••• ${num.slice(-4)}`;
}

async function charge({ method, amount, details }) {
  const err = validate(method, details);
  if (err) return { ok: false, message: err };

  await new Promise((r) => setTimeout(r, 900)); // pretend to talk to the bank

  const declined =
    (method === 'UPI' && /^fail@/i.test(String(details.upiId).trim())) ||
    ((method === 'DEBIT_CARD' || method === 'CREDIT_CARD') && String(details.cardNumber).replace(/\s+/g, '').endsWith('0002'));
  if (declined) return { ok: false, message: 'Payment declined by your bank. Please try another method.' };

  return {
    ok: true,
    ref: 'TXN' + crypto.randomBytes(6).toString('hex').toUpperCase(),
    summary: summarise(method, details),
    amount,
  };
}

module.exports = { charge, BANKS, METHODS };
