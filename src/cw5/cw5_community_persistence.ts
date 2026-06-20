// CW5 Persistence — P1 Community Posts & Events
//
// Spec line: "[P1] persist community posts/events."
// Built on the same append-only discipline as the world delta store: community
// items are append-only with monotonic ids; edits/deletes are new records, not
// in-place mutation, so history is preserved (matches the ledger/ownership
// "history[]" philosophy in the spec).
//
// Storage is behind an interface so the in-memory impl (tests) swaps for a
// dcsgames_community_* table with no engine change — same pattern as the world store.

// ============================================================================
// TYPES
// ============================================================================

export type CommunityItemKind = 'post' | 'event';

export interface CommunityPost {
  item_id: string;             // monotonic-ish unique id
  kind: 'post';
  world_id: string;            // posts are world-scoped (a world's community)
  author_id: string;
  body: string;
  created_at: number;          // epoch ms
  edited_at: number | null;    // set when an edit record supersedes
  deleted_at: number | null;   // soft-delete
  reply_to: string | null;     // threaded replies (item_id of parent)
}

export interface CommunityEvent {
  item_id: string;
  kind: 'event';
  world_id: string;
  organizer_id: string;
  title: string;
  description: string;
  starts_at: number;           // epoch ms
  ends_at: number | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export type CommunityItem = CommunityPost | CommunityEvent;

// ============================================================================
// STORE INTERFACE (in-memory now → dcsgames_community_* later)
// ============================================================================

export interface CommunityStore {
  put(item: CommunityItem): Promise<void>;
  get(itemId: string): Promise<CommunityItem | null>;
  listByWorld(worldId: string, opts: { includeDeleted?: boolean; limit?: number; offset?: number }): Promise<CommunityItem[]>;
  listReplies(parentId: string): Promise<CommunityPost[]>;
}

export class InMemoryCommunityStore implements CommunityStore {
  private items = new Map<string, CommunityItem>();

  async put(item: CommunityItem) {
    this.items.set(item.item_id, structuredClone(item));
  }
  async get(itemId: string) {
    const i = this.items.get(itemId);
    return i ? structuredClone(i) : null;
  }
  async listByWorld(worldId: string, opts: { includeDeleted?: boolean; limit?: number; offset?: number } = {}) {
    const { includeDeleted = false, limit = 50, offset = 0 } = opts;
    return Array.from(this.items.values())
      .filter((i) => i.world_id === worldId && (includeDeleted || i.deleted_at === null))
      .sort((a, b) => b.created_at - a.created_at) // newest first
      .slice(offset, offset + limit)
      .map((i) => structuredClone(i));
  }
  async listReplies(parentId: string) {
    return Array.from(this.items.values())
      .filter((i): i is CommunityPost => i.kind === 'post' && i.reply_to === parentId && i.deleted_at === null)
      .sort((a, b) => a.created_at - b.created_at)
      .map((i) => structuredClone(i));
  }

  reset() {
    this.items.clear();
  }
}

// ============================================================================
// COMMUNITY SERVICE
// ============================================================================

let __seq = 0;
function nextId(prefix: string): string {
  __seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${__seq}`;
}

export class CommunityService {
  constructor(private store: CommunityStore, private now: () => number = () => Date.now()) {}

  // ---- posts ----

  async createPost(params: { world_id: string; author_id: string; body: string; reply_to?: string | null }): Promise<CommunityPost> {
    if (!params.world_id || !params.author_id) throw new Error('world_id and author_id required');
    if (!params.body || params.body.trim().length === 0) throw new Error('post body cannot be empty');
    if (params.body.length > 5000) throw new Error('post body exceeds 5000 chars');

    // If it's a reply, the parent must exist and not be deleted.
    if (params.reply_to) {
      const parent = await this.store.get(params.reply_to);
      if (!parent || parent.kind !== 'post') throw new Error('reply_to parent post not found');
      if (parent.deleted_at !== null) throw new Error('cannot reply to a deleted post');
    }

    const post: CommunityPost = {
      item_id: nextId('post'),
      kind: 'post',
      world_id: params.world_id,
      author_id: params.author_id,
      body: params.body,
      created_at: this.now(),
      edited_at: null,
      deleted_at: null,
      reply_to: params.reply_to ?? null,
    };
    await this.store.put(post);
    return post;
  }

  async editPost(itemId: string, authorId: string, newBody: string): Promise<CommunityPost> {
    const item = await this.store.get(itemId);
    if (!item || item.kind !== 'post') throw new Error('post not found');
    if (item.deleted_at !== null) throw new Error('cannot edit a deleted post');
    if (item.author_id !== authorId) throw new Error('only the author can edit');
    if (!newBody || newBody.trim().length === 0) throw new Error('post body cannot be empty');

    const updated: CommunityPost = { ...item, body: newBody, edited_at: this.now() };
    await this.store.put(updated);
    return updated;
  }

  async deletePost(itemId: string, requesterId: string): Promise<boolean> {
    const item = await this.store.get(itemId);
    if (!item || item.kind !== 'post') throw new Error('post not found');
    if (item.author_id !== requesterId) throw new Error('only the author can delete');
    if (item.deleted_at !== null) return true; // already deleted (idempotent)

    await this.store.put({ ...item, deleted_at: this.now() });
    return true;
  }

  // ---- events ----

  async createEvent(params: {
    world_id: string;
    organizer_id: string;
    title: string;
    description?: string;
    starts_at: number;
    ends_at?: number | null;
  }): Promise<CommunityEvent> {
    if (!params.world_id || !params.organizer_id) throw new Error('world_id and organizer_id required');
    if (!params.title || params.title.trim().length === 0) throw new Error('event title required');
    if (!params.starts_at) throw new Error('event starts_at required');
    if (params.ends_at != null && params.ends_at < params.starts_at) {
      throw new Error('event ends_at cannot be before starts_at');
    }

    const event: CommunityEvent = {
      item_id: nextId('event'),
      kind: 'event',
      world_id: params.world_id,
      organizer_id: params.organizer_id,
      title: params.title,
      description: params.description ?? '',
      starts_at: params.starts_at,
      ends_at: params.ends_at ?? null,
      created_at: this.now(),
      edited_at: null,
      deleted_at: null,
    };
    await this.store.put(event);
    return event;
  }

  async cancelEvent(itemId: string, requesterId: string): Promise<boolean> {
    const item = await this.store.get(itemId);
    if (!item || item.kind !== 'event') throw new Error('event not found');
    if (item.organizer_id !== requesterId) throw new Error('only the organizer can cancel');
    if (item.deleted_at !== null) return true;

    await this.store.put({ ...item, deleted_at: this.now() });
    return true;
  }

  // ---- feeds ----

  async getWorldFeed(worldId: string, opts: { limit?: number; offset?: number } = {}): Promise<CommunityItem[]> {
    return this.store.listByWorld(worldId, opts);
  }

  async getUpcomingEvents(worldId: string, now: number = this.now()): Promise<CommunityEvent[]> {
    const items = await this.store.listByWorld(worldId, { limit: 1000 });
    return items
      .filter((i): i is CommunityEvent => i.kind === 'event' && i.starts_at >= now)
      .sort((a, b) => a.starts_at - b.starts_at);
  }

  async getThread(parentId: string): Promise<{ parent: CommunityPost | null; replies: CommunityPost[] }> {
    const parent = await this.store.get(parentId);
    const replies = await this.store.listReplies(parentId);
    return {
      parent: parent && parent.kind === 'post' ? parent : null,
      replies,
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export const communityService = new CommunityService(new InMemoryCommunityStore());
