# Worker shutdown

SIGTERM and SIGINT start draining RabbitMQ consumers before HTTP shutdown and before database/Redis teardown. Consumers are cancelled, deliveries already in progress are allowed to settle, then channels and their connection close. Deliveries arriving while cancellation is pending are immediately requeued.

SHUTDOWN_DRAIN_TIMEOUT_MS defaults to 25000 milliseconds. Set it below SHUTDOWN_TIMEOUT_MS (default 30000) and the platform's termination grace period, leaving time for connection cleanup. At the deadline, unfinished deliveries are nacked with requeue=true. Their handlers cannot subsequently ack, nack, or publish retries for those deliveries. The process exits after shutdown; partial S3 output cleanup remains a separate concern. RabbitMQ reconnection is disabled during shutdown.

JobQueueWorker consumes Redis, not RabbitMQ, so it does not register an AMQP consumer.
