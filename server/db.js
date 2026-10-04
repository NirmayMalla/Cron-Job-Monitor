const fastify = require('fastify')();

fastify.register(require('@fastify/postgres'), {
	connectionString: 'postgres://postgres@localhost/postgres'
});



