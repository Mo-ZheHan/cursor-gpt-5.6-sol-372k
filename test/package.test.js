'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const manifest = require('../package.json');

test('ships only the standalone macOS patcher', () => {
  assert.equal(manifest.name, 'cursor-gpt-5.6-sol-372k');
  assert.equal(manifest.private, true);
  assert.equal(manifest.publisher, undefined);
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.activationEvents, undefined);
  assert.equal(manifest.enabledApiProposals, undefined);
  assert.equal(manifest.license, 'MIT');
  assert.deepEqual(manifest.repository, {
    type: 'git',
    url: 'git+https://github.com/Mo-ZheHan/cursor-gpt-5.6-sol-372k.git',
  });
  assert.equal(
    manifest.homepage,
    'https://github.com/Mo-ZheHan/cursor-gpt-5.6-sol-372k#readme',
  );
  assert.deepEqual(manifest.bugs, {
    url: 'https://github.com/Mo-ZheHan/cursor-gpt-5.6-sol-372k/issues',
  });
  assert.deepEqual(manifest.os, ['darwin']);
  assert.equal(manifest.engines.node, '>=20');
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.deepEqual(manifest.files, [
    'patch-cursor.js',
    'README.md',
    'CHANGELOG.md',
    'SECURITY.md',
    'LICENSE',
  ]);
});
