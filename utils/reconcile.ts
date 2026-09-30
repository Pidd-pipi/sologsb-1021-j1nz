import type { DictionaryEntry, DialectVariant, EntryStatus, ReviewComment } from '../types/dictionary';
import { normalizeWord } from './dictionary';

export interface BackupData {
  exportedAt?: string;
  entries: DictionaryEntry[];
  versions?: unknown[];
  audit?: unknown[];
}

export type MatchBasis = 'archiveNo' | 'fallback';
export type DefinitionChoice = 'keep' | 'incoming' | 'combine';

export interface PendingItem {
  key: string;
  incoming: DictionaryEntry;
  archiveNo: string;
  basis: MatchBasis;
  kind: 'multiMatch' | 'definitionDiverge';
  candidates: DictionaryEntry[];
  targetId?: string;
  definitionChoice?: DefinitionChoice;
}

export interface ReconcileOperation {
  kind: 'create' | 'merge';
  incoming: DictionaryEntry;
  targetId?: string;
  definitionChoice?: DefinitionChoice;
}

export interface ReconcileSummary {
  total: number;
  deduped: number;
  byArchiveNo: number;
  byFallback: number;
  creates: number;
  merges: number;
  pendingCount: number;
}

export interface ReconcilePlan {
  summary: ReconcileSummary;
  autoOperations: ReconcileOperation[];
  pending: PendingItem[];
}

export interface PendingDecision {
  action: 'merge' | 'create' | 'skip';
  targetId?: string;
  definitionChoice?: DefinitionChoice;
}

const SNAPSHOT_KEY = 'sologsb-1021-dictionary-v1';
const QUOTA_CHARS = 2_500_000; // ~5MB UTF-16，保守上限
const CAPACITY_MARGIN = 4_000;

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const validStatus = (value: unknown): value is EntryStatus =>
  value === 'draft' || value === 'review' || value === 'disputed' || value === 'confirmed';

/** 解析备份文件，校验 entries 数组。 */
export function parseBackup(text: string): BackupData {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('备份文件不是有效的 JSON');
  }
  if (!data || typeof data !== 'object') throw new Error('备份文件格式不正确');
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.entries)) throw new Error('备份文件缺少 entries 词条数组');
  return {
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : undefined,
    entries: obj.entries as DictionaryEntry[],
    versions: Array.isArray(obj.versions) ? obj.versions : [],
    audit: Array.isArray(obj.audit) ? obj.audit : []
  };
}

/** 词条的方言集合（去重、排序）。 */
export function dialectSet(entry: DictionaryEntry): string[] {
  return [...new Set((entry.dialectVariants ?? []).map((variant) => variant.dialect.trim()).filter(Boolean))].sort();
}

/** 兜底匹配键：统一词形 + 词性。 */
function fallbackKey(entry: DictionaryEntry): string {
  return `${normalizeWord(entry.headword)}|${(entry.partOfSpeech ?? '').trim()}`;
}

function recordKey(entry: DictionaryEntry): string {
  const archiveNo = (entry.archiveNo ?? '').trim();
  if (archiveNo) return `a:${archiveNo}`;
  return `f:${fallbackKey(entry)}|${dialectSet(entry).join(',')}`;
}

function mergeDuplicateRecord(keep: DictionaryEntry, extra: DictionaryEntry): void {
  const commentIds = new Set(keep.reviewerComments.map((comment) => comment.id));
  const commentKeys = new Set(keep.reviewerComments.map((comment) => `${comment.field}|${normalizeWord(comment.message)}`));
  for (const comment of extra.reviewerComments ?? []) {
    const key = `${comment.field}|${normalizeWord(comment.message)}`;
    if (!commentIds.has(comment.id) && !commentKeys.has(key)) {
      keep.reviewerComments.push(clone(comment));
      commentIds.add(comment.id);
      commentKeys.add(key);
    }
  }
  const synonyms = new Set(keep.synonyms.map(normalizeWord));
  for (const synonym of extra.synonyms ?? []) {
    const normalized = normalizeWord(synonym);
    if (normalized && !synonyms.has(normalized)) {
      synonyms.add(normalized);
      keep.synonyms.push(synonym);
    }
  }
  for (const variant of extra.dialectVariants ?? []) mergeVariant(keep, variant);
  for (const example of extra.examples ?? []) {
    const text = normalizeWord(example.text ?? '');
    if (text && !keep.examples.some((item) => normalizeWord(item.text ?? '') === text)) keep.examples.push(clone(example));
  }
  for (const source of extra.sources ?? []) {
    const key = normalizeWord(`${source.title ?? ''}|${source.citation ?? ''}`);
    if (key && !keep.sources.some((item) => normalizeWord(`${item.title ?? ''}|${item.citation ?? ''}`) === key)) keep.sources.push(clone(source));
  }
}

