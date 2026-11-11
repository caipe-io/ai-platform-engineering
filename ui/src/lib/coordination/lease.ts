import { randomUUID } from "node:crypto";

/** Durable assignment state is independent of human notification delivery. */
export interface HandoffDeliveryState {
  _id: string;
  status: "pending" | "processing" | "delivered" | "failed" | "skipped";
  attempts: number;
  availableAt: Date;
  leaseUntil?: Date;
  leaseToken?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export function dueDelivery(now = new Date()) {
  return { expiresAt: { $gt: now }, $or: [
    { status: "pending" as const, availableAt: { $lte: now } },
    { status: "processing" as const, leaseUntil: { $lte: now } },
  ] };
}

export function deliveryLease(now = new Date()) {
  return { $set: { status: "processing" as const, leaseToken: randomUUID(),
    leaseUntil: new Date(now.getTime() + 60_000), updatedAt: now }, $inc: { attempts: 1 } };
}
