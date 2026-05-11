const crypto = require('crypto');

// Tag every request with a short ID so a 500 logged by the error handler
// can be cross-referenced with the response a user reported. nginx will
// pass an inbound X-Request-Id through if the client sent one (useful when
// chasing a request from browser devtools); otherwise we mint our own.
function requestId(req, res, next) {
  const inbound = req.headers['x-request-id'];
  const id = (typeof inbound === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(inbound))
    ? inbound
    : crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = { requestId };
