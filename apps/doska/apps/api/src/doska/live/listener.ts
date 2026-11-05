import { Client, type Notification } from "pg";
import { resolveDatabaseConnectionString } from "../../database/resolve-database-url";
import { LIVE_CHANNEL, parseLiveEvent, type LiveEvent } from "./events";

export type LiveListenerState = { ready: boolean; generation: number };
export type LiveSubscriber = {
  onEvent(event: LiveEvent): void;
  onInvalidated(): void;
};
export type LiveClient = Pick<
  Client,
  "connect" | "query" | "end" | "on" | "removeListener"
>;

export class LiveListener {
  private state: LiveListenerState = { ready: false, generation: 0 };
  private subscribers = new Set<LiveSubscriber>();
  private observers = new Set<(state: LiveListenerState) => void>();
  private client: LiveClient | undefined;
  private running = false;
  private draining = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private openingDeadline: ReturnType<typeof setTimeout> | undefined;
  private closing: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      createClient?: () => LiveClient;
      reconnectMs?: number;
      lifecycleTimeoutMs?: number;
    } = {},
  ) {}

  getState(): LiveListenerState {
    return { ...this.state };
  }

  // Registration and readiness check are synchronous, with no await gap.
  subscribe(
    subscriber: LiveSubscriber,
  ): { generation: number; unsubscribe(): void } | undefined {
    if (!this.state.ready) return;
    this.subscribers.add(subscriber);
    return {
      generation: this.state.generation,
      unsubscribe: () => {
        this.subscribers.delete(subscriber);
      },
    };
  }

  observeState(callback: (state: LiveListenerState) => void): () => void {
    this.observers.add(callback);
    this.call(() => callback(this.getState()));
    return () => {
      this.observers.delete(callback);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.closing.then(() => this.open());
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.client) this.disconnect(this.client);
    await this.closing;
  }

  private call(callback: () => void): void {
    try {
      callback();
    } catch {
      /* Consumer failure must not crash the shared listener. */
    }
  }

  private setReady(ready: boolean): void {
    this.state = { ready, generation: this.state.generation + (ready ? 1 : 0) };
    if (!ready) {
      const previous = [...this.subscribers];
      this.subscribers.clear();
      for (const subscriber of previous)
        this.call(() => subscriber.onInvalidated());
    }
    for (const observer of [...this.observers])
      this.call(() => observer(this.getState()));
  }

  private async open(): Promise<void> {
    if (!this.running || this.client || this.draining) return;
    let client: LiveClient;
    try {
      client =
        this.options.createClient?.() ??
        new Client({
          connectionString: resolveDatabaseConnectionString(),
          connectionTimeoutMillis: 5000,
          query_timeout: 5000,
          application_name: "doska-live-listener",
          keepAlive: true,
        });
    } catch {
      this.schedule();
      return;
    }
    this.client = client;
    this.openingDeadline = setTimeout(
      () => this.disconnect(client),
      this.options.lifecycleTimeoutMs ?? 5000,
    );
    this.openingDeadline.unref();
    client.on("error", () => this.disconnect(client));
    client.on("end", () => this.disconnect(client));
    const pending: LiveEvent[] = [];
    const dispatch = (event: LiveEvent) => {
      for (const subscriber of [...this.subscribers]) {
        if (this.client !== client || !this.state.ready) return;
        if (!this.subscribers.has(subscriber)) continue;
        try {
          subscriber.onEvent(event);
        } catch {
          this.subscribers.delete(subscriber);
          this.call(() => subscriber.onInvalidated());
        }
      }
    };
    client.on("notification", (notification: Notification) => {
      if (this.client !== client || notification.channel !== LIVE_CHANNEL)
        return;
      const event = parseLiveEvent(notification.payload ?? "");
      // Invalid data means consumers cannot trust that their snapshot is current.
      if (!event) {
        this.disconnect(client);
        return;
      }
      if (!this.state.ready) {
        // pg may emit NotificationResponse in the same socket read as the LISTEN
        // result, before its Promise continuation has registered ready consumers.
        if (pending.length >= 64) {
          this.disconnect(client);
          return;
        }
        pending.push(event);
      } else dispatch(event);
    });
    try {
      await client.connect();
      if (this.client !== client) return;
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
      if (this.client === client && this.running) {
        clearTimeout(this.openingDeadline);
        this.setReady(true);
        for (const event of pending.splice(0)) dispatch(event);
      }
    } catch {
      this.disconnect(client);
    }
  }

  private disconnect(client: LiveClient): void {
    if (this.client !== client) return;
    this.client = undefined;
    clearTimeout(this.openingDeadline);
    this.setReady(false);
    // Wait for the old socket to close before allocating the next connection.
    this.draining = true;
    this.closing = new Promise<void>((resolve) => {
      const deadline = setTimeout(
        resolve,
        this.options.lifecycleTimeoutMs ?? 5000,
      );
      deadline.unref();
      // A stuck close remains fail-closed: do not accumulate replacement sockets.
      void client
        .end()
        .catch(() => {})
        .then(() => {
          clearTimeout(deadline);
          this.draining = false;
          resolve();
          this.schedule();
        });
    });
  }

  private schedule(): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.open();
    }, this.options.reconnectMs ?? 1000);
    this.timer.unref();
  }
}