/** 按档案编号去重；编号缺失时按统一词形+词性+方言组合去重。重复记录只挂一次，意见与同义词并入首条。 */
export function dedupeRecords(records: DictionaryEntry[]): DictionaryEntry[] {
  const map = new Map<string, DictionaryEntry>();
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const key = recordKey(raw);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, clone(raw));
    } else {
      mergeDuplicateRecord(existing, raw);
    }
  }
  return [...map.values()];
}

/**
 * 匹配词条：先按档案编号认词条；编号缺失时用统一词形、词性和方言组合匹配。
 * 方言组合：双方有交集即命中；任一方无方言信息时退回词形+词性匹配。
 */
export function matchRecord(incoming: DictionaryEntry, entries: DictionaryEntry[]): { basis: MatchBasis; matches: DictionaryEntry[] } {
  const archiveNo = (incoming.archiveNo ?? '').trim();
  if (archiveNo) {
    const matches = entries.filter((entry) => (entry.archiveNo ?? '').trim() === archiveNo);
    if (matches.length) return { basis: 'archiveNo', matches };
  }
  const key = fallbackKey(incoming);
  const incomingDialects = dialectSet(incoming);
  const matches = entries.filter((entry) => {
    if (fallbackKey(entry) !== key) return false;
    const targetDialects = dialectSet(entry);
    if (!incomingDialects.length || !targetDialects.length) return true;
    return incomingDialects.some((dialect) => targetDialects.includes(dialect));
  });
  return { basis: 'fallback', matches };
}

/** 释义是否都有新值（双方非空且不一致）。 */
export function definitionDiverges(incoming: DictionaryEntry, target: DictionaryEntry): boolean {
  const inc = (incoming.definition ?? '').trim();
  const tgt = (target.definition ?? '').trim();
  return !!inc && !!tgt && inc !== tgt;
}

/** 构建对账计划：自动合并项 + 待决项。待决项未处理完不入库。 */
export function buildReconcilePlan(entries: DictionaryEntry[], backup: BackupData): ReconcilePlan {
  const raw = (backup.entries ?? []).filter((entry) => entry && typeof entry === 'object');
  const deduped = dedupeRecords(raw);
  const autoOperations: ReconcileOperation[] = [];
  const pending: PendingItem[] = [];
  let byArchiveNo = 0;
  let byFallback = 0;
  let creates = 0;
  let merges = 0;

  deduped.forEach((incoming, index) => {
    const archiveNo = (incoming.archiveNo ?? '').trim();
    const { basis, matches } = matchRecord(incoming, entries);
    if (matches.length === 0) {
      creates += 1;
      autoOperations.push({ kind: 'create', incoming });
      return;
    }
    if (matches.length === 1) {
      const target = matches[0]!;
      if (basis === 'archiveNo') byArchiveNo += 1; else byFallback += 1;
      if (definitionDiverges(incoming, target)) {
        pending.push({
          key: `p-${index}`,
          incoming, archiveNo, basis,
          kind: 'definitionDiverge',
          candidates: [target],
          targetId: target.id
        });
      } else {
        merges += 1;
        autoOperations.push({ kind: 'merge', incoming, targetId: target.id });
      }
      return;
    }
    if (basis === 'archiveNo') byArchiveNo += 1; else byFallback += 1;
    pending.push({
      key: `p-${index}`,
      incoming, archiveNo, basis,
      kind: 'multiMatch',
      candidates: matches
    });
  });

  return {
    summary: { total: raw.length, deduped: deduped.length, byArchiveNo, byFallback, creates, merges, pendingCount: pending.length },
    autoOperations,
    pending
  };
}

