import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestFromTool } from './jellyfin.js';

test('structured jellyfin fields become a request', () => {
  assert.deepEqual(requestFromTool({ intent: 'recommend', genres: ['Comedy', ' '], item_type: 'Series' }), {
    intent: 'recommend', searchTerm: null, genres: ['Comedy'], itemType: 'Series',
  });
  assert.deepEqual(requestFromTool({ intent: 'search', search_term: ' Dune ', item_type: 'Movie' }), {
    intent: 'search', searchTerm: 'Dune', genres: [], itemType: 'Movie',
  });
});

test('no usable intent means the classifier decides', () => {
  assert.equal(requestFromTool({ query: 'something' }), null);
  assert.equal(requestFromTool({ intent: 'play' }), null);
  assert.equal(requestFromTool({ intent: 'search' }), null);
});

test('unknown item types are dropped, a genre-only search is kept', () => {
  assert.equal(requestFromTool({ intent: 'recent', item_type: 'Music' }).itemType, null);
  assert.deepEqual(requestFromTool({ intent: 'search', genres: ['Horror'] }).genres, ['Horror']);
});
