import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withReplyContext } from './reply-context.js';

test('no reply leaves the text untouched', () => {
  assert.equal(withReplyContext('yes do it', undefined), 'yes do it');
});

test('swipe-reply prepends the quoted message text', () => {
  const out = withReplyContext('This message', { text: 'Shall I start with step 1?' });
  assert.match(out, /Shall I start with step 1\?/);
  assert.match(out, /This message$/);
});

test('quoted caption is used when the replied-to message has no text', () => {
  const out = withReplyContext('what is this', { caption: 'photo of the garage' });
  assert.match(out, /photo of the garage/);
});

test('a reply with no new text is not turned into a prompt by itself', () => {
  assert.equal(withReplyContext('   ', { text: 'quoted' }), '   ');
});

test('long quotes are clipped', () => {
  const out = withReplyContext('ok', { text: 'x'.repeat(5000) });
  assert.ok(out.length < 1200);
});
