// netlify/functions/test-generate-patent.js
//
// Manually invokes generate-patent.js and returns the resulting PDF
// (or a structured error if the generator throws). Used to verify that
// the patent generator runs correctly in the Netlify Lambda environment
// before wiring it into the conferral pipeline. Pure read of the
// generator output — no Supabase calls, no DB writes, no email sends.
//
// USAGE (from terminal — saves the PDF to disk):
//
//   curl -X POST 'https://www.ocomain.org/.netlify/functions/test-generate-patent' \
//     -H 'Content-Type: application/json' \
//     -d '{"honourSlug":"cara","recipientName":"Antoin Commane","isSpecimen":true}' \
//     --output /tmp/patent.pdf
//   open /tmp/patent.pdf
//
// PARAMETERS (JSON body):
//
//   honourSlug      (required) 'cara' | 'ardchara' | 'onoir'
//   recipientName   (required) full name as it should appear on the patent
//   dateString      (optional) long-form date — defaults to 'this third
//                              day of May, in the year of Our Lord two
//                              thousand and twenty-six'
//   isSpecimen      (optional) boolean — if true, render the diagonal
//                              SPECIMEN watermark. Defaults to false.
//
// SAFETY:
//   - No authentication. Anyone hitting this URL gets a generated PDF
//     back — same risk profile as test-send-lifecycle-email. The PDF
//     they get bears whatever name they requested, and is marked
//     SPECIMEN by default in this test endpoint to make accidental
//     screenshots-as-real-patents impossible.
//
//   - DB has no record of the generation. This endpoint never writes
//     to members.patent_urls; it only invokes the pure renderer.
//
// RESPONSE:
//   On success: PDF bytes with Content-Type: application/pdf
//   On failure: 500 with JSON { error, message, stack } so we can
//               diagnose Lambda-specific failures (missing fonts,
//               missing PNG assets, font-rendering crashes, etc).

const { generatePatent } = require('./lib/generate-patent');

console.log('[test-generate-patent] module load start');

exports.handler = async (event) => {
  console.log('[test-generate-patent] handler invoked');

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'method_not_allowed', message: 'POST only' }),
    };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid_json', message: 'Body is not valid JSON' }),
    };
  }

  const honourSlug = body.honourSlug;
  const recipientName = body.recipientName;
  const dateString = body.dateString || 'this third day of May, in the year of Our Lord two thousand and twenty-six';
  // Default isSpecimen to true on this test endpoint as a safety
  // measure — accidentally generated test patents should be visibly
  // marked. If a caller specifically passes false they get an
  // unmarked PDF (useful for sanity-checking the conferred-patent
  // visual), but the explicit opt-out is the protection.
  const isSpecimen = body.isSpecimen === false ? false : true;

  if (!honourSlug || !['cara', 'ardchara', 'onoir'].includes(honourSlug)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'invalid_honourSlug',
        message: `honourSlug must be 'cara', 'ardchara', or 'onoir'; got ${JSON.stringify(honourSlug)}`,
      }),
    };
  }
  if (!recipientName || typeof recipientName !== 'string') {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'invalid_recipientName',
        message: 'recipientName is required and must be a string',
      }),
    };
  }

  try {
    console.log(`[test-generate-patent] generating ${honourSlug} for "${recipientName}", specimen=${isSpecimen}`);
    const pdfBytes = await generatePatent({
      honourSlug,
      recipientName,
      dateString,
      isSpecimen,
    });
    console.log(`[test-generate-patent] generated ${pdfBytes.length} bytes`);

    // Return PDF directly. base64 encode for Lambda binary response.
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="patent-${honourSlug}-test.pdf"`,
        'Cache-Control': 'no-store',
      },
      body: Buffer.from(pdfBytes).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('[test-generate-patent] generation failed:', err.message);
    console.error(err.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'generation_failed',
        message: err.message,
        stack: err.stack,
      }),
    };
  }
};
