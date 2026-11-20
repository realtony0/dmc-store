// Espace de gestion DMC Store (gestion.html) : lecture et suivi des commandes enregistrées par order.js.
// Accès par code à chiffres. Seule une empreinte du code est stockée (scrypt + sel), jamais le code lui-même.
import { getStore } from '@netlify/blobs';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const empreinte = (sel, code) => scryptSync(code, sel, 32).toString('hex');
const STATUTS = ['nouvelle', 'confirmee', 'livree', 'annulee', 'injoignable', 'abandon'];
const moisValide = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

export default async (req) => {
    if (req.method !== 'POST') return J({ ok: false, error: 'method' }, 405);
    let b;
    try { b = await req.json(); } catch { return J({ ok: false, error: 'json' }, 400); }

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
        if (i < 0) return J({ ok: false, error: 'introuvable' }, 404);
        if (b.action === 'supprimer') liste.splice(i, 1);
        else {
            if (b.statut !== undefined) { if (!STATUTS.includes(b.statut)) return J({ ok: false, error: 'statut' }, 400); liste[i].statut = b.statut; }
            if (b.note !== undefined) liste[i].note = String(b.note).slice(0, 300);
            liste[i].maj = new Date().toISOString();
        }
        await store.setJSON(cle, liste);
        return J({ ok: true });
    }
    return J({ ok: false, error: 'action' }, 400);
};

export const config = { path: '/api/gestion' };
