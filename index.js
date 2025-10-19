const { Client } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const QRCode = require('qrcode');
require('dotenv').config();

// ===== الإعدادات =====
const PORT = process.env.PORT || 3000;
const SESSION_ID = process.env.SESSION_ID || 'default';
const STATUS_UPDATE_INTERVAL = 5000;
const MONGO_URI = process.env.MONGO_URI; // مثال: mongodb+srv://user:pass@cluster0.mongodb.net/whatsappdb
const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
const API_WEBHOOK_QR = process.env.API_WEBHOOK_QR || "/webhook/qr";
const API_WEBHOOK_STATUS = process.env.API_WEBHOOK_STATUS || "/webhook/status";

// مسار Chrome (يمكن حذفه على Render حيث يتم تثبيت chromium تلقائياً)
const CHROME_PATH = process.env.CHROME_PATH || null;

// --- إعداد Express ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Endpoint للحفاظ على التطبيق نشطًا
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// Start Express server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

// --- ربط MongoDB ---
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- نموذج تخزين الجلسة ---
const SessionSchema = new mongoose.Schema({
    sessionId: String,
    sessionData: Object
});
const Session = mongoose.model('Session', SessionSchema);

async function loadSession() {
    const doc = await Session.findOne({ sessionId: SESSION_ID });
    if (doc) return doc.sessionData;
    return null;
}

async function saveSession(sessionData) {
    await Session.findOneAndUpdate(
        { sessionId: SESSION_ID },
        { sessionData },
        { upsert: true }
    );
}

// ===== إعداد البوت =====
let currentQR = null;
let isClientReady = false;
let clientInfo = null;
let reconnectAttempts = 0;
let statusUpdateInterval = null;

async function sendQRToAPI(qrString) {
    if (!API_BASE_URL) return;
    try {
        const qrImage = await QRCode.toDataURL(qrString);
        await axios.post(`${API_BASE_URL}${API_WEBHOOK_QR}`, {
            sessionId: SESSION_ID,
            qrCode: qrString,
            qrImage,
            timestamp: new Date().toISOString()
        }, { timeout: 5000 });
        console.log('📱 QR Code sent to API');
    } catch (err) {
        console.error('❌ Error sending QR to API:', err.message);
    }
}

async function sendStatusToAPI() {
    if (!API_BASE_URL) return;
    try {
        const status = {
            sessionId: SESSION_ID,
            status: isClientReady ? 'ready' : (currentQR ? 'qr' : 'disconnected'),
            isReady: isClientReady,
            hasQR: !!currentQR,
            clientInfo,
            reconnectAttempts,
            timestamp: new Date().toISOString()
        };
        await axios.post(`${API_BASE_URL}${API_WEBHOOK_STATUS}`, status, { timeout: 5000 });
        console.log('📊 Status sent to API');
    } catch (err) {
        console.error('❌ Error sending status:', err.message);
    }
}

function startStatusUpdates() {
    if (statusUpdateInterval) clearInterval(statusUpdateInterval);
    statusUpdateInterval = setInterval(async () => {
        await sendStatusToAPI();
    }, STATUS_UPDATE_INTERVAL);
}

// --- بدء البوت ---
(async () => {
    const sessionData = await loadSession();

    const client = new Client({
        puppeteer: {
            headless: true,
            executablePath: CHROME_PATH,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-zygote',
                '--disable-gpu'
            ]
        },
        session: sessionData
    });

    client.on('qr', async qr => {
        console.log('QR code received. Scan it.');
        currentQR = qr;
        await sendQRToAPI(qr);
    });

    client.on('authenticated', async session => {
        console.log('✅ Authenticated, saving session...');
        currentQR = null;
        try {
            await saveSession(session);
            console.log('✅ Session saved to MongoDB');
        } catch (err) {
            console.error('❌ Error saving session:', err.message);
        }
    });

    client.on('ready', async () => {
        console.log('WhatsApp client is ready!');
        isClientReady = true;
        currentQR = null;
        reconnectAttempts = 0;
        clientInfo = {
            phoneNumber: client.info.wid.user,
            pushname: client.info.pushname,
            platform: client.info.platform,
            wid: client.info.wid._serialized
        };
        await sendStatusToAPI();
        startStatusUpdates();
    });

    client.on('disconnected', (reason) => {
        console.log('⚠️ Disconnected:', reason);
        isClientReady = false;
        clientInfo = null;
        currentQR = null;
    });

    client.on('message', msg => {
        if (msg.body.toLowerCase() === 'ping') msg.reply('pong');
    });

    client.initialize();

    // --- خيط كل 7 ثواني ---
    setInterval(() => {
        console.log('🕒 Running repeated task every 7 seconds...');
        // ضع هنا أي عملية دورية تريد تنفيذها
    }, 7000);
})();

// --- Endpoint للحصول على الحالة ---
app.get('/api/status', async (req, res) => {
    try {
        let actualStatus = 'disconnected';
        if (isClientReady && clientInfo) actualStatus = 'ready';
        else if (currentQR) actualStatus = 'qr';
        res.json({
            success: true,
            status: actualStatus,
            isReady: isClientReady,
            clientInfo,
            qr: currentQR,
            reconnectAttempts,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
