const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '5mb' }));

// Zamówienia w pliku JSON
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
const ADMIN_PASS   = process.env.ADMIN_PASSWORD || 'polki2024';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const MAIL_TO      = process.env.MAIL_TO || '';

// ── PayNow (mBank) ──────────────────────────────────────────
const PAYNOW_API_KEY       = process.env.PAYNOW_API_KEY       || '';
const PAYNOW_SIGNATURE_KEY = process.env.PAYNOW_SIGNATURE_KEY || '';
const PAYNOW_ENV           = process.env.PAYNOW_ENV           || 'sandbox';
const PAYNOW_API_URL       = PAYNOW_ENV === 'production'
    ? 'https://api.paynow.pl/v1/payments'
    : 'https://api.sandbox.paynow.pl/v1/payments';
// Tymczasowy store oczekujących płatności (w pamięci serwera)
const pendingPaynow = new Map();

console.log('📧 RESEND_KEY:', RESEND_KEY ? `ustawiony (${RESEND_KEY.slice(0,8)}...)` : 'BRAK');
console.log('📧 MAIL_TO:', MAIL_TO || 'BRAK');

function p24Sign(data) {
    return crypto.createHash('sha384').update(JSON.stringify(data)).digest('hex');
}

app.use('/api/create-order', rateLimit({ windowMs: 15*60*1000, max: 15 }));

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', mode: TEST_MODE ? 'test' : 'production' }));

