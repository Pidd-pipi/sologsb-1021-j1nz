import type {
  DialectVariant, DictionaryEntry, DictionarySource, ExampleSentence, ReviewComment
} from './dictionary';

/** 命中依据：档案编号 或 统一词形+词性+方言组合 */
export type ReconcileStrategy = 'id' | 'key';

export type ReconcileOutcome = 'new' | 'matched' | 'ambiguous' | 'duplicate' | 'error';

/** 释义冲突时由人决定的处理方式 */
export type DefinitionChoice = 'pending' | 'keep' | 'update' | 'combine' | 'skip';

export interface IncomingRecord {
  archiveId: string;
  headword: string;
  pronunciation: string;
  partOfSpeech: string;
  definition: string;
  dialectVariants: DialectVariant[];
  examples: ExampleSentence[];
  sources: DictionarySource[];
  synonyms: string[];
  notes: string;
  status?: DictionaryEntry['status'];
  reviewerComments: ReviewComment[];
}

export interface ReconcileConflict {
  field: string;
  label: string;
  localValue: string;
  incomingValue: string;
}

export interface ReconcileItem {
  /** 批次内引用序号 */
  ref: string;
  /** 档案编号（可能缺失） */
  archiveId: string;
  /** 来源备份文件名 */
  sourceName: string;
  incoming: IncomingRecord;
  outcome: ReconcileOutcome;
  strategy?: ReconcileStrategy;
  /** 命中或人工选定的本地词条 */
  targetId?: string;
  /** 一份档案落到多条词条时的全部候选 */
  candidateIds: string[];
  /** 与本地释义存在新值 */
  definitionChanged: boolean;
  /** 释义一变，已确认词条的确认失效 */
  confirmInvalid: boolean;
  conflicts: ReconcileConflict[];
  /** 重复档案里出现的不同释义候选 */
  definitionAlternatives: string[];
  definitionChoice: DefinitionChoice;
  /** 人工从重复档案的不同释义中选定的值 */
  definitionOverride?: string;
  /** 人工跳过：该档案不入库 */
  skipped: boolean;
  /** 重复档案：只挂载意见、同义词等集合，不覆盖字段 */
  attachOnly: boolean;
  /** 所属去重组的主档案 ref（重复档案指向主条） */
  groupRef?: string;
  reason: string;
  error?: string;
}

export interface ReconcileError {
  ref: string;
  sourceName: string;
  message: string;
}

export interface ReconcilePlan {
  items: ReconcileItem[];
  errors: ReconcileError[];
  totalIncoming: number;
  parsedAt: string;
  sourceNames: string[];
}

export interface ReconcileResult {
  created: number;
  updated: number;
  attachedOnly: number;
  skipped: number;
  batches: number;
  storageError?: string;
  details: string[];
}
