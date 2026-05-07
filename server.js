require('dotenv').config();
const express  = require('express');
const nodemailer = require('nodemailer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app      = express();
const PORT     = process.env.PORT || 3000;
const APP_URL  = process.env.APP_URL || `http://localhost:${PORT}`;

// ─── Stockage des réservations (fichier JSON) ─────────────────────────────────
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'reservations.json');

function loadReservations() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return []; }
}

function saveReservations(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

function datesOverlap(s1, e1, s2, e2) {
  return new Date(s1) < new Date(e2) && new Date(e1) > new Date(s2);
}

// ─── Sessions admin (tokens en mémoire) ──────────────────────────────────────
const adminTokens = new Map(); // token -> expiry

function requireAdmin(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !adminTokens.has(token) || adminTokens.get(token) < Date.now()) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

// ─── Webhook Stripe (raw body avant express.json) ─────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = secret
      ? stripe.webhooks.constructEvent(req.body, sig, secret)
      : JSON.parse(req.body.toString());
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    await handlePaidSession(event.data.object).catch(console.error);
  }
  res.json({ received: true });
});

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── Disponibilité : toutes les périodes bloquées par véhicule ───────────────
app.get('/api/unavailable-dates', (req, res) => {
  const reservations = loadReservations();
  const map = {};
  for (const r of reservations) {
    if (r.status === 'cancelled') continue;
    if (!map[r.carId]) map[r.carId] = [];
    map[r.carId].push({ dateDebut: r.dateDebut, dateFin: r.dateFin });
  }
  res.json(map);
});

// ─── Vérification ponctuelle de disponibilité ─────────────────────────────────
app.get('/api/availability', (req, res) => {
  const { carId, dateDebut, dateFin } = req.query;
  if (!carId || !dateDebut || !dateFin)
    return res.status(400).json({ error: 'Paramètres manquants' });
  const reservations = loadReservations();
  const conflict = reservations.some(r =>
    String(r.carId) === String(carId) &&
    r.status !== 'cancelled' &&
    datesOverlap(dateDebut, dateFin, r.dateDebut, r.dateFin)
  );
  res.json({ available: !conflict });
});

