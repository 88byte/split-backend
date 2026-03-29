‘use strict’;

var express    = require(‘express’);
var cors       = require(‘cors’);
var Stripe     = require(‘stripe’);
var supabaseJs = require(’@supabase/supabase-js’);

var app      = express();
var stripe   = Stripe(process.env.STRIPE_SECRET_KEY);
var supabase = supabaseJs.createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_SERVICE_KEY
);

var FRONTEND_URL = process.env.FRONTEND_URL || ‘https://split.game’;

// Replace with your actual price_xxx IDs from Stripe Dashboard
// Go to: Products > click product > copy the price_xxx ID under Pricing
var PRICES = {
standard: ‘price_1TGCcV6Y0qc5ka7CjDbqDglm’,
origin:   ’price_1TGCdK6Y0qc5ka7CpAGoWJ2q’,
};

// Raw body for Stripe webhook - must be before express.json()
app.use(’/stripe-webhook’, express.raw({ type: ‘application/json’ }));
app.use(express.json());
app.use(cors({
origin: [FRONTEND_URL, ‘http://localhost:3000’],
methods: [‘GET’, ‘POST’],
}));

// Health check
app.get(’/’, function(req, res) {
res.json({ status: ‘Split backend running’ });
});

// Track page view
app.post(’/track-view’, function(req, res) {
supabase.from(‘page_views’).insert({
session_id: req.body.session_id,
referrer:   req.body.referrer,
}).then(function() {
res.json({ ok: true });
}).catch(function() {
res.json({ ok: false });
});
});

// Submit score
app.post(’/submit-score’, function(req, res) {
var username    = String(req.body.username || ‘Anonymous’).slice(0, 12);
var score       = parseInt(req.body.score) || 0;
var run_time_ms = parseInt(req.body.run_time_ms) || 0;
var level       = req.body.level || ‘dark’;

supabase.from(‘scores’).insert({
username:    username,
score:       score,
run_time_ms: run_time_ms,
level:       level,
}).then(function() {
return supabase.from(‘game_sessions’).insert({
username:    username,
score:       score,
run_time_ms: run_time_ms,
level:       level,
});
}).then(function() {
res.json({ ok: true });
}).catch(function(e) {
console.error(‘submit-score error:’, e);
res.status(500).json({ error: ‘Server error’ });
});
});

// Leaderboard top 20
app.get(’/leaderboard’, function(req, res) {
supabase
.from(‘leaderboard’)
.select(‘username, score, run_time_ms, level, created_at’)
.order(‘score’, { ascending: false })
.limit(20)
.then(function(result) {
if(result.error) throw result.error;
res.json({ leaderboard: result.data });
})
.catch(function(e) {
console.error(‘leaderboard error:’, e);
res.status(500).json({ error: ‘Server error’ });
});
});

// Player rank
app.get(’/rank/:username’, function(req, res) {
var username = req.params.username;
supabase
.from(‘leaderboard’)
.select(‘score’)
.eq(‘username’, username)
.single()
.then(function(result) {
if(!result.data) return res.json({ rank: null });
var userScore = result.data.score;
return supabase
.from(‘leaderboard’)
.select(’*’, { count: ‘exact’, head: true })
.gt(‘score’, userScore)
.then(function(r) {
res.json({ rank: (r.count || 0) + 1, score: userScore });
});
})
.catch(function(e) {
res.status(500).json({ error: ‘Server error’ });
});
});

// Create Stripe checkout session
app.post(’/create-checkout-session’, function(req, res) {
var tier     = req.body.tier;
var username = req.body.username || ‘Anonymous’;

if(!PRICES[tier]) {
return res.status(400).json({ error: ‘Invalid tier’ });
}

stripe.checkout.sessions.create({
payment_method_types: [‘card’],
line_items: [{ price: PRICES[tier], quantity: 1 }],
mode: ‘payment’,
success_url: FRONTEND_URL + ‘?payment=success&tier=’ + tier,
cancel_url:  FRONTEND_URL + ‘?payment=cancelled’,
metadata: { tier: tier, username: username },
billing_address_collection: ‘auto’,
}).then(function(session) {
res.json({ url: session.url });
}).catch(function(e) {
console.error(‘checkout error:’, e);
res.status(500).json({ error: ‘Could not create checkout session’ });
});
});

// Stripe webhook
app.post(’/stripe-webhook’, function(req, res) {
var sig   = req.headers[‘stripe-signature’];
var event;

try {
event = stripe.webhooks.constructEvent(
req.body,
sig,
process.env.STRIPE_WEBHOOK_SECRET
);
} catch(e) {
console.error(‘Webhook signature failed:’, e.message);
return res.status(400).send(’Webhook Error: ’ + e.message);
}

if(event.type === ‘checkout.session.completed’) {
var session  = event.data.object;
var tier     = session.metadata.tier;
var username = session.metadata.username;
var email    = session.customer_details ? session.customer_details.email : null;

```
supabase.from('purchases').insert({
  username:          username,
  email:             email,
  stripe_session_id: session.id,
  stripe_payment_id: session.payment_intent,
  tier:              tier,
  amount_cents:      session.amount_total,
  currency:          session.currency,
  status:            'complete',
}).then(function() {
  return supabase.from('users').upsert({
    username: username,
    email:    email,
    tier:     tier,
  }, { onConflict: 'username' });
}).then(function() {
  console.log('Payment complete:', tier, username, email);
}).catch(function(e) {
  console.error('Supabase insert error:', e);
});
```

}

res.json({ received: true });
});

// Admin stats
app.get(’/admin/stats’, function(req, res) {
var auth = req.headers[‘x-admin-key’];
if(auth !== process.env.ADMIN_KEY) {
return res.status(401).json({ error: ‘Unauthorized’ });
}

supabase.from(‘admin_stats’).select(’*’).single()
.then(function(statsResult) {
return supabase
.from(‘purchases’)
.select(‘username, email, tier, amount_cents, created_at’)
.eq(‘status’, ‘complete’)
.order(‘created_at’, { ascending: false })
.limit(50)
.then(function(purchResult) {
res.json({
stats: statsResult.data,
recent_purchases: purchResult.data,
});
});
})
.catch(function(e) {
console.error(‘admin stats error:’, e);
res.status(500).json({ error: ‘Server error’ });
});
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
console.log(‘Split backend running on port’, PORT);
});
