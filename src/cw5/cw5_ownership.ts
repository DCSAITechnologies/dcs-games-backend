// CW5 Persistence — Ownership Store (dcsgames_ownership) · PURE PROVENANCE
//
// Manager ruling (option a): build NOW as pure provenance. "Who owns what + the
// transfer chain." NO money fields — no balances, transactions, purchases, or
// entitlements (those stay money-DARK with P5/P6).
//
// Integration (from _SHARED_Day0/_frozen_lane_contracts/CW7_C4_atlas_trust.contract.md):
//   - Each ownership record is Atlas-signed via the LIVE ed25519 interface
//     (injected `signReceipt`/`verifyReceiptSig`; deterministic stub in tests).
//   - Records chain via prev_receipt_id so CW7's buildOwnershipHistory can prove
//     chain_intact && signed → `verified`.
//   - History entries serialize to CW7's exact shape: {builder_id, action, ts, receipt_id}.
//
// Consumers: CW4 (inventory handler integrates against ownership), CW7 (signing +
// chain verification for trust/verified), CW6 (provenance display, money-DARK).

// ============================================================================
// SIGNING INTERFACE (injected — live ed25519 in prod, stub in tests)
// ============================================================================

export interface AtlasSigner {
  // Signs the canonical receipt payload, returns the signature string.
  signReceipt(payload: string): string;
  // Verifies a signature against the payload. Forged/unsigned → false.
  verifyReceiptSig(payload: string, sig: string): boolean;
}

