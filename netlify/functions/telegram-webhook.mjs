// Reçoit les clics sur les boutons « ⏰ Rappel » et les réponses de date envoyés au bot Telegram.
import { getStore } from '@netlify/blobs';
import { createRappels, WEBHOOK_SECRET } from '../lib/rappels.mjs';

export default async (req) => {
    if (req.method !== 'POST') return new Response('ok');
    if (req.headers.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
    let update;
    try { update = await req.json(); } catch { return new Response('ok'); }
    try {
        const store = getStore({ name: 'rappels', consistency: 'strong' });
        await createRappels({ store }).onUpdate(update);
    } catch (e) {
        console.error('rappels webhook', e);
    }
    // Toujours 200, sinon Telegram renvoie la même mise à jour en boucle
    return new Response('ok');
};