// ─── Créer une session Stripe Checkout ────────────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  try {
    const {
      carId, carName, carPrice, days, dateDebut, dateFin,
      paymentType, prenom, nom, email, tel, permis, agence
    } = req.body;

    // Vérification de disponibilité côté serveur
    const reservations = loadReservations();
    const conflict = reservations.some(r =>
      String(r.carId) === String(carId) &&
      r.status !== 'cancelled' &&
      datesOverlap(dateDebut, dateFin, r.dateDebut, r.dateFin)
    );
    if (conflict) {
      return res.status(409).json({ error: 'Ce véhicule est déjà réservé pour ces dates.' });
    }

    const totalAmount = Math.round(Number(carPrice) * Number(days));
    const amountToPay = paymentType === 'deposit'
      ? Math.round(totalAmount * 0.30)
      : totalAmount;
    const remaining   = totalAmount - amountToPay;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: paymentType === 'deposit'
              ? `Acompte 30% – ${carName}`
              : `Paiement intégral – ${carName}`,
            description: `${days} jour${days > 1 ? 's' : ''} · Du ${dateDebut} au ${dateFin} · ${agence}`,
          },
          unit_amount: amountToPay * 100,
        },
        quantity: 1,
      }],
      metadata: {
        carId: String(carId),
        carName, carPrice: String(carPrice), days: String(days),
        dateDebut, dateFin, paymentType,
        prenom, nom, email, tel, permis, agence,
        totalAmount: String(totalAmount),
        amountPaid:  String(amountToPay),
        remaining:   String(remaining),
      },
      success_url: `${APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}/cancel.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Appelé depuis success.html ───────────────────────────────────────────────
const processedSessions = new Set();

app.get('/order-complete', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id manquant' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.json({ ok: false, status: session.payment_status });
    }

    if (!processedSessions.has(session_id)) {
      processedSessions.add(session_id);
      await handlePaidSession(session).catch(console.error);
    }

    res.json({ ok: true, metadata: session.metadata });
  } catch (err) {
    console.error('order-complete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Traitement d'un paiement validé ──────────────────────────────────────────
async function handlePaidSession(session) {
  const m   = session.metadata;
  const ref = 'EVA-' + Math.floor(100000 + Math.random() * 900000);

  // Sauvegarder la réservation
  const reservations = loadReservations();
  const alreadySaved = reservations.some(r => r.stripeSessionId === session.id);
  if (!alreadySaved) {
    reservations.push({
      id:             ref,
      carId:          m.carId,
      carName:        m.carName,
      carPrice:       m.carPrice,
      days:           m.days,
      dateDebut:      m.dateDebut,
      dateFin:        m.dateFin,
      paymentType:    m.paymentType,
      prenom:         m.prenom,
      nom:            m.nom,
      email:          m.email,
      tel:            m.tel,
      permis:         m.permis,
      agence:         m.agence,
      totalAmount:    m.totalAmount,
      amountPaid:     m.amountPaid,
      remaining:      m.remaining,
      stripeSessionId: session.id,
      status:         'confirmed',
      createdAt:      new Date().toISOString(),
      updatedAt:      new Date().toISOString(),
    });
    saveReservations(reservations);
    console.log(`💾 Réservation sauvegardée [${ref}]`);
  }

  await sendEmails(m, ref).catch(err => console.error('Email error:', err.message));
}

// ─── Envoi des emails ─────────────────────────────────────────────────────────
async function sendEmails(m, ref) {
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '465'),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const isDeposit = m.paymentType === 'deposit';

  const clientHtml = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f2f5;padding:32px 16px}
.wrap{max-width:580px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.12)}
.hdr{background:linear-gradient(135deg,#060e1e,#1a3a6b);padding:40px 44px;text-align:center}
.logo{font-size:32px;font-weight:900;color:#fff}.logo em{color:#d4b96a;font-style:normal}
.badge{display:inline-block;margin-top:14px;padding:7px 20px;border-radius:100px;background:rgba(16,185,129,.18);border:1px solid rgba(16,185,129,.45);color:#34d399;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.body{padding:38px 44px}
.greeting{font-size:20px;font-weight:700;color:#0a1628;margin-bottom:10px}
.intro{font-size:15px;color:#525d70;line-height:1.72;margin-bottom:28px}
.ref-box{background:#0a1628;border-radius:12px;padding:18px 26px;text-align:center;margin-bottom:26px}
.ref-label{font-size:11px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.15em;margin-bottom:7px}
.ref-num{font-family:'Courier New',monospace;font-size:24px;font-weight:700;color:#d4b96a;letter-spacing:.14em}
.section{background:#f7f8fa;border-radius:12px;padding:20px 24px;margin-bottom:14px}
.stitle{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9098a8;margin-bottom:12px}
.row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #eeeef2;font-size:14px;color:#525d70}
.row:last-child{border-bottom:none}.row strong{color:#0a1628;font-weight:600}
.paid-box{background:linear-gradient(135deg,#c9a84c,#e8c97e);border-radius:10px;padding:15px 20px;display:flex;justify-content:space-between;align-items:center;margin-top:10px}
.paid-label{font-size:14px;font-weight:700;color:#fff}.paid-amount{font-size:26px;font-weight:900;color:#fff}
.rem-note{font-size:13px;color:#92400e;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:8px;padding:10px 16px;margin-top:10px;text-align:center}
.note{font-size:13px;color:#9098a8;line-height:1.65;margin-top:22px;padding-top:18px;border-top:1px solid #eeeef2}
.ftr{background:#060e1e;padding:24px 44px;text-align:center}
.ftr p{font-size:12px;color:rgba(255,255,255,.3);margin:3px 0}
</style></head><body>
<div class="wrap">
  <div class="hdr"><div class="logo">Evan<em>oloca</em></div><div class="badge">✓ Réservation confirmée</div></div>
  <div class="body">
    <div class="greeting">Bonjour ${m.prenom} ${m.nom},</div>
    <p class="intro">Votre paiement a été accepté et votre réservation est confirmée. Conservez cet email — il vous servira de justificatif à l'agence.</p>
    <div class="ref-box"><div class="ref-label">Référence de réservation</div><div class="ref-num">${ref}</div></div>
    <div class="section">
      <div class="stitle">Votre véhicule</div>
      <div class="row"><span>Modèle</span><strong>${m.carName}</strong></div>
      <div class="row"><span>Prise en charge</span><strong>${m.dateDebut}</strong></div>
      <div class="row"><span>Retour</span><strong>${m.dateFin}</strong></div>
      <div class="row"><span>Durée</span><strong>${m.days} jour${m.days > 1 ? 's' : ''}</strong></div>
      <div class="row"><span>Agence</span><strong>${m.agence}</strong></div>
    </div>
    <div class="section">
      <div class="stitle">Paiement</div>
      <div class="row"><span>Tarif journalier</span><strong>${m.carPrice} €/jour</strong></div>
      <div class="row"><span>Total de la location</span><strong>${m.totalAmount} €</strong></div>
      <div class="row"><span>Mode</span><strong>${isDeposit ? 'Acompte 30%' : 'Paiement intégral'}</strong></div>
      <div class="paid-box"><span class="paid-label">Montant encaissé</span><span class="paid-amount">${m.amountPaid} €</span></div>
      ${isDeposit ? `<div class="rem-note">⚠️ Solde de <strong>${m.remaining} €</strong> à régler sur place à la remise des clés.</div>` : ''}
    </div>
    <p class="note">Pour toute question : <strong>contact@evanoloca.gp</strong> · <strong>+590 590 23 45 67</strong><br>Présentez cette confirmation et votre permis de conduire à votre arrivée.</p>
  </div>
  <div class="ftr">
    <p>Evanoloca – Sainte-Rose, 97115 Guadeloupe</p>
    <p>contact@evanoloca.gp · +590 590 23 45 67</p>
  </div>
</div></body></html>`;

  const ownerHtml = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f2f5;padding:32px 16px}
