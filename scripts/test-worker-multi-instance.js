/* Disposable RabbitMQ smoke test; intentionally avoids application queues/effects. */
const amqp = require('amqplib');
const { fork } = require('child_process');
const assert = require('node:assert/strict');

async function child() {
  const connection = await amqp.connect(process.env.RABBITMQ_TEST_URL);
  const channel = await connection.createChannel();
  await channel.prefetch(1);
  let active = 0;
  await channel.consume(process.env.WORKER_TEST_QUEUE, async (msg) => {
    if (!msg) return;
    active++;
    process.send({ type: 'active', active });
    await new Promise((resolve) => setTimeout(resolve, 50));
    active--;
    channel.ack(msg);
    process.send({ type: 'done', id: msg.content.toString() });
  });
  process.send({ type: 'ready' });
  process.on('message', async (message) => {
    if (message === 'stop') {
      await connection.close();
      process.exit(0);
    }
  });
  process.on('disconnect', () => process.exit(1));
}

async function parent() {
  if (!process.env.RABBITMQ_TEST_URL)
    throw new Error('Set RABBITMQ_TEST_URL to a disposable local broker');
  let connection;
  const children = [];
  let timer;
  try {
    await Promise.race([
      (async () => {
        connection = await amqp.connect(process.env.RABBITMQ_TEST_URL, { timeout: 5000 });
        const channel = await connection.createConfirmChannel();
        const { queue } = await channel.assertQueue('', {
          durable: false,
          autoDelete: false,
          arguments: { 'x-expires': 60000 },
        });
        const seen = new Set();
        const counts = [0, 0];
        let ready = 0;
        await new Promise((resolve, reject) => {
          for (let index = 0; index < 2; index++) {
            const worker = fork(__filename, ['--child'], {
              env: { ...process.env, WORKER_TEST_QUEUE: queue },
              stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            });
            children.push(worker);
            worker.on('error', reject);
            worker.on('exit', (code) => reject(new Error(`Consumer exited early: ${code}`)));
            worker.on('message', (message) => {
              try {
                if (message.type === 'active') assert.equal(message.active, 1);
                if (message.type === 'ready' && ++ready === 2) {
                  for (let id = 0; id < 12; id++)
                    channel.sendToQueue(queue, Buffer.from(String(id)));
                  channel.waitForConfirms().catch(reject);
                }
                if (message.type === 'done') {
                  assert.match(message.id, /^(?:[0-9]|1[01])$/);
                  assert.equal(seen.has(message.id), false, `Duplicate delivery ${message.id}`);
                  seen.add(message.id);
                  counts[index]++;
                  if (seen.size === 12) resolve();
                }
              } catch (error) {
                reject(error);
              }
            });
          }
        });
        assert.ok(
          counts.every((count) => count > 0),
          'Both instances must process work',
        );
        // Graceful AMQP close flushes acknowledgements before consumers exit.
        await Promise.all(
          children.map(
            (worker) =>
              new Promise((resolve, reject) => {
                worker.once('exit', (code) =>
                  code === 0 ? resolve() : reject(new Error(`Consumer shutdown failed: ${code}`)),
                );
                worker.send('stop');
              }),
          ),
        );
        const state = await channel.checkQueue(queue);
        assert.equal(state.messageCount, 0);
        assert.equal(state.consumerCount, 0);
        await channel.deleteQueue(queue);
        console.log(
          `PASS: 12 unique jobs; per-instance counts ${counts.join(', ')}; max concurrency 1 each`,
        );
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('30 second test deadline exceeded')), 30000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    for (const worker of children) worker.kill();
    if (connection) await connection.close();
  }
}

(process.argv.includes('--child') ? child() : parent()).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
