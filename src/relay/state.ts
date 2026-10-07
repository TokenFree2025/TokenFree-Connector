import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Fault, type Session } from "../protocol/index.js";
export type Device = {
  id: string;
  name: string;
  account: string;
  tokenHash: string;
  revoked: boolean;
  scopes: Session[];
  status: any;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class RelayState {
  pairs = new Map<
    string,
    {
      deviceId: string;
      name: string;
      secretHash: string;
      codeHash: string;
      expires: number;
      tries: number;
      account?: string;
      used: boolean;
    }
  >();
  devices = new Map<string, Device>();
  attempts = new Map<string, { count: number; until: number }>();
  constructor(readonly now = () => Date.now()) {}
  start(deviceId: string, name: string) {
    for (const [k, p] of this.pairs)
      if (p.expires < this.now() - 300000) this.pairs.delete(k);
    if (this.pairs.size >= 200) throw new Fault("BACKPRESSURE");
    const id = randomUUID(),
      secret = randomBytes(32).toString("base64url"),
      code = String(randomBytes(4).readUInt32BE() % 100000000).padStart(8, "0");
    const expires = this.now() + 300000;
    this.pairs.set(id, {
      deviceId,
      name,
      secretHash: hash(secret),
      codeHash: hash(code),
      expires,
      tries: 0,
      used: false,
    });
    return { id, secret, code, expires };
  }
  private pair(id: string) {
    const p = this.pairs.get(id);
    if (!p) throw new Fault("PAIR_EXPIRED");
    if (p.used) throw new Fault("PAIR_USED");
    if (p.expires <= this.now()) throw new Fault("PAIR_EXPIRED");
    if (p.tries >= 5) throw new Fault("PAIR_LOCKED");
    return p;
  }
  claim(id: string, code: string, account: string) {
    const rate = this.attempts.get(account);
    if (rate && rate.until > this.now() && rate.count >= 5)
      throw new Fault("PAIR_LOCKED");
    const p = this.pair(id);
    if (!timingSafeEqual(Buffer.from(p.codeHash), Buffer.from(hash(code)))) {
      p.tries++;
      this.attempts.set(account, {
        count: rate && rate.until > this.now() ? rate.count + 1 : 1,
        until: this.now() + 300000,
      });
      throw new Fault("INVALID_REQUEST");
    }
    if (p.account) throw new Fault("PAIR_USED");
    p.account = account;
    return { account, deviceName: p.name };
  }
  poll(id: string, secret: string) {
    const p = this.pair(id);
    if (hash(secret) !== p.secretHash) throw new Fault("UNAUTHORIZED");
    return { account: p.account ?? null, expires: p.expires };
  }
  confirm(id: string, secret: string) {
    const p = this.pair(id);
    if (hash(secret) !== p.secretHash) throw new Fault("UNAUTHORIZED");
    if (!p.account) throw new Fault("PAIR_PENDING");
    if (this.devices.has(p.deviceId) && !this.devices.get(p.deviceId)!.revoked)
      throw new Fault("FORBIDDEN");
    p.used = true;
    const token = randomBytes(32).toString("base64url");
    this.devices.set(p.deviceId, {
      id: p.deviceId,
      name: p.name,
      account: p.account,
      tokenHash: hash(token),
      revoked: false,
      scopes: [],
      status: {},
    });
    return { deviceId: p.deviceId, token, account: p.account };
  }
  auth(token: string) {
    const h = hash(token);
    const d = [...this.devices.values()].find(
      (d) =>
        !d.revoked && timingSafeEqual(Buffer.from(d.tokenHash), Buffer.from(h)),
    );
    if (!d) throw new Fault("UNAUTHORIZED");
    return d;
  }
  owned(id: string, account: string) {
    const d = this.devices.get(id);
    if (!d || d.revoked || d.account !== account) throw new Fault("FORBIDDEN");
    return d;
  }
  revoke(d: Device) {
    d.revoked = true;
    d.tokenHash = hash(randomBytes(32).toString("hex"));
    d.scopes = [];
    d.status = {};
  }
}