// ════════════════════════════════════════════════════════════
//  PAYNOW — Inicjacja płatności
//  Wywołanie z przeglądarki → zwraca redirectUrl do bramki
// ════════════════════════════════════════════════════════════
app.post('/api/paynow-init', rateLimit({ windowMs: 15*60*1000, max: 20 }), async (req, res) => {
    try {
        const { amount, orderData } = req.body;
        if (!amount || !orderData) return res.status(400).json({ error: 'Brak danych' });
        console.log('\uD83D\uDCDE Telefon z formularza:', JSON.stringify(orderData.phone));

        const externalId = 'PN-' + crypto.randomUUID().slice(0, 13).toUpperCase();
        const RETURN_URL = (process.env.SITE_URL || 'https://konfiguratorpolki.github.io') + '/?payment=success';

        const payload = {
            amount,
            currency:    'PLN',
            externalId,
            description: 'Zamówienie półki — Nowy Wymiar',
            buyer: {
                email:     orderData.email,
                firstName: orderData.firstName,
                lastName:  orderData.lastName,
                phone: (() => {
                    if (!orderData.phone) return undefined;
                    const digits = String(orderData.phone).replace(/\D/g, '').replace(/^48/, '');
                    return digits.length >= 9 ? '48' + digits.slice(-9) : undefined;
                })()
            },
            continueUrl: RETURN_URL
        };

        const idempotencyKey = crypto.randomUUID();
        const signature = crypto
            .createHmac('sha256', PAYNOW_SIGNATURE_KEY)
            .update(JSON.stringify(payload))
            .digest('base64');

        const pnRes = await fetch(PAYNOW_API_URL, {
            method:  'POST',
            headers: {
                'Api-Key':         PAYNOW_API_KEY,
                'Signature':       signature,
                'Idempotency-Key': idempotencyKey,
                'Content-Type':    'application/json'
            },
            body: JSON.stringify(payload)
        });
        const pnData = await pnRes.json();

        if (!pnRes.ok || !pnData.redirectUrl) {
            console.error('❌ PayNow init:', JSON.stringify(pnData));
            return res.status(502).json({ error: pnData.message || 'Błąd PayNow' });
        }

        // Zapisz dane zamówienia — użyjemy po potwierdzeniu webhookiem
        pendingPaynow.set(externalId, { orderData, amount, paymentId: pnData.paymentId, createdAt: Date.now() });
        // Wyczyść stare wpisy (>2h)
        for (const [k, v] of pendingPaynow) { if (Date.now() - v.createdAt > 7200000) pendingPaynow.delete(k); }

        console.log(`💳 PayNow init: ${externalId} | ${(amount/100).toFixed(2)} zł | ${orderData.email}`);
        return res.json({ redirectUrl: pnData.redirectUrl, paymentId: pnData.paymentId, externalId });

    } catch (err) {
        console.error('❌ paynow-init:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════
//  PAYNOW — Webhook (IPN)
//  PayNow wywołuje ten endpoint gdy zmienia się status płatności
//  Po CONFIRMED → tworzy zamówienie w BaseLinker i wysyła email
// ════════════════════════════════════════════════════════════
app.post('/api/paynow-notify', async (req, res) => {
    try {
        const receivedSig = req.headers['signature'];
        const body        = req.body;

        // Weryfikacja podpisu PayNow
        if (receivedSig && PAYNOW_SIGNATURE_KEY) {
            const expected = crypto
                .createHmac('sha256', PAYNOW_SIGNATURE_KEY)
                .update(JSON.stringify(body))
                .digest('base64');
            if (receivedSig !== expected) {
                console.warn('⚠️ PayNow webhook: zły podpis');
                return res.status(401).send('Invalid signature');
            }
        }

        const { paymentId, status, externalId } = body;
        console.log(`[PayNow Notify] ${externalId} | ${paymentId} | ${status}`);

        if (status === 'CONFIRMED') {
            const pending = pendingPaynow.get(externalId);
            if (!pending) {
                console.warn(`⚠️ Brak oczekującego zamówienia: ${externalId}`);
                return res.status(200).send('OK'); // już przetworzone lub wygasłe
            }

            const { orderData, amount } = pending;

            // Zapisz zamówienie lokalnie
            const order = {
                order_uuid:       externalId,
                p24_session_id:   externalId,
                customer_name:    `${orderData.firstName} ${orderData.lastName}`,
                customer_email:   orderData.email,
                customer_phone:   orderData.phone || '',
                customer_address: `${orderData.street}, ${orderData.postCode} ${orderData.city}`,
                customer_notes:   orderData.notes || '',
                cart_json:        JSON.stringify(orderData.cart || []),
                total_amount:     amount,
                status:           'paid',
                payment_method:   'paynow',
                paid_at:          new Date().toISOString(),
                created_at:       new Date().toISOString()
            };
            saveOrder(order);

            // Wyślij do BaseLinker
            try {
                const BL_URL = process.env.BASELINKER_PROXY_URL || 'https://baselinker-proxy.007lukasz-m.workers.dev';
                const BL_SOURCE = parseInt(process.env.ORDER_SOURCE_ID || '16611');

                let statusId = 0;
                try {
                    const sr = await fetch(BL_URL, { method:'POST', headers:{'Content-Type':'application/json'},
                        body: JSON.stringify({ method:'getOrderStatusList', parameters:{} }) });
                    const sd = await sr.json();
                    if (sd.status === 'SUCCESS' && sd.statuses?.length) {
                        const f = sd.statuses.find(s => /nowe|oczekuj|new|pending/i.test(s.name));
                        statusId = f ? f.id : sd.statuses[0].id;
                    }
                } catch(e) { console.warn('Statusy BL:', e.message); }

                const blPayload = {
                    order_status_id:       statusId,
                    custom_source_id:      BL_SOURCE,
                    date_add:              Math.floor(Date.now()/1000),
                    currency:              'PLN',
                    payment_method:        'PayNow (online)',
                    payment_done:          amount / 100,
                    delivery_method:       'kurier',
                    delivery_price:        orderData.shipping || 0,
                    delivery_fullname:     `${orderData.firstName} ${orderData.lastName}`,
                    delivery_address:      orderData.street || '',
                    delivery_city:         orderData.city   || '',
                    delivery_postcode:     orderData.postCode || '',
                    delivery_country_code: 'PL',
                    email:                 orderData.email,
                    phone:                 orderData.phone || '',
                    user_login:            orderData.email,
                    user_comments:         (orderData.notes||'') + (orderData.orderCode ? '\n\nKod konfiguracji:\n'+orderData.orderCode : ''),
                    admin_comments:        'Zamówienie opłacone przez PayNow',
                    want_invoice:          orderData.wantInvoice ? 1 : 0,
                    invoice_fullname:      orderData.wantInvoice ? `${orderData.firstName} ${orderData.lastName}` : '',
                    invoice_company:       orderData.invCompany  || '',
                    invoice_nip:           orderData.invNip      || '',
                    invoice_address:       orderData.invAddr     || '',
                    invoice_postcode:      orderData.invPostCode || '',
                    invoice_country_code:  orderData.wantInvoice ? 'PL' : '',
                    products: (orderData.cart||[]).map(i => ({
                        name: i.name, sku: i.code, quantity: i.quantity,
                        price_brutto: i.price, tax_rate: 23, weight: 2
                    }))
                };
                const blRes = await fetch(BL_URL, { method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ method:'addOrder', parameters: blPayload }) });
                const blData = await blRes.json();
                if (blData.status === 'SUCCESS') {
                    console.log(`✅ BaseLinker zamówienie #${blData.order_id} dla PayNow ${externalId}`);
                    order.baselinker_id = blData.order_id;
                } else {
                    console.error('❌ BaseLinker:', blData.error_message);
                }
            } catch(e) { console.error('❌ BaseLinker wyjątek:', e.message); }

            // Wyślij emaile
            await sendEmails(order, paymentId);

            pendingPaynow.delete(externalId);
        }

        return res.status(200).send('OK');
    } catch(e) {
        console.error('❌ paynow-notify:', e.message);
        return res.status(200).send('OK'); // zawsze 200 żeby PayNow nie powtarzał
    }
});

// Panel zamówień
app.get('/zamowienia', (req, res) => {
    const pass = req.query.pass;
    if (pass !== ADMIN_PASS) {
        return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <title>Panel zamówień</title>
        <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f3f4f6}
        .box{background:white;padding:40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);text-align:center}
        input{padding:10px 16px;border:1px solid #ddd;border-radius:8px;margin:10px 0;width:200px;font-size:16px}
        button{padding:10px 24px;background:#16a34a;color:white;border:none;border-radius:8px;cursor:pointer;font-size:16px}</style>
        </head><body><div class="box"><h2>🔐 Panel zamówień</h2>
        <form onsubmit="location.href='/zamowienia?pass='+document.getElementById('p').value;return false">
        <input id="p" type="password" placeholder="Hasło"><br>
        <button type="submit">Zaloguj</button></form></div></body></html>`);
    }

    const orders = loadOrders().reverse();
    const rows = orders.map(o => {
        const cart = JSON.parse(o.cart_json || '[]');
        const total = ((o.total_amount||0)/100).toFixed(2);
        const statusColor = o.status === 'paid' ? '#16a34a' : o.status === 'paid_test' ? '#ca8a04' : '#6b7280';
        const statusLabel = o.status === 'paid' ? '✅ Opłacone' : o.status === 'paid_test' ? '🧪 Test' : '⏳ Oczekuje';
        const items = cart.map(i => `${i.name} x${i.quantity}`).join(', ');
        const date = new Date(o.created_at).toLocaleString('pl-PL');
        return `<tr>
            <td>${date}</td>
            <td><b>${o.customer_name}</b><br><small>${o.customer_email}</small><br><small>${o.customer_phone}</small></td>
            <td><small>${o.customer_address}</small></td>
            <td><small>${items}</small></td>
            <td><b>${total} zł</b></td>
            <td style="color:${statusColor}">${statusLabel}</td>
            <td><small>${o.order_uuid.slice(0,8)}</small></td>
        </tr>`;
    }).join('');

    const totalRevenue = orders.filter(o => o.status === 'paid' || o.status === 'paid_test')
        .reduce((s, o) => s + (o.total_amount||0), 0) / 100;

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Panel zamówień</title>
    <style>
        body{font-family:sans-serif;margin:0;background:#f3f4f6;color:#111}
        .header{background:#16a34a;color:white;padding:20px 32px;display:flex;justify-content:space-between;align-items:center}
        .header h1{margin:0;font-size:22px}
        .stats{display:flex;gap:16px;padding:24px 32px}
        .stat{background:white;border-radius:10px;padding:16px 24px;flex:1;box-shadow:0 1px 4px rgba(0,0,0,.08)}
        .stat .val{font-size:28px;font-weight:bold;color:#16a34a}
        .stat .lbl{color:#6b7280;font-size:14px}
        .table-wrap{padding:0 32px 32px}
        table{width:100%;border-collapse:collapse;background:white;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
        th{background:#f9fafb;padding:12px 16px;text-align:left;font-size:13px;color:#6b7280;border-bottom:1px solid #e5e7eb}
        td{padding:12px 16px;border-bottom:1px solid #f3f4f6;vertical-align:top;font-size:14px}
        tr:hover td{background:#f9fafb}
        .empty{text-align:center;padding:48px;color:#6b7280}
    </style>
    </head><body>
    <div class="header"><h1>🛒 Panel zamówień — Konfigurator Półek</h1>
    <span>${orders.length} zamówień</span></div>
    <div class="stats">
        <div class="stat"><div class="val">${orders.length}</div><div class="lbl">Wszystkie zamówienia</div></div>
        <div class="stat"><div class="val">${orders.filter(o=>o.status==='paid').length}</div><div class="lbl">Opłacone</div></div>
        <div class="stat"><div class="val">${totalRevenue.toFixed(2)} zł</div><div class="lbl">Łączna wartość</div></div>
    </div>
    <div class="table-wrap">
    ${orders.length === 0 ? '<div class="empty">Brak zamówień</div>' : `
    <table>
        <thead><tr>
            <th>Data</th><th>Klient</th><th>Adres</th><th>Produkty</th><th>Kwota</th><th>Status</th><th>Nr</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table>`}
    </div></body></html>`);
});

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
            order_uuid: orderUuid, p24_session_id: sessionId,
            customer_name: customer.fullName, customer_email: customer.email,
            customer_phone: customer.phone, customer_address: customer.address,
            customer_notes: customer.notes || '', cart_json: JSON.stringify(cart),
            total_amount: amountGrosze, status: 'pending',
            created_at: new Date().toISOString()
        };
        saveOrder(order);
        console.log(`✅ Zamówienie: ${orderUuid} | ${customer.fullName} | ${(amountGrosze/100).toFixed(2)} zł`);

        if (TEST_MODE) {
            order.status = 'paid_test';
            await sendEmails(order, 'TEST');
            const returnUrl = `https://konfiguratorpolki.github.io/nowyprojekt3/thank-you.html?session=${encodeURIComponent(sessionId)}`;
            return res.json({ redirectUrl: returnUrl });
        }

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
            headers: { 'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${P24_POS_ID}:${P24_SECRET}`).toString('base64') },
            body: JSON.stringify(p24Payload),
        });
        const p24Data = await p24Res.json();
        if (!p24Res.ok || p24Data.error || !p24Data.data?.token) {
            console.error('❌ P24:', JSON.stringify(p24Data));
            return res.status(502).json({ error: 'Błąd bramki płatności.' });
        }
        return res.json({ redirectUrl: `${P24_BASE}/trnRequest/${p24Data.data.token}` });

    } catch (err) {
        console.error('❌', err.message);
        return res.status(500).json({ error: 'Błąd serwera: ' + err.message });
    }
});

