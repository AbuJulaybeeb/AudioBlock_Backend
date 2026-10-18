import amqp from 'amqplib';

let channel: amqp.Channel | null = null;

// export async function initRabbitMQ(): Promise<void> {
//   const connect = async () => {
//     try {
//       const connection = await amqp.connect({
//         protocol: "amqp",
//         hostname: process.env.RABBITMQ_HOST || "rabbitmq",
//         port: parseInt(process.env.RABBITMQ_PORT || "5672"),
//         username: process.env.RABBITMQ_USER || "guest",
//         password: process.env.RABBITMQ_PASS || "guest",
//       });

//       channel = await connection.createChannel();
//       console.log("✅ RabbitMQ connected and channel created");

//       connection.on("close", () => {
//         console.error("⚠️ RabbitMQ connection closed. Retrying...");
//         channel = null;
//         setTimeout(connect, 5000);
//       });

//       connection.on("error", (err) => {
//         console.error("⚠️ RabbitMQ connection error:", err.message);
//       });
//     } catch (error: any) {
//       console.error("❌ RabbitMQ connection failed:", error.message);
//       channel = null;
//       setTimeout(connect, 5000);
//     }
//   };

//   await connect();
// }

export async function initRabbitMQ(): Promise<void> {
  const connect = async () => {
    try {
      const rabbitmqUrl = process.env.RABBITMQ_URL;

      if (!rabbitmqUrl) {
        throw new Error('RABBITMQ_URL environment variable is required');
      }

      console.log(`🔄 Connecting to RabbitMQ (secure connection)...`);

      // For amqps://, no additional config needed - amqplib handles TLS automatically
      const connection = await amqp.connect(rabbitmqUrl, {
        heartbeat: 60,
        // ssl: { rejectUnauthorized: false }
      } as any);

      channel = await connection.createChannel();
      console.log('✅ RabbitMQ connected and channel created');

      connection.on('close', () => {
        console.error('⚠️ RabbitMQ connection closed. Retrying...');
        channel = null;
        setTimeout(connect, 5000);
      });

      connection.on('error', (err) => {
        console.error('⚠️ RabbitMQ connection error:', err.message);
      });
    } catch (error: any) {
      console.error('❌ RabbitMQ connection failed:', error.message);
      channel = null;
      setTimeout(connect, 5000);
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