function normalizeIncoming(raw: DictionaryEntry): DictionaryEntry {
  const entry = clone(raw);
  entry.id = uid('entry');
  entry.archiveNo = (raw.archiveNo ?? '').trim() || undefined;
  entry.dialectVariants = Array.isArray(entry.dialectVariants)
    ? entry.dialectVariants.map((variant) => ({ ...variant, id: uid('variant'), archiveNo: (variant.archiveNo ?? '').trim() || undefined }))
    : [];
  entry.examples = Array.isArray(entry.examples) ? entry.examples.map((example) => ({ ...example, id: uid('example') })) : [];
  entry.sources = Array.isArray(entry.sources) ? entry.sources.map((source) => ({ ...source, id: uid('source') })) : [];
  entry.synonyms = Array.isArray(entry.synonyms) ? entry.synonyms.filter(Boolean) : [];
  entry.reviewerComments = Array.isArray(entry.reviewerComments)
    ? entry.reviewerComments.map((comment) => ({
      ...comment,
      id: uid('comment'),
      replies: Array.isArray(comment.replies) ? comment.replies.map((reply) => ({ ...reply, id: uid('reply') })) : []
    }))
    : [];
  entry.status = validStatus(entry.status) ? entry.status : 'draft';
  entry.createdAt = entry.createdAt || new Date().toISOString();
  entry.updatedAt = new Date().toISOString();
  return entry;
}

function mergeVariant(target: DictionaryEntry, variant: DialectVariant): void {
  const variantArchive = (variant.archiveNo ?? '').trim();
  let existing = variantArchive
    ? target.dialectVariants.find((item) => (item.archiveNo ?? '').trim() === variantArchive)
    : undefined;
  if (!existing) {
    const dialect = (variant.dialect ?? '').trim();
    const form = normalizeWord(variant.form ?? '');
    existing = target.dialectVariants.find((item) => (item.dialect ?? '').trim() === dialect && normalizeWord(item.form ?? '') === form);
  }
  if (existing) {
    if (!existing.dialect && variant.dialect) existing.dialect = variant.dialect;
    if (!existing.form && variant.form) existing.form = variant.form;
    if (!existing.pronunciation && variant.pronunciation) existing.pronunciation = variant.pronunciation;
    if (!existing.note && variant.note) existing.note = variant.note;
    if (!existing.archiveNo && variant.archiveNo) existing.archiveNo = variant.archiveNo;
  } else {
    target.dialectVariants.push({ ...clone(variant), id: uid('variant'), archiveNo: (variant.archiveNo ?? '').trim() || undefined });
  }
}

function mergeInto(target: DictionaryEntry, incoming: DictionaryEntry, definitionChoice?: DefinitionChoice): void {
  // 标量字段：仅补充空值，不覆盖已有词形/发音/词性/备注
  if (!target.headword && incoming.headword) target.headword = incoming.headword;
  if (!target.pronunciation && incoming.pronunciation) target.pronunciation = incoming.pronunciation;
  if (!target.partOfSpeech && incoming.partOfSpeech) target.partOfSpeech = incoming.partOfSpeech;
  if (!target.notes && incoming.notes) target.notes = incoming.notes;

  // 释义：双方都有新值时按选择处理；释义一变，已确认状态失效
  const incDef = (incoming.definition ?? '').trim();
  const tgtDef = (target.definition ?? '').trim();
  let definitionChanged = false;
  if (incDef) {
    if (!tgtDef) {
      target.definition = incoming.definition;
      definitionChanged = true;
    } else if (incDef !== tgtDef) {
      if (definitionChoice === 'incoming') {
        target.definition = incoming.definition;
        definitionChanged = true;
      } else if (definitionChoice === 'combine') {
        target.definition = `${tgtDef}；${incDef}`;
        definitionChanged = true;
      }
    }
  }
  if (definitionChanged && target.status === 'confirmed') target.status = 'draft';

  // 方言变体：按档案编号认变体，再按方言+词形匹配，否则新增
  for (const variant of incoming.dialectVariants ?? []) mergeVariant(target, variant);

  // 例句：按原文去重
  for (const example of incoming.examples ?? []) {
    const text = (example.text ?? '').trim();
    if (text && !target.examples.some((item) => normalizeWord(item.text ?? '') === normalizeWord(text))) {
      target.examples.push({ ...clone(example), id: uid('example') });
    }
  }

  // 来源：按标题+引用去重
  for (const source of incoming.sources ?? []) {
    const key = normalizeWord(`${source.title ?? ''}|${source.citation ?? ''}`);
    if (key && !target.sources.some((item) => normalizeWord(`${item.title ?? ''}|${item.citation ?? ''}`) === key)) {
      target.sources.push({ ...clone(source), id: uid('source') });
    }
  }

  // 同义词：统一词形去重后并入
  const synonyms = new Set(target.synonyms.map(normalizeWord));
  for (const synonym of incoming.synonyms ?? []) {
    const normalized = normalizeWord(synonym);
    if (normalized && !synonyms.has(normalized)) {
      synonyms.add(normalized);
      target.synonyms.push(synonym);
    }
  }

  // 审校意见：按 id 再按字段+内容去重，跟到对应词条
  const commentIds = new Set(target.reviewerComments.map((comment) => comment.id));
  const commentKeys = new Set(target.reviewerComments.map((comment) => `${comment.field}|${normalizeWord(comment.message)}`));
  for (const comment of incoming.reviewerComments ?? []) {
    const key = `${comment.field}|${normalizeWord(comment.message)}`;
    if (commentIds.has(comment.id) || commentKeys.has(key)) continue;
    target.reviewerComments.push({
      ...clone(comment),
      id: uid('comment'),
      replies: (comment.replies ?? []).map((reply) => ({ ...clone(reply), id: uid('reply') }))
    });
  }
}

