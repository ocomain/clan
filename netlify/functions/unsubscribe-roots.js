// netlify/functions/unsubscribe-roots.js
//
// GET endpoint for the unsubscribe link in the footer of every
// lead-magnet email. Sets unsubscribed_at on the matching row,
// stops all further lifecycle email dispatch from the cron, and
// redirects to a friendly confirmation page.

const { supa, clanId, logEvent } = require('./lib/supabase');

const SITE = process.env.SITE_URL || 'https://www.ocomain.org';

exports.handler = async (event) => {
  const token = (event.queryStringParameters && event.queryStringParameters.t) || '';

  if (!token || typeof token !== 'string' || token.length < 16) {
    return { statusCode: 302, headers: { Location: `${SITE}/roots?unsub=invalid` }, body: '' };
  }

  try {
    const clan_id = await clanId();

    const { data: subscriber, error: lookupErr } = await supa()
      .from('pdf_subscribers')
      .select('id, email')
      .eq('clan_id', clan_id)
      .eq('unsubscribe_token', token)
      .maybeSingle();

    if (lookupErr) {
      console.error('unsubscribe-roots: lookup failed:', lookupErr.message);
      return { statusCode: 302, headers: { Location: `${SITE}/roots?unsub=error` }, body: '' };
    }

    if (!subscriber) {
      // Treat unknown tokens as already-unsubscribed for the user UX.
      return { statusCode: 302, headers: { Location: `${SITE}/roots-unsubscribed.html` }, body: '' };
    }

    await supa()
      .from('pdf_subscribers')
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq('id', subscriber.id);

    await logEvent({
      clan_id,
      member_id: null,
      event_type: 'pdf_subscriber_unsubscribed',
      payload: { subscriber_id: subscriber.id },
    });

    return { statusCode: 302, headers: { Location: `${SITE}/roots-unsubscribed.html` }, body: '' };
  } catch (err) {
    console.error('unsubscribe-roots: fatal:', err.message, err.stack);
    return { statusCode: 302, headers: { Location: `${SITE}/roots?unsub=error` }, body: '' };
  }
};
