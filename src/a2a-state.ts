// Durable Object holding the strongly-consistent A2A state:
// consumed nonces (replay guard), tasks, payments, and a fixed-window rate limiter.

import { DurableObject } from "cloudflare:workers";
import { ALLOWED_TRANSITIONS, type Env, type A2AState as TaskState } from "./lib";

export interface TaskRow {
  id: string;
  state: TaskState;
  history: TaskState[];
  payload: string;
  payment_id: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
}

export interface PaymentRow {
  id: string;
  status: "required" | "pending" | "confirmed" | "failed";
  payer: string | null;
  requirements: string;
  tx_hash: string | null;
  server_signed?: number;
  created_at: number;
  updated_at: number;
}

export class A2AState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS nonces (
        caller TEXT NOT NULL, nonce TEXT NOT NULL, used_at INTEGER NOT NULL,
        PRIMARY KEY (caller, nonce))`);
      sql.exec(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, history TEXT NOT NULL,
        payload TEXT NOT NULL, payment_id TEXT, result TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, payer TEXT,
        requirements TEXT NOT NULL, payload TEXT, tx_hash TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      // demo-only marker: this payment was signed server-side by the funded demo wallet
      try { sql.exec(`ALTER TABLE payments ADD COLUMN server_signed INTEGER NOT NULL DEFAULT 0`); } catch {}
      sql.exec(`CREATE TABLE IF NOT EXISTS rate (
        bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    });
  }

  /** Replay guard. The UNIQUE(caller, nonce) primary key is what makes this real. */
  async consumeNonce(caller: string, nonce: string): Promise<{ ok: boolean; reason?: string }> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `DELETE FROM nonces WHERE used_at < ?`, now - 10 * 60 * 1000,
    );
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO nonces (caller, nonce, used_at) VALUES (?, ?, ?)`,
        caller.toLowerCase(), nonce, now,
      );
      return { ok: true };
    } catch {
      return { ok: false, reason: "nonce already used (replay rejected)" };
    }
  }

  /** Fixed 1-second window counter, per caller + method. */
  async rateLimit(bucket: string, limit: number): Promise<{ allowed: boolean; count: number }> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const rows = sql.exec(`SELECT count, expires_at FROM rate WHERE bucket = ?`, bucket).toArray();
    const row = rows[0] as { count: number; expires_at: number } | undefined;
    let count = 1;
    if (!row || row.expires_at <= now) {
      sql.exec(`INSERT INTO rate (bucket, count, expires_at) VALUES (?, 1, ?)
                ON CONFLICT(bucket) DO UPDATE SET count = 1, expires_at = ?`, bucket, now + 1000, now + 1000);
    } else {
      count = row.count + 1;
      sql.exec(`UPDATE rate SET count = ? WHERE bucket = ?`, count, bucket);
    }
    return { allowed: count <= limit, count };
  }

  async createTask(id: string, payload: string, paymentId: string | null): Promise<TaskRow> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO tasks (id, state, history, payload, payment_id, result, created_at, updated_at)
       VALUES (?, 'created', ?, ?, ?, NULL, ?, ?)`,
      id, JSON.stringify(["created"]), payload, paymentId, now, now,
    );
    return (await this.getTask(id))! as TaskRow;
  }

  async getTask(id: string): Promise<TaskRow | null> {
    const rows = this.ctx.storage.sql.exec(`SELECT * FROM tasks WHERE id = ?`, id).toArray();
    const row = rows[0] as any;
    if (!row) return null;
    return { ...row, history: JSON.parse(row.history) } as TaskRow;
  }

  /** Applies the transition table. Illegal transitions are rejected, not raised. */
  async setTaskState(id: string, next: TaskState, result: string | null): Promise<{ ok: boolean; state: TaskState; reason?: string }> {
    const task = await this.getTask(id);
    if (!task) return { ok: false, state: "failed", reason: "task not found" };
    if (task.state === next) return { ok: true, state: next };
    if (!this.isTransitionAllowed(task.state, next)) {
      console.warn(`[a2a] illegal transition ${task.state} -> ${next} for task ${id} (ignored)`);
      return { ok: false, state: task.state, reason: `illegal transition ${task.state} -> ${next}` };
    }
    const history = [...task.history, next];
    this.ctx.storage.sql.exec(
      `UPDATE tasks SET state = ?, history = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ?`,
      next, JSON.stringify(history), result, Date.now(), id,
    );
    return { ok: true, state: next };
  }

  private isTransitionAllowed(from: TaskState, to: TaskState): boolean {
    return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
  }

  async createPayment(id: string, requirements: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO payments (id, status, payer, requirements, payload, tx_hash, created_at, updated_at)
       VALUES (?, 'required', NULL, ?, NULL, NULL, ?, ?)`,
      id, requirements, now, now,
    );
  }

  async getPayment(id: string): Promise<PaymentRow | null> {
    const rows = this.ctx.storage.sql.exec(`SELECT * FROM payments WHERE id = ?`, id).toArray();
    return ((rows[0] as unknown) as PaymentRow) ?? null;
  }

  async markServerSigned(id: string): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE payments SET server_signed = 1 WHERE id = ?`, id);
  }

  async setPaymentStatus(id: string, status: PaymentRow["status"], payer: string | null, txHash: string | null): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE payments SET status = ?, payer = COALESCE(?, payer), tx_hash = COALESCE(?, tx_hash), updated_at = ? WHERE id = ?`,
      status, payer, txHash, Date.now(), id,
    );
  }

  async stats(): Promise<Record<string, number>> {
    const sql = this.ctx.storage.sql;
    const count = (t: string) => Number((sql.exec(`SELECT COUNT(*) AS c FROM ${t}`).toArray()[0] as any)?.c ?? 0);
    const byState = sql.exec(`SELECT state, COUNT(*) AS c FROM tasks GROUP BY state`).toArray() as any[];
    const out: Record<string, number> = {
      nonces_consumed: count("nonces"),
      tasks_total: count("tasks"),
      payments_total: count("payments"),
    };
    for (const r of byState) out[`tasks_${r.state}`] = Number(r.c);
    return out;
  }
}
