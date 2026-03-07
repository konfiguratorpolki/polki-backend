require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');

const app = express();

// ─── CORS — pozwól GitHub Pages łączyć się z tym backendem ───────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '5mb' }));

// ─── BAZA SQLite ──────────────────────────────────────────────────────────────
const db = new Database('orders.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_uuid TEXT UNIQUE NOT NULL,
    p24_session_id TEXT,
    p24_order_id TEXT,
    customer_name TEXT,
    customer_email TEXT,
    customer_phone TEXT,
    customer_address TEXT,
    customer_notes TEXT,
    cart_json TEXT,
    total_amount INTEGER,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_at DATETIME
  )
`);

// ─── KONFIGURACJA ─────────────────────────────────────────────────────────────
const P24_SANDBOX  = process.env.P24_SANDBOX !== 'false';
const P24_BASE     = P24_SANDBOX ? 'https://sandbox.przelewy24.pl' : 'https://secure.przelewy24.pl';
const P24_MERCHANT = parseInt(process.env.P24_MERCHANT_ID || '0');
const P24_POS_ID   = parseInt(process.env.P24_POS_ID || process.env.P24_MERCHANT_ID || '0');
const P24_API_KEY  = process.env.P24_API_KEY || '';
const P24_SECRET   = process.env.P24_SECRET  || '';
const SITE_URL     = process.env.SITE_URL    || '';  // np. https://konfiguratorpolki.github.io/nowyprojekt3
const TEST_MODE    = (P24_MERCHANT === 0);

// ─── EMAIL ────────────────────────────────────────────────────────────────────
let mailer = null;
try {
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        const nodemailer = require('nodemailer');
        mailer = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: false,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
        console.log('📧 Email:', process.env.SMTP_USER);
    }
} catch(e) {}

function p24Sign(data) {
    return crypto.createHash('sha384').update(JSON.stringify(data)).digest('hex');
}

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
app.use('/api/create-order', rateLimit({ windowMs: 15*60*1000, max: 15 }));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', mode: TEST_MODE ? 'test' : 'production' }));

// ─── TWORZENIE ZAMÓWIENIA ─────────────────────────────────────────────────────
app.post('/api/create-order', async (req, res) => {
    try {
        const { customer, cart, totals } = req.body;

        if (!customer?.fullName || !customer?.email || !customer?.phone || !customer?.address)
            return res.status(400).json({ error: 'Brakujące dane klienta.' });
        if (!cart?.length)
            return res.status(400).json({ error: 'Koszyk jest pusty.' });

        const amountGrosze = Math.round((totals?.total || 0) * 100);
        if (amountGrosze < 100)
            return res.status(400).json({ error: 'Kwota zamówienia za niska.' });

        const orderUuid = crypto.randomUUID();
        const sessionId = `POLKA-${orderUuid}`;

        db.prepare(`
            INSERT INTO orders
              (order_uuid, p24_session_id, customer_name, customer_email,
               customer_phone, customer_address, customer_notes,
               cart_json, total_amount, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).run(orderUuid, sessionId, customer.fullName, customer.email,
               customer.phone, customer.address, customer.notes || '',
               JSON.stringify(cart), amountGrosze);

        console.log(`✅ Zamówienie: ${orderUuid} | ${customer.fullName} | ${(amountGrosze/100).toFixed(2)} zł`);

        // TRYB TESTOWY — bez P24
        if (TEST_MODE) {
            db.prepare(`UPDATE orders SET status='paid_test', paid_at=CURRENT_TIMESTAMP WHERE order_uuid=?`).run(orderUuid);
            if (mailer) await sendOwnerEmail({ order_uuid:orderUuid, customer_name:customer.fullName,
                customer_email:customer.email, customer_phone:customer.phone,
                customer_address:customer.address, customer_notes:customer.notes||'',
                cart_json:JSON.stringify(cart), total_amount:amountGrosze }, 'TEST');
            const returnUrl = SITE_URL
                ? `${SITE_URL}/thank-you.html?session=${encodeURIComponent(sessionId)}`
                : `/thank-you.html?session=${encodeURIComponent(sessionId)}`;
            return res.json({ redirectUrl: returnUrl });
        }

        // TRYB PRODUKCYJNY — z P24
        const returnUrl = `${SITE_URL}/thank-you.html?session=${encodeURIComponent(sessionId)}`;
        const p24Payload = {
            merchantId: P24_MERCHANT, posId: P24_POS_ID,
            sessionId, amount: amountGrosze, currency: 'PLN',
            description: `Zamówienie półki ${sessionId.slice(0,20)}`,
            email: customer.email, client: customer.fullName,
            phone: customer.phone, address: customer.address,
            zip:'', city:'', country:'PL', language:'pl',
            urlReturn: returnUrl,
            urlStatus: `${process.env.BACKEND_URL || ''}/api/p24-notify`,
            timeLimit: 30, encoding: 'UTF-8', methodId: 150,
        };
        p24Payload.sign = p24Sign({ sessionId, merchantId:P24_MERCHANT, amount:amountGrosze, currency:'PLN', crc:P24_API_KEY });

        const p24Res = await fetch(`${P24_BASE}/api/v1/transaction/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${P24_POS_ID}:${P24_SECRET}`).toString('base64'),
            },
            body: JSON.stringify(p24Payload),
        });
        const p24Data = await p24Res.json();

        if (!p24Res.ok || p24Data.error || !p24Data.data?.token) {
            console.error('❌ P24 error:', JSON.stringify(p24Data));
            return res.status(502).json({ error: 'Błąd bramki płatności. Sprawdź dane P24.' });
        }

        return res.json({ redirectUrl: `${P24_BASE}/trnRequest/${p24Data.data.token}` });

    } catch (err) {
        console.error('❌ Error:', err.message);
        return res.status(500).json({ error: 'Błąd serwera: ' + err.message });
    }
});