// Deterministic non-crypto stub for tests/local. Production injects the real
// atlas-sign ed25519 (`issueReceipt`/`verifyReceiptSig`) — same interface.
export class StubSigner implements AtlasSigner {
  constructor(private secret = 'stub-secret') {}
  signReceipt(payload: string): string {
    // FNV-1a-ish deterministic hash → hex. NOT cryptographic; stub only.
    let h = 0x811c9dc5;
    const s = `${this.secret}|${payload}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `stubsig_${(h >>> 0).toString(16)}`;
  }
  verifyReceiptSig(payload: string, sig: string): boolean {
    return this.signReceipt(payload) === sig;
  }
}

// ============================================================================
// TYPES
// ============================================================================

export type OwnershipAction = 'create' | 'transfer';
export type SubjectType = 'world' | 'asset' | 'object';

// The signed receipt — shape aligned to CW7's authoritative receipt
// ({receipt_id, world_id, builder_id, action, prev_receipt_id, ts, sig}),
// generalized so subject can be a world/asset/object.
export interface OwnershipReceipt {
  receipt_id: string;
  subject_type: SubjectType;
  subject_id: string;
  owner_id: string;           // builder_id taking ownership in this entry
  action: OwnershipAction;    // 'create' (base) | 'transfer'
  prev_receipt_id: string | null; // chains to the prior record; null at create
  ts: string;                 // ISO 8601
  sig: string;                // Atlas ed25519 signature over the canonical payload
}

// CW7's exact history-entry shape (for buildOwnershipHistory consumption).
export interface CW7HistoryEntry {
  builder_id: string;
  action: OwnershipAction;
  ts: string;
  receipt_id: string;
}

// The stored ownership record (dcsgames_ownership row).
export interface OwnershipRecord {
  subject_type: SubjectType;
  subject_id: string;
  owner_id: string;           // CURRENT owner (head of chain)
  created_at: string;         // ts of the create record (base, immutable)
  history: OwnershipReceipt[]; // append-only chain, create first → transfers
}

// ============================================================================
// CANONICAL PAYLOAD (what gets signed — stable, sorted, deterministic)
// ============================================================================

function canonicalPayload(r: Omit<OwnershipReceipt, 'sig'>): string {
  // Sign over every field except the sig itself, in fixed order.
  return [
    r.receipt_id,
    r.subject_type,
    r.subject_id,
    r.owner_id,
    r.action,
    r.prev_receipt_id ?? 'null',
    r.ts,
  ].join('|');
}

// ============================================================================
// STORE INTERFACE
// ============================================================================

export interface OwnershipStore {
  get(subjectType: SubjectType, subjectId: string): Promise<OwnershipRecord | null>;
  put(record: OwnershipRecord): Promise<void>;
  byOwner(ownerId: string): Promise<OwnershipRecord[]>;
}

export class InMemoryOwnershipStore implements OwnershipStore {
  private records = new Map<string, OwnershipRecord>();
  private key(t: SubjectType, id: string) {
    return `${t}::${id}`;
  }
  async get(t: SubjectType, id: string) {
    const r = this.records.get(this.key(t, id));
    return r ? structuredClone(r) : null;
  }
  async put(record: OwnershipRecord) {
    this.records.set(this.key(record.subject_type, record.subject_id), structuredClone(record));
  }
  async byOwner(ownerId: string) {
    return Array.from(this.records.values())
      .filter((r) => r.owner_id === ownerId)
      .map((r) => structuredClone(r));
  }
  reset() {
    this.records.clear();
  }
}

// ============================================================================
// OWNERSHIP SERVICE
// ============================================================================

let __rid = 0;
function nextReceiptId(): string {
  __rid += 1;
  return `own_${Date.now().toString(36)}_${__rid}`;
}

export class OwnershipService {
  constructor(
    private store: OwnershipStore,
    private signer: AtlasSigner,
    private now: () => string = () => new Date().toISOString()
  ) {}

  private sign(receiptNoSig: Omit<OwnershipReceipt, 'sig'>): OwnershipReceipt {
    const sig = this.signer.signReceipt(canonicalPayload(receiptNoSig));
    return { ...receiptNoSig, sig };
  }

  /**
   * Create the base ownership record (the genesis of the chain).
   * Base record is immutable: once created, create cannot run again for the subject.
   */
  async create(params: { subject_type: SubjectType; subject_id: string; owner_id: string }): Promise<OwnershipRecord> {
    const existing = await this.store.get(params.subject_type, params.subject_id);
    if (existing) throw new Error(`ownership already exists for ${params.subject_type}:${params.subject_id} (base is immutable)`);

    const ts = this.now();
    const receipt = this.sign({
      receipt_id: nextReceiptId(),
      subject_type: params.subject_type,
      subject_id: params.subject_id,
      owner_id: params.owner_id,
      action: 'create',
      prev_receipt_id: null,
      ts,
    });

    const record: OwnershipRecord = {
      subject_type: params.subject_type,
      subject_id: params.subject_id,
      owner_id: params.owner_id,
      created_at: ts,
      history: [receipt],
    };
    await this.store.put(record);
    return record;
  }

  /**
   * Transfer ownership: append a signed 'transfer' receipt chained to the head.
   * Append-only — prior history is never mutated. Current owner only may transfer.
   */
  async transfer(params: {
    subject_type: SubjectType;
    subject_id: string;
    from_owner_id: string;
    to_owner_id: string;
  }): Promise<OwnershipRecord> {
    const record = await this.store.get(params.subject_type, params.subject_id);
    if (!record) throw new Error(`ownership not found for ${params.subject_type}:${params.subject_id}`);
    if (record.owner_id !== params.from_owner_id) {
      throw new Error(`only the current owner can transfer (current=${record.owner_id}, got=${params.from_owner_id})`);
    }
    if (params.to_owner_id === record.owner_id) {
      throw new Error('cannot transfer to the current owner');
    }

    const head = record.history[record.history.length - 1];
    const receipt = this.sign({
      receipt_id: nextReceiptId(),
      subject_type: params.subject_type,
      subject_id: params.subject_id,
      owner_id: params.to_owner_id,
      action: 'transfer',
      prev_receipt_id: head.receipt_id,
      ts: this.now(),
    });

    record.history.push(receipt);   // append-only
    record.owner_id = params.to_owner_id; // head moves
    await this.store.put(record);
    return record;
  }

  async getRecord(subjectType: SubjectType, subjectId: string): Promise<OwnershipRecord | null> {
    return this.store.get(subjectType, subjectId);
  }

  async worldsOwnedBy(ownerId: string): Promise<OwnershipRecord[]> {
    return this.store.byOwner(ownerId);
  }

  /**
   * Verify the full chain: every receipt signature valid AND prev_receipt_id links
   * form an unbroken chain from create to head. This is what CW7's `verified`
   * (chain_intact && signed) is computed from.
   */
  verifyChain(record: OwnershipRecord): { chain_intact: boolean; signed: boolean; verified: boolean } {
    let signed = true;
    let chain_intact = true;

    for (let i = 0; i < record.history.length; i++) {
      const r = record.history[i];
      // signature check
      const { sig, ...noSig } = r;
      if (!this.signer.verifyReceiptSig(canonicalPayload(noSig), sig)) signed = false;
      // chain check
      if (i === 0) {
        if (r.action !== 'create' || r.prev_receipt_id !== null) chain_intact = false;
      } else {
        if (r.prev_receipt_id !== record.history[i - 1].receipt_id) chain_intact = false;
        if (r.action !== 'transfer') chain_intact = false;
      }
    }
    // head owner must equal record.owner_id
    if (record.history.length > 0 && record.history[record.history.length - 1].owner_id !== record.owner_id) {
      chain_intact = false;
    }

    return { chain_intact, signed, verified: chain_intact && signed };
  }

  /**
   * Export history in CW7's exact consumption shape:
   * [{builder_id, action, ts, receipt_id}].
   */
  toCW7History(record: OwnershipRecord): CW7HistoryEntry[] {
    return record.history.map((r) => ({
      builder_id: r.owner_id,
      action: r.action,
      ts: r.ts,
      receipt_id: r.receipt_id,
    }));
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createOwnershipService(signer?: AtlasSigner): OwnershipService {
  return new OwnershipService(new InMemoryOwnershipStore(), signer ?? new StubSigner());
}
