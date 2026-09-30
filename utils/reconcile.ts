import type { DictionaryEntry } from '~/types/dictionary';
import type {
  IncomingRecord, ReconcileError, ReconcileItem, ReconcilePlan
} from '~/types/reconcile';
import { normalizeWord } from './dictionary';

const cleanText = (value: unknown): string => (typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim());

const toStringArray = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => cleanText(item)).filter(Boolean) : []);

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);

let refCounter = 0;
const nextRef = () => {
  refCounter += 1;
  return `A${String(refCounter).padStart(3, '0')}`;
};

/** 统一词形 + 词性 + 方言组合：主词形与全部方言词形共同参与匹配 */
const entryDialects = (entry: { dialectVariants: Array<{ dialect: string }> }) =>
  new Set(entry.dialectVariants.map((variant) => cleanText(variant.dialect)).filter(Boolean));

export const entryKey = (headword: string, partOfSpeech: string, dialects: Iterable<string>) =>
  [normalizeWord(headword), normalizeWord(partOfSpeech), [...dialects].map(normalizeWord).filter(Boolean).sort().join('|')].join('@');

const recordDialects = (record: IncomingRecord) => new Set(record.dialectVariants.map((variant) => cleanText(variant.dialect)).filter(Boolean));

/** 把各种可能的备份结构规整成 IncomingRecord；无法识别时抛错 */
export function normalizeIncomingRecord(raw: unknown, sourceName: string, index: number): IncomingRecord {
  if (typeof raw !== 'object' || raw === null) throw new Error(`第 ${index + 1} 条不是对象`);
  const obj = raw as Record<string, unknown>;
  const headword = cleanText(obj.headword ?? obj.word ?? obj.form ?? obj.lemma);
  if (!headword) throw new Error(`第 ${index + 1} 条缺少统一词形（headword）`);
  return {
    archiveId: cleanText(obj.archiveId ?? obj.archiveNo ?? obj.archivalId ?? obj.refNo ?? obj.id),
    headword,
    pronunciation: cleanText(obj.pronunciation ?? obj.ipa),
    partOfSpeech: cleanText(obj.partOfSpeech ?? obj.pos),
    definition: cleanText(obj.definition ?? obj.gloss ?? obj.meaning),
    dialectVariants: asArray<Record<string, unknown>>(obj.dialectVariants ?? obj.variants).map((variant, i) => ({
      id: cleanText(variant.id) || `in-variant-${index}-${i}`,
      dialect: cleanText(variant.dialect ?? variant.name),
      form: cleanText(variant.form ?? variant.word),
      pronunciation: cleanText(variant.pronunciation ?? variant.ipa),
      note: cleanText(variant.note)
    })),
    examples: asArray<Record<string, unknown>>(obj.examples ?? obj.sentences).map((example, i) => ({
      id: cleanText(example.id) || `in-example-${index}-${i}`,
      text: cleanText(example.text ?? example.sentence),
      translation: cleanText(example.translation ?? example.gloss),
      source: cleanText(example.source)
    })),
    sources: asArray<Record<string, unknown>>(obj.sources ?? obj.references).map((source, i) => ({
      id: cleanText(source.id) || `in-source-${index}-${i}`,
      title: cleanText(source.title ?? source.name),
      citation: cleanText(source.citation),
      url: cleanText(source.url ?? source.link)
    })),
    synonyms: toStringArray(obj.synonyms ?? obj.syn),
    notes: cleanText(obj.notes ?? obj.note ?? obj.editorNote),
    status: ['draft', 'review', 'disputed', 'confirmed'].includes(cleanText(obj.status)) ? cleanText(obj.status) as DictionaryEntry['status'] : undefined,
    reviewerComments: asArray<Record<string, unknown>>(obj.reviewerComments ?? obj.comments ?? obj.reviews).map((comment, i) => ({
      id: cleanText(comment.id) || `in-comment-${index}-${i}`,
      field: cleanText(comment.field) || 'definition',
      author: cleanText(comment.author ?? comment.reviewer),
      message: cleanText(comment.message ?? comment.text ?? comment.content),
      status: cleanText(comment.status) === 'resolved' ? 'resolved' as const : 'open' as const,
      createdAt: cleanText(comment.createdAt ?? comment.at) || new Date(0).toISOString(),
      replies: asArray<Record<string, unknown>>(comment.replies).map((reply, j) => ({
        id: cleanText(reply.id) || `in-reply-${index}-${i}-${j}`,
        author: cleanText(reply.author),
        message: cleanText(reply.message ?? reply.text),
        createdAt: cleanText(reply.createdAt ?? reply.at) || new Date(0).toISOString()
      }))
    })).filter((comment) => comment.message)
  };
}