// ─── IPN OD P24 ───────────────────────────────────────────────────────────────
app.post('/api/p24-notify', async (req, res) => {
    try {
        const { sessionId, amount, currency, orderId, sign } = req.body;
        if (sign !== p24Sign({ sessionId, orderId, amount, currency, crc: P24_API_KEY }))
            return res.status(400).send('Invalid signature');

        const verifyPayload = { merchantId:P24_MERCHANT, posId:P24_POS_ID, sessionId, amount, currency, orderId };
        verifyPayload.sign = p24Sign({ sessionId, orderId, amount, currency, crc: P24_API_KEY });

        const vRes = await fetch(`${P24_BASE}/api/v1/transaction/verify`, {
            method: 'PUT',
            headers: { 'Content-Type':'application/json',
                'Authorization':'Basic '+Buffer.from(`${P24_POS_ID}:${P24_SECRET}`).toString('base64') },
            body: JSON.stringify(verifyPayload),
        });
        if (!vRes.ok) return res.status(400).send('Verification failed');

        const order = db.prepare('SELECT * FROM orders WHERE p24_session_id=?').get(sessionId);
        if (!order) return res.status(404).send('Not found');

        db.prepare(`UPDATE orders SET status='paid', p24_order_id=?, paid_at=CURRENT_TIMESTAMP WHERE p24_session_id=?`)
          .run(String(orderId), sessionId);

        if (mailer) { await sendOwnerEmail(order, orderId); await sendCustomerEmail(order); }
        return res.status(200).send('OK');
    } catch(e) { return res.status(500).send('Error'); }
});

// ─── EMAILE ───────────────────────────────────────────────────────────────────
async function sendOwnerEmail(order, p24Id='?') {
    const cart  = JSON.parse(order.cart_json || '[]');
    const total = ((order.total_amount||0)/100).toFixed(2);
    const items = cart.map((i,n)=>`${n+1}. ${i.name} x${i.quantity} | ${i.summary} | ${i.sideColor}/${i.shelfColor} | ${(i.price*i.quantity).toFixed(2)} zł`).join('\n');
    await mailer.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to:   process.env.MAIL_TO   || process.env.SMTP_USER,
        subject: `🛒 Nowe zamówienie #${order.order_uuid.slice(0,8)} — ${total} zł`,
        html: `<h2>🛒 Nowe zamówienie!</h2>
               <p><b>Klient:</b> ${order.customer_name}<br><b>Email:</b> ${order.customer_email}<br>
               <b>Telefon:</b> ${order.customer_phone}<br><b>Adres:</b> ${order.customer_address}<br>
               <b>Uwagi:</b> ${order.customer_notes||'-'}</p>
               <pre style="background:#f3f4f6;padding:12px;border-radius:6px">${items}</pre>
               <p><b>Łącznie: ${total} zł</b> | P24: ${p24Id}</p>`
    });
}
async function sendCustomerEmail(order) {
    const total = ((order.total_amount||0)/100).toFixed(2);
    await mailer.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to:   order.customer_email,
        subject: `Potwierdzenie zamówienia #${order.order_uuid.slice(0,8)}`,
        html: `<h2 style="color:green">Dziękujemy! 🎉</h2>
               <p>Cześć <b>${order.customer_name}</b>, przyjęliśmy Twoje zamówienie.</p>
               <p>Realizacja: <b>3–5 dni roboczych</b><br>Kwota: <b>${total} zł</b><br>
               Adres: ${order.customer_address}</p>`
    });
}

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✅ Backend działa na porcie ${PORT}`);
    console.log(`   Tryb: ${TEST_MODE ? '⚠️  TESTOWY (brak P24)' : '✅ PRODUKCJA'}`);
    console.log(`   SITE_URL: ${SITE_URL || '(nie ustawiony)'}\n`);
});
