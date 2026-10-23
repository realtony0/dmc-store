// Toutes les 5 minutes : envoie les rappels arrivés à échéance et vérifie que le bot est bien branché.
import { getStore } from '@netlify/blobs';
import { createRappels, ensureWebhook } from '../lib/rappels.mjs';

export default async () => {
    const webhook = await ensureWebhook().catch(e => 'error: ' + e.message);
    const store = getStore({ name: 'rappels', consistency: 'strong' });
    const sent = await createRappels({ store }).sendDue();
    console.log(`rappels: ${sent} envoyé(s), webhook ${webhook}`);
};

export const config = { schedule: '*/5 * * * *' };
