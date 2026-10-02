import test from 'node:test';
import assert from 'node:assert/strict';
import { packageFilename, selectPostgresql18, ctfileLink, verifiedEntry } from '../scripts/postgresql18.mjs';

const platform = (arch = 'x86_64') => ({
  platformID: arch,
  location: `https://packages.example/PostgreSQL18_18.0.0_${arch}.qpkg`,
  signature: 'example-signature',
});
const app = (extra = {}) => ({ name: 'PostgreSQL 18', internalName: 'PostgreSQL18', version: '18.0.0', platform: [platform()], ...extra });
const config = item => ({ plugins: { cachechk: 'example', item } });
const expected = { productName: 'PostgreSQL 18', version: '18.0.0', architecture: 'x86_64', filename: 'PostgreSQL18_18.0.0_x86_64.qpkg' };

test('selects PostgreSQL 18 without synchronizing unrelated purchases', () => {
  const result = selectPostgresql18(config([app(), app({ name: 'PostgreSQL 17', internalName: 'PostgreSQL17' }), app({ name: 'Apache84', internalName: 'Apache84' })]));
  assert.equal(result.plugins.item.length, 1);
  assert.equal(result.plugins.item[0].name, 'PostgreSQL 18');
  assert.equal(result.plugins.cachechk, 'example');
});

test('normalizes singleton XML items and singleton platforms', () => {
  const result = selectPostgresql18(config(app({ platform: platform() })));
  assert.equal(result.plugins.item.length, 1);
  assert.equal(result.plugins.item[0].platform.length, 1);
});

test('supports PostgreSQL18 and postgres 18 aliases', () => {
  for (const name of ['PostgreSQL18', 'PostgreSQL 18', 'postgres 18', 'POSTGRES-18']) {
    assert.equal(selectPostgresql18(config(app({ name, internalName: '' }))).plugins.item.length, 1);
  }
});

test('retains every architecture in the purchased feed', () => {
  const result = selectPostgresql18(config(app({ platform: [platform('x86_64'), platform('arm_64'), platform('arm-x41')] })));
  assert.equal(result.plugins.item[0].platform.length, 3);
});

test('fails clearly when entitlement is absent', () => {
  for (const value of [null, {}, config([]), config(app({ name: 'PostgreSQL 17', internalName: 'PostgreSQL17' }))]) {
    assert.throws(() => selectPostgresql18(value), /absent from the authenticated QNAP feed/);
  }
});

test('does not confuse PostgreSQL 180 or extensions with PostgreSQL 18', () => {
  assert.throws(() => selectPostgresql18(config(app({ name: 'PostgreSQL 180', internalName: 'PostgreSQL18-extension' }))), /absent/);
});

test('rejects missing version and platform metadata', () => {
  for (const extra of [{ version: '' }, { platform: [] }, { platform: [{}] }]) {
    assert.throws(() => selectPostgresql18(config(app(extra))), /metadata/);
  }
});

test('rejects conflicting filenames across architectures', () => {
  assert.throws(() => selectPostgresql18(config(app({ platform: [platform(), { ...platform(), platformID: 'arm_64' }] }))), /Conflicting package filename/);
});

test('extracts the QPKG filename without signed URL parameters', () => {
  assert.equal(packageFilename('https://packages.example/PostgreSQL18_18.0.0_x86_64.qpkg?token=private'), expected.filename);
});

test('rejects unsafe download URLs and paths', () => {
  for (const url of ['http://packages.example/a.qpkg', 'file:///tmp/a.qpkg', 'https://user:pass@packages.example/a.qpkg', 'https://packages.example/a.zip', 'https://packages.example/%2e%2e%2fa.qpkg']) {
    assert.throws(() => packageFilename(url));
  }
});

test('accepts only HTTPS CTFile file or folder links', () => {
  assert.equal(ctfileLink('https://url88.ctfile.com/f/example'), 'https://url88.ctfile.com/f/example');
  assert.equal(ctfileLink('/dir/d123'), 'https://url88.ctfile.com/dir/d123');
  for (const value of ['', undefined, 'https://ctfile.com.attacker.example/f/example', 'https://attacker.example/f/example', 'javascript:alert(1)', 'http://ctfile.com/f/example', 'https://user:pass@ctfile.com/f/example', 'https://ctfile.com/login']) {
    assert.equal(ctfileLink(value), undefined);
  }
});

test('requires remote filename and file ID confirmation', () => {
  for (const remote of [undefined, {}, { name: 'other.qpkg', key: 'f1' }, { name: expected.filename, icon: 'folder', key: 'd1' }, { name: expected.filename }]) {
    assert.throws(() => verifiedEntry(expected, remote, 'https://url88.ctfile.com/dir/d123'));
  }
});

test('prefers a canonical file link returned by CTFile', () => {
  const result = verifiedEntry(expected, { name: expected.filename, key: 'f123', url: 'https://url88.ctfile.com/f/123-example', size: 12345 }, 'https://url88.ctfile.com/dir/d456');
  assert.equal(result.linkType, 'file');
  assert.equal(result.ctfileUrl, 'https://url88.ctfile.com/f/123-example');
  assert.equal(result.fileId, 'f123');
});

test('labels folder-only links instead of inventing direct file links', () => {
  const result = verifiedEntry(expected, { name: expected.filename, key: 'f123' }, 'https://url88.ctfile.com/dir/d456');
  assert.equal(result.linkType, 'folder');
  assert.equal(result.ctfileUrl, 'https://url88.ctfile.com/dir/d456');
});

test('link reports omit source URLs, signatures and account credentials', () => {
  const result = verifiedEntry({ ...expected, downloadUrl: 'https://private.example/?token=secret', signature: 'private', session: 'private' }, { name: expected.filename, key: 'f123' }, 'https://url88.ctfile.com/dir/d456');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('private'));
  assert.ok(!serialized.includes('signature'));
  assert.ok(!serialized.includes('session'));
});
