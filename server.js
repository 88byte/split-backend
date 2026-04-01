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
  if(username.toLowerCase() === current.toLowerCase()) return res.json({ available: true });
  supabase.from('users')
    .select('username')
    .ilike('username', username)
    .limit(1)
    .maybeSingle()
    .then(function(result) {
      res.json({ available: !result.data });
    })
    .catch(function() { res.json({ available: true }); });
});

// Update username — rename the existing user record
app.post('/update-username', function(req, res) {
  var oldUsername = String(req.body.old_username || '').slice(0, 12).trim();
  var newUsername = String(req.body.new_username || '').slice(0, 12).trim();
  var email       = String(req.body.email || '');

  // Hard guards — never allow empty, domain-like, or same values
  if(!oldUsername || !newUsername) return res.json({ ok: false, error: 'Missing fields' });
  if(oldUsername === newUsername) return res.json({ ok: true }); // no-op
  if(newUsername.indexOf('.') > -1) return res.json({ ok: false, error: 'Invalid username' });
  if(newUsername.length < 2) return res.json({ ok: false, error: 'Too short' });

  // Update user record by email (most reliable identifier)
  var query = email
    ? supabase.from('users').update({ username: newUsername }).eq('email', email)
    : supabase.from('users').update({ username: newUsername }).eq('username', oldUsername);

  query.then(function() {
    return supabase.from('scores').update({ username: newUsername }).eq('username', oldUsername);
  }).then(function() {
    return supabase.from('game_sessions').update({ username: newUsername }).eq('username', oldUsername);
  }).then(function() {
    res.json({ ok: true });
  }).catch(function(e) {
    console.error('update-username error:', e);
    res.json({ ok: false, error: 'Server error' });
  });
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

    // First try to find existing user by email
    supabase.from('users').select('username').eq('email', email).maybeSingle()
    .then(function(existing) {
      if(existing.data) {
        // User exists — update username if changed
        return supabase.from('users').update({ username: username }).eq('email', email);
      } else {
        // New user — insert
        return supabase.from('users').insert({ username: username, email: email });
      }
    }).then(function() {
      // Check purchase by email OR username (handles cases where email was null on insert)
      return supabase.from('purchases')
        .select('tier')
        .eq('status', 'complete')
        .or('email.eq.' + email + ',username.eq.' + username)
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
  var username = req.params.username;
  // Get this user's best score from scores table directly
  supabase.from('scores')
    .select('score')
    .eq('username', username)
    .order('score', { ascending: false })
    .limit(1)
    .maybeSingle()
    .then(function(result) {
      if(!result.data) return res.json({ rank: null });
      var best = result.data.score;
      // Count distinct usernames who have a best score strictly higher
      return supabase.rpc('count_players_above', { target_score: best })
        .then(function(r) {
          // Fallback if RPC not available
          res.json({ rank: (r.data || 0) + 1, score: best });
        })
        .catch(function() {
          // Simple fallback - count from leaderboard view
          return supabase.from('leaderboard')
            .select('*', { count: 'exact', head: true })
            .gt('score', best)
            .neq('username', username)
            .then(function(r2) {
              res.json({ rank: (r2.count || 0) + 1, score: best });
            });
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

// Confirm purchase after Stripe redirect — updates user tier even if webhook was missed
app.post('/confirm-purchase', function(req, res) {
  var username = String(req.body.username || '').slice(0, 12);
  var tier     = req.body.tier;
  var email    = String(req.body.email || '');
  if(!username || !tier) return res.json({ ok: false });

  // Update user tier
  var userUpdate = email
    ? supabase.from('users').update({ tier: tier }).eq('email', email)
    : supabase.from('users').update({ tier: tier }).eq('username', username);

  userUpdate.then(function() {
    // Check if purchase already exists by email or username
    return supabase.from('purchases')
      .select('id')
      .eq('status', 'complete')
      .or((email ? 'email.eq.' + email + ',' : '') + 'username.eq.' + username)
      .limit(1)
      .maybeSingle();
  }).then(function(existing) {
    if(existing.data) return Promise.resolve(); // already recorded
    return supabase.from('purchases').insert({
      username:          username,
      email:             email || null,
      tier:              tier,
      status:            'complete',
      amount_cents:      tier === 'origin' ? 799 : 299,
      currency:          'usd',
      stripe_session_id: 'manual_' + username + '_' + Date.now(),
    });
  }).then(function() {
    res.json({ ok: true });
  }).catch(function(e) {
    console.error('confirm-purchase error:', e);
    res.json({ ok: false });
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
    var tier     = session.metadata ? session.metadata.tier : null;
    var username = session.metadata ? session.metadata.username : 'Guest';
    var email    = session.customer_details ? session.customer_details.email : null;
    var amountCents = session.amount_total || 0;
    var paymentId   = session.payment_intent || session.id; // free orders have no payment_intent

    // Check if already recorded (idempotency — Stripe may retry)
    supabase.from('purchases')
      .select('id')
      .eq('stripe_session_id', session.id)
      .maybeSingle()
      .then(function(existing) {
        if(existing.data) {
          console.log('Webhook already processed:', session.id);
          return Promise.resolve();
        }
        return supabase.from('purchases').insert({
          username:          username,
          email:             email,
          stripe_session_id: session.id,
          stripe_payment_id: paymentId,
          tier:              tier,
          amount_cents:      amountCents,
          currency:          session.currency || 'usd',
          status:            'complete',
        }).then(function() {
          return supabase.from('users').upsert(
            { username: username, email: email, tier: tier },
            { onConflict: 'username' }
          );
        }).then(function() {
          console.log('Payment recorded:', tier, username, email, amountCents);
        });
      })
      .catch(function(e) {
        console.error('Supabase webhook error:', e);
      });
  }

  res.json({ received: true });
});

// Admin stats — expanded
app.get('/admin/stats', function(req, res) {
  if(req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  var todayISO = todayStart.toISOString();

  // Run all queries in parallel
  Promise.all([
    // Aggregate stats view
    supabase.from('admin_stats').select('*').single(),
    // All purchases (for revenue page + recent feed)
    supabase.from('purchases')
      .select('username, email, tier, amount_cents, created_at')
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
      .limit(100),
    // Leaderboard top 50
    supabase.from('leaderboard')
      .select('username, score, level, created_at')
      .order('score', { ascending: false })
      .limit(50),
    // Recent game sessions
    supabase.from('game_sessions')
      .select('username, score, level, created_at')
      .order('created_at', { ascending: false })
      .limit(50),
    // Revenue by day — last 14 days
    supabase.from('purchases')
      .select('amount_cents, created_at')
      .eq('status', 'complete')
      .gte('created_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()),
    // Today counts
    supabase.from('game_sessions')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', todayISO),
    supabase.from('users')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', todayISO),
    supabase.from('purchases')
      .select('amount_cents')
      .eq('status', 'complete')
      .gte('created_at', todayISO),
    // All players for admin lookup
    supabase.from('users')
      .select('username, email, tier, created_at')
      .order('created_at', { ascending: false })
      .limit(500),
    // All session usernames for funnel calculation
    supabase.from('game_sessions')
      .select('username')
      .limit(5000),
  ])
  .then(function(results) {
    var statsData       = results[0].data;
    var allPurchases    = results[1].data || [];
    var leaderboard     = results[2].data || [];
    var recentSessions  = results[3].data || [];
    var recentPurch14d  = results[4].data || [];
    var gamesToday      = results[5].count || 0;
    var usersToday      = results[6].count || 0;
    var purchToday      = results[7].data || [];
    var allPlayers      = results[8].data || [];
    var allSessionRows  = results[9].data || [];

    // Build revenue by day (last 14)
    var dayMap = {};
    for(var i = 13; i >= 0; i--) {
      var d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      var key = d.toISOString().slice(0, 10);
      dayMap[key] = 0;
    }
    recentPurch14d.forEach(function(p) {
      var day = (p.created_at || '').slice(0, 10);
      if(dayMap[day] !== undefined) dayMap[day] += (p.amount_cents || 0);
    });
    var revenueByDay = Object.keys(dayMap).map(function(day) {
      return { day: day, amount_cents: dayMap[day] };
    });

    var revToday = purchToday.reduce(function(sum, p) { return sum + (p.amount_cents || 0); }, 0);

    // Build funnel: count distinct users by session count
    var sessionCounts = {};
    allSessionRows.forEach(function(s) {
      if(s.username) sessionCounts[s.username] = (sessionCounts[s.username] || 0) + 1;
    });
    var paywallHits = Object.keys(sessionCounts).filter(function(u) { return sessionCounts[u] >= 7; }).length;
    var paidUsernames = new Set(allPurchases.map(function(p) { return p.username; }));
    var atRiskCount = Object.keys(sessionCounts).filter(function(u) { return sessionCounts[u] >= 5 && !paidUsernames.has(u); }).length;

    res.json({
      stats:           statsData,
      recent_purchases: allPurchases.slice(0, 50),
      all_purchases:    allPurchases,
      leaderboard:      leaderboard,
      recent_sessions:  recentSessions,
      revenue_by_day:   revenueByDay,
      players:          allPlayers,
      today: {
        games:         gamesToday,
        new_players:   usersToday,
        revenue_cents: revToday,
        purchases:     purchToday.length,
      },
      funnel: {
        visits:       statsData ? (statsData.total_page_views || 0) : 0,
        paywall_hits: paywallHits,
        paid:         statsData ? (statsData.total_purchases || 0) : 0,
        at_risk:      atRiskCount,
      },
    });
  })
  .catch(function(e) {
    console.error('admin stats error:', e);
    res.status(500).json({ error: 'Server error' });
  });
});

// Admin — full user list with game counts
app.get('/admin/users', function(req, res) {
  if(req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  supabase.from('users')
    .select('username, email, tier, created_at')
    .order('created_at', { ascending: false })
    .limit(500)
    .then(function(result) {
      res.json({ users: result.data || [] });
    })
    .catch(function(e) {
      console.error('admin users error:', e);
      res.status(500).json({ error: 'Server error' });
    });
});

// Admin — single player deep dive
app.get('/admin/user/:username', function(req, res) {
  if(req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  var username = req.params.username;
  Promise.all([
    supabase.from('users').select('*').eq('username', username).maybeSingle(),
    supabase.from('scores').select('score, level, created_at').eq('username', username).order('score', { ascending: false }).limit(10),
    supabase.from('game_sessions').select('*', { count: 'exact', head: true }).eq('username', username),
    supabase.from('purchases').select('tier, amount_cents, created_at').eq('username', username).eq('status', 'complete').maybeSingle(),
  ])
  .then(function(results) {
    res.json({
      user:         results[0].data,
      top_scores:   results[1].data || [],
      games_played: results[2].count || 0,
      purchase:     results[3].data,
    });
  })
  .catch(function(e) {
    console.error('admin user error:', e);
    res.status(500).json({ error: 'Server error' });
  });
});

// Admin — grant tier to a user manually
app.post('/admin/grant-tier', function(req, res) {
  if(req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  var username = String(req.body.username || '').slice(0, 12).trim();
  var tier     = req.body.tier;
  var note     = String(req.body.note || 'admin_grant');
  if(!username || !['standard', 'origin'].includes(tier)) {
    return res.status(400).json({ error: 'Invalid params' });
  }
  // Update user tier
  supabase.from('users')
    .update({ tier: tier })
    .eq('username', username)
    .then(function() {
      // Insert a purchase record so history is clean
      return supabase.from('purchases')
        .select('id')
        .eq('username', username)
        .eq('tier', tier)
        .eq('status', 'complete')
        .maybeSingle();
    })
    .then(function(existing) {
      if(existing.data) return Promise.resolve(); // already has one
      return supabase.from('purchases').insert({
        username:          username,
        tier:              tier,
        status:            'complete',
        amount_cents:      0,
        currency:          'usd',
        stripe_session_id: note + '_' + username + '_' + Date.now(),
      });
    })
    .then(function() {
      res.json({ ok: true });
    })
    .catch(function(e) {
      console.error('admin grant-tier error:', e);
      res.status(500).json({ error: 'Server error' });
    });
});

// Admin — activity feed (recent events across all tables)
app.get('/admin/activity', function(req, res) {
  if(req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  Promise.all([
    supabase.from('purchases')
      .select('username, email, tier, amount_cents, created_at')
      .eq('status', 'complete')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('users')
      .select('username, email, tier, created_at')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('scores')
      .select('username, score, level, created_at')
      .order('score', { ascending: false })
      .limit(20),
  ])
  .then(function(results) {
    var events = [];
    (results[0].data || []).forEach(function(p) {
      events.push({ type: 'purchase', username: p.username, email: p.email, tier: p.tier, amount_cents: p.amount_cents, at: p.created_at });
    });
    (results[1].data || []).forEach(function(u) {
      events.push({ type: 'signup', username: u.username, email: u.email, at: u.created_at });
    });
    (results[2].data || []).forEach(function(s) {
      events.push({ type: 'score', username: s.username, score: s.score, level: s.level, at: s.created_at });
    });
    // Sort by time descending
    events.sort(function(a, b) { return new Date(b.at) - new Date(a.at); });
    res.json({ events: events.slice(0, 60) });
  })
  .catch(function(e) {
    console.error('admin activity error:', e);
    res.status(500).json({ error: 'Server error' });
  });
});

// Admin — at-risk players (5+ games, no purchase)
app.get('/admin/at-risk', function(req, res) {
  if(req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  Promise.all([
    supabase.from('game_sessions').select('username').limit(5000),
    supabase.from('purchases').select('username').eq('status', 'complete'),
    supabase.from('users').select('username, email, tier, created_at'),
  ])
  .then(function(results) {
    var sessions  = results[0].data || [];
    var purchases = results[1].data || [];
    var users     = results[2].data || [];

    // Count sessions per username
    var counts = {};
    sessions.forEach(function(s) {
      if(s.username) counts[s.username] = (counts[s.username] || 0) + 1;
    });

    // Build set of paid usernames
    var paid = {};
    purchases.forEach(function(p) { if(p.username) paid[p.username] = true; });

    // Build user lookup map
    var userMap = {};
    users.forEach(function(u) { if(u.username) userMap[u.username] = u; });

    // Filter: 5+ sessions, not paid
    var atRisk = Object.keys(counts)
      .filter(function(u) { return counts[u] >= 5 && !paid[u]; })
      .map(function(u) {
        var user = userMap[u] || {};
        return {
          username:    u,
          email:       user.email || null,
          games_played: counts[u],
          joined:      user.created_at || null,
        };
      })
      .sort(function(a, b) { return b.games_played - a.games_played; })
      .slice(0, 100);

    res.json({ at_risk: atRisk });
  })
  .catch(function(e) {
    console.error('admin at-risk error:', e);
    res.status(500).json({ error: 'Server error' });
  });
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log('Split backend running on port', PORT);
});