export function applyOperation(entries: DictionaryEntry[], operation: ReconcileOperation): void {
  if (operation.kind === 'create') {
    entries.push(normalizeIncoming(operation.incoming));
    return;
  }
  const target = entries.find((entry) => entry.id === operation.targetId);
  if (!target) return;
  mergeInto(target, operation.incoming, operation.definitionChoice);
}

/** 待决项是否已处理完（没处理完不入库）。 */
export function isPendingResolved(item: PendingItem, decision: PendingDecision | undefined): boolean {
  if (!decision) return false;
  if (item.kind === 'definitionDiverge') return !!decision.definitionChoice;
  if (decision.action === 'create' || decision.action === 'skip') return true;
  if (decision.action === 'merge' && decision.targetId) {
    const target = item.candidates.find((entry) => entry.id === decision.targetId);
    if (!target) return false;
    if (definitionDiverges(item.incoming, target)) return !!decision.definitionChoice;
    return true;
  }
  return false;
}

/** 待决决策转成入库操作。 */
export function pendingToOperations(pending: PendingItem[], decisions: Record<string, PendingDecision>): ReconcileOperation[] {
  const operations: ReconcileOperation[] = [];
  for (const item of pending) {
    const decision = decisions[item.key];
    if (!decision) continue;
    if (item.kind === 'definitionDiverge') {
      if (decision.definitionChoice) operations.push({ kind: 'merge', incoming: item.incoming, targetId: item.targetId, definitionChoice: decision.definitionChoice });
    } else if (decision.action === 'create') {
      operations.push({ kind: 'create', incoming: item.incoming });
    } else if (decision.action === 'merge' && decision.targetId) {
      operations.push({ kind: 'merge', incoming: item.incoming, targetId: decision.targetId, definitionChoice: decision.definitionChoice });
    }
  }
  return operations;
}

/** 当前本地容量预算（可写入的快照字符数）。 */
export function detectCapacityBudget(): number {
  try {
    if (typeof localStorage === 'undefined') return QUOTA_CHARS;
    let used = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) used += (localStorage.getItem(key) ?? '').length + key.length;
    }
    const old = (localStorage.getItem(SNAPSHOT_KEY) ?? '').length + SNAPSHOT_KEY.length;
    return Math.max(0, QUOTA_CHARS - used + old - CAPACITY_MARGIN);
  } catch {
    return QUOTA_CHARS;
  }
}

/** 估算提交后的快照大小（含版本与审计增长）。 */
export function estimateSnapshotSize(entries: DictionaryEntry[], versions: unknown[], audit: unknown[], extraBatches: number): number {
  const newVersionSize = JSON.stringify(entries).length + 300;
  const projectedVersionsSize = JSON.stringify(versions).length + extraBatches * newVersionSize;
  return JSON.stringify({ revision: 1, entries, versions: { length: versions.length + extraBatches }, audit }).length + projectedVersionsSize;
}