.wrap{max-width:580px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.12)}
.hdr{background:linear-gradient(135deg,#060e1e,#1a3a6b);padding:28px 40px;text-align:center}
.logo{font-size:24px;font-weight:900;color:#fff}.logo em{color:#d4b96a;font-style:normal}
.badge{display:inline-block;margin-top:10px;padding:6px 16px;border-radius:100px;background:rgba(99,102,241,.2);border:1px solid rgba(99,102,241,.4);color:#a5b4fc;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em}
.body{padding:28px 36px}
.top{display:flex;justify-content:space-between;align-items:center;background:#0a1628;border-radius:12px;padding:16px 22px;margin-bottom:20px}
.top-ref{font-family:'Courier New',monospace;font-size:18px;font-weight:700;color:#d4b96a}
.top-amt{font-size:22px;font-weight:900;color:#34d399}
.section{background:#f7f8fa;border-radius:12px;padding:18px 22px;margin-bottom:12px}
.stitle{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9098a8;margin-bottom:10px}
.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eeeef2;font-size:14px;color:#525d70}
.row:last-child{border-bottom:none}.row strong{color:#0a1628;font-weight:600}
.green{color:#10b981!important}.warn{color:#f59e0b!important}
.ftr{background:#060e1e;padding:18px 36px;text-align:center}
.ftr p{font-size:12px;color:rgba(255,255,255,.3);margin:3px 0}
</style></head><body>
<div class="wrap">
  <div class="hdr"><div class="logo">Evan<em>oloca</em></div><div class="badge">🔔 Nouvelle réservation</div></div>
  <div class="body">
    <div class="top">
      <div><div style="font-size:11px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.1em;margin-bottom:5px">Référence</div><div class="top-ref">${ref}</div></div>
      <div class="top-amt">${m.amountPaid} €</div>
    </div>
    <div class="section">
      <div class="stitle">Client</div>
      <div class="row"><span>Nom</span><strong>${m.prenom} ${m.nom}</strong></div>
      <div class="row"><span>Email</span><strong>${m.email}</strong></div>
      <div class="row"><span>Téléphone</span><strong>${m.tel}</strong></div>
      <div class="row"><span>N° permis</span><strong>${m.permis}</strong></div>
    </div>
    <div class="section">
      <div class="stitle">Réservation</div>
      <div class="row"><span>Véhicule</span><strong>${m.carName}</strong></div>
      <div class="row"><span>Début</span><strong>${m.dateDebut}</strong></div>
      <div class="row"><span>Fin</span><strong>${m.dateFin}</strong></div>
      <div class="row"><span>Durée</span><strong>${m.days} jour${m.days > 1 ? 's' : ''}</strong></div>
      <div class="row"><span>Agence</span><strong>${m.agence}</strong></div>
    </div>
    <div class="section">
      <div class="stitle">Paiement</div>
      <div class="row"><span>Total location</span><strong>${m.totalAmount} €</strong></div>
      <div class="row"><span>Type</span><strong>${isDeposit ? 'Acompte 30%' : 'Intégral'}</strong></div>
      <div class="row"><span>Encaissé</span><strong class="green">${m.amountPaid} €</strong></div>
      ${isDeposit ? `<div class="row"><span>À encaisser sur place</span><strong class="warn">${m.remaining} €</strong></div>` : ''}
    </div>
  </div>
  <div class="ftr"><p>Evanoloca – Système automatique · Sainte-Rose, 97115 Guadeloupe</p></div>
</div></body></html>`;

  await transporter.sendMail({
    from:    `"Evanoloca" <${process.env.SMTP_USER}>`,
    to:      m.email,
    subject: `✅ Réservation ${ref} confirmée – ${m.carName}`,
    html:    clientHtml,
  });

  await transporter.sendMail({
    from:    `"Evanoloca Système" <${process.env.SMTP_USER}>`,
    to:      process.env.OWNER_EMAIL,
    subject: `🔔 Nouvelle réservation ${ref} – ${m.carName} – ${m.amountPaid} €`,
    html:    ownerHtml,
  });

  console.log(`✅ Emails envoyés [${ref}] → ${m.email}`);
}

// ─── ADMIN : connexion ────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const adminPwd = process.env.ADMIN_PASSWORD;
  if (!adminPwd) return res.status(500).json({ error: 'Mot de passe admin non configuré dans .env' });
  if (password !== adminPwd) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.set(token, Date.now() + 24 * 60 * 60 * 1000); // expire dans 24h
  res.json({ ok: true, token });
});

// ─── ADMIN : liste des réservations ──────────────────────────────────────────
app.get('/api/admin/reservations', requireAdmin, (req, res) => {
  const reservations = loadReservations();
  reservations.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(reservations);
});

// ─── ADMIN : changer le statut d'une réservation ─────────────────────────────
app.put('/api/admin/reservations/:id', requireAdmin, (req, res) => {
  const { id }     = req.params;
  const { status } = req.body;
  if (!['confirmed', 'cancelled', 'pending'].includes(status))
    return res.status(400).json({ error: 'Statut invalide' });

  const reservations = loadReservations();
  const idx = reservations.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Réservation introuvable' });

  reservations[idx].status    = status;
  reservations[idx].updatedAt = new Date().toISOString();
  saveReservations(reservations);
  res.json({ ok: true, reservation: reservations[idx] });
});

// ─── ADMIN : supprimer une réservation ────────────────────────────────────────
app.delete('/api/admin/reservations/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const reservations = loadReservations();
  const idx = reservations.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Réservation introuvable' });
  reservations.splice(idx, 1);
  saveReservations(reservations);
  res.json({ ok: true });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🚗  Evanoloca – Serveur démarré');
  console.log(`🌐  http://localhost:${PORT}`);
  console.log(`🔐  Admin : http://localhost:${PORT}/admin.html`);
  console.log(`📧  SMTP  : ${process.env.SMTP_HOST || '⚠️  non configuré'}`);
  console.log(`👤  Owner : ${process.env.OWNER_EMAIL || '⚠️  non configuré'}`);
  console.log(`💳  Stripe: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_test') ? '✅ mode test' : '⚠️  clé manquante'}`);
  console.log(`🔑  Admin pwd: ${process.env.ADMIN_PASSWORD ? '✅ configuré' : '⚠️  manquant (ajouter ADMIN_PASSWORD dans .env)'}\n`);
});
