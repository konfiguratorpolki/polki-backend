const express    = require('express');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const rateLimit  = require('express-rate-limit');
const nodemailer = require('nodemailer');

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
const ORDERS_FILE    = path.join(__dirname, 'orders.json');
const SNAPSHOTS_FILE = path.join(__dirname, 'snapshots.json');

const SELF_URL = process.env.BACKEND_URL || 'https://polki-backend-production.up.railway.app';

function loadOrders() {
    try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); }
    catch(e) { return []; }
}
function saveOrder(order) {
    const orders = loadOrders();
    orders.push(order);
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}
function saveSnapshots(orderId, snaps) {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8')); } catch(e) {}
    all[orderId] = snaps;
    fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(all));
}
function loadSnapshots(orderId) {
    try {
        const all = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'));
        return all[orderId] || [];
    } catch(e) { return []; }
}

// ── Snapshoty w pamięci (Map) — BaseLinker pobiera je w ciągu sekund od addOrder ──
// Klucz: unikalna nazwa pliku, wartość: { buf: Buffer, expires: timestamp }
const snapMemory = new Map();

// Wyślij obraz do ImgBB → zwróć stały publiczny URL
async function uploadToImgBB(base64DataUri, name) {
    const key = process.env.IMGBB_API_KEY;
    if (!key) return null;
    try {
        const b64 = base64DataUri.replace('data:image/png;base64,', '');
        const body = new URLSearchParams();
        body.append('key', key);
        body.append('image', b64);
        body.append('name', name);
        const r = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body });
        const d = await r.json();
        if (d.success) {
            console.log(`🖼️ ImgBB OK: ${d.data.url}`);
            return d.data.url;
        }
        console.warn('⚠️ ImgBB error:', JSON.stringify(d.error));
        return null;
    } catch(e) {
        console.warn('⚠️ ImgBB wyjątek:', e.message);
        return null;
    }
}

// Upload zdjęcia do GitHub repo → zwróć trwały publiczny URL
async function uploadToGitHub(base64DataUri, filename) {
    const token = process.env.GITHUB_TOKEN;
    const repo  = process.env.GITHUB_REPO; // np. "konfiguratorpolki/snapshots"
    if (!token || !repo) return null;
    try {
        const b64 = base64DataUri.replace('data:image/png;base64,', '');
        const url = `https://api.github.com/repos/${repo}/contents/${filename}`;
        const r = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'polki-backend'
            },
            body: JSON.stringify({
                message: `snapshot ${filename}`,
                content: b64
            })
        });
        const d = await r.json();
        if (r.ok && d.content?.download_url) {
            // Użyj raw.githubusercontent.com — bezpośredni publiczny URL
            const rawUrl = `https://raw.githubusercontent.com/${repo}/main/${filename}`;
            console.log(`🖼️ GitHub OK: ${rawUrl}`);
            return rawUrl;
        }
        console.warn('⚠️ GitHub upload błąd:', JSON.stringify(d.message || d));
        return null;
    } catch(e) {
        console.warn('⚠️ GitHub upload wyjątek:', e.message);
        return null;
    }
}

