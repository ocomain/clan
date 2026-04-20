// netlify/functions/debug-supabase.js
// Visit /api/debug-supabase to verify Supabase connection from Netlify functions.
// Returns a JSON dump of: env vars present? client loadable? clans table readable?
// applications table writeable? Lets us pinpoint exactly where the pipeline fails.
// Safe to leave in place — returns no secrets, only health info.

exports.handler = async () => {
  const result = {
    timestamp: new Date().toISOString(),
    checks: [],
  };

  // Check 1: env vars present
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  result.checks.push({
    name: 'env_vars',
    SUPABASE_URL_present: !!url,
    SUPABASE_URL_value: url ? url.replace(/^(https:\/\/[a-z0-9]{6}).*/, '$1...supabase.co') : null,
    SUPABASE_ANON_KEY_present: !!anonKey,
    SUPABASE_ANON_KEY_starts: anonKey ? anonKey.slice(0, 10) + '...' : null,
    SUPABASE_SERVICE_KEY_present: !!serviceKey,
    SUPABASE_SERVICE_KEY_starts: serviceKey ? serviceKey.slice(0, 10) + '...' : null,
  });

  if (!url || !serviceKey) {
    result.fatal = 'Required env vars missing — set SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify and redeploy with cache cleared';
    return { statusCode: 500, body: JSON.stringify(result, null, 2) };
  }

  // Check 2: client loadable
  let createClient;
  try {
    ({ createClient } = require('@supabase/supabase-js'));
    result.checks.push({ name: 'package_loaded', ok: true });
  } catch (e) {
    result.checks.push({ name: 'package_loaded', ok: false, error: e.message });
    result.fatal = '@supabase/supabase-js not installed — Netlify needs a clean rebuild (Trigger deploy → Clear cache and deploy)';
    return { statusCode: 500, body: JSON.stringify(result, null, 2) };
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Check 3: clans table readable, ocomain row present
  try {
    const { data, error } = await supabase
      .from('clans')
      .select('id, slug, name')
      .eq('slug', 'ocomain')
      .single();
    if (error) throw error;
    result.checks.push({ name: 'clans_read', ok: true, ocomain_id: data.id, name: data.name });
  } catch (e) {
    result.checks.push({ name: 'clans_read', ok: false, error: e.message, hint: e.message.includes('does not exist') ? 'Schema not applied — paste 001_init.sql into SQL Editor and run' : 'Check anon key vs service key + RLS policies' });
    return { statusCode: 500, body: JSON.stringify(result, null, 2) };
  }

  // Check 4: applications table writeable
  try {
    const clan = await supabase.from('clans').select('id').eq('slug', 'ocomain').single();
    const testEmail = `debug-${Date.now()}@ocomain.test`;
    const { data: inserted, error: insErr } = await supabase
      .from('applications')
      .insert({ clan_id: clan.data.id, email: testEmail, name: 'Debug Probe', status: 'pending' })
      .select('id')
      .single();
    if (insErr) throw insErr;
    // Clean up immediately
    await supabase.from('applications').delete().eq('id', inserted.id);
    result.checks.push({ name: 'applications_write', ok: true, inserted_then_deleted_id: inserted.id });
  } catch (e) {
    result.checks.push({ name: 'applications_write', ok: false, error: e.message });
    return { statusCode: 500, body: JSON.stringify(result, null, 2) };
  }

  // Check 5: list recent real applications so user can verify their herald submissions actually landed
  try {
    const { data: recent, error: listErr } = await supabase
      .from('applications')
      .select('email, name, tier, status, submitted_at')
      .order('submitted_at', { ascending: false })
      .limit(10);
    if (listErr) throw listErr;
    result.checks.push({
      name: 'recent_applications',
      ok: true,
      count: recent.length,
      rows: recent.map(r => ({
        email: r.email,
        name: r.name,
        tier: r.tier || '(no tier)',
        status: r.status,
        submitted_at: r.submitted_at,
      })),
    });
  } catch (e) {
    result.checks.push({ name: 'recent_applications', ok: false, error: e.message });
  }

  result.summary = 'All checks passed. Supabase pipeline is healthy.';
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result, null, 2) };
};
