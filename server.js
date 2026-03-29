// =============================================
//  SPLIT GAME — RAILWAY BACKEND
//  Node.js / Express
//
//  Environment variables to set in Railway:
//    STRIPE_SECRET_KEY      = sk_live_…
//    STRIPE_WEBHOOK_SECRET  = whsec_…  (from Stripe dashboard > Webhooks)
//    SUPABASE_URL           = https://xxxx.supabase.co
//    SUPABASE_SERVICE_KEY   = your service role key (NOT anon key)
//    FRONTEND_URL           = https://split.game
//    PORT                   = 3000 (Railway sets this automatically)
// =============================================

‘use strict’;

var express    = require(‘express’);
var cors       = require(‘cors’);
var Stripe     = require(‘stripe’);
var { createClient } = require(’@supabase/supabase-js’);

var app    = express();
var stripe = Stripe(process.env.STRIPE_SECRET_KEY);
var supabase = createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_SERVICE_KEY
);

var FRONTEND_URL = process.env.FRONTEND_URL || ‘https://split.game’;

// Stripe price IDs — add yours from Stripe dashboard
// NOTE: You gave PRODUCT IDs (prod_xxx). Go to Stripe Dashboard > Products
// click each product > find the Price ID (price_xxx) and add it below
var PRICES = {
standard: ‘price_REPLACE_WITH_SPLIT_PASS_PRICE_ID’,   // $2.99 Split Pass
origin:   ‘price_REPLACE_WITH_ORIGIN_PASS_PRICE_ID’,  // $5.99 Origin Pass
};

// =============================================
//  MIDDLEWARE
// =============================================

// Raw body needed for Stripe webhook verification
app.use(’/stripe-webhook’, express.raw({ type: ‘application/json’ }));

// JSON for all other routes
app.use(express.json());

// CORS — allow split.game frontend
app.use(cors({
origin: [FRONTEND_URL, ‘http://localhost:3000’],
methods: [‘GET’, ‘POST’],
}));

// =============================================
//  HEALTH CHECK
// =============================================
app.get(’/’, function(req, res) {
res.json({ status: ‘Split backend running’ });
});

// =============================================
//  TRACK PAGE VIEW
// =============================================
app.post(’/track-view’, async function(req, res) {
try {
var { session_id, referrer } = req.body;
await supabase.from(‘page_views’).insert({ session_id, referrer });
res.json({ ok: true });
} catch(e) {
res.json({ ok: false });
}
});

// =============================================
//  SUBMIT SCORE
// =============================================
app.post(’/submit-score’, async function(req, res) {
try {
var { username, score, run_time_ms, level } = req.body;
if(!username || score == null) return res.status(400).json({ error: ‘Missing fields’ });

```
await supabase.from('scores').insert({
  username: String(username).slice(0, 12),
  score: parseInt(score),
  run_time_ms: parseInt(run_time_ms) || 0,
  level: level || 'dark',
});

// Also upsert to game_sessions
await supabase.from('game_sessions').insert({
  username: String(username).slice(0, 12),
  score: parseInt(score),
  run_time_ms: parseInt(run_time_ms) || 0,
  level: level || 'dark',
});

res.json({ ok: true });
```

} catch(e) {
console.error(‘submit-score error:’, e);
res.status(500).json({ error: ‘Server error’ });
}
});

// =============================================
//  LEADERBOARD
// =============================================
app.get(’/leaderboard’, async function(req, res) {
try {
// Top 20 scores (one per username)
var { data, error } = await supabase
.from(‘leaderboard’)
.select(‘username, score, run_time_ms, level, created_at’)
.order(‘score’, { ascending: false })
.limit(20);

```
if(error) throw error;
res.json({ leaderboard: data });
```

} catch(e) {
console.error(‘leaderboard error:’, e);
res.status(500).json({ error: ‘Server error’ });
}
});

// Get a user’s global rank
app.get(’/rank/:username’, async function(req, res) {
try {
var username = req.params.username;

```
// Get user's best score
var { data: userScore } = await supabase
  .from('leaderboard')
  .select('score')
  .eq('username', username)
  .single();

if(!userScore) return res.json({ rank: null });

// Count how many players have a higher score
var { count } = await supabase
  .from('leaderboard')
  .select('*', { count: 'exact', head: true })
  .gt('score', userScore.score);

res.json({ rank: (count || 0) + 1, score: userScore.score });
```

} catch(e) {
res.status(500).json({ error: ‘Server error’ });
}
});

// =============================================
//  CREATE STRIPE CHECKOUT SESSION
// =============================================
app.post(’/create-checkout-session’, async function(req, res) {
try {
var { tier, username } = req.body;
if(!PRICES[tier]) return res.status(400).json({ error: ‘Invalid tier’ });

```
var session = await stripe.checkout.sessions.create({
  payment_method_types: ['card'],
  line_items: [{
    price: PRICES[tier],
    quantity: 1,
  }],
  mode: 'payment',
  success_url: FRONTEND_URL + '?payment=success&tier=' + tier,
  cancel_url:  FRONTEND_URL + '?payment=cancelled',
  metadata: {
    tier: tier,
    username: username || 'Anonymous',
  },
  // Collect email for your records
  customer_email: undefined, // Stripe will ask for it at checkout
  billing_address_collection: 'auto',
});

res.json({ url: session.url });
```

} catch(e) {
console.error(‘checkout error:’, e);
res.status(500).json({ error: ‘Could not create checkout session’ });
}
});

// =============================================
//  STRIPE WEBHOOK
//  Verifies payment and stores in Supabase
// =============================================
app.post(’/stripe-webhook’, async function(req, res) {
var sig = req.headers[‘stripe-signature’];
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
var session = event.data.object;
var tier     = session.metadata.tier;
var username = session.metadata.username;
var email    = session.customer_details && session.customer_details.email;

```
try {
  // Store purchase in Supabase
  await supabase.from('purchases').insert({
    username:           username,
    email:              email,
    stripe_session_id:  session.id,
    stripe_payment_id:  session.payment_intent,
    tier:               tier,
    amount_cents:       session.amount_total,
    currency:           session.currency,
    status:             'complete',
  });

  // Upsert user record
  await supabase.from('users').upsert({
    username: username,
    email:    email,
    tier:     tier,
  }, { onConflict: 'username' });

  console.log('Payment complete:', tier, username, email);
} catch(e) {
  console.error('Supabase insert error:', e);
}
```

}

res.json({ received: true });
});

// =============================================
//  ADMIN STATS (password protected)
// =============================================
app.get(’/admin/stats’, async function(req, res) {
var auth = req.headers[‘x-admin-key’];
if(auth !== process.env.ADMIN_KEY) {
return res.status(401).json({ error: ‘Unauthorized’ });
}

try {
var { data: stats } = await supabase.from(‘admin_stats’).select(’*’).single();
var { data: recent } = await supabase
.from(‘purchases’)
.select(‘username, email, tier, amount_cents, created_at’)
.eq(‘status’, ‘complete’)
.order(‘created_at’, { ascending: false })
.limit(50);

```
res.json({ stats, recent_purchases: recent });
```

} catch(e) {
res.status(500).json({ error: ‘Server error’ });
}
});

// =============================================
//  START SERVER
// =============================================
var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
console.log(‘Split backend running on port’, PORT);
});
