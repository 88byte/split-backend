'use strict';

var express    = require('express');
var cors       = require('cors');
var Stripe     = require('stripe');
var supabaseJs = require('@supabase/supabase-js');

var app      = express();
var stripe   = Stripe(process.env.STRIPE_SECRET_KEY);
var supabase = supabaseJs.createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

var FRONTEND_URL = process.env.FRONTEND_URL || 'https://split.games';

var PRICES = {
  standard: 'price_1TGCcV6Y0qc5ka7CjDbqDglm',
  origin:   'price_1TGCdK6Y0qc5ka7CpAGoWJ2q',
};

app.use('/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors());

// Health check
app.get('/', function(req, res) {
  res.json({ status: 'Split backend running' });
});

// Track page view
app.post('/track-view', function(req, res) {
  supabase.from('page_views').insert({
    session_id: req.body.session_id,
    referrer:   req.body.referrer,
  }).then(function() { res.json({ ok: true }); })
  .catch(function() { res.json({ ok: false }); });
});

// Register username only
app.post('/register-user', function(req, res) {
  var username = String(req.body.username || '').slice(0, 12);
  if(!username) return res.json({ ok: false });
  supabase.from('users').upsert(
    { username: username },
    { onConflict: 'username', ignoreDuplicates: true }
  ).then(function() { res.json({ ok: true }); })
  .catch(function() { res.json({ ok: false }); });
});

// Check if username is available (allow current user to keep theirs)
app.post('/check-username', function(req, res) {
  var username = String(req.body.username || '').slice(0, 12).trim();
  var current  = String(req.body.current  || '').slice(0, 12).trim();
  if(!username) return res.json({ available: false });
  // Same as current = always available
  if(username.toLowerCase() === current.toLowerCase()) return res.json({ available: true });
  supabase.from('users')
    .select('username')
    .ilike('username', username)
    .limit(1)
    .maybeSingle()
    .then(function(result) {
      res.json({ available: !result.data });
    })
    .catch(function() { res.json({ available: true }); }); // fail open
});

// Google Sign In - verify token, return paid status
app.post('/google-auth', function(req, res) {
  var token    = req.body.token;
  var username = String(req.body.username || '').slice(0, 12);
  if(!token) return res.status(400).json({ error: 'No token' });

  try {
    // Decode Google JWT (trusted since it comes from Google's library)
    var parts   = token.split('.');
    var payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    var email   = payload.email;
    var name    = (payload.given_name || payload.name || email.split('@')[0]).slice(0, 12);

    // Use Google name if no username yet
    if(!username) username = name;

    // Upsert user in Supabase
    supabase.from('users').upsert(
      { username: username, email: email },
      { onConflict: 'username' }
    ).then(function() {
      // Check purchase by email
      return supabase.from('purchases')
        .select('tier')
        .eq('email', email)
        .eq('status', 'complete')
        .limit(1)
        .maybeSingle();
    }).then(function(result) {
      var paid = !!(result.data);
      var tier = result.data ? result.data.tier : null;
      // Get server-side game count
      return supabase.from('game_sessions')
        .select('*', { count: 'exact', head: true })
        .eq('username', username)
        .then(function(r) {
          res.json({
            ok:           true,
            paid:         paid,
            tier:         tier,
            games_played: r.count || 0,
            username:     username,
            email:        email,
          });
        });
    }).catch(function(e) {
      console.error('google-auth supabase error:', e);
      res.json({ ok: true, paid: false, tier: null, games_played: 0 });
    });

  } catch(e) {
    console.error('google-auth decode error:', e);
    res.status(400).json({ error: 'Invalid token' });
  }
});

// Track game played server-side
app.post('/track-game', function(req, res) {
  var username = String(req.body.username || 'Guest').slice(0, 12);
  supabase.from('game_sessions')
    .insert({ username: username, score: 0 })
    .then(function() { res.json({ ok: true }); })
    .catch(function() { res.json({ ok: false }); });
});

// Submit score
app.post('/submit-score', function(req, res) {
  var username    = String(req.body.username || 'Guest').slice(0, 12);
  var score       = parseInt(req.body.score) || 0;
  var run_time_ms = parseInt(req.body.run_time_ms) || 0;
  var level       = req.body.level || 'dark';

  supabase.from('scores').insert({ username, score, run_time_ms, level })
    .then(function() {
      return supabase.from('game_sessions')
        .insert({ username, score, run_time_ms, level });
    })
    .then(function() { res.json({ ok: true }); })
    .catch(function(e) {
      console.error('submit-score error:', e);
      res.status(500).json({ error: 'Server error' });
    });
});

// Leaderboard
app.get('/leaderboard', function(req, res) {
  supabase.from('leaderboard')
    .select('username, score, run_time_ms, level, created_at')
    .order('score', { ascending: false })
    .limit(20)
    .then(function(result) {
      if(result.error) throw result.error;
      res.json({ leaderboard: result.data });
    })
    .catch(function(e) {
      console.error('leaderboard error:', e);
      res.status(500).json({ error: 'Server error' });
    });
});

// Player rank
app.get('/rank/:username', function(req, res) {
  supabase.from('leaderboard')
    .select('score')
    .eq('username', req.params.username)
    .single()
    .then(function(result) {
      if(!result.data) return res.json({ rank: null });
      return supabase.from('leaderboard')
        .select('*', { count: 'exact', head: true })
        .gt('score', result.data.score)
        .then(function(r) {
          res.json({ rank: (r.count || 0) + 1, score: result.data.score });
        });
    })
    .catch(function() { res.status(500).json({ error: 'Server error' }); });
});

// Stripe checkout
app.post('/create-checkout-session', function(req, res) {
  var tier     = req.body.tier;
  var username = req.body.username || 'Guest';
  var email    = req.body.email || undefined;
  if(!PRICES[tier]) return res.status(400).json({ error: 'Invalid tier' });

  stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{ price: PRICES[tier], quantity: 1 }],
    mode: 'payment',
    success_url: FRONTEND_URL + '?payment=success&tier=' + tier,
    cancel_url:  FRONTEND_URL + '?payment=cancelled',
    metadata: { tier, username },
    customer_email: email,
    billing_address_collection: 'auto',
    allow_promotion_codes: true,
  }).then(function(session) {
    res.json({ url: session.url });
  }).catch(function(e) {
    console.error('checkout error:', e);
    res.status(500).json({ error: 'Could not create checkout session' });
  });
});

