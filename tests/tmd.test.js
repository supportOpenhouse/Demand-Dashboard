// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDocuments, forRole, shapeDeviation } = require('../api/_tmd');
const { stripStaffOnlyColumns } = require('../api/_db');

test('checklist: Yes without a file is listed by name, no link', () => {
  const docs = buildDocuments({ propDocs: { bba: { status: 'Yes', url: '' } } });
  assert.deepEqual(docs, [{ name: 'Builder Buyer Agreement', url: null, source: 'checklist' }]);
});

test('checklist: No / NA / blank without a file are dropped; a file alone is kept', () => {
  const docs = buildDocuments({ propDocs: JSON.stringify({
    gpa: { status: 'No', url: '' },
    mutation: { status: 'NA', url: '' },
    noc: { status: '', url: '' },
    allotment_letter: { status: '', url: 'https://x/allot.pdf' },
  }) });
  assert.deepEqual(docs.map(d => d.name), ['Allotment Letter']);
  assert.equal(docs[0].url, 'https://x/allot.pdf');
});

test('checklist keeps TMD order regardless of key order', () => {
  const docs = buildDocuments({ propDocs: {
    mutation: { status: 'Yes' }, allotment_letter: { status: 'yes' }, conveyance_deed: { status: 'YES' },
  } });
  assert.deepEqual(docs.map(d => d.name),
    ['Allotment Letter', 'Conveyance/Sub Lease/Sale Deed', 'Mutation']);
});

test('seller app: a replaced document shows only its newest file', () => {
  const docs = buildDocuments({ sellerApp: [
    { document_name: 'Builder Buyer Agreement', url: 'https://x/old.pdf', first_seen_at: '2026-10-01T00:00:00Z' },
    { document_name: 'Builder Buyer Agreement', url: 'https://x/new.pdf', first_seen_at: '2026-11-01T00:00:00Z' },
  ] });
  assert.deepEqual(docs, [{ name: 'Builder Buyer Agreement', url: 'https://x/new.pdf', source: 'seller_app' }]);
});

test('seller app named documents come before its additional ones', () => {
  const docs = buildDocuments({ sellerApp: [
    { document_name: 'Additional Document 1', url: 'https://x/a1', first_seen_at: '2026-10-01' },
    { document_name: 'Allotment Letter issued by the Builder', url: 'https://x/al', first_seen_at: '2026-10-02' },
  ] });
  assert.deepEqual(docs.map(d => d.name), ['Allotment Letter issued by the Builder', 'Additional Document 1']);
});

test('a file both in the Seller App and uploaded in TMD is listed once', () => {
  const docs = buildDocuments({
    sellerApp: [{ document_name: 'Additional Document 1', url: 'https://x/same.pdf', first_seen_at: '2026-10-01' }],
    crm: [{ filename: 'same.pdf', url: 'https://x/same.pdf', created_at: '2026-09-30' },
          { filename: 'noc.pdf', url: 'https://x/noc.pdf', created_at: '2026-09-29' }],
  });
  assert.deepEqual(docs.map(d => d.url), ['https://x/same.pdf', 'https://x/noc.pdf']);
  assert.equal(docs[1].source, 'crm');
});

test('a checklist entry without a file gives way to the same document in the Seller App', () => {
  const docs = buildDocuments({
    propDocs: {
      allotment_letter: { status: 'Yes', url: '' },
      bba: { status: 'Yes', url: '' },
      conveyance_deed: { status: 'Yes', url: '' },
      noc: { status: 'Yes', url: '' },
      possession_letter: { status: 'Yes', url: 'https://x/pl-from-checklist' },
    },
    sellerApp: [
      { document_name: 'Allotment Letter issued by the Builder', url: 'https://x/al', first_seen_at: '2026-10-01' },
      { document_name: 'Builder Buyer Agreement', url: 'https://x/bba', first_seen_at: '2026-10-01' },
      { document_name: 'Conveyance Deed/Sale Deed/Registry', url: 'https://x/cd', first_seen_at: '2026-10-01' },
      { document_name: 'Possession Letter/Certificate by the Builder', url: 'https://x/pl', first_seen_at: '2026-10-01' },
    ],
  });
  assert.deepEqual(docs.map(d => d.name), [
    'Possession Letter',  // has its own file, so it stays
    'NOC',                // nothing in the Seller App covers it
    'Allotment Letter issued by the Builder',
    'Builder Buyer Agreement',
    'Possession Letter/Certificate by the Builder',
    'Conveyance Deed/Sale Deed/Registry',
  ]);
});

test('empty / missing inputs give an empty list', () => {
  assert.deepEqual(buildDocuments({}), []);
  assert.deepEqual(buildDocuments({ propDocs: 'not json', sellerApp: null, crm: undefined }), []);
});

test('viewers get names only; managers and admins keep links', () => {
  const docs = [{ name: 'BBA', url: 'https://x/b', source: 'seller_app' }];
  assert.deepEqual(forRole(docs, 'viewer'), [{ name: 'BBA', source: 'seller_app' }]);
  assert.deepEqual(forRole(docs, 'manager'), docs);
  assert.deepEqual(forRole(docs, 'admin'), docs);
  assert.ok(!('url' in forRole(docs, undefined)[0]), 'unknown role is treated as viewer');
});

test('deviation shows only when it is on and has wording', () => {
  assert.equal(shapeDeviation(null), null);
  assert.equal(shapeDeviation({ has_deviation: false, text: 'Possession letter in 15 days' }), null);
  assert.equal(shapeDeviation({ has_deviation: true, text: '   ' }), null);
  assert.deepEqual(
    shapeDeviation({ has_deviation: true, text: ' NOC within 30 days ', resolved_at: null }),
    { text: 'NOC within 30 days', resolved_at: null });
});

test('deposit split is stripped for viewers only', () => {
  const row = () => ({ total_deposit: 1, performance_guarantee: 1, refundable_deposit: 0, uid: 'X' });
  const v = stripStaffOnlyColumns(row(), { role: 'viewer' });
  assert.deepEqual(v, { uid: 'X' });
  assert.equal(stripStaffOnlyColumns(row(), { role: 'manager' }).refundable_deposit, 0);
  assert.equal(stripStaffOnlyColumns(row(), { role: 'admin' }).total_deposit, 1);
});
