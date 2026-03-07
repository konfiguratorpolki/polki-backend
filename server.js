require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const rateLimit = require('express-rate-limit');

const app = express();

// CORS — pozwól GitHub Pages łączyć się z backendem
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '5mb' }));

// Zapis zamówień do pliku JSON (zamiast SQLite)
const ORDERS_FILE = path.join(__dirname, 'orders.json');
function loadOrders() {
    try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } 
    catch(e) { return []; }
}
function saveOrder(order) {
    const orders = loadOrders();
    orders.push(order);
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// Konfiguracja
const P24_SANDBOX  = process.env.P24_SANDBOX !== 'false';
const P24_BASE     = P24_SANDBOX ? 'https://sandbox.przelewy24.pl' : 'https://secure.przelewy24.pl';
const P24_MERCHANT = parseInt(process.env.P24_MERCHANT_ID || '0');
const P24_POS_ID   = parseInt(process.env.P24_POS_ID || process.env.P24_MERCHANT_ID || '0');
const P24_API_KEY  = process.env.P24_API_KEY || '';
const P24_SECRET   = process.env.P24_SECRET  || '';
const SITE_URL     = process.env.SITE_URL    || '';
const TEST_MODE    = (P24_MERCHANT === 0);

// Email
let mailer = null;
try {
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        const nodemailer = require('nodemailer');
        mailer = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: 587, secure: false,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
    }
} catch(e) {}

function p24Sign(data) {
    return crypto.createHash('sha384').update(JSON.stringify(data)).digest('hex');
}

app.use('/api/create-order', rateLimit({ windowMs: 15*60*1000, max: 15 }));

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', mode: TEST_MODE ? 'test' : 'production' }));

// Tworzenie zamówienia
app.post('/api/create-order', async (req, res) => {
    try {
        const { customer, cart, totals } = req.body;

        if (!customer?.fullName || !customer?.email || !customer?.phone || !customer?.address)
            return res.status(400).json({ error: 'Brakujące dane klienta.' });
        if (!cart?.length)
            return res.status(400).json({ error: 'Koszyk jest pusty.' });

        const amountGrosze = Math.round((totals?.total || 0) * 100);
        if (amountGrosze < 100)
            return res.status(400).json({ error: 'Kwota za niska.' });

        const orderUuid = crypto.randomUUID();
        const sessionId = `POLKA-${orderUuid}`;

        const order = {
            order_uuid: orderUuid,
            p24_session_id: sessionId,
            customer_name: customer.fullName,
            customer_email: customer.email,
            customer_phone: customer.phone,
            customer_address: customer.address,
            customer_notes: customer.notes || '',
            cart_json: JSON.stringify(cart),
            total_amount: amountGrosze,
            status: 'pending',
            created_at: new Date().toISOString()
        };

        saveOrder(order);
        console.log(`✅ Zamówienie: ${orderUuid} | ${customer.fullName} | ${(amountGrosze/100).toFixed(2)} zł`);

        // TRYB TESTOWY
        if (TEST_MODE) {
            order.status = 'paid_test';
            if (mailer) await sendOwnerEmail(order, 'TEST');
            const returnUrl = SITE_URL
                ? `${SITE_URL}/thank-you.html?session=${encodeURIComponent(sessionId)}`
                : `https://konfiguratorpolki.github.io/nowyprojekt3/thank-you.html?session=${encodeURIComponent(sessionId)}`;
            return res.json({ redirectUrl: returnUrl });
        }

        // TRYB PRODUKCYJNY z P24
        const returnUrl = `${SITE_URL}/thank-you.html?session=${encodeURIComponent(sessionId)}`;
        const p24Payload = {
            merchantId: P24_MERCHANT, posId: P24_POS_ID,
            sessionId, amount: amountGrosze, currency: 'PLN',
            description: `Zamówienie półki`,
            email: customer.email, client: customer.fullName,
            phone: customer.phone, address: customer.address,
            zip:'', city:'', country:'PL', language:'pl',
            urlReturn: returnUrl,
            urlStatus: `${process.env.BACKEND_URL||''}/api/p24-notify`,
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
            return res.status(502).json({ error: 'Błąd bramki płatności.' });
        }

        return res.json({ redirectUrl: `${P24_BASE}/trnRequest/${p24Data.data.token}` });

    } catch (err) {
        console.error('❌ Error:', err.message);
        return res.status(500).json({ error: 'Błąd serwera: ' + err.message });
    }
});

// IPN od P24
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

        const orders = loadOrders();
        const order = orders.find(o => o.p24_session_id === sessionId);
        if (!order) return res.status(404).send('Not found');
        order.status = 'paid';
        order.p24_order_id = String(orderId);
        order.paid_at = new Date().toISOString();
        fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));

        if (mailer) { await sendOwnerEmail(order, orderId); await sendCustomerEmail(order); }
        return res.status(200).send('OK');
    } catch(e) { return res.status(500).send('Error'); }
});

// Emaile
async function sendOwnerEmail(order, p24Id='?') {
    if (!mailer) return;
    const cart  = JSON.parse(order.cart_json || '[]');
    const total = ((order.total_amount||0)/100).toFixed(2);
    const items = cart.map((i,n)=>`${n+1}. ${i.name} x${i.quantity} | ${i.summary} | ${(i.price*i.quantity).toFixed(2)} zł`).join('\n');
    await mailer.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to:   process.env.MAIL_TO   || process.env.SMTP_USER,
        subject: `🛒 Nowe zamówienie #${order.order_uuid.slice(0,8)} — ${total} zł`,
        html: `<h2>🛒 Nowe zamówienie!</h2>
               <p><b>Klient:</b> ${order.customer_name}<br>
               <b>Email:</b> ${order.customer_email}<br>
               <b>Telefon:</b> ${order.customer_phone}<br>
               <b>Adres:</b> ${order.customer_address}<br>
               <b>Uwagi:</b> ${order.customer_notes||'-'}</p>
               <pre style="background:#f5f5f5;padding:12px">${items}</pre>
               <p><b>Łącznie: ${total} zł</b></p>`
    });
    console.log('📧 Email wysłany do właściciela');
}

async function sendCustomerEmail(order) {
    if (!mailer) return;
    const total = ((order.total_amount||0)/100).toFixed(2);
    await mailer.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to:   order.customer_email,
        subject: `Potwierdzenie zamówienia #${order.order_uuid.slice(0,8)}`,
        html: `<h2 style="color:green">Dziękujemy! 🎉</h2>
               <p>Cześć <b>${order.customer_name}</b>,</p>
               <p>Przyjęliśmy Twoje zamówienie.<br>
               Realizacja: <b>3–5 dni roboczych</b><br>
               Kwota: <b>${total} zł</b><br>
               Adres: ${order.customer_address}</p>`
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Backend działa na porcie ${PORT}`);
    console.log(`   Tryb: ${TEST_MODE ? '⚠️  TESTOWY' : '✅ PRODUKCJA P24'}`);
});