// Zapisz snapshot i zwróć publiczny URL
// 1. Próbuje GitHub (trwały URL, dostępny zawsze)
// 2. Fallback: pamięć RAM serwera (działa dopóki serwer nie zrestartuje)
async function saveSnapshotImage(prefix, idx, base64DataUri) {
    if (!base64DataUri || !base64DataUri.startsWith('data:image/png;base64,')) return null;
    const filename = `${prefix}-${idx}.png`;

    // Próba 1: GitHub
    const githubUrl = await uploadToGitHub(base64DataUri, filename);
    if (githubUrl) return githubUrl;

    // Próba 2: pamięć RAM (fallback gdy brak tokena)
    try {
        const buf = Buffer.from(base64DataUri.replace('data:image/png;base64,', ''), 'base64');
        snapMemory.set(filename, { buf, expires: Date.now() + 2 * 60 * 60 * 1000 });
        for (const [k, v] of snapMemory) { if (Date.now() > v.expires) snapMemory.delete(k); }
        console.log(`🖼️ Snapshot RAM (fallback): ${filename} (${(buf.length/1024).toFixed(1)} KB)`);
        return `${SELF_URL}/api/snapshot-img/${filename}`;
    } catch(e) {
        console.warn('⚠️ Snapshot RAM błąd:', e.message);
        return null;
    }
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
const MAIL_TO      = process.env.MAIL_TO || 'regaliki.pl@gmail.com';

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
console.log('📧 MAIL_TO:', MAIL_TO);

function p24Sign(data) {
    return crypto.createHash('sha384').update(JSON.stringify(data)).digest('hex');
}

app.use('/api/create-order', rateLimit({ windowMs: 15*60*1000, max: 15 }));

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', mode: TEST_MODE ? 'test' : 'production' }));

// ── Serwowanie snapszotów PNG dla BaseLinker auction_images ──
app.get('/api/snapshot-img/:filename', (req, res) => {
    const key   = path.basename(req.params.filename); // blokuj path traversal
    const entry = snapMemory.get(key);
    if (!entry) {
        console.warn(`⚠️ Snapshot nie znaleziony w pamięci: ${key}`);
        return res.status(404).send('Not found');
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(entry.buf);
});

// ════════════════════════════════════════════════════════════
//  PAYNOW — Inicjacja płatności
//  Wywołanie z przeglądarki → zwraca redirectUrl do bramki
// ════════════════════════════════════════════════════════════
app.post('/api/paynow-init', rateLimit({ windowMs: 15*60*1000, max: 20 }), async (req, res) => {
    try {
        const { amount, orderData } = req.body;
        if (!amount || !orderData) return res.status(400).json({ error: 'Brak danych' });

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
                lastName:  orderData.lastName
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

            // Zapisz snapshoty w pamięci RAM i wygeneruj URL-e do admin_comments
            const cartWithImgUrls = await Promise.all((orderData.cart||[]).map(async (item, idx) => {
                const imgUrl = await saveSnapshotImage(externalId, idx, item.snapshot);
                return { ...item, imgUrl };
            }));

            // Zbuduj linki do zdjęć dla admin_comments
            const imgLinks = cartWithImgUrls
                .filter(i => i.imgUrl)
                .map((i, n) => `Zdjęcie półki ${n+1}: ${i.imgUrl}`)
                .join('\n');

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
                    paid:                  1,
                    delivery_method:       'kurier',
                    delivery_price:        orderData.shipping || 0,
                    user_comments:         (orderData.notes||'') + (orderData.orderCode ? '\n\nKod konfiguracji:\n'+orderData.orderCode : '') + (orderData.discount ? '\n\nRabat: '+parseFloat(orderData.discount).toFixed(2)+' zł' : ''),
                    delivery_fullname:     `${orderData.firstName} ${orderData.lastName}`,
                    delivery_address:      orderData.street || '',
                    delivery_city:         orderData.city   || '',
                    delivery_postcode:     orderData.postCode || '',
                    delivery_country_code: 'PL',
                    email:                 orderData.email,
                    phone:                 orderData.phone || '',
                    user_login:            orderData.email,
                    admin_comments:        'Zamówienie opłacone przez PayNow' + (imgLinks ? '\n\n📷 Podgląd 3D:\n' + imgLinks : ''),
                    want_invoice:          orderData.wantInvoice ? 1 : 0,
                    invoice_fullname:      orderData.wantInvoice ? `${orderData.firstName} ${orderData.lastName}` : '',
                    invoice_company:       orderData.invCompany  || '',
                    invoice_nip:           orderData.invNip      || '',
                    invoice_address:       orderData.invAddr     || '',
                    invoice_postcode:      orderData.invPostCode || '',
                    invoice_country_code:  orderData.wantInvoice ? 'PL' : '',
                    products: [
                        ...cartWithImgUrls.map(i => ({
                            name: i.name, sku: i.code, quantity: i.quantity,
                            price_brutto: i.price, tax_rate: 23, weight: 2,
                            ...(i.imgUrl ? { auction_images: [i.imgUrl] } : {})
                        })),
                        ...(orderData.discount > 0 ? [{
                            name: 'Rabat', sku: 'rabat', quantity: 1,
                            price_brutto: -parseFloat(orderData.discount), tax_rate: 23, weight: 0
                        }] : [])
                    ]
                };
                const blRes = await fetch(BL_URL, { method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ method:'addOrder', parameters: blPayload }) });
                const blData = await blRes.json();
                if (blData.status === 'SUCCESS') {
                    console.log(`✅ BaseLinker zamówienie #${blData.order_id} dla PayNow ${externalId}`);
                    order.baselinker_id = blData.order_id;
                    // Zapisz snapshoty → /api/order-snapshots (dla zamowienie.html)
                    const snapsToSave = (orderData.cart||[]).map(i=>({code:i.code,snapshot:i.snapshot||''})).filter(i=>i.snapshot);
                    if (snapsToSave.length > 0) saveSnapshots(String(blData.order_id), snapsToSave);
                } else {
                    console.error('❌ BaseLinker:', blData.error_message);
                }
            } catch(e) { console.error('❌ BaseLinker wyjątek:', e.message); }

            // Wyślij emaile
            await sendEmails(order, paymentId, cartWithImgUrls);

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

// ════════════════════════════════════════════════════════════
//  🧪 ENDPOINT TESTOWY — USUŃ PRZED WDROŻENIEM NA PRODUKCJĘ
//  Symuluje pełny flow po CONFIRMED z PayNow:
//  zapisuje zamówienie, wysyła do BaseLinker, wysyła emaile
//  Wywołanie: POST /api/test-order { amount, orderData }
// ════════════════════════════════════════════════════════════
app.post('/api/test-order', async (req, res) => {
    try {
        const { amount, orderData } = req.body;
        if (!amount || !orderData) return res.status(400).json({ error: 'Brak danych' });

        const externalId = 'TEST-' + crypto.randomUUID().slice(0, 13).toUpperCase();

        // Zapisz zamówienie lokalnie (tak samo jak po webhooks PayNow)
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
            status:           'paid_test',
            payment_method:   'test',
            paid_at:          new Date().toISOString(),
            created_at:       new Date().toISOString()
        };
        saveOrder(order);
        console.log(`🧪 TEST zamówienie: ${externalId} | ${orderData.email} | ${(amount/100).toFixed(2)} zł`);

        // Zapisz snapshoty w pamięci RAM → URL-e do admin_comments
        const cartWithImgUrls = await Promise.all((orderData.cart||[]).map(async (item, idx) => {
            const imgUrl = await saveSnapshotImage(externalId, idx, item.snapshot);
            return { ...item, imgUrl };
        }));

        const imgLinks = cartWithImgUrls
            .filter(i => i.imgUrl)
            .map((i, n) => `Zdjęcie półki ${n+1}: ${i.imgUrl}`)
            .join('\n');

        // Wyślij do BaseLinker (identycznie jak webhook PayNow)
        try {
            const BL_URL    = process.env.BASELINKER_PROXY_URL || 'https://baselinker-proxy.007lukasz-m.workers.dev';
            const BL_SOURCE = parseInt(process.env.ORDER_SOURCE_ID || '16611');

            let statusId = 0;
            try {
                const sr = await fetch(BL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ method: 'getOrderStatusList', parameters: {} }) });
                const sd = await sr.json();
                if (sd.status === 'SUCCESS' && sd.statuses?.length) {
                    const f = sd.statuses.find(s => /nowe|oczekuj|new|pending/i.test(s.name));
                    statusId = f ? f.id : sd.statuses[0].id;
                }
            } catch(e) { console.warn('Statusy BL:', e.message); }

            const blPayload = {
                order_status_id:       statusId,
                custom_source_id:      BL_SOURCE,
                date_add:              Math.floor(Date.now() / 1000),
                currency:              'PLN',
                payment_method:        '🧪 TEST (bez płatności)',
                paid:                  0,
                delivery_method:       'kurier',
                delivery_price:        orderData.shipping || 0,
                user_comments:         (orderData.notes || '') + (orderData.orderCode ? '\n\nKod konfiguracji:\n' + orderData.orderCode : '') + (orderData.discount ? '\n\nRabat: ' + parseFloat(orderData.discount).toFixed(2) + ' zł' : ''),
                delivery_fullname:     `${orderData.firstName} ${orderData.lastName}`,
                delivery_address:      orderData.street    || '',
                delivery_city:         orderData.city      || '',
                delivery_postcode:     orderData.postCode  || '',
                delivery_country_code: 'PL',
                email:                 orderData.email,
                phone:                 orderData.phone     || '',
                user_login:            orderData.email,
                admin_comments:        '🧪 ZAMÓWIENIE TESTOWE — bez płatności PayNow' + (imgLinks ? '\n\n📷 Podgląd 3D:\n' + imgLinks : ''),
                want_invoice:          orderData.wantInvoice ? 1 : 0,
                invoice_fullname:      orderData.wantInvoice ? `${orderData.firstName} ${orderData.lastName}` : '',
                invoice_company:       orderData.invCompany  || '',
                invoice_nip:           orderData.invNip      || '',
                invoice_address:       orderData.invAddr     || '',
                invoice_postcode:      orderData.invPostCode || '',
                invoice_country_code:  orderData.wantInvoice ? 'PL' : '',
                products: [
                    ...cartWithImgUrls.map(i => ({
                        name: i.name, sku: i.code, quantity: i.quantity,
                        price_brutto: i.price, tax_rate: 23, weight: 2,
                        ...(i.imgUrl ? { auction_images: [i.imgUrl] } : {})
                    })),
                    ...(orderData.discount > 0 ? [{
                        name: 'Rabat', sku: 'rabat', quantity: 1,
                        price_brutto: -parseFloat(orderData.discount), tax_rate: 23, weight: 0
                    }] : [])
                ]
            };

            const blRes  = await fetch(BL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: 'addOrder', parameters: blPayload }) });
            const blData = await blRes.json();

            if (blData.status === 'SUCCESS') {
                console.log(`✅ BaseLinker TEST zamówienie #${blData.order_id}`);
                order.baselinker_id = blData.order_id;
                // Zapisz snapshoty → /api/order-snapshots (dla zamowienie.html)
                const snapsToSave = (orderData.cart||[]).map(i=>({code:i.code,snapshot:i.snapshot||''})).filter(i=>i.snapshot);
                if (snapsToSave.length > 0) saveSnapshots(String(blData.order_id), snapsToSave);
                // Wyślij emaile
                await sendEmails(order, 'TEST', cartWithImgUrls);
                return res.json({ success: true, baselinker_id: blData.order_id, order_uuid: externalId });
            } else {
                console.error('❌ BaseLinker test:', blData.error_message);
                return res.status(502).json({ error: 'BaseLinker: ' + blData.error_message });
            }
        } catch(e) {
            console.error('❌ BaseLinker test wyjątek:', e.message);
            return res.status(500).json({ error: e.message });
        }

    } catch(err) {
        console.error('❌ test-order:', err.message);
        return res.status(500).json({ error: err.message });
    }
});
// ════════════════════════════════════════════════════════════
//  🧪 KONIEC ENDPOINTU TESTOWEGO
// ════════════════════════════════════════════════════════════

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
async function sendEmails(order, p24Id='TEST', cartWithImgUrls=[]) {
    if (!RESEND_KEY) { console.log('⚠️ Brak RESEND_API_KEY — email pominięty'); return; }
    const cart  = JSON.parse(order.cart_json || '[]');
    const total = ((order.total_amount||0)/100).toFixed(2);
    // Użyj cartWithImgUrls jeśli dostępne, inaczej cart z cart_json
    const items = cartWithImgUrls.length > 0 ? cartWithImgUrls : cart;

    // Wiersze produktów dla emaila właściciela
    const itemsHtml = items.map((i) => `<tr>
        <td style="padding:12px;vertical-align:middle">
            <b>${i.name}</b> x${i.quantity}<br>
            <small style="color:#6b7280">${i.summary || ''}</small><br>
            <small style="color:#6b7280">Boki: ${i.sideColor || '-'} | Półki: ${i.shelfColor || '-'}</small>
        </td>
        <td style="padding:12px;vertical-align:middle;text-align:right"><b>${(i.price*i.quantity).toFixed(2)} zł</b></td>
    </tr>`).join('');

    // Miniatury półek dla emaila klienta
    const snapshotsHtml = items
        .filter(i => i.imgUrl)
        .map(i => `<td style="padding:4px;text-align:center;vertical-align:top">
            <img src="${i.imgUrl}" width="150" alt="${i.name}"
                 style="width:150px;height:150px;object-fit:contain;border-radius:8px;border:1px solid #e5e7eb;background:#f9fafb;display:block">
            <p style="margin:6px 0 0;font-size:11px;color:#6b7280;font-weight:500">${i.name}</p>
        </td>`)
        .join('');

    const snapshotsSectionHtml = snapshotsHtml ? `
    <!-- SHELF PREVIEWS -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr>
        <td>
          <p style="margin:0 0 12px;font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.08em">Twoje półki</p>
          <table cellpadding="0" cellspacing="0">
            <tr>${snapshotsHtml}</tr>
          </table>
        </td>
      </tr>
    </table>
    <tr><td style="padding:0 0 20px"><hr style="border:none;border-top:1px solid #f3f4f6;margin:0"></td></tr>` : '';

    // Email do właściciela
    try {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: 'regaliki.pl <zamowienia@regaliki.pl>',
                reply_to: 'regaliki.pl@gmail.com',
                to: [MAIL_TO],
                subject: `🛒 Nowe zamówienie #${order.order_uuid.slice(0,8)} — ${total} zł`,
                html: `<div style="font-family:sans-serif;max-width:600px">
                       <h2 style="color:#16a34a">🛒 Nowe zamówienie!</h2>
                       <p><b>Klient:</b> ${order.customer_name}<br>
                       <b>Email:</b> ${order.customer_email}<br>
                       <b>Telefon:</b> ${order.customer_phone}<br>
                       <b>Adres:</b> ${order.customer_address}<br>
                       <b>Uwagi:</b> ${order.customer_notes||'-'}</p>
                       <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb">
                       ${itemsHtml}
                       <tr style="background:#f9fafb">
                           <td style="padding:12px;text-align:right"><b>Łącznie:</b></td>
                           <td style="padding:12px;text-align:right"><b style="color:#16a34a;font-size:18px">${total} zł</b></td>
                       </tr>
                       </table></div>`
            })
        });
        const d = await r.json();
        if (r.ok) console.log('📧 Email do właściciela wysłany:', d.id);
        else console.log('❌ Email właściciel błąd:', JSON.stringify(d));
    } catch(e) { console.log('❌ Email właściciel wyjątek:', e.message); }

    // Email do klienta
    try {
        const blId = order.baselinker_id || null;
        const orderLink = blId ? `https://regaliki.pl/zamowienia/zamowienie.html?id=${blId}` : null;
        const orderLinkHtml = orderLink
            ? `<a href="${orderLink}" style="display:inline-block;padding:13px 32px;background:#16a34a;color:#fff;text-decoration:none;border-radius:9px;font-size:14px;font-weight:700">
                 📦 Sprawdź status zamówienia
               </a>` : '';

        const r2 = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: 'regaliki.pl <zamowienia@regaliki.pl>',
                reply_to: 'regaliki.pl@gmail.com',
                to: [order.customer_email],
                subject: `Potwierdzenie zamówienia #${blId || order.order_uuid.slice(0,8)}`,
                html: `<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

  <!-- BODY -->
  <tr><td style="background:#fff;border-radius:14px 14px 0 0;padding:32px 36px 0">

    <!-- Mini logo -->
    <p style="margin:0 0 20px;font-size:13px;font-weight:700;color:#16a34a">🪵 regaliki.pl</p>

    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827">Dziękujemy za zamówienie! 🎉</h1>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6">
      Cześć <strong style="color:#374151">${order.customer_name}</strong> — Twoje zamówienie trafiło do realizacji.<br>
      Poinformujemy Cię mailowo gdy wyślemy paczkę.
    </p>

    <!-- STATUS BUTTON -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
      <tr><td style="text-align:center">
        ${orderLinkHtml}
      </td></tr>
    </table>

    <hr style="border:none;border-top:1px solid #f3f4f6;margin:0 0 24px">

    ${snapshotsSectionHtml}

    <!-- INFO BOXES -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px">
      <tr>
        <td style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;width:48%;vertical-align:top">
          <p style="margin:0 0 3px;font-size:10px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.1em">Kwota zamówienia</p>
          <p style="margin:0;font-size:23px;font-weight:800;color:#15803d">${total} zł</p>
        </td>
        <td style="width:4%"></td>
        <td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;width:48%;vertical-align:top">
          <p style="margin:0 0 3px;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.1em">Czas realizacji</p>
          <p style="margin:0;font-size:23px;font-weight:800;color:#111827">3–7 <span style="font-size:13px;font-weight:500;color:#6b7280">dni rob.</span></p>
        </td>
      </tr>
    </table>

    <!-- ADDRESS -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
      <tr>
        <td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:13px 18px">
          <p style="margin:0 0 2px;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.1em">Adres dostawy</p>
          <p style="margin:0;font-size:14px;color:#374151;font-weight:500">${order.customer_address}</p>
        </td>
      </tr>
    </table>

  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 14px 14px;padding:20px 36px;text-align:center">
    <p style="margin:0 0 6px;font-size:12px;color:#9ca3af">Pytania? Napisz do nas:</p>
    <a href="mailto:regaliki.pl@gmail.com" style="font-size:13px;font-weight:600;color:#16a34a;text-decoration:none">regaliki.pl@gmail.com</a>
    <p style="margin:14px 0 0;font-size:11px;color:#d1d5db">© 2026 Nowy Wymiar Damian Maga · regaliki.pl</p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`
            })
        });
        const d2 = await r2.json();
        if (r2.ok) console.log('📧 Email do klienta wysłany:', d2.id);
        else console.log('❌ Email klient błąd:', JSON.stringify(d2));
    } catch(e) { console.log('❌ Email klient wyjątek:', e.message); }
}

