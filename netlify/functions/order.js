// Reçoit les commandes et paniers abandonnés du site, puis les transmet à Telegram.
// La clé du bot reste ici, côté serveur : elle n'apparaît plus dans la page.
//
// Clé : variable d'environnement Netlify TELEGRAM_BOT_TOKEN.
// L'ancienne clé ci-dessous sert uniquement de secours tant que la variable n'est pas créée ;
// elle est publique et doit être révoquée via @BotFather.
const LEGACY_TOKEN = '8993836003:AAFRa8Lgm0WnapvbTTaDwTYDidNiGJT2I-M';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || LEGACY_TOKEN;
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '8224396442').split(',').map(s => s.trim()).filter(Boolean);

const PRODUCT = { name: 'Déboucheur DMC Pro', label: 'déboucheur(s)' };
const PRICES = { 1: 9000, 2: 15000, 3: 20000 };

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const money = n => n.toLocaleString('fr-FR').replace(/[  ]/g, ' ');

// Numéro sénégalais : 9 chiffres commençant par 70-78 ou 33, avec ou sans +221 / 00221
function normalizePhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('00221')) d = d.slice(5);
    else if (d.startsWith('221') && d.length === 12) d = d.slice(3);
    return /^(7[0-8]|33)\d{7}$/.test(d) ? d : null;
}
const prettyPhone = d => `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 7)} ${d.slice(7)}`;
const newOrderId = () => 'DMC-' + (Date.now().toString(36).slice(-3) + require('crypto').randomBytes(3).toString('hex').slice(0, 3)).toUpperCase();
const cleanOrderId = s => /^DMC-[A-Z0-9]{4,8}$/.test(String(s || '')) ? s : null;
const units = q => `${q} flacon${q > 1 ? 's' : ''}`;

function buildMessage(type, o) {
    const total = money(PRICES[o.qty]);
    const date = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Dakar', dateStyle: 'short', timeStyle: 'short' });
    if (type === 'upsell') {
        return [
            `⬆️ <b>COMMANDE AUGMENTÉE — ${o.orderId}</b>`,
            ``,
            `Le client a accepté l'offre après sa commande.`,
            ``,
            `👤 <b>Nom :</b> ${esc(o.name || '—')}`,
            `📞 <b>Téléphone :</b> ${prettyPhone(o.phone)}`,
            `📦 <b>Avant :</b> ${units(o.fromQty)} — ${money(PRICES[o.fromQty])} FCFA`,
            `📦 <b>Maintenant :</b> <b>${units(o.qty)} — ${total} FCFA</b>`,
            ``,
            `🕐 ${date}`,
        ].join('\n');
    }
    const lines = type === 'abandon'
        ? [`⚠️ <b>PANIER ABANDONNÉ — DMC Store</b>`, ``, `Ce client a rempli le formulaire mais n'a pas validé. Relance-le vite !`, ``]
        : [`🛒 <b>NOUVELLE COMMANDE ${o.orderId}</b>`, ``, `🏷️ <b>Produit :</b> ${esc(PRODUCT.name)}`];
    lines.push(
        `👤 <b>Nom :</b> ${esc(o.name || '(non renseigné)')}`,
        `📞 <b>Téléphone :</b> ${prettyPhone(o.phone)}`,
        `🏙️ <b>Ville :</b> ${esc(o.city || '(non renseignée)')}`,
        `📍 <b>Quartier / adresse :</b> ${esc(o.address || '(non renseigné)')}`,
        `📦 <b>Quantité :</b> ${o.qty} ${PRODUCT.label}`,
        `💰 <b>Total :</b> ${total} FCFA`,
        ``,
        `📊 <b>Source :</b> ${esc(o.source || '—')}`,
    );
    if (type !== 'abandon') lines.push(`🎯 <b>Campagne :</b> ${esc(o.campaign || '—')}`);
    lines.push(``, `🕐 ${date}`);
    return lines.join('\n');
}

function whatsappUrl(type, o) {
    const firstName = (o.name || '').split(/\s+/)[0];
    const pack = `${o.qty} déboucheur${o.qty > 1 ? 's' : ''}`;
    const text = type === 'abandon'
        ? `Bonjour${firstName ? ' ' + firstName : ''}, c'est DMC Store. Vous avez commencé une commande de ${pack} (${money(PRICES[o.qty])} F) sur notre site. Souhaitez-vous qu'on vous livre ?`
        : `Bonjour${firstName ? ' ' + firstName : ''}, c'est DMC Store. Nous avons bien reçu votre commande ${o.orderId} de ${pack} pour ${money(PRICES[o.qty])} F. Êtes-vous disponible pour la livraison ?`;
    return `https://wa.me/221${o.phone}?text=${encodeURIComponent(text)}`;
}

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method' });

    let b;
    try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'json' }); }

    // Champ piège invisible : rempli uniquement par les robots
    if (b.website) return json(200, { ok: true });

    const type = ['abandon', 'upsell'].includes(b.type) ? b.type : 'order';
    const o = {
        name: clip(b.name, 80),
        phone: normalizePhone(b.phone),
        city: clip(b.city, 40),
        address: clip(b.address, 160),
        qty: PRICES[parseInt(b.qty)] ? parseInt(b.qty) : 1,
        source: clip(b.source, 60),
        campaign: clip(b.campaign, 80),
        orderId: type === 'upsell' ? cleanOrderId(b.orderId) : newOrderId(),
        fromQty: parseInt(b.fromQty),
    };

    if (!o.phone) return json(400, { ok: false, error: 'phone' });
    if (type === 'order' && (o.name.length < 3 || !o.city || o.address.length < 2)) return json(400, { ok: false, error: 'fields' });
    if (type === 'upsell' && (!o.orderId || !PRICES[o.fromQty] || o.qty <= o.fromQty)) return json(400, { ok: false, error: 'upsell' });

    const payload = {
        text: buildMessage(type, o),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
    };
    if (type !== 'upsell') payload.reply_markup = { inline_keyboard: [[{ text: type === 'abandon' ? '💬 Relancer sur WhatsApp' : '💬 Écrire au client sur WhatsApp', url: whatsappUrl(type, o) }]] };

    const results = await Promise.all(CHAT_IDS.map(chat_id =>
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id, ...payload }),
        }).then(r => r.json()).catch(e => ({ ok: false, description: String(e) }))
    ));

    if (!results.some(r => r.ok)) {
        console.error('Telegram a refusé le message', results);
        return json(502, { ok: false, error: 'telegram' });
    }
    return json(200, { ok: true, total: PRICES[o.qty], orderId: type === 'abandon' ? undefined : o.orderId });
};

// Exposé pour les tests locaux
exports._test = { normalizePhone, buildMessage, whatsappUrl, PRICES };