/** 解析一套或两套备份文件（JSON），返回记录数组与来源名 */
export async function parseBackupFiles(files: File[]): Promise<{ records: Array<{ record: IncomingRecord; sourceName: string }>; errors: ReconcileError[] }> {
  const records: Array<{ record: IncomingRecord; sourceName: string }> = [];
  const errors: ReconcileError[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      errors.push({ ref: '-', sourceName: file.name, message: '文件不是合法 JSON，整份跳过' });
      continue;
    }
    const rawList: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.records)
        ? (parsed as Record<string, unknown>).records as unknown[]
        : Array.isArray((parsed as Record<string, unknown>)?.entries)
          ? (parsed as Record<string, unknown>).entries as unknown[]
          : [];
    if (!rawList.length) {
      errors.push({ ref: '-', sourceName: file.name, message: '备份中没有可读取的词条数组' });
      continue;
    }
    rawList.forEach((raw, index) => {
      try {
        records.push({ record: normalizeIncomingRecord(raw, file.name, index), sourceName: file.name });
      } catch (error) {
        errors.push({ ref: `第 ${index + 1} 条`, sourceName: file.name, message: (error as Error).message });
      }
    });
  }
  return { records, errors };
}

const compareScalar = (label: string, field: string, localValue: string, incomingValue: string, conflicts: ReconcileItem['conflicts']) => {
  if (incomingValue && normalizeWord(incomingValue) !== normalizeWord(localValue)) {
    conflicts.push({ field, label, localValue: localValue || '（空）', incomingValue: incomingValue || '（空）' });
  }
};

/**
 * 跨系统对账：
 * 1. 先按档案编号认词条（含方言变体所属）；
 * 2. 编号缺失时按 统一词形 + 词性 + 方言组合 匹配；
 * 3. 一份档案落到多条词条 / 释义有新值 → 列候选、等人工决定；
 * 4. 编号冲突（同编号对应词形不同）直接报错，不静默错配。
 */
export function buildReconcilePlan(localEntries: DictionaryEntry[], incoming: Array<{ record: IncomingRecord; sourceName: string }>): ReconcilePlan {
  refCounter = 0;
  const errors: ReconcileError[] = [];

  const localById = new Map<string, DictionaryEntry>();
  localEntries.forEach((entry) => {
    if (entry.archiveId) localById.set(normalizeWord(entry.archiveId), entry);
    localById.set(normalizeWord(entry.id), entry);
  });
  const localByHeadwordPos = new Map<string, DictionaryEntry[]>();
  localEntries.forEach((entry) => {
    const key = `${normalizeWord(entry.headword)}@${normalizeWord(entry.partOfSpeech)}`;
    localByHeadwordPos.set(key, [...(localByHeadwordPos.get(key) ?? []), entry]);
  });

  const items: ReconcileItem[] = incoming.map(({ record, sourceName }) => {
    const ref = nextRef();
    const item: ReconcileItem = {
      ref,
      archiveId: record.archiveId,
      sourceName,
      incoming: record,
      outcome: 'new',
      candidateIds: [],
      definitionChanged: false,
      confirmInvalid: false,
      conflicts: [],
      definitionAlternatives: [],
      definitionChoice: 'pending',
      skipped: false,
      attachOnly: false,
      reason: ''
    };

    // 第一步：档案编号
    if (record.archiveId) {
      const byId = localById.get(normalizeWord(record.archiveId));
      if (byId) {
        if (normalizeWord(byId.headword) !== normalizeWord(record.headword)) {
          item.outcome = 'error';
          item.error = `档案编号 ${record.archiveId} 在本库对应词形“${byId.headword}”，与备份词形“${record.headword}”不一致，需人工核对`;
          item.candidateIds = [byId.id];
          item.reason = '编号与词形冲突';
          return item;
        }
        item.outcome = 'matched';
        item.strategy = 'id';
        item.targetId = byId.id;
        item.candidateIds = [byId.id];
        item.reason = '档案编号一致';
      }
    }

    // 第二步：统一词形 + 词性 + 方言组合
    if (item.outcome === 'new') {
      const headPosKey = `${normalizeWord(record.headword)}@${normalizeWord(record.partOfSpeech)}`;
      const sameHeadPos = localByHeadwordPos.get(headPosKey) ?? [];
      const wantedDialects = recordDialects(record);
      const hits = sameHeadPos.filter((entry) => {
        if (wantedDialects.size === 0) return true; // 备份未标方言时仅按词形+词性，可能多条 → 交人决定
        const local = entryDialects(entry);
        return [...wantedDialects].every((dialect) => local.has(dialect));
      });
      const uniqueHits = hits.filter((entry) => entry.id !== item.targetId);
      if (uniqueHits.length === 1) {
        item.outcome = 'matched';
        item.strategy = 'key';
        item.targetId = uniqueHits[0]!.id;
        item.candidateIds = [uniqueHits[0]!.id];
        item.reason = '词形 + 词性 + 方言组合一致';
      } else if (uniqueHits.length > 1) {
        item.outcome = 'ambiguous';
        item.candidateIds = uniqueHits.map((entry) => entry.id);
        item.reason = `组合命中 ${uniqueHits.length} 条本地词条`;
        return item;
      }
    }

    // 命中后比对字段：释义新值与其他冲突
    const target = item.targetId ? localEntries.find((entry) => entry.id === item.targetId) : undefined;
    if (target) {
      compareScalar('发音', 'pronunciation', target.pronunciation, record.pronunciation, item.conflicts);
      compareScalar('词性', 'partOfSpeech', target.partOfSpeech, record.partOfSpeech, item.conflicts);
      compareScalar('编者备注', 'notes', target.notes, record.notes, item.conflicts);
      if (record.definition && normalizeWord(record.definition) !== normalizeWord(target.definition)) {
        item.definitionChanged = true;
        item.confirmInvalid = target.status === 'confirmed';
        item.conflicts.unshift({
          field: 'definition',
          label: '释义',
          localValue: target.definition || '（空）',
          incomingValue: record.definition
        });
        if (item.strategy === 'key') {
          // 词形组合一致但释义不同，也可能是同形异义的另一条 → 交人决定
          item.outcome = 'ambiguous';
          item.candidateIds = [target.id];
          item.reason = `${item.reason}，但释义为新值，需确认是更新还是另立词条`;
        } else {
          item.reason = `${item.reason}，释义有新值`;
        }
      }
    } else if (item.outcome === 'new') {
      item.reason = '本库无对应词条，将新建';
    }
    return item;
  });

  // 第三步：备份内部去重——同一档案编号 / 同一统一组合只挂一次，重复档案只保留意见与同义词。
  // 分组只看档案签名，不受主条是否因释义新值进入“待裁定”影响。
  const groupIndex = new Map<string, ReconcileItem>();
  items.forEach((item) => {
    if (item.outcome === 'error') return;
    const signature = item.archiveId
      ? `id:${normalizeWord(item.archiveId)}`
      : `key:${entryKey(item.incoming.headword, item.incoming.partOfSpeech, recordDialects(item.incoming))}`;
    const primary = groupIndex.get(signature);
    if (!primary) {
      groupIndex.set(signature, item);
      return;
    }
    item.outcome = 'duplicate';
    item.attachOnly = true;
    item.groupRef = primary.ref;
    item.targetId = primary.targetId;
    item.reason = `与 ${primary.ref} 重复（${item.archiveId ? '同档案编号' : '同词形/词性/方言组合'}），仅挂载一次意见与同义词`;
    if (item.incoming.definition && !primary.definitionAlternatives.includes(item.incoming.definition)
      && normalizeWord(item.incoming.definition) !== normalizeWord(primary.incoming.definition)) {
      primary.definitionAlternatives.push(item.incoming.definition);
    }
  });

  return {
    items,
    errors,
    totalIncoming: incoming.length,
    parsedAt: new Date().toISOString(),
    sourceNames: [...new Set(incoming.map((item) => item.sourceName))]
  };
}

