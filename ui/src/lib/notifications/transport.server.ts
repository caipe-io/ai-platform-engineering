import {
  AckPolicy,
  connect,
  RetentionPolicy,
  StorageType,
  type NatsConnection,
} from "nats";

/**
 * JetStream transport for notification events. Only used when
 * NOTIFICATIONS_TRANSPORT=jetstream. Server-side only: browsers never reach
 * NATS, and credentials stay in the server environment.
 */

export const NOTIFICATION_STREAM = "CAIPE_EVENTS";
export const NOTIFICATION_CONSUMER = "caipe-notifications";
export const NOTIFICATION_SUBJECT_PREFIX = "caipe.events.v1";

const NANOS_PER_SECOND = 1_000_000_000;
const STREAM_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const DUPLICATE_WINDOW_SECONDS = 2 * 60;
const CONSUMER_ACK_WAIT_SECONDS = 30;
const CONSUMER_MAX_DELIVER = 5;

export function notificationSubject(eventType: string): string {
  return `${NOTIFICATION_SUBJECT_PREFIX}.${eventType}`;
}

export function notificationTransportMode(): "direct" | "jetstream" {
  return process.env.NOTIFICATIONS_TRANSPORT === "jetstream" ? "jetstream" : "direct";
}

let connection: Promise<NatsConnection> | null = null;

/**
 * Lazily connects once per process. The NATS client reconnects on its own
 * after a drop. If the first connect fails, the cached promise is cleared so
 * the next publish or consumer start tries again.
 */
export function getNatsConnection(): Promise<NatsConnection> {
  if (!connection) {
    const servers = process.env.NATS_URL ?? "nats://localhost:4222";
    const token = process.env.NATS_TOKEN;
    connection = connect({ servers, ...(token ? { token } : {}) })
      .then((nc) => {
        void watchStatus(nc);
        return nc;
      })
      .catch((error: unknown) => {
        connection = null;
        throw error;
      });
  }
  return connection;
}

/** Drains and forgets the shared connection. Used on shutdown and in tests. */
export async function closeNotificationConnection(): Promise<void> {
  if (!connection) return;
  const nc = await connection;
  connection = null;
  await nc.drain();
}

async function watchStatus(nc: NatsConnection): Promise<void> {
  for await (const status of nc.status()) {
    if (status.type === "disconnect" || status.type === "reconnect" || status.type === "error") {
      console.warn(`[notifications] NATS ${status.type}`, status.data ?? "");
    }
  }
}

/**
 * Creates the stream and durable consumer if they are missing. Idempotent:
 * re-running it with the same config is safe, so every replica can call it.
 */
export async function ensureNotificationStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.info(NOTIFICATION_STREAM);
  } catch {
    await jsm.streams.add({
      name: NOTIFICATION_STREAM,
      subjects: [`${NOTIFICATION_SUBJECT_PREFIX}.>`],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: STREAM_MAX_AGE_SECONDS * NANOS_PER_SECOND,
      duplicate_window: DUPLICATE_WINDOW_SECONDS * NANOS_PER_SECOND,
    });
  }

  try {
    await jsm.consumers.info(NOTIFICATION_STREAM, NOTIFICATION_CONSUMER);
  } catch {
    await jsm.consumers.add(NOTIFICATION_STREAM, {
      durable_name: NOTIFICATION_CONSUMER,
      ack_policy: AckPolicy.Explicit,
      ack_wait: CONSUMER_ACK_WAIT_SECONDS * NANOS_PER_SECOND,
      max_deliver: CONSUMER_MAX_DELIVER,
      filter_subject: `${NOTIFICATION_SUBJECT_PREFIX}.>`,
    });
  }
}
