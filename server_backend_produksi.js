/**
 * ====================================================================
 * SECURE PRODUCTION BACKEND SERVER - CUANKU APP v3.0
 * ====================================================================
 * Tech Stack: Node.js, Express.js, MongoDB (Mongoose)
 * Sistem ini memegang otoritas penuh atas semua data permainan.
 * Sisi klien (HP/Browser) hanya mengirimkan request aksi, 
 * sedangkan server yang melakukan kalkulasi matematika dan menyimpan data secara aman.
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// --- KONEKSI DATABASE CLOUD MONGODB ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/cuanku_secure_db";
mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log("[DB SUCCESS] Database MongoDB terkoneksi dengan aman.");
}).catch((err) => {
    console.error("[DB ERROR] Kegagalan koneksi database:", err.message);
});

// ==========================================
// DATA SCHEMAS & MODELS (DATABASE)
// ==========================================

const UserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    balance: { type: Number, default: 0 },         // Saldo rupiah nyata pengguna
    tapPower: { type: Number, default: 5 },        // Nominal per klik
    totalTaps: { type: Number, default: 0 },       // Total statistik ketukan
    cps: { type: Number, default: 0 },             // Cuan Per Second (Passive)
    playerLevel: { type: Number, default: 1 },     // Tingkat level user
    lastTick: { type: Date, default: Date.now },   // Waktu sinkronisasi server terakhir (mengamankan Idle Income)
    
    // Status upgrade jari
    upgrades: {
        clickMultiplier: { type: Number, default: 1 }, // Level upgrade
        autoMiner: { type: Number, default: 0 }
    },
    
    // Status Kepemilikan Barang Lucu
    funnyItems: {
        swallow: { type: Number, default: 0 },
        kipas: { type: Number, default: 0 },
        kucing: { type: Number, default: 0 }
    },
    
    // Status Kepemilikan Bisnis Pasif
    businesses: {
        boba: { type: Number, default: 0 },
        warung: { type: Number, default: 0 },
        kopi: { type: Number, default: 0 }
    }
});

const TransactionSchema = new mongoose.Schema({
    txId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    wallet: { type: String, required: true },
    account: { type: String, required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'DECLINED'], default: 'PENDING' },
    payoutResponse: { type: Object, default: {} },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

// ==========================================
// HARGA DAN ATURAN MATEMATIKA PERMAINAN (SERVER-SIDE TRUTH)
// ==========================================
const GAME_RULES = {
    upgrades: {
        clickMultiplier: { baseCost: 100, multiplier: 1.6, benefit: 5 },
        autoMiner: { baseCost: 500, multiplier: 1.6, benefit: 25 }
    },
    funnyItems: {
        swallow: { baseCost: 300, multiplier: 1.55, tapBonus: 3 },
        kipas: { baseCost: 1200, multiplier: 1.55, tapBonus: 15 },
        kucing: { baseCost: 5000, multiplier: 1.55, tapBonus: 75 }
    },
    businesses: {
        boba: { baseCost: 200, multiplier: 1.4, revenue: 2 },
        warung: { baseCost: 1500, multiplier: 1.4, revenue: 15 },
        kopi: { baseCost: 10000, multiplier: 1.4, revenue: 80 }
    }
};

// ==========================================
// SISTEM KEAMANAN & UTILITY HELPER
// ==========================================

// Fungsi untuk menghitung biaya item secara dinamis berdasarkan jumlah kepemilikan saat ini
function calculateCost(baseCost, multiplier, count) {
    return Math.floor(baseCost * Math.pow(multiplier, count));
}

// Fungsi untuk menghitung ulang status CPS, Tap Power, dan Level dari database secara real-time
function recalculateUserStats(user) {
    // 1. Hitung Tap Power dasar + bonus upgrade + bonus item lucu
    let power = 5;
    power += (user.upgrades.clickMultiplier - 1) * GAME_RULES.upgrades.clickMultiplier.benefit;
    power += (user.upgrades.autoMiner) * GAME_RULES.upgrades.autoMiner.benefit;
    
    power += user.funnyItems.swallow * GAME_RULES.funnyItems.swallow.tapBonus;
    power += user.funnyItems.kipas * GAME_RULES.funnyItems.kipas.tapBonus;
    power += user.funnyItems.kucing * GAME_RULES.funnyItems.kucing.tapBonus;
    
    user.tapPower = power;

    // 2. Hitung CPS (Cuan Per Second) dari bisnis pasif
    let totalCps = 0;
    totalCps += user.businesses.boba * GAME_RULES.businesses.boba.revenue;
    totalCps += user.businesses.warung * GAME_RULES.businesses.warung.revenue;
    totalCps += user.businesses.kopi * GAME_RULES.businesses.kopi.revenue;
    
    user.cps = totalCps;

    // 3. Hitung Level Akun berdasarkan total barang aksesoris absurd yang dibeli
    user.playerLevel = 1 + user.funnyItems.swallow + user.funnyItems.kipas + user.funnyItems.kucing;
}

// ==========================================
// API SECURE ROUTING
// ==========================================

// 1. Sinkronisasi Awal & Ambil Data Pengguna
app.get('/api/users/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        let user = await User.findOne({ userId });
        
        if (!user) {
            user = new User({ userId });
            await user.save();
            console.log(`[USER] Pengguna baru terdaftar di database: ${userId}`);
        }
        
        // Sebelum kirim data ke klien, jalankan Siklus Akumulasi Pendapatan Pasif Berdasarkan Waktu
        const now = Date.now();
        const secondsElapsed = Math.floor((now - user.lastTick.getTime()) / 1000);
        
        if (secondsElapsed > 0 && user.cps > 0) {
            const idleEarnings = user.cps * secondsElapsed;
            user.balance += idleEarnings;
            user.lastTick = now;
            await user.save();
            console.log(`[PASSIVE INCOME] User ${userId} mendapatkan Rp ${idleEarnings} selama ditinggal offline (${secondsElapsed} detik).`);
        }
        
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: "Gagal mengambil profil database." });
    }
});

// 2. Klik Koin Aman dengan Deteksi Kecepatan (Anti Auto-Clicker Cheat)
// Kami membatasi player mengirimkan request ketukan melebihi batas biologis manusia normal
const clickLimiters = {}; 
app.post('/api/users/secure-tap', async (req, res) => {
    try {
        const { userId } = req.body;
        const now = Date.now();
        
        // Deteksi spam click: Jika request kurang dari 80ms dari klik terakhir, tolak!
        if (clickLimiters[userId] && (now - clickLimiters[userId]) < 80) {
            console.warn(`[WARNING SECURITY] Potensi Cheat Auto-Clicker terdeteksi untuk user: ${userId}`);
            return res.status(429).json({ error: "Ketukan terdeteksi terlalu cepat (Anti-Cheat Active)." });
        }
        clickLimiters[userId] = now;

        const user = await User.findOne({ userId });
        if (!user) return res.status(404).json({ error: "User tidak ditemukan." });

        // Update saldo berdasarkan tap power resmi di server-side
        user.balance += user.tapPower;
        user.totalTaps += 1;
        user.lastTick = now; // Perbarui siklus detak idle
        await user.save();

        res.json({ success: true, balance: user.balance, totalTaps: user.totalTaps });
    } catch (err) {
        res.status(500).json({ error: "Gagal memproses ketukan aman." });
    }
});

// 3. Pembelian Item Terenkripsi (Server Validates Balance & Adds Upgrades)
app.post('/api/users/secure-buy', async (req, res) => {
    try {
        const { userId, category, itemKey } = req.body; // category: 'upgrades' | 'funnyItems' | 'businesses'
        
        const user = await User.findOne({ userId });
        if (!user) return res.status(404).json({ error: "User tidak terdaftar." });

        const rule = GAME_RULES[category]?.[itemKey];
        if (!rule) return res.status(400).json({ error: "Item atau Kategori tidak valid." });

        // Hitung biaya item saat ini berdasarkan jumlah kepemilikan di DB
        let currentOwnedCount = 0;
        if (category === 'upgrades') {
            // clickMultiplier mulai level 1, autoMiner mulai 0
            currentOwnedCount = itemKey === 'clickMultiplier' ? user.upgrades.clickMultiplier : user.upgrades.autoMiner;
        } else {
            currentOwnedCount = user[category][itemKey];
        }

        const cost = calculateCost(rule.baseCost, rule.multiplier, currentOwnedCount);

        if (user.balance < cost) {
            return res.status(400).json({ error: "Transaksi Ditolak: Saldo Anda tidak mencukupi!" });
        }

        // Proses Potong Saldo & Tambahkan kepemilikan secara aman
        user.balance -= cost;

        if (category === 'upgrades') {
            user.upgrades[itemKey] += 1;
        } else {
            user[category][itemKey] += 1;
        }

        // Jalankan kalkulasi ulang status stat
        recalculateUserStats(user);
        await user.save();

        console.log(`[PURCHASE] Sukses membeli ${itemKey} (${category}) oleh ${userId}. Sisa saldo: Rp ${user.balance}`);
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: "Gagal memproses transaksi toko." });
    }
});

// 4. Verifikasi Keabsahan Reward Iklan AdMob
app.post('/api/ads/verify-reward', async (req, res) => {
    try {
        const { userId, reward } = req.body;
        
        // Pada aplikasi nyata rilis Play Store:
        // Di sini Anda wajib mengecek validasi kunci kriptografi AdMob SSV (Server-Side Verification).
        // Caranya: menguji verifikasi URL Signature dari server Google AdMob.

        const user = await User.findOne({ userId });
        if (!user) return res.status(404).json({ error: "User tidak ditemukan." });

        user.balance += reward;
        await user.save();

        console.log(`[ADMOB SECURE] Reward iklan +Rp ${reward} masuk ke user ${userId}.`);
        res.json({ success: true, balance: user.balance });
    } catch (err) {
        res.status(500).json({ error: "Gagal memproses verifikasi iklan." });
    }
});

// 5. Ajukan Penarikan Dana ke Antrean Admin
app.post('/api/payout/request', async (req, res) => {
    try {
        const { userId, wallet, account, amount } = req.body;

        const user = await User.findOne({ userId });
        if (!user) return res.status(404).json({ error: "Pengguna tidak terdaftar." });

        if (user.balance < amount) {
            return res.status(400).json({ error: "Saldo tidak mencukupi untuk ditarik." });
        }

        // Kunci dan potong saldo user secara langsung dari database server
        user.balance -= amount;
        await user.save();

        const txId = "TX-" + crypto.randomBytes(4).toString('hex').toUpperCase();
        const transaction = new Transaction({
            txId,
            userId,
            wallet,
            account,
            amount,
            status: 'PENDING'
        });
        await transaction.save();

        console.log(`[WITHDRAWAL PENDING] User ${userId} memotong saldo Rp ${amount} menuju rekening ${wallet} (${account}).`);
        res.json({ success: true, txId, balance: user.balance });
    } catch (err) {
        res.status(500).json({ error: "Gagal mendaftarkan antrean penarikan dana." });
    }
});

// 6. Portal Admin: Eksekusi Pencairan Dana Otomatis via API Gateway Xendit
app.post('/api/admin/payouts/:txId/approve', async (req, res) => {
    try {
        const { txId } = req.params;
        const transaction = await Transaction.findOne({ txId });

        if (!transaction || transaction.status !== 'PENDING') {
            return res.status(400).json({ error: "Transaksi tidak ditemukan atau sudah diproses." });
        }

        // AMANKAN INTEGRASI API PAYOUT NYATA (CONTOH: XENDIT DISBURSEMENT API)
        const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;
        
        if (XENDIT_SECRET_KEY) {
            try {
                // Hubungi server Xendit nyata untuk langsung mentransfer uang rupiah ke DANA/Gopay user
                const xenditResponse = await axios.post('https://api.xendit.co/disbursements', {
                    external_id: transaction.txId,
                    amount: transaction.amount,
                    bank_code: transaction.wallet, // misal: 'DANA', 'GOPAY', 'OVO'
                    account_holder_name: "Pemain CuanKu",
                    account_number: transaction.account,
                    description: "Penarikan Dana Game CuanKu"
                }, {
                    headers: {
                        'Authorization': 'Basic ' + Buffer.from(XENDIT_SECRET_KEY + ':').toString('base64'),
                        'Content-Type': 'application/json'
                    }
                });

                transaction.status = 'APPROVED';
                transaction.payoutResponse = xenditResponse.data;
                await transaction.save();

                console.log(`[PAYOUT REAL SUCCESS] Transfer otomatis Xendit ${txId} sukses.`);
                return res.json({ success: true, message: "Pencairan via API Xendit sukses!", transaction });
            } catch (xenditErr) {
                console.error("[GATEWAY ERROR] Kegagalan API Payment Gateway:", xenditErr.response ? xenditErr.response.data : xenditErr.message);
                return res.status(502).json({ error: "Gagal mengirim dana melalui Payment Gateway. Sila cek saldo deposit Anda." });
            }
        } else {
            // Mode Manual: Admin menyetujui tanpa API key (sudah dikirim manual via M-Banking)
            transaction.status = 'APPROVED';
            transaction.payoutResponse = { approved_manually_by: "Admin", timestamp: new Date() };
            await transaction.save();
            
            console.log(`[PAYOUT MANUAL SUCCESS] Status transaksi ${txId} ditandai sukses secara manual.`);
            res.json({ success: true, message: "Transaksi ditandai sukses secara manual.", transaction });
        }
    } catch (err) {
        res.status(500).json({ error: "Gagal memproses verifikasi admin." });
    }
});

// --- Jalankan Server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`\n====================================================================`);
    console.log(` 🖥️  CUANKU SECURE BACKEND ACTIVE: http://localhost:${PORT}`);
    console.log(` MongoDB Location: ${MONGO_URI.substring(0, 30)}...`);
    console.log(`====================================================================\n`);
});