/** 人工选定候选词条（或决定另立词条）后，重新比对字段与释义 */
export function evaluateAgainstTarget(item: ReconcileItem, target: DictionaryEntry | undefined) {
  item.conflicts = [];
  item.definitionChanged = false;
  item.confirmInvalid = false;
  item.definitionChoice = 'pending';
  if (!target) {
    item.outcome = 'new';
    item.targetId = undefined;
    item.reason = '人工判定：另立为新词条';
    return;
  }
  item.outcome = 'matched';
  item.targetId = target.id;
  item.candidateIds = item.candidateIds.includes(target.id) ? item.candidateIds : [target.id, ...item.candidateIds];
  item.reason = `人工指定词条“${target.headword}”`;
  compareScalar('发音', 'pronunciation', target.pronunciation, item.incoming.pronunciation, item.conflicts);
  compareScalar('词性', 'partOfSpeech', target.partOfSpeech, item.incoming.partOfSpeech, item.conflicts);
  compareScalar('编者备注', 'notes', target.notes, item.incoming.notes, item.conflicts);
  if (item.incoming.definition && normalizeWord(item.incoming.definition) !== normalizeWord(target.definition)) {
    item.definitionChanged = true;
    item.confirmInvalid = target.status === 'confirmed';
    item.conflicts.unshift({ field: 'definition', label: '释义', localValue: target.definition || '（空）', incomingValue: item.incoming.definition });
    item.reason += '，释义有新值';
  }
}

/** 还有未处理项（歧义未选定 / 释义新值未决定 / 编号错误 / 未决定跳过与否） */
export function pendingItems(plan: ReconcilePlan): ReconcileItem[] {
  return plan.items.filter((item) => {
    if (item.skipped) return false;
    if (item.outcome === 'error') return true;
    if (item.attachOnly) return false;
    if (item.outcome === 'ambiguous' && !item.targetId) return true;
    if (item.definitionChanged && item.definitionChoice === 'pending') return true;
    return false;
  });
}