const BASELINKER_TOKEN = process.env.BASELINKER_TOKEN || '';
const BL_API = 'https://api.baselinker.com/connector.php';

// ════════════════════════════════════════════════════════════
//  BaseLinker — Pobierz PDF faktury dla zamówienia
//  GET /api/invoice-pdf?order_id=123
// ════════════════════════════════════════════════════════════
app.get('/api/invoice-pdf', async (req, res) => {
    try {
        const orderId = parseInt(req.query.order_id);
        if (!orderId) return res.status(400).json({ error: 'Brak order_id' });
        if (!BASELINKER_TOKEN) return res.status(500).json({ error: 'Brak tokena BaseLinker' });

        // 1. Pobierz listę faktur dla zamówienia
        const invoiceListRes = await fetch(BL_API, {
            method: 'POST',
            headers: { 'X-BLToken': BASELINKER_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `method=getInvoices&parameters=${encodeURIComponent(JSON.stringify({ order_id: orderId }))}`
        });
        const invoiceList = await invoiceListRes.json();

        if (invoiceList.status !== 'SUCCESS' || !invoiceList.invoices?.length) {
            console.error('❌ getInvoices response:', JSON.stringify(invoiceList));
            return res.status(404).json({ error: 'Brak faktury dla tego zamówienia', debug: invoiceList });
        }

        const invoiceId = invoiceList.invoices[0].invoice_id;
        console.log(`📄 Faktura ID: ${invoiceId} dla zamówienia ${orderId}`);

        // 2. Pobierz plik PDF faktury
        const pdfRes = await fetch(BL_API, {
            method: 'POST',
            headers: { 'X-BLToken': BASELINKER_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `method=getInvoiceFile&parameters=${encodeURIComponent(JSON.stringify({ invoice_id: invoiceId }))}`
        });
        const pdfData = await pdfRes.json();

        if (pdfData.status !== 'SUCCESS' || (!pdfData.file && !pdfData.invoice)) {
            console.error('❌ getInvoiceFile response:', JSON.stringify(pdfData).slice(0, 200));
            return res.status(404).json({ error: 'Nie można pobrać pliku PDF', debug: pdfData });
        }

        // BaseLinker zwraca pole 'invoice' jako data URI lub 'file' jako base64
        let base64Data = pdfData.file || pdfData.invoice || '';
        // Usuń prefix "data:application/pdf;base64," jeśli istnieje
        if (base64Data.includes(',')) {
            base64Data = base64Data.split(',')[1];
        }

        // 3. Zwróć PDF jako plik do pobrania
        const pdfBuffer = Buffer.from(base64Data, 'base64');
        const filename = `faktura-${orderId}.pdf`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        return res.send(pdfBuffer);

    } catch (err) {
        console.error('❌ invoice-pdf:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════
//  Snapshoty 3D dla strony zamówienia
//  GET /api/order-snapshots?bl_order_id=123
// ════════════════════════════════════════════════════════════
// Test wysyłki emaila — GET /api/test-email?to=adres@gmail.com
app.get('/api/test-email', async (req, res) => {
    const to = req.query.to || MAIL_TO;
    if (!RESEND_KEY) return res.json({ ok: false, error: 'Brak RESEND_API_KEY' });
    try {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: 'regaliki.pl <zamowienia@regaliki.pl>',
                reply_to: 'regaliki.pl@gmail.com',
                to: [to],
                subject: 'Test emaila — regaliki.pl',
                html: '<p>Działa! Resend wysyła poprawnie z domeny regaliki.pl.</p>'
            })
        });
        const d = await r.json();
        if (r.ok) res.json({ ok: true, to, id: d.id });
        else res.json({ ok: false, error: d.message || JSON.stringify(d) });
    } catch(e) {
        res.json({ ok: false, error: e.message });
    }
});

app.get('/api/order-snapshots', (req, res) => {
    try {
        const { bl_order_id } = req.query;
        if (!bl_order_id) return res.status(400).json({ error: 'Brak bl_order_id' });
        const snaps = loadSnapshots(String(bl_order_id));
        return res.json({ snapshots: snaps });
    } catch(err) {
        return res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════
//  BaseLinker Webhook — powiadomienie o wysyłce
//  POST /api/bl-webhook
//  BaseLinker wywołuje ten endpoint gdy zmieni się status zamówienia.
//  Gdy status = SHIPPED_STATUS_ID → wysyłamy email z numerem przewozowym.
//
//  Konfiguracja w Railway Variables:
//    SHIPPED_STATUS_ID  — ID statusu "Wysłano" z BaseLinker
//    BASELINKER_TOKEN   — token API BaseLinker
// ════════════════════════════════════════════════════════════
const SHIPPED_STATUS_ID = process.env.SHIPPED_STATUS_ID || '';

// Generuj link śledzenia na podstawie nazwy kuriera
function trackingUrl(courier, number) {
    const c = (courier || '').toLowerCase();
    if (c.includes('inpost'))  return `https://inpost.pl/sledzenie-przesylek?number=${number}`;
    if (c.includes('dpd'))     return `https://tracktrace.dpd.com.pl/parcelDetails?p1=${number}`;
    if (c.includes('dhl'))     return `https://www.dhl.com/pl-pl/home/tracking.html?tracking-id=${number}`;
    if (c.includes('gls'))     return `https://gls-group.eu/PL/pl/sledzenie-paczek?match=${number}`;
    if (c.includes('poczta') || c.includes('pp')) return `https://emonitoring.poczta-polska.pl/?numer=${number}`;
    if (c.includes('fedex'))   return `https://www.fedex.com/fedextrack/?trknbr=${number}`;
    if (c.includes('ups'))     return `https://www.ups.com/track?tracknum=${number}`;
    return null;
}

// BaseLinker może wysyłać GET lub POST — obsługujemy oba
// Plik do śledzenia już wysłanych emaili wysyłkowych (żeby nie wysyłać dwa razy)
const SHIPPED_EMAILS_FILE = path.join(__dirname, 'shipped_emails.json');
function loadShippedEmails() {
    try { return new Set(JSON.parse(fs.readFileSync(SHIPPED_EMAILS_FILE, 'utf8'))); }
    catch(e) { return new Set(); }
}
function saveShippedEmail(orderId) {
    const set = loadShippedEmails();
    set.add(String(orderId));
    fs.writeFileSync(SHIPPED_EMAILS_FILE, JSON.stringify([...set]));
}

async function handleBlWebhook(req, res) {
    console.log('[BL Webhook] method:', req.method);
    // Odpowiedz natychmiast 200 żeby BL nie czekał
    res.status(200).json({ ok: true });

    if (!BASELINKER_TOKEN || !SHIPPED_STATUS_ID) {
        console.warn('⚠️ Brak BASELINKER_TOKEN lub SHIPPED_STATUS_ID');
        return;
    }

    try {
        // Pobierz zamówienia z statusem "Wysłane" zmienione w ostatniej godzinie
        const since = Math.floor(Date.now() / 1000) - 60 * 60;
        const blRes = await fetch(BL_API, {
            method: 'POST',
            headers: { 'X-BLToken': BASELINKER_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `method=getOrders&parameters=${encodeURIComponent(JSON.stringify({
                status_id: parseInt(SHIPPED_STATUS_ID),
                date_confirmed_from: since
            }))}`
        });
        const blData = await blRes.json();

        if (blData.status !== 'SUCCESS') {
            console.error('❌ BL getOrders:', JSON.stringify(blData));
            return;
        }

        const orders = blData.orders || [];
        console.log(`[BL Webhook] Znaleziono ${orders.length} zamówień ze statusem Wysłane`);

        // Filtruj tylko zamówienia ze źródła konfiguratora i te co nie dostały jeszcze emaila
        const shippedEmails = loadShippedEmails();
        const toNotify = orders.filter(o => {
            if (shippedEmails.has(String(o.order_id))) return false;
            // Tylko zamówienia z konfiguratora (opcjonalnie)
            return true;
        });

        for (const order of toNotify) {
            const orderId = order.order_id;
            const email   = order.email;
            const name    = order.delivery_fullname || order.invoice_fullname || '';
            const tracking = order.packages?.[0]?.tracking_number || order.package_number || '';
            const courier  = order.packages?.[0]?.courier_code    || order.delivery_method || '';
            const address  = [order.delivery_address, order.delivery_postcode, order.delivery_city].filter(Boolean).join(', ');

            if (!email) { console.warn(`⚠️ Brak emaila dla zamówienia #${orderId}`); continue; }

            await sendShippingEmail(orderId, email, name, tracking, courier, address);
            saveShippedEmail(orderId);
        }
    } catch(err) {
        console.error('❌ bl-webhook:', err.message);
    }
}

async function sendShippingEmail(orderId, email, name, tracking, courier, address) {
    if (!RESEND_KEY) return;
    try {
    const tUrl = tracking ? trackingUrl(courier, tracking) : null;
    const trackBtn = tUrl
        ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0"><tr><td style="text-align:center">
             <a href="${tUrl}" style="display:inline-block;padding:13px 32px;background:#16a34a;color:#fff;text-decoration:none;border-radius:9px;font-size:14px;font-weight:700">🚚 Śledź przesyłkę</a>
           </td></tr></table>` : '';
    const trackInfo = tracking
        ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px"><tr>
             <td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;width:48%;vertical-align:top">
               <p style="margin:0 0 3px;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.1em">Numer przesyłki</p>
               <p style="margin:0;font-size:15px;font-weight:700;color:#111827">${tracking}</p>
             </td>
             <td style="width:4%"></td>
             <td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;width:48%;vertical-align:top">
               <p style="margin:0 0 3px;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.1em">Kurier</p>
               <p style="margin:0;font-size:15px;font-weight:700;color:#111827">${courier || '—'}</p>
             </td>
           </tr></table>` : '';

        // Wyślij email przez Resend
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: 'regaliki.pl <zamowienia@regaliki.pl>',
                reply_to: 'regaliki.pl@gmail.com',
                to: [email],
                subject: `Twoja paczka jest w drodze! 🚚 #${orderId}`,
                html: `<!DOCTYPE html>
<html lang="pl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

  <tr><td style="background:#fff;border-radius:14px 14px 0 0;padding:32px 36px 0">
    <p style="margin:0 0 20px;font-size:13px;font-weight:700;color:#16a34a">🪵 regaliki.pl</p>

    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827">Paczka wysłana! 🚚</h1>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6">
      Cześć <strong style="color:#374151">${name}</strong> — Twoja półka jest już w drodze do Ciebie!
    </p>

    ${trackBtn}
    <hr style="border:none;border-top:1px solid #f3f4f6;margin:0 0 20px">

    ${trackInfo}

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
      <tr>
        <td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:13px 18px">
          <p style="margin:0 0 2px;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.1em">Adres dostawy</p>
          <p style="margin:0;font-size:14px;color:#374151;font-weight:500">${name}<br>${address}</p>
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 14px 14px;padding:18px 36px;text-align:center">
    <p style="margin:0 0 5px;font-size:12px;color:#9ca3af">Pytania? Napisz do nas:</p>
    <a href="mailto:regaliki.pl@gmail.com" style="font-size:13px;font-weight:600;color:#16a34a;text-decoration:none">regaliki.pl@gmail.com</a>
    <p style="margin:12px 0 0;font-size:11px;color:#d1d5db">© 2026 Nowy Wymiar Damian Maga · regaliki.pl</p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`
            })
        });
        const d = await r.json();
        if (r.ok) console.log(`📧 Email wysyłki do ${email} (zamówienie #${orderId}):`, d.id);
        else console.error('❌ Resend błąd:', JSON.stringify(d));
    } catch(err) {
        console.error('❌ sendShippingEmail:', err.message);
    }
}
app.post('/api/bl-webhook', handleBlWebhook);
app.get('/api/bl-webhook',  handleBlWebhook);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Backend port ${PORT} | Tryb: ${TEST_MODE ? 'TESTOWY' : 'PRODUKCJA'}`);
    console.log(`📋 Panel zamówień: /zamowienia?pass=${ADMIN_PASS}`);
});
