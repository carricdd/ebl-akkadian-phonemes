import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeDetailed, explain } from '../dist/index.js';

test('unsupported dialect options cannot silently produce an unchanged reading', async () => {
  for (const dialect of ['OB', 'OA', 'SB', 'NA', 'NB']) {
    await assert.rejects(synthesizeDetailed('šarru', { dialect }), /not implemented/);
    assert.throws(() => explain('šarru', { dialect }), /not implemented/);
  }
});
