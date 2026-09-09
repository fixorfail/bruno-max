const express = require('express');
const router = express.Router();

/**
 * A resource that only becomes ready once it has been asked for.
 *
 * `GET /api/settle/:key?after=2` answers `{ state: 'pending' }` for the first two requests against
 * that key and `{ state: 'settled' }` from the third on, so a polling client reaches a terminal
 * state after a known number of attempts rather than after a length of wall-clock time — which is
 * what lets a poll be asserted on without a timing assumption.
 *
 * The counter is keyed on a path segment so concurrent callers stay independent: each picks a key of
 * its own and reads a count nothing else has advanced.
 */
const attempts = new Map();

const MAX_PENDING = 100;

router.get('/:key', (req, res) => {
  const after = Math.min(Math.max(parseInt(req.query.after, 10) || 1, 0), MAX_PENDING);
  const attempt = (attempts.get(req.params.key) || 0) + 1;
  attempts.set(req.params.key, attempt);

  return res.json({
    key: req.params.key,
    attempt,
    state: attempt > after ? 'settled' : 'pending'
  });
});

module.exports = router;
