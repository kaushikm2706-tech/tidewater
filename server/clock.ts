import type { Store } from './db';

export interface Clock {
  readonly kind: 'virtual' | 'real';
  now(): number;
}

export class RealClock implements Clock {
  readonly kind = 'real' as const;
  now() {
    return Date.now();
  }
}

/** Simulator time. Persisted so the demo survives a restart; advanced explicitly by the user. */
export class VirtualClock implements Clock {
  readonly kind = 'virtual' as const;
  constructor(private store: Store, private initial: number) {}
  now() {
    const v = this.store.getMeta('sim_now');
    return v ? Number(v) : this.initial;
  }
  set(ms: number) {
    this.store.setMeta('sim_now', String(ms));
  }
}
