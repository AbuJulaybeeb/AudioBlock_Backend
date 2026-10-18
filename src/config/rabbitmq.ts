import amqp from 'amqplib';
import { isShuttingDown } from '../utils/gracefulShutdown';

let connection: Awaited<ReturnType<typeof amqp.connect>> | null = null;
let stopping = false;
let retryTimer: NodeJS.Timeout | undefined;

export async function closeRabbitMQConnection(): Promise<void> {
  stopping = true;
  if (retryTimer) clearTimeout(retryTimer);
  const current = connection;
  connection = null;
  channel = null;
  if (current) await current.close();
}

let channel: amqp.Channel | null = null;

export async function initRabbitMQ(): Promise<void> {
  const connect = async () => {
    if (stopping || isShuttingDown()) return;
    try {
      const rabbitmqUrl = process.env.RABBITMQ_URL;

      if (!rabbitmqUrl) {
        throw new Error('RABBITMQ_URL environment variable is required');
      }

      console.log(`🔄 Connecting to RabbitMQ (secure connection)...`);

      // For amqps://, no additional config needed - amqplib handles TLS automatically
      const connected = await amqp.connect(rabbitmqUrl, {
        heartbeat: 60,
        // ssl: { rejectUnauthorized: false }
      } as any);

      connection = connected;
      if (stopping || isShuttingDown()) {
        await closeRabbitMQConnection();
        return;
      }
      channel = await connected.createChannel();
      console.log('✅ RabbitMQ connected and channel created');

      connected.on('close', () => {
        console.error('⚠️ RabbitMQ connection closed. Retrying...');
        channel = null;
        if (!stopping && !isShuttingDown()) retryTimer = setTimeout(connect, 5000);
      });

      connected.on('error', (err) => {
        console.error('⚠️ RabbitMQ connection error:', err.message);
      });
    } catch (error: any) {
      console.error('❌ RabbitMQ connection failed:', error.message);
      channel = null;
      if (!stopping && !isShuttingDown()) retryTimer = setTimeout(connect, 5000);
    }
  };

  await connect();
}

export const MAIN_QUEUE = 'song_processing';
export const DLQ = 'song_processing_dlq';

export function getChannel(): amqp.Channel {
  if (!channel) throw new Error('RabbitMQ not initialized');
  return channel;
}

export function getRawChannel(): amqp.Channel | null {
  return channel;
}

export function isConnected(): boolean {
  return channel !== null;
}
