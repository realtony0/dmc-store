// Rappels clients : boutons sous les commandes Telegram → le bot renvoie la commande au bon moment.
// Heure de Dakar = UTC (pas d'heure d'été), donc on calcule tout en UTC.
import { createHash } from 'node:crypto';

const LEGACY_TOKEN = '8993836003:AAFRa8Lgm0WnapvbTTaDwTYDidNiGJT2I-M';
export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || LEGACY_TOKEN;
export const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '8224396442').split(',').map(s => s.trim()).filter(Boolean);
export const SITE_URL = (process.env.URL || 'https://cosmic-frangipane-dd411c.netlify.app').replace(/\/$/, '');
export const WEBHOOK_URL = `${SITE_URL}/.netlify/functions/telegram-webhook`;
// Secret dérivé de la clé : change automatiquement si la clé du bot est changée
export const WEBHOOK_SECRET = createHash('sha256').update('dmc-rappels:' + BOT_TOKEN).digest('hex').slice(0, 48);
export const DEFAULT_HOUR = 10;

export async function tg(method, body, fetchImpl = fetch) {
    const r = await fetchImpl(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return r.json();
}

/* ─────────── Dates en français ─────────── */
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const strip = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const atHour = (d, h, m) => { const x = new Date(d); x.setUTCHours(h, m, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

export function inDays(n, now = new Date()) { return atHour(addDays(now, n), DEFAULT_HOUR, 0); }

/** « demain », « jeudi 15h », « 28/10 10h30 », « dans 3 jours », « dans 2h », « 16h »… → Date, ou null */
export function parseWhen(input, now = new Date()) {
    const t = strip(String(input || '')).replace(/\s+/g, ' ').trim();
    if (!t) return null;

    let rel = t.match(/dans (\d{1,3}) ?(h|heures?|min|minutes?|j|jours?|semaines?)\b/);
    if (rel) {
        const n = parseInt(rel[1]), u = rel[2];
        if (u.startsWith('h')) return new Date(now.getTime() + n * 3600e3);
        if (u.startsWith('min')) return new Date(now.getTime() + n * 60e3);
        const days = u.startsWith('s') ? n * 7 : n;
        const tm = hourOf(t.replace(rel[0], ''));
        return atHour(addDays(now, days), tm ? tm[0] : DEFAULT_HOUR, tm ? tm[1] : 0);
    }

    const tm = hourOf(t);
    const [h, m] = tm || [DEFAULT_HOUR, 0];
    let day = null;

    if (/apres[ -]?demain/.test(t)) day = addDays(now, 2);
    else if (/\bdemain\b/.test(t)) day = addDays(now, 1);
    else if (/aujourd|\bauj\b|ce soir|cet apres/.test(t)) day = new Date(now);

    if (!day) {
        const dm = t.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
        if (dm) {
            let y = dm[3] ? parseInt(dm[3]) : now.getUTCFullYear(); if (y < 100) y += 2000;
            const d = new Date(Date.UTC(y, parseInt(dm[2]) - 1, parseInt(dm[1]), h, m));
            if (isNaN(d) || d.getUTCDate() !== parseInt(dm[1])) return null;
            if (!dm[3] && d <= now) d.setUTCFullYear(y + 1);
            return d;
        }
    }
    if (!day) {
        const wd = DAYS.findIndex(n => new RegExp('\\b' + n + '\\b').test(t));
        if (wd >= 0) { let diff = (wd - now.getUTCDay() + 7) % 7; if (diff === 0) diff = 7; day = addDays(now, diff); }
    }
    if (!day && tm) { // seulement une heure : aujourd'hui si c'est encore à venir, sinon demain
        day = new Date(now); if (atHour(day, h, m) <= now) day = addDays(now, 1);
    }
    if (!day) return null;
    const when = atHour(day, h, m);
    return when > now ? when : null;
}
function hourOf(t) {
    const x = t.match(/\b(\d{1,2}) ?(?:h|:) ?(\d{2})?\b/);
    if (!x) return null;
    const h = parseInt(x[1]), m = x[2] ? parseInt(x[2]) : 0;
    return h < 24 && m < 60 ? [h, m] : null;
}
export function fmtWhen(d) {
    const p = n => String(n).padStart(2, '0');
    return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} à ${p(d.getUTCHours())}h${p(d.getUTCMinutes())}`;
}

/* ─────────── Boutons ─────────── */
export const scheduleRow = () => [
    { text: '⏰ Demain', callback_data: 'r|1' },
    { text: '⏰ Dans 3 jours', callback_data: 'r|3' },
    { text: '📅 Autre date', callback_data: 'r|ask' },
];
export function waButton(markup) {
    for (const row of markup?.inline_keyboard || []) for (const b of row) if (b.url && b.url.includes('wa.me')) return b;
    return null;
}

/* ─────────── Logique (store et client Telegram injectables pour les tests) ─────────── */
export function createRappels({ store, call = tg, now = () => new Date() }) {
    const allowed = id => CHAT_IDS.includes(String(id));

    async function schedule(chatId, orderMsgId, when, wa) {
        const id = `${chatId}-${orderMsgId}-${when.getTime()}`;
        await store.setJSON(`r/${id}`, { id, chatId, orderMsgId, due: when.getTime(), wa: wa || null, created: now().getTime() });
        await call('sendMessage', {
            chat_id: chatId, parse_mode: 'HTML',
            text: `⏰ Rappel programmé : <b>${fmtWhen(when)}</b>\nJe te renverrai cette commande à ce moment-là.`,
            reply_parameters: { message_id: orderMsgId, allow_sending_without_reply: true },
        });
        return id;
    }

    async function onUpdate(u) {
        const cq = u.callback_query;
        if (cq) {
            const chatId = cq.message?.chat?.id, msg = cq.message;
            if (!allowed(chatId)) return call('answerCallbackQuery', { callback_query_id: cq.id });
            const [kind, a, b] = String(cq.data || '').split('|');
            if (kind === 'r' && (a === '1' || a === '3')) {
                const when = inDays(parseInt(a), now());
                await schedule(chatId, msg.message_id, when, waButton(msg.reply_markup));
                return call('answerCallbackQuery', { callback_query_id: cq.id, text: `⏰ Rappel : ${fmtWhen(when)}` });
            }
            if (kind === 'r' && a === 'ask') {
                const sent = await call('sendMessage', {
                    chat_id: chatId, parse_mode: 'HTML',
                    text: '📅 <b>Quand rappeler ce client ?</b>\nRéponds à ce message, par exemple :\n• <i>jeudi 15h</i>\n• <i>demain</i>\n• <i>28/10 10h</i>\n• <i>dans 2 jours</i>',
                    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
                    reply_markup: { force_reply: true, input_field_placeholder: 'ex : jeudi 15h' },
                });
                if (sent?.ok) await store.setJSON(`p/${chatId}-${sent.result.message_id}`, { orderMsgId: msg.message_id, wa: waButton(msg.reply_markup) });
                return call('answerCallbackQuery', { callback_query_id: cq.id });
            }
            if (kind === 'snz') { // depuis un rappel : +N jours sur la même commande
                const orderMsgId = parseInt(b), when = inDays(parseInt(a), now());
                await schedule(chatId, orderMsgId, when, waButton(msg.reply_markup));
                await call('editMessageReplyMarkup', { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [[{ text: `⏰ Reporté au ${fmtWhen(when)}`, callback_data: 'noop' }]] } });
                return call('answerCallbackQuery', { callback_query_id: cq.id, text: `⏰ Reporté : ${fmtWhen(when)}` });
            }
            if (kind === 'done') {
                await call('editMessageReplyMarkup', { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [[{ text: '✅ Client rappelé', callback_data: 'noop' }]] } });
                return call('answerCallbackQuery', { callback_query_id: cq.id, text: '✅ Noté' });
            }
            return call('answerCallbackQuery', { callback_query_id: cq.id });
        }

        const m = u.message;
        if (!m || !allowed(m.chat?.id) || typeof m.text !== 'string') return;
        const chatId = m.chat.id;

        if (/^\/rappels?\b/.test(m.text)) {
            const list = (await allReminders()).filter(r => String(r.chatId) === String(chatId)).sort((x, y) => x.due - y.due);
            const text = list.length
                ? '📋 <b>Rappels à venir</b>\n\n' + list.map(r => `• ${fmtWhen(new Date(r.due))}`).join('\n')
                : 'Aucun rappel programmé.';
            return call('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text });
        }

        const rt = m.reply_to_message;
        if (!rt) return;
        const pending = await store.get(`p/${chatId}-${rt.message_id}`, { type: 'json' });
        const orderMsgId = pending?.orderMsgId ?? rt.message_id;
        const wa = pending?.wa ?? waButton(rt.reply_markup);
        const when = parseWhen(m.text, now());
        if (!when) {
            return call('sendMessage', {
                chat_id: chatId,
                text: '🤔 Je n\'ai pas compris la date. Essaie par exemple « jeudi 15h », « demain », « 28/10 10h » ou « dans 2 jours ».',
                reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
            });
        }
        await schedule(chatId, orderMsgId, when, wa);
        if (pending) await store.delete(`p/${chatId}-${rt.message_id}`);
    }

    async function allReminders() {
        const { blobs } = await store.list({ prefix: 'r/' });
        const out = [];
        for (const b of blobs) { const v = await store.get(b.key, { type: 'json' }); if (v) out.push({ ...v, key: b.key }); }
        return out;
    }

    /** Envoie les rappels arrivés à échéance. */
    async function sendDue() {
        const t = now().getTime(); let sent = 0;
        for (const r of await allReminders()) {
            if (r.due > t) continue;
            const kb = [];
            if (r.wa) kb.push([r.wa]);
            kb.push([{ text: '✅ Fait', callback_data: 'done' }]);
            kb.push([{ text: '⏰ +1 jour', callback_data: `snz|1|${r.orderMsgId}` }, { text: '⏰ +3 jours', callback_data: `snz|3|${r.orderMsgId}` }]);
            const res = await call('sendMessage', {
                chat_id: r.chatId, parse_mode: 'HTML',
                text: `🔔 <b>RAPPEL — client à rappeler maintenant</b>\n(prévu ${fmtWhen(new Date(r.due))})\n\nLa commande est juste au-dessus 👆`,
                reply_parameters: { message_id: r.orderMsgId, allow_sending_without_reply: true },
                reply_markup: { inline_keyboard: kb },
            });
            if (res?.ok || t - r.due > 3 * 86400e3) { await store.delete(r.key); sent++; }
        }
        return sent;
    }

    return { onUpdate, sendDue, allReminders, schedule };
}

/** Branche le bot sur la fonction webhook si ce n'est pas déjà fait (se répare tout seul après un changement de clé). */
export async function ensureWebhook(call = tg) {
    const info = await call('getWebhookInfo', {});
    if (info?.ok && info.result?.url === WEBHOOK_URL) return 'ok';
    const r = await call('setWebhook', { url: WEBHOOK_URL, secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
    return r?.ok ? 'set' : 'error: ' + (r?.description || '?');
}
