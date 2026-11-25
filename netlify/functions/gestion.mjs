// Espace de gestion DMC Store (gestion.html) : lecture et suivi des commandes enregistrées par order.js.
// Accès par code à chiffres. Seule une empreinte du code est stockée (scrypt + sel), jamais le code lui-même.
import { getStore } from '@netlify/blobs';
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { BOT_TOKEN } from '../lib/rappels.mjs';

// Clé interne partagée avec order.js (dérivée de la clé du bot, jamais envoyée au navigateur)
const CLE_INTERNE = createHash('sha256').update('dmc-gestion:' + BOT_TOKEN).digest('hex').slice(0, 48);

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const empreinte = (sel, code) => scryptSync(code, sel, 32).toString('hex');
const STATUTS = ['nouvelle', 'confirmee', 'livree', 'annulee', 'injoignable', 'abandon'];
const moisValide = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);


// Envoi à Meta (API Conversions) des commandes confirmées au téléphone : Meta apprend qui confirme vraiment.
// Inactif tant que la variable META_CAPI_TOKEN n'existe pas dans Netlify.
const PIXEL = '2020255135270613';
const sha = v => createHash('sha256').update(v).digest('hex');
async function envoyerMeta(c) {
    const token = process.env.META_CAPI_TOKEN;
    if (!token) return { envoye: false, raison: 'pas de clé' };
    const nom = String(c.name || '').toLowerCase().trim().split(/\s+/);
    const ud = { country: [sha('sn')] };
    if (c.phone) ud.ph = [sha('221' + c.phone)];
    if (nom[0]) ud.fn = [sha(nom[0])];
    if (nom.length > 1) ud.ln = [sha(nom.slice(1).join(' '))];
    if (c.city && c.city !== 'Autre ville') ud.ct = [sha(c.city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, ''))];
    if (c.eid) ud.external_id = [sha(c.eid)];
    if (c.fbp) ud.fbp = c.fbp;
    if (c.fbc) ud.fbc = c.fbc;
    if (c.ip) ud.client_ip_address = c.ip;
    if (c.ua) ud.client_user_agent = c.ua;
    const ev = {
        event_name: 'CommandeConfirmee', event_time: Math.floor(Date.now() / 1000), event_id: 'conf.' + c.id,
        action_source: 'website', event_source_url: 'https://cosmic-frangipane-dd411c.netlify.app/' + (c.product === 'peluche' ? 'peluche.html' : ''),
        user_data: ud, custom_data: { currency: 'XOF', value: Number(c.total) || 0, content_ids: [c.product || 'deboucheur'], num_items: Number(c.qty) || 1 },
    };
    const body = { data: [ev] };
    if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;
    const v = process.env.META_API_VERSION || 'v23.0';
    try {
        const r = await fetch(`https://graph.facebook.com/${v}/${PIXEL}/events?access_token=${encodeURIComponent(token)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
        });
        const j = await r.json().catch(() => ({}));
        return j.events_received ? { envoye: true } : { envoye: false, raison: (j.error && j.error.message) || 'refus' };
    } catch (e) { return { envoye: false, raison: String(e).slice(0, 120) }; }
}

export default async (req) => {
    if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
    let b;
    try { b = await req.json(); } catch { return J({ ok: false, error: 'json' }, 400); }

    if (b.action === 'enregistrer') {
        if (b.cle !== CLE_INTERNE || !b.commande || typeof b.commande !== 'object') return J({ ok: false, error: 'interdit' }, 403);
        const store = getStore({ name: 'commandes', consistency: 'strong' });
        const now = new Date();
        const cle = 'mois/' + now.toISOString().slice(0, 7);
        const liste = (await store.get(cle, { type: 'json' })) || [];
        const c = b.commande;
        liste.push({
            id: now.getTime().toString(36) + Math.random().toString(36).slice(2, 6), t: now.toISOString(),
            type: c.type === 'abandon' ? 'abandon' : 'order', product: String(c.product || ''), color: String(c.color || ''),
            name: String(c.name || '').slice(0, 80), phone: String(c.phone || '').slice(0, 12), city: String(c.city || '').slice(0, 40),
            address: String(c.address || '').slice(0, 160), qty: Number(c.qty) || 1, total: Number(c.total) || 0,
            source: String(c.source || '').slice(0, 60), campaign: String(c.campaign || '').slice(0, 80),
            statut: c.type === 'abandon' ? 'abandon' : 'nouvelle', telegram: !!c.telegram,
            fbp: String(c.fbp || '').slice(0, 120), fbc: String(c.fbc || '').slice(0, 400), eid: String(c.eid || '').slice(0, 60),
            ip: String(c.ip || '').slice(0, 60), ua: String(c.ua || '').slice(0, 300),
        });
        await store.setJSON(cle, liste);
        return J({ ok: true });
    }

    const reglages = getStore({ name: 'gestion', consistency: 'strong' });
    const auth = await reglages.get('auth', { type: 'json' });
    if (b.action === 'etat') return J({ ok: true, configure: !!auth });

    const code = String(b.code || '');
    if (b.action === 'creer') {
        if (auth) return J({ ok: false, error: 'deja' }, 409);
        if (!/^\d{4,8}$/.test(code)) return J({ ok: false, error: 'format' }, 400);
        const sel = randomBytes(16).toString('hex');
        await reglages.setJSON('auth', { sel, h: empreinte(sel, code), echecs: 0, bloque: 0 });
        return J({ ok: true });
    }

    if (!auth) return J({ ok: false, error: 'configurer' }, 401);
    if (auth.bloque > Date.now()) return J({ ok: false, error: 'bloque' }, 429);
    const bon = /^\d{4,8}$/.test(code) && timingSafeEqual(Buffer.from(empreinte(auth.sel, code)), Buffer.from(auth.h));
    if (!bon) {
        auth.echecs = (auth.echecs || 0) + 1;
        if (auth.echecs >= 8) { auth.bloque = Date.now() + 15 * 60000; auth.echecs = 0; }
        await reglages.setJSON('auth', auth);
        return J({ ok: false, error: 'code' }, 401);
    }
    if (auth.echecs) { auth.echecs = 0; await reglages.setJSON('auth', auth); }

    const store = getStore({ name: 'commandes', consistency: 'strong' });

    if (b.action === 'liste') {
        const mois = (Array.isArray(b.mois) ? b.mois : []).filter(moisValide).slice(0, 4);
        const out = [];
        for (const m of mois) for (const c of ((await store.get('mois/' + m, { type: 'json' })) || [])) out.push({ ...c, mois: m });
        return J({ ok: true, commandes: out });
    }

    if (b.action === 'maj' || b.action === 'supprimer') {
        if (!moisValide(b.mois) || typeof b.id !== 'string') return J({ ok: false, error: 'champs' }, 400);
        const cle = 'mois/' + b.mois;
        const liste = (await store.get(cle, { type: 'json' })) || [];
        const i = liste.findIndex(c => c.id === b.id);
        let meta = null;
        if (i < 0) return J({ ok: false, error: 'introuvable' }, 404);
        if (b.action === 'supprimer') liste.splice(i, 1);
        else {
            if (b.statut !== undefined) { if (!STATUTS.includes(b.statut)) return J({ ok: false, error: 'statut' }, 400); liste[i].statut = b.statut; }
            if (['confirmee', 'livree'].includes(liste[i].statut) && liste[i].type === 'order' && !liste[i].meta) {
                const m = await envoyerMeta(liste[i]);
                if (m.envoye) liste[i].meta = new Date().toISOString(); else liste[i].metaErreur = m.raison;
                meta = m;
            }
            if (b.note !== undefined) liste[i].note = String(b.note).slice(0, 300);
            liste[i].maj = new Date().toISOString();
        }
        await store.setJSON(cle, liste);
        return J({ ok: true, meta });
    }
    return J({ ok: false, error: 'action' }, 400);
};

export const config = { path: '/api/gestion' };
