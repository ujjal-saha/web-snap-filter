const test = require('node:test');
const assert = require('node:assert/strict');

const { canAcceptUpload, markSessionFinalized } = require('./server');

test('uploads are rejected while a session is finalized or actively merging', () => {
  const sessionId = 'abc12345';
  const state = new Map();

  assert.equal(canAcceptUpload(sessionId, state), true);
  markSessionFinalized(sessionId, state);
  assert.equal(canAcceptUpload(sessionId, state), false);
});
