// server/index.js - simple webhook listener
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');

const APP_SECRET = process.env.GITHUB_APP_SECRET || '';
const PORT = process.env.PORT || 3000;

function verifySignature(req, res, buf) {
  const sig = req.headers['x-hub-signature-256'] || '';
  if (!APP_SECRET) return;
  const hmac = crypto.createHmac('sha256', APP_SECRET);
  hmac.update(buf);
  const digest = 'sha256=' + hmac.digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest))) {
    throw new Error('Invalid signature');
  }
}

const app = express();
app.use(bodyParser.json({ verify: verifySignature }));

app.post('/webhook', (req, res) => {
  const event = req.headers['x-github-event'];
  console.log(`Received event ${event}`);
  // print small summary to logs (do not log full secret data)
  console.log(JSON.stringify({ event, id: req.headers['x-github-delivery'] }));
  // For PRs, add simple behavior: log PR action
  if (event === 'pull_request') {
    const pr = req.body.pull_request;
    console.log(`PR ${pr.number} action=${req.body.action}, title=${pr.title}`);
  }
  res.status(200).send('ok');
});

app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`Webhook server listening on ${PORT}`);
});
