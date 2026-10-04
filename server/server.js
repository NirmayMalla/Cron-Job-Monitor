require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const crypto = require ('crypto')
const PORT = 5000;

// Slack alert
async function sendAlert(message) {
	try {
		console.log("Alert called");
		await fetch(process.env.SLACK_WEBHOOK_URL, {
			method: "POST",
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: message })
		});
	}
	catch(err) {
		fastify.log.error('Failed to send Slack alert', err);
	}
}

// Db connection
fastify.register(require('@fastify/postgres'), {
	connectionString: 'postgres://postgres:motherjoseph1412*@localhost:5432/cronjob'
});

fastify.register(require('@fastify/cors'), {
    origin: 'http://localhost:3000'
});

// Add monitor
fastify.post('/monitors', async (req, reply) => {
	try {
		const { monitor_name, expected_interval, grace_period } = req.body;
		const monitor_key = crypto.randomBytes(8).toString('hex');

		const response = await fastify.pg.query(`INSERT INTO monitors(name, expected_interval, grace_period, monitor_key, status) VALUES($1, $2, $3, $4, 'ok') RETURNING *`,
			[monitor_name, expected_interval, grace_period, monitor_key]);

		return reply.code(202).send(response.rows[0]);
	}
	catch (err) {
		fastify.log.error(err);
		return reply.code(500).send({ error: "Failed to create monitor" });
	}
});

// Get all monitors
fastify.get('/monitors', async (req, reply) => {
	try {
		const result = await fastify.pg.query('SELECT * FROM monitors');
		return reply.send(result.rows);
	}
	catch(err) {
		fastify.log.error(err);
		return reply.code(500).send({ error: 'Failed to fetch monitors' });
	}
});

// Get log of one monitor
fastify.get('/monitors/:monitor_id/pings', async (req, reply) => {
	const monitorId = req.params.monitor_id;
	try {
		const result = await fastify.pg.query(`SELECT * FROM pings WHERE monitor_id = $1 ORDER BY TIMESTAMP DESC LIMIT 20`,
		[monitorId]);
		
		return reply.send(result.rows);
	}
	catch(err) {
		fastify.log.error(err);
		return reply.code(500).send({ error: "Failed to fetch ping history" })
	}
});

// Ping monitors
fastify.get('/ping/:monitor_key', async (req, reply) => {
	try {
		const state = req.query.state;
		const validStates = ['completed', 'failed'];

		if (!validStates.includes(state))
			return reply.code(400).send({ error: "state must be complete, or fail" });

		const monitor = await fastify.pg.query('SELECT * FROM monitors WHERE monitor_key = $1', [req.params.monitor_key]);

		if (monitor.rows.length == 0) 
			return reply.code(404).send({ error: "Monitor not found" });
		
		const monitorRow = monitor.rows[0];
		const monitorId = monitorRow.id;
		
		const ping = await fastify.pg.query(`INSERT INTO pings(monitor_id, state, timestamp, duration) VALUES($1, $2, CURRENT_TIMESTAMP, 10)`, 
			[monitorId, state]);

		if (ping.rowCount === 0) 
			return reply.code(500).send({ error: "Failed to record ping" });

		if (state === 'failed') {
			await fastify.pg.query(`UPDATE monitors SET status = 'failed' WHERE id = $1`, [monitorId]);
			sendAlert(`*${monitorRow.name}* failed`);
		}

		if (state === 'completed') {
			if (monitorRow.status === 'late' || monitorRow.status === 'failed')
				sendAlert(`*${monitorRow.name}* completed (recovered)`);
			await fastify.pg.query(`UPDATE monitors SET status = 'ok' WHERE id = $1`, [monitorId]);
		}

		return reply.send({ message: `Ping recorded ${state}` });
	}
	catch(err) {
		fastify.log.error(err);
		return reply.code(500).send({ error: "Database query failed" });
	}
});

// Watchdog check one monitor
async function checkMonitor(monitor) {
	const lastPingResult = await fastify.pg.query(`SELECT * FROM pings WHERE monitor_id=$1 ORDER BY TIMESTAMP DESC LIMIT 1`, [monitor.id]);

	if (lastPingResult.rows.length == 0) 
		return;

	const lastPing = lastPingResult.rows[0];
	const lastPingTime = new Date(lastPing.timestamp);
	const currentTime = new Date();

	const secondsSinceLastPing = (currentTime - lastPingTime) / 1000; 	// In seconds
	const allowedSeconds = monitor.expected_interval + monitor.grace_period;

	const isLate = secondsSinceLastPing > allowedSeconds;

	const newStatus = isLate ? 'late' : 'ok';

	if (newStatus !== monitor.status) {
		await fastify.pg.query('UPDATE monitors SET status = $1 WHERE id = $2',
			[newStatus, monitor.id]
		);
		fastify.log.info(`Monitor ${monitor.id} status changed: ${monitor.status} -> ${newStatus}`);
		
		if (newStatus === 'late')
			sendAlert(`${monitor.name} was late`);
	}
}

// Watchdog check each monitor
async function checkEachMonitor() {
	const result = await fastify.pg.query('SELECT * FROM monitors');
	for (const monitor of result.rows)
		await checkMonitor(monitor);
}

const start = async () => {
	try {
		await fastify.listen({ port: PORT });
		console.log(`Listening on http://localhost:${PORT}`);


		setInterval(checkEachMonitor, 6000);
		fastify.log.info('Watchdog started. Checking every 6 seconds')
	}   
	catch(err) {
		fastify.log.error(err);
		process.exit(1);
	}
}

start();

