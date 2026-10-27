require('dotenv').config();
const crypto = require('crypto');
const fastify = require('fastify')({ logger: true });
const bcrypt = require('bcryptjs')

// Config
const {
	DATABASE_URL,
	SLACK_WEBHOOK_URL,
	FRONTEND_ORIGIN = 'http://localhost:3000',
} = process.env;
const PORT = parseInt(process.env.PORT) || 5000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const WATCHDOG_INTERVAL_MS = parseInt(process.env.WATCHDOG_INTERVAL_MS) || 5000;
const PING_RETENTION_DAYS = parseInt(process.env.PING_RETENTION_DAYS) || 30;
const IS_PROD = process.env.NODE_ENV === 'production';

const SESSION_DAYS = 7;
const MAX_MONITORS_PER_USER = 100;
const VALID_STATES = ['run', 'complete', 'fail'];
const MAX_SECONDS = 31536000;

if (!DATABASE_URL) {
	console.error('DATABASE_URL must be set in .env');
	process.exit(1);
}

// Alerting (Slack) 
const safe = (text) => String(text).replace(/[<>&]/g, '');

async function sendAlert(message) {
	if (!SLACK_WEBHOOK_URL) {
		fastify.log.warn('SLACK_WEBHOOK_URL not set, skipping alert');
		return;
	}
	try {
		const res = await fetch(SLACK_WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: message }),
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok)
			fastify.log.error(`Slack responded with status ${res.status}`);
	} catch (err) {
		fastify.log.error({ err }, 'Failed to send Slack alert');
	}
}

// Passwords 

const hashPassword = (password) => bcrypt.hash(password, 12);
const verifyPassword = (password, hash) => bcrypt.compare(password, hash);

let DUMMY_HASH;

// Sessions 

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// A new random token every login, so an attacker can never plant a known session id
async function createSession(userId, reply) {
	const token = crypto.randomBytes(32).toString('base64url');
	await fastify.pg.query(
		`INSERT INTO sessions(user_id, token_hash, expires_at)
		 VALUES($1, $2, now() + ($3::int * interval '1 day'))`,
		[userId, sha256(token), SESSION_DAYS],
	);
	reply.setCookie('sid', token, {
		httpOnly: true, // JavaScript can't read it
		sameSite: 'lax', // not sent on cross-site POSTs
		secure: IS_PROD, // HTTPS only in production
		path: '/',
		maxAge: SESSION_DAYS * 86400,
	});
}

// Attach to any route that needs a logged-in user
async function requireAuth(req, reply) {
	const token = req.cookies.sid;
	if (!token) return reply.code(401).send({ error: 'Not logged in' });

	const result = await fastify.pg.query(
		`SELECT u.id, u.email, u.telemetry_key
		 FROM sessions s JOIN users u ON u.id = s.user_id
		 WHERE s.token_hash = $1 AND s.expires_at > now()`,
		[sha256(token)],
	);
	if (result.rows.length === 0)
		return reply.code(401).send({ error: 'Not logged in' });
	req.user = result.rows[0];
}

const credentialsSchema = (minPassword) => ({
	body: {
		type: 'object',
		required: ['email', 'password'],
		properties: {
			email: {
				type: 'string',
				maxLength: 254,
				pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
			},
			password: {
				type: 'string',
				minLength: minPassword,
				maxLength: 72,
			},
		},
	},
});

const baseUrlFor = (key) => `${PUBLIC_URL}/p/${key}`;