// IPN
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
        await sendEmails(order, orderId);
        return res.status(200).send('OK');
    } catch(e) { return res.status(500).send('Error'); }
});

// Wysyłka emaili przez Resend API
async function sendEmails(order, p24Id='TEST') {
    if (!RESEND_KEY) { console.log('⚠️ Brak RESEND_API_KEY — email pominięty'); return; }
    const cart  = JSON.parse(order.cart_json || '[]');
    const total = ((order.total_amount||0)/100).toFixed(2);

    // Buduj HTML i załączniki
    const attachments = [];
    const itemsHtml = cart.map((i,n) => {
        let imgHtml = '';
        if (i.snapshot && i.snapshot.startsWith('data:image/png;base64,')) {
            const b64 = i.snapshot.replace('data:image/png;base64,', '');
            const filename = `polka-${n+1}.png`;
            attachments.push({ filename, content: b64 });
            imgHtml = `<img src="${i.snapshot}" width="120" height="120" style="object-fit:contain;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;" />`;
        }
        return `<tr>
            <td style="padding:12px;vertical-align:middle">${imgHtml}</td>
            <td style="padding:12px;vertical-align:middle">
                <b>${i.name}</b> x${i.quantity}<br>
                <small style="color:#6b7280">${i.summary || ''}</small><br>
                <small style="color:#6b7280">Boki: ${i.sideColor || '-'} | Półki: ${i.shelfColor || '-'}</small>
            </td>
            <td style="padding:12px;vertical-align:middle;text-align:right"><b>${(i.price*i.quantity).toFixed(2)} zł</b></td>
        </tr>`;
    }).join('');

    // Email do właściciela
    try {
        const emailPayload = {
            from: 'Konfigurator Półek <onboarding@resend.dev>',
            to: [MAIL_TO || order.customer_email],
            subject: `🛒 Nowe zamówienie #${order.order_uuid.slice(0,8)} — ${total} zł`,
            html: `<div style="font-family:sans-serif;max-width:600px">
                   <h2 style="color:#16a34a">🛒 Nowe zamówienie!</h2>
                   <p><b>Klient:</b> ${order.customer_name}<br>
                   <b>Email:</b> ${order.customer_email}<br>
                   <b>Telefon:</b> ${order.customer_phone}<br>
                   <b>Adres:</b> ${order.customer_address}<br>
                   <b>Uwagi:</b> ${order.customer_notes||'-'}</p>
                   <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px">
                   ${itemsHtml}
                   <tr style="background:#f9fafb">
                       <td colspan="2" style="padding:12px;text-align:right"><b>Łącznie:</b></td>
                       <td style="padding:12px;text-align:right"><b style="color:#16a34a;font-size:18px">${total} zł</b></td>
                   </tr>
                   </table></div>`,
        };
        if (attachments.length > 0) emailPayload.attachments = attachments;
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(emailPayload)
        });
        const data = await r.json();
        if (r.ok) console.log('📧 Email do właściciela wysłany:', data.id);
        else console.log('❌ Email błąd:', JSON.stringify(data));
    } catch(e) { console.log('❌ Email wyjątek:', e.message); }

    // Email do klienta
    try {
        await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: 'Konfigurator Półek <onboarding@resend.dev>',
                to: [order.customer_email],
                subject: `Potwierdzenie zamówienia #${order.order_uuid.slice(0,8)}`,
                html: `<h2 style="color:green">Dziękujemy! 🎉</h2>
                       <p>Cześć <b>${order.customer_name}</b>,<br>
                       Realizacja: <b>3–5 dni roboczych</b><br>
                       Kwota: <b>${total} zł</b><br>
                       Adres: ${order.customer_address}</p>`
            })
        });
        console.log('📧 Email do klienta wysłany');
    } catch(e) { console.log('❌ Email klient wyjątek:', e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Backend port ${PORT} | Tryb: ${TEST_MODE ? 'TESTOWY' : 'PRODUKCJA'}`);
    console.log(`📋 Panel zamówień: /zamowienia?pass=${ADMIN_PASS}`);
});
