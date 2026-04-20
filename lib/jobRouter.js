const express = require('express');

function createJobRouter(options = {}) {
  const router = express.Router();

  router.get('/', function(req, res) {
    res.json({ service: 'jobs', status: 'running' });
  });

  return router;
}

module.exports = createJobRouter;