// Routes 
function registerRoutes() {
	fastify.get('/health', async (req, reply) => {
		try {
			await fastify.pg.query('SELECT 1');
			return { status: 'ok' };
		} catch (err) {
			return reply.code(503).send({ status: 'unavailable' });
		}
	});

	fastify.get(
		'/monitors/:id/chart',
		{
			onRequest: requireAuth,
			schema: {
				params: {
					type: 'object',
					properties: { id: { type: 'integer', minimum: 1 } },
					required: ['id'],
				},
				querystring: {
					type: 'object',
					properties: {
						hours: {
							type: 'integer',
							minimum: 1,
							maximum: 720,
							default: 24,
						},
					},
				},
			},
		},
		async (req, reply) => {
			try {
				const result = await fastify.pg.query(
					`SELECT p.id, p.state, p.status, p.timestamp, p.duration
			 FROM pings p JOIN monitors m ON m.id = p.monitor_id
			 WHERE p.monitor_id = $1 AND m.user_id = $2
			   AND p.timestamp > now() - ($3::int * interval '1 hour')
			 ORDER BY p.timestamp DESC
			 LIMIT 2000`,
					[req.params.id, req.user.id, req.query.hours],
				);
				// Selected newest-first so the 2000 cap drops the oldest, then flipped for charting
				return reply.send(result.rows.reverse());
			} catch (err) {
				fastify.log.error(err);
				return reply
					.code(500)
					.send({ error: 'Failed to fetch chart data' });
			}
		},
	);

	// Auth 
	fastify.post(
		'/auth/signup',
		{
			schema: credentialsSchema(10),
			config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
		},
		async (req, reply) => {
			try {
				const email = req.body.email.trim().toLowerCase();
				const passwordHash = await hashPassword(req.body.password);
				const telemetryKey = crypto.randomBytes(16).toString('hex');

				const result = await fastify.pg.query(
					'INSERT INTO users(email, password_hash, telemetry_key) VALUES($1, $2, $3) RETURNING id, email',
					[email, passwordHash, telemetryKey],
				);
				await createSession(result.rows[0].id, reply);
				return reply.code(201).send(result.rows[0]);
			} catch (err) {
				if (err.code === '23505') {
					return reply
						.code(409)
						.send({
							error: 'An account with that email already exists',
						});
				}
				fastify.log.error(err);
				return reply.code(500).send({ error: 'Signup failed' });
			}
		},
	);

	fastify.post(
		'/auth/login',
		{
			schema: credentialsSchema(1),
			config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
		},
		async (req, reply) => {
			try {
				const email = req.body.email.trim().toLowerCase();
				const result = await fastify.pg.query(
					'SELECT id, email, password_hash FROM users WHERE lower(email) = $1',
					[email],
				);
				const user = result.rows[0];

				// Always do one hash check, real or dummy, so timing doesn't reveal which emails exist
				const ok = await verifyPassword(
					req.body.password,
					user ? user.password_hash : DUMMY_HASH,
				);
				if (!user || !ok)
					return reply
						.code(401)
						.send({ error: 'Invalid email or password' });

				await createSession(user.id, reply);
				return { id: user.id, email: user.email };
			} catch (err) {
				fastify.log.error(err);
				return reply.code(500).send({ error: 'Login failed' });
			}
		},
	);

	fastify.post('/auth/logout', async (req, reply) => {
		try {
			const token = req.cookies.sid;
			if (token)
				await fastify.pg.query(
					'DELETE FROM sessions WHERE token_hash = $1',
					[sha256(token)],
				);
			reply.clearCookie('sid', { path: '/' });
			return { ok: true };
		} catch (err) {
			fastify.log.error(err);
			return reply.code(500).send({ error: 'Logout failed' });
		}
	});

	fastify.get('/auth/me', { onRequest: requireAuth }, async (req) => ({
		id: req.user.id,
		email: req.user.email,
	}));


	// Per-user telemetry key 
	fastify.get('/config', { onRequest: requireAuth }, async (req) => ({
		telemetry_key: req.user.telemetry_key,
		telemetry_base_url: baseUrlFor(req.user.telemetry_key),
	}));

	fastify.post(
		'/config/regenerate-key',
		{
			onRequest: requireAuth,
			config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
		},
		async (req, reply) => {
			try {
				const key = crypto.randomBytes(16).toString('hex');
				await fastify.pg.query(
					'UPDATE users SET telemetry_key = $1 WHERE id = $2',
					[key, req.user.id],
				);
				return {
					telemetry_key: key,
					telemetry_base_url: baseUrlFor(key),
				};
			} catch (err) {
				fastify.log.error(err);
				return reply
					.code(500)
					.send({ error: 'Failed to regenerate key' });
			}
		},
	);

	// Monitors (for each user) 
	fastify.post(
		'/monitors',
		{
			onRequest: requireAuth,
			schema: {
				body: {
					type: 'object',
					required: ['monitor_name'],
					properties: {
						monitor_name: {
							type: 'string',
							pattern: '^[A-Za-z0-9_-]{1,64}$',
						},
						expected_interval: {
							type: 'integer',
							minimum: 1,
							maximum: MAX_SECONDS,
						},
						grace_period: {
							type: 'integer',
							minimum: 0,
							maximum: MAX_SECONDS,
							default: 0,
						},
					},
				},
			},
		},
		async (req, reply) => {
			try {
				const { monitor_name, expected_interval, grace_period } =
					req.body;
				const result = await fastify.pg.query(
					`INSERT INTO monitors(user_id, name, monitor_key, expected_interval, grace_period, status)
				 VALUES($1, $2, $2, $3, $4, 'pending')
				 ON CONFLICT (user_id, monitor_key) DO UPDATE
				   SET expected_interval = COALESCE(EXCLUDED.expected_interval, monitors.expected_interval),
				       grace_period = EXCLUDED.grace_period
				 RETURNING id, name, monitor_key, expected_interval, grace_period, status, last_ping_at, created_at`,
					[
						req.user.id,
						monitor_name,
						expected_interval ?? null,
						grace_period,
					],
				);
				return reply.code(201).send(result.rows[0]);
			} catch (err) {
				fastify.log.error(err);
				return reply
					.code(500)
					.send({ error: 'Failed to create monitor' });
			}
		},
	);

	fastify.get('/monitors', { onRequest: requireAuth }, async (req, reply) => {
		try {
			const result = await fastify.pg.query(
				`SELECT id, name, monitor_key, expected_interval, grace_period, status, last_ping_at, created_at
				 FROM monitors WHERE user_id = $1 ORDER BY id`,
				[req.user.id],
			);
			return reply.send(result.rows);
		} catch (err) {
			fastify.log.error(err);
			return reply.code(500).send({ error: 'Failed to fetch monitors' });
		}
	});

	// JOIN on user_id stops user B reading user A's history by guessing an id

	fastify.get(
		'/monitors/:id/pings',
		{
			onRequest: requireAuth,
			schema: {
				params: {
					type: 'object',
					properties: { id: { type: 'integer', minimum: 1 } },
					required: ['id'],
				},
			},
		},
		async (req, reply) => {
			try {
				const result = await fastify.pg.query(
					`SELECT p.id, p.state, p.status, p.timestamp, p.duration
				 	FROM pings p JOIN monitors m ON m.id = p.monitor_id
				 	WHERE p.monitor_id = $1 AND m.user_id = $2
				 	ORDER BY p.timestamp DESC LIMIT 50`,
					[req.params.id, req.user.id],
				);
				return reply.send(result.rows);
			} catch (err) {
				fastify.log.error(err);
				return reply
					.code(500)
					.send({ error: 'Failed to fetch ping history' });
			}
		},
	);

	// Telemetry (authenticated by the user's key in the URL) 

	fastify.route({
		method: ['GET', 'POST'],
		url: '/p/:telemetry_key/:name',
		config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
		schema: {
			params: {
				type: 'object',
				required: ['telemetry_key', 'name'],
				properties: {
					telemetry_key: { type: 'string', maxLength: 128 },
					name: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
				},
			},
			querystring: {
				type: 'object',
				required: ['state'],
				properties: {
					state: { type: 'string', enum: VALID_STATES },
					duration: {
						type: 'number',
						minimum: 0,
						maximum: MAX_SECONDS,
					},
				},
			},
		},
		handler: async (req, reply) => {
			try {
				const { state, duration } = req.query;
				const name = req.params.name;

				// The key identifies WHOSE monitors these are

				const owner = await fastify.pg.query(
					'SELECT id FROM users WHERE telemetry_key = $1',
					[req.params.telemetry_key],
				);
				if (owner.rows.length === 0)
					return reply
						.code(401)
						.send({ error: 'Invalid telemetry key' });
				const userId = owner.rows[0].id;

				const outcome = await fastify.pg.transact(async (client) => {
					let found = await client.query(
						'SELECT id, name, status FROM monitors WHERE user_id = $1 AND monitor_key = $2 FOR UPDATE',
						[userId, name],
					);

					// Unknown name: auto-create (with a cap)

					if (found.rows.length === 0) {
						const count = await client.query(
							'SELECT count(*)::int AS n FROM monitors WHERE user_id = $1',
							[userId],
						);
						if (count.rows[0].n >= MAX_MONITORS_PER_USER)
							return { limitReached: true };

						await client.query(
							`INSERT INTO monitors(user_id, name, monitor_key, status) VALUES($1, $2, $2, 'pending')
							 ON CONFLICT (user_id, monitor_key) DO NOTHING`,
							[userId, name],
						);
						found = await client.query(
							'SELECT id, name, status FROM monitors WHERE user_id = $1 AND monitor_key = $2 FOR UPDATE',
							[userId, name],
						);
					}
					const monitor = found.rows[0];

					let measured = null;
					let pingStatus = state === 'fail' ? 'failed' : 'ok';

					if (state === 'complete' || state === 'fail') {
						const run = await client.query(
							`SELECT EXTRACT(EPOCH FROM (now() - timestamp))::float8 AS elapsed
							 FROM pings
							 WHERE monitor_id = $1 AND state = 'run'
							   AND timestamp > COALESCE(
							     (SELECT max(timestamp) FROM pings
							      WHERE monitor_id = $1 AND state IN ('complete', 'fail')),
							     'epoch'::timestamptz)
							 ORDER BY timestamp DESC LIMIT 1`,
							[monitor.id],
						);
						if (run.rows.length > 0)
							measured =
								Math.round(run.rows[0].elapsed * 1000) / 1000;
					}

					if (state === 'complete') {
						const sched = await client.query(
							`SELECT m.expected_interval, m.grace_period,
							        EXTRACT(EPOCH FROM (now() - (
							          SELECT max(timestamp) FROM pings
							          WHERE monitor_id = m.id AND state IN ('complete', 'fail')
							        )))::float8 AS since_outcome
							 FROM monitors m WHERE m.id = $1`,
							[monitor.id],
						);
						const s = sched.rows[0];
						if (
							s.expected_interval !== null &&
							s.since_outcome !== null &&
							s.since_outcome >
								s.expected_interval + s.grace_period
						) {
							pingStatus = 'late';
						}
					}

					await client.query(
						'INSERT INTO pings(monitor_id, state, status, duration) VALUES($1, $2, $3, $4)',
						[monitor.id, state, pingStatus, duration ?? measured],
					);

					let newStatus = monitor.status;
					if (state === 'fail') newStatus = 'failed';
					if (state === 'complete') newStatus = 'ok';

					await client.query(
						'UPDATE monitors SET last_ping_at = now(), status = $2 WHERE id = $1',
						[monitor.id, newStatus],
					);
					return { monitor };
				});

				if (outcome.limitReached) {
					return reply
						.code(403)
						.send({
							error: 'Monitor limit reached for this account',
						});
				}

				const { monitor } = outcome;
				if (state === 'fail' && monitor.status !== 'failed') {
					sendAlert(`*${safe(monitor.name)}* reported a failure`);
				}
				if (
					state === 'complete' &&
					(monitor.status === 'late' || monitor.status === 'failed')
				) {
					sendAlert(`*${safe(monitor.name)}* recovered`);
				}

				return reply.send({ message: `Ping recorded ${state}` });
			} catch (err) {
				fastify.log.error(err);
				return reply.code(500).send({ error: 'Failed to record ping' });
			}
		},
	});
}

