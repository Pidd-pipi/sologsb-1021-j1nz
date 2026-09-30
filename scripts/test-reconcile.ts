import { buildReconcilePlan, pendingItems, evaluateAgainstTarget, normalizeIncomingRecord } from '../utils/reconcile';
import type { DictionaryEntry } from '../types/dictionary';

const mkEntry = (over: Partial<DictionaryEntry>): DictionaryEntry => ({
  id: 'entry-x', headword: '', pronunciation: '', partOfSpeech: '', definition: '',
  dialectVariants: [], examples: [], sources: [], synonyms: [], status: 'draft',
  notes: '', createdAt: '', updatedAt: '', reviewerComments: [], ...over
});

const local: DictionaryEntry[] = [
  mkEntry({
    id: 'entry-001', archiveId: 'A-001', headword: 'ŋgɨ³³', partOfSpeech: '名词', definition: '山间小水潭', status: 'confirmed',
    dialectVariants: [{ id: 'v1', dialect: '北坡话', form: 'x', pronunciation: '', note: '' }],
    synonyms: ['水潭'], reviewerComments: []
  }),
  mkEntry({
    id: 'entry-002', headword: 'dʑa⁵⁵', partOfSpeech: '动词', definition: '晒谷物', status: 'review',
    dialectVariants: [{ id: 'v2', dialect: '东南村话', form: 'y', pronunciation: '', note: '' }], reviewerComments: []
  }),
  mkEntry({
    id: 'entry-003', headword: 'dʑa⁵⁵', partOfSpeech: '动词', definition: '等待（同形异义）', status: 'disputed',
    dialectVariants: [], reviewerComments: []
  })
];

const incoming = [
  // 1. 编号命中 + 释义新值 + 已确认 → 失效转待审
  { archiveId: 'A-001', headword: 'ŋgɨ³³', partOfSpeech: '名词', definition: '山间不涸小水潭（修订释义）', dialectVariants: [{ dialect: '北坡话', form: 'z' }], synonyms: ['泉'], reviewerComments: [{ field: 'definition', message: '释义已与发音人复核' }] },
  // 2. 无编号 + 词形/词性 + 方言组合命中唯一条目
  { headword: 'dʑa⁵⁵', partOfSpeech: '动词', definition: '晒谷物', dialectVariants: [{ dialect: '东南村话', form: 'y2' }] },
  // 3. 无编号 + 无方言 → 同词形词性两条 → 歧义
  { headword: 'dʑa⁵⁵', partOfSpeech: '动词', definition: '晒谷物（另一备份）' },
  // 4. 全新条目
  { headword: 'lo³³', partOfSpeech: '方向词', definition: '向说话者移动' },
  // 5. 重复档案：同编号再来一份，不同释义备选
  { archiveId: 'A-001', headword: 'ŋgɨ³³', partOfSpeech: '名词', definition: '石缝间的水源（另一套备份释义）', synonyms: ['泉水'], reviewerComments: [{ field: 'definition', message: '释义已与发音人复核' }] },
  // 6. 编号与词形冲突
  { archiveId: 'A-001', headword: '完全不同的词', partOfSpeech: '名词', definition: '错配' }
];

const records = incoming.map((raw, i) => ({ record: normalizeIncomingRecord(raw, `backup-${i < 3 ? '甲' : '乙'}.json`, i), sourceName: i < 3 ? 'backup-甲.json' : 'backup-乙.json' }));
const plan = buildReconcilePlan(local, records);

const show = () => plan.items.map((item) => `${item.ref} ${item.outcome} strategy=${item.strategy ?? '-'} target=${item.targetId ?? '-'} defChanged=${item.definitionChanged} invalid=${item.confirmInvalid} dup=${item.attachOnly} cands=[${item.candidateIds.join(',')}] ${item.reason}`);

console.log('--- 初始对账 ---');
show().forEach((line) => console.log(line));

const a = plan.items[0]!;
const b = plan.items[1]!;
const c = plan.items[2]!;
const d = plan.items[3]!;
const e = plan.items[4]!;
const f = plan.items[5]!;

const assert = (cond: boolean, msg: string) => {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; } else console.log('✅', msg);
};

assert(a.outcome === 'matched' && a.strategy === 'id', 'A001 按档案编号命中 entry-001');
assert(a.definitionChanged && a.confirmInvalid, 'A001 释义新值 + 已确认条目确认失效');
assert(a.incoming.reviewerComments.length === 1, 'A001 带来审校意见');
assert(b.outcome === 'matched' && b.strategy === 'key' && b.targetId === 'entry-002', '无编号按词形+词性+方言组合命中 entry-002');
assert(c.outcome === 'ambiguous' && c.candidateIds.length === 2 && !c.targetId, '无方言时同词形词性命中两条 → 歧义候选');
assert(d.outcome === 'new', '全新词形 → 新建');
assert(e.outcome === 'duplicate' && e.attachOnly && e.groupRef === 'A001', '同编号重复档案标记为仅挂载');
assert(a.definitionAlternatives.includes('石缝间的水源（另一套备份释义）'), '重复档案的不同释义列入备选');
assert(f.outcome === 'error' && f.error?.includes('不一致'), '编号与词形冲突报错');
assert(pendingItems(plan).length === 3, `未处理项阻塞入库（实际 ${pendingItems(plan).length}）：A001 释义、歧义、编号冲突`);

// 处理歧义：选定 entry-002 → 释义也有新值，需继续决定
evaluateAgainstTarget(c, local.find((x) => x.id === 'entry-002')!);
assert(c.outcome === 'matched' && c.definitionChanged, '歧义选定后重新比对出释义新值');
c.definitionChoice = 'keep';

// 编号冲突人工跳过
f.skipped = true;

assert(pendingItems(plan).some((i) => i.ref === a.ref), 'A001 释义未决定前仍阻塞');
a.definitionChoice = 'update';
assert(pendingItems(plan).length === 0, '全部处理完（释义决定、歧义选定、冲突跳过）后 pending 清零，允许入库');

console.log('--- 最终状态 ---');
show().forEach((line) => console.log(line));
