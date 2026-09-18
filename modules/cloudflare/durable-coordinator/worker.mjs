import { DurableObject } from "cloudflare:workers";
import {
  leaseIsLive,
  normalizeExpectedVersion,
  normalizeKey,
  normalizeTtlMs,
} from "./protocol.mjs";

export class FiduciaLeaseCoordinator extends DurableObject {
  async health() {
    return { ok: true, project: "fiducia-cloud", durable_object: "FiduciaLeaseCoordinator", storage: "sqlite", rpc: true };
  }

  async getState(key) {
    const storageKey = `kv:${normalizeKey(key)}`;
    return (await this.ctx.storage.get(storageKey)) ?? null;
  }

  async compareAndSet(key, expectedVersion, value) {
    const storageKey = `kv:${normalizeKey(key)}`;
    const expected = normalizeExpectedVersion(expectedVersion);
    return this.ctx.storage.transaction(async (txn) => {
      const current = (await txn.get(storageKey)) ?? null;
      const actualVersion = current?.version ?? 0;
      if (expected !== null && expected !== actualVersion) {
        throw new Error(`version_conflict:${actualVersion}`);
      }
      const record = { value, version: actualVersion + 1, updated_at: new Date().toISOString() };
      await txn.put(storageKey, record);
      return record;
    });
  }

  async acquireLease(resource, holder, ttlMs) {
    const normalizedResource = normalizeKey(resource);
    const normalizedHolder = normalizeKey(holder);
    const ttl = normalizeTtlMs(ttlMs);
    return this.ctx.storage.transaction(async (txn) => {
      const leaseKey = `lease:${normalizedResource}`;
      const counterKey = `lease-counter:${normalizedResource}`;
      const now = Date.now();
      const current = (await txn.get(leaseKey)) ?? null;
      if (leaseIsLive(current, now)) {
        if (current.holder !== normalizedHolder) return { acquired: false, lease: current };
        const renewed = { ...current, expires_at: now + ttl };
        await txn.put(leaseKey, renewed);
        return { acquired: true, lease: renewed };
      }
      const counter = (await txn.get(counterKey)) ?? 0;
      const fencingToken = Math.max(counter, current?.fencing_token ?? 0) + 1;
      const lease = { resource: normalizedResource, holder: normalizedHolder, fencing_token: fencingToken, expires_at: now + ttl };
      await txn.put(counterKey, fencingToken);
      await txn.put(leaseKey, lease);
      return { acquired: true, lease };
    });
  }

  async releaseLease(resource, holder, fencingToken) {
    const normalizedResource = normalizeKey(resource);
    const normalizedHolder = normalizeKey(holder);
    if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0) return false;
    return this.ctx.storage.transaction(async (txn) => {
      const leaseKey = `lease:${normalizedResource}`;
      const current = (await txn.get(leaseKey)) ?? null;
      if (!current || current.holder !== normalizedHolder || current.fencing_token !== fencingToken) return false;
      await txn.delete(leaseKey);
      return true;
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "fiducia-cloud-coordinator" });
    }
    if (url.pathname === "/do-health") {
      const name = url.searchParams.get("object") || "default";
      if (name.length > 256) return Response.json({ error: "invalid_object_name" }, { status: 400 });
      const stub = env.COORDINATOR.getByName(name);
      return Response.json(await stub.health());
    }
    return new Response("Not Found", { status: 404 });
  },
};