// Watchdog
let watchdogTimer;
let cleanupTimer;
let shuttingDown = false;

async function watchdogTick() {
	try {
		const result = await fastify.pg.query(
			`UPDATE monitors
			 SET status = 'late'
			 WHERE status = 'ok'
			   AND expected_interval IS NOT NULL
			   AND last_ping_at IS NOT NULL
			   AND last_ping_at + (expected_interval + grace_period) * interval '1 second' < now()
			 RETURNING id, name`,
		);
		for (const m of result.rows) {
			fastify.log.info(`Monitor ${m.id} is now late`);
			sendAlert(
				`*${safe(m.name)}* is LATE: no ping received within its schedule`,
			);
		}
	} catch (err) {
		fastify.log.error({ err }, 'Watchdog tick failed');
	} finally {
		if (!shuttingDown)
			watchdogTimer = setTimeout(watchdogTick, WATCHDOG_INTERVAL_MS);
	}
}

async function cleanupTick() {
	try {
		const pings = await fastify.pg.query(
			`DELETE FROM pings WHERE timestamp < now() - ($1::int * interval '1 day')`,
			[PING_RETENTION_DAYS],
		);
		await fastify.pg.query('DELETE FROM sessions WHERE expires_at < now()');
		if (pings.rowCount > 0)
			fastify.log.info(
				`Retention cleanup removed ${pings.rowCount} old pings`,
			);
	} catch (err) {
		fastify.log.error({ err }, 'Retention cleanup failed');
	}
}

// Startup / shutdown

async function shutdown(signal) {
	fastify.log.info(`${signal} received, shutting down`);
	shuttingDown = true;
	clearTimeout(watchdogTimer);
	clearInterval(cleanupTimer);
	try {
		await fastify.close();
		process.exit(0);
	} catch (err) {
		fastify.log.error(err);
		process.exit(1);
	}
}

async function start() {
	try {
		await fastify.register(require('@fastify/postgres'), {
			connectionString: DATABASE_URL,
		});
		await fastify.register(require('@fastify/cookie'));
		await fastify.register(require('@fastify/cors'), {
			origin: FRONTEND_ORIGIN,
			credentials: true,
		});
		await fastify.register(require('@fastify/rate-limit'), {
			max: 600,
			timeWindow: '1 minute',
		});

		DUMMY_HASH = await hashPassword('placeholder-password');

		registerRoutes();
		await fastify.listen({ port: PORT, host: '0.0.0.0' });

		watchdogTick();
		cleanupTimer = setInterval(cleanupTick, 60 * 60 * 1000);
	} catch (err) {
		fastify.log.error(err);
		process.exit(1);
	}
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
