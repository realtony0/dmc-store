// Reçoit les commandes et paniers abandonnés du site, puis les transmet à Telegram.
// La clé du bot reste ici, côté serveur : elle n'apparaît plus dans la page.
//
// Clé : variable d'environnement Netlify TELEGRAM_BOT_TOKEN.
// L'ancienne clé ci-dessous sert uniquement de secours tant que la variable n'est pas créée ;
// elle est publique et doit être révoquée via @BotFather.
const LEGACY_TOKEN = '8993836003:AAFRa8Lgm0WnapvbTTaDwTYDidNiGJT2I-M';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || LEGACY_TOKEN;
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '8224396442').split(',').map(s => s.trim()).filter(Boolean);

const PRODUCTS = {
    deboucheur: { name: 'Déboucheur DMC Pro', label: 'déboucheur(s)', short: 'déboucheur', prices: { 1: 9000, 2: 15000, 3: 20000 } },
    peluche: { name: 'Ours en Peluche Géant', label: 'peluche(s)', short: 'ours en peluche', plural: 'ours en peluche', prices: { 1: 50000, 2: 95000, 3: 140000 }, colors: ['Rose', 'Beige', 'Blanc', 'Marron'] },
};
// Rétro-compatibilité (tests, rappels) : le déboucheur reste le produit par défaut
const PRODUCT = PRODUCTS.deboucheur;
const PRICES = PRODUCT.prices;

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

function buildMessage(type, o) {
    const P = PRODUCTS[o.product] || PRODUCT;
    const total = money(P.prices[o.qty]);
    const date = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Dakar', dateStyle: 'short', timeStyle: 'short' });
    const lines = type === 'abandon'
        ? [`⚠️ <b>PANIER ABANDONNÉ — DMC Store</b>`, ``, `Ce client a rempli le formulaire mais n'a pas validé. Relance-le vite !`, ``]
        : [`🛒 <b>NOUVELLE COMMANDE — DMC Store</b>`, ``, `🏷️ <b>Produit :</b> ${esc(P.name)}`];
    lines.push(
        `👤 <b>Nom :</b> ${esc(o.name || '(non renseigné)')}`,
        `📞 <b>Téléphone :</b> ${prettyPhone(o.phone)}`,
        `🏙️ <b>Ville :</b> ${esc(o.city || '(non renseignée)')}`,
        `📍 <b>Quartier / adresse :</b> ${esc(o.address || '(non renseigné)')}`,
        ...(type === 'abandon' ? [`🏷️ <b>Produit :</b> ${esc(P.name)}`] : []),
        ...(o.color ? [`🎨 <b>Couleur :</b> ${esc(o.color)}`] : []),
        `📦 <b>Quantité :</b> ${o.qty} ${P.label}`,
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
    const P = PRODUCTS[o.product] || PRODUCT;
    const pack = `${o.qty} ${o.qty > 1 ? (P.plural || P.short + 's') : P.short}${o.color ? ' (' + o.color + ')' : ''}`;
    const text = type === 'abandon'
        ? `Bonjour${firstName ? ' ' + firstName : ''}, c'est DMC Store. Vous avez commencé une commande de ${pack} (${money(P.prices[o.qty])} F) sur notre site. Souhaitez-vous qu'on vous livre ?`
        : `Bonjour${firstName ? ' ' + firstName : ''}, c'est DMC Store. Nous avons bien reçu votre commande de ${pack} pour ${money(P.prices[o.qty])} F. Êtes-vous disponible pour la livraison ?`;
    return `https://wa.me/221${o.phone}?text=${encodeURIComponent(text)}`;
}

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method' });

    let b;
    try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'json' }); }

    // Champ piège invisible : rempli uniquement par les robots
    if (b.website) return json(200, { ok: true });

    const type = b.type === 'abandon' ? 'abandon' : 'order';
    const product = PRODUCTS[b.product] ? b.product : 'deboucheur';
    const P = PRODUCTS[product];
    const o = {
        product,
        color: P.colors ? String(b.color || '').split('+').map(c => c.trim()).filter(c => P.colors.includes(c)).slice(0, 3).join(' + ') : '',
        name: clip(b.name, 80),
        phone: normalizePhone(b.phone),
        city: clip(b.city, 40),
        address: clip(b.address, 160),
        qty: P.prices[parseInt(b.qty)] ? parseInt(b.qty) : 1,
        source: clip(b.source, 60),
        campaign: clip(b.campaign, 80),
    };

    if (!o.phone) return json(400, { ok: false, error: 'phone' });
    if (type === 'order' && (o.name.length < 3 || !o.city || o.address.length < 2)) return json(400, { ok: false, error: 'fields' });

    const payload = {
        text: buildMessage(type, o),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [
            [{ text: type === 'abandon' ? '💬 Relancer sur WhatsApp' : '💬 Écrire au client sur WhatsApp', url: whatsappUrl(type, o) }],
            // Rappels clients : gérés par netlify/functions/telegram-webhook.mjs
            [{ text: '⏰ Demain', callback_data: 'r|1' }, { text: '⏰ Dans 3 jours', callback_data: 'r|3' }, { text: '📅 Autre date', callback_data: 'r|ask' }],
        ] },
    };

    const results = await Promise.all(CHAT_IDS.map(chat_id =>
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id, ...payload }),
        }).then(r => r.json()).catch(e => ({ ok: false, description: String(e) }))
    ));

    // Enregistrement pour l'espace de gestion (gestion.html). Ne bloque jamais la commande :
    // si l'enregistrement échoue, le message Telegram est déjà parti et le client voit quand même la confirmation.
    let saved = false;
    try {
        const { getStore, connectLambda } = require('@netlify/blobs');
        connectLambda(event);
        const store = getStore({ name: 'commandes', consistency: 'strong' });
        const now = new Date();
        const cle = 'mois/' + now.toISOString().slice(0, 7);
        const liste = (await store.get(cle, { type: 'json' })) || [];
        liste.push({
            id: now.getTime().toString(36) + Math.random().toString(36).slice(2, 6),
            t: now.toISOString(), type, ...o, total: P.prices[o.qty],
            statut: type === 'abandon' ? 'abandon' : 'nouvelle',
            telegram: results.some(r => r.ok),
        });
        await store.setJSON(cle, liste);
        saved = true;
    } catch (e) {
        console.error('Enregistrement de la commande impossible', e); global.__saveErr = e && e.message;
    }

    if (!results.some(r => r.ok)) {
        console.error('Telegram a refusé le message', results);
        return json(502, { ok: false, error: 'telegram' });
    }
    return json(200, { ok: true, total: P.prices[o.qty], saved, why: saved ? undefined : String(global.__saveErr || '').slice(0, 200) });
};

// Exposé pour les tests locaux
exports._test = { normalizePhone, buildMessage, whatsappUrl, PRICES };