// Stripe webhook
app.post('/stripe-webhook', function(req, res) {
  var sig = req.headers['stripe-signature'];
  var event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch(e) {
    console.error('Webhook signature failed:', e.message);
    return res.status(400).send('Webhook Error: ' + e.message);
  }

  if(event.type === 'checkout.session.completed') {
    var session  = event.data.object;
    var tier     = session.metadata.tier;
    var username = session.metadata.username;
    var email    = session.customer_details ? session.customer_details.email : null;

    supabase.from('purchases').insert({
      username, email,
      stripe_session_id: session.id,
      stripe_payment_id: session.payment_intent,
      tier,
      amount_cents: session.amount_total,
      currency:     session.currency,
      status:       'complete',
    }).then(function() {
      return supabase.from('users').upsert(
        { username, email, tier },
        { onConflict: 'username' }
      );
    }).then(function() {
      console.log('Payment complete:', tier, username, email);
    }).catch(function(e) {
      console.error('Supabase insert error:', e);
    });
  }

  res.json({ received: true });
});

// Admin stats
app.get('/admin/stats', function(req, res) {
  if(req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  supabase.from('admin_stats').select('*').single()
    .then(function(statsResult) {
      return supabase.from('purchases')
        .select('username, email, tier, amount_cents, created_at')
        .eq('status', 'complete')
        .order('created_at', { ascending: false })
        .limit(50)
        .then(function(purchResult) {
          res.json({
            stats: statsResult.data,
            recent_purchases: purchResult.data,
          });
        });
    })
    .catch(function(e) {
      console.error('admin stats error:', e);
      res.status(500).json({ error: 'Server error' });
    });
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log('Split backend running on port', PORT);
});
