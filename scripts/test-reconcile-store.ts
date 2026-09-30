import { setActivePinia, createPinia } from 'pinia';
import { useDictionaryStore } from '../store/dictionary';
import type { DictionaryEntry } from '../types/dictionary';

class MemoryStorage {
  store = new Map<string, string>();
  failOn = ''; // 包含该标记的写入抛 QuotaExceededError
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  setItem(key: string, value: string) {
    if (value.includes(this.failOn) && this.failOn) {
      const err = new Error("Failed to execute 'setItem': Setting the value exceeded the quota.");
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.store.set(key, value);
  }
  removeItem(key: string) { this.store.delete(key); }
  clear() { this.store.clear(); }
}

const storage = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = storage;

const assert = (cond: boolean, msg: string) => {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; } else console.log('✅', msg);
};

setActivePinia(createPinia());
const store = useDictionaryStore();
store.hydrated = true;
const originalCount = store.entries.length;
const confirmedBefore = store.entries.find((e) => e.id === 'entry-001')!;
assert(confirmedBefore.status === 'confirmed', '前置：entry-001 初始为已确认');

// 构造对账档案
const backup = [
  // entry-001：无档案号走组合匹配 + 释义新值 + 新意见 + 新同义词
  {
    headword: 'ŋgɨ³³', partOfSpeech: '名词', definition: '修订释义·永不干涸',
    dialectVariants: [{ dialect: '北坡话', form: 'ŋgɨ³³ tsha⁵⁵' }], // 已有变体，应去重
    synonyms: ['水潭', '泉眼'], // 水潭已有，泉眼新增
    reviewerComments: [{ field: 'definition', author: '审校甲', message: '新释义请复核' }]
  },
  // 全新词条
  { headword: 'thu²¹', partOfSpeech: '名词', definition: '火塘上方悬挂的熏架', synonyms: ['熏架'], reviewerComments: [] },
  // 重复档案：同一词形/词性/方言组合再来一份，意见内容相同（去重）+ 新同义词
  {
    headword: 'ŋgɨ³³', partOfSpeech: '名词', definition: '修订释义·永不干涸',
    dialectVariants: [{ dialect: '北坡话', form: 'ŋgɨ³³ tsha⁵⁵' }],
    synonyms: ['清泉'], reviewerComments: [{ field: 'definition', author: '审校甲', message: '新释义请复核' }]
  }
];

// 用 store 的内部构造间接生成 plan
const { buildReconcilePlan, normalizeIncomingRecord } = await import('../utils/reconcile');
const records = backup.map((raw, i) => ({ record: normalizeIncomingRecord(raw, 'f.json', i), sourceName: 'f.json' }));
const plan = buildReconcilePlan(store.entries, records);
console.log(plan.items.map((i) => `${i.ref} ${i.outcome} ${i.reason}`).join('\n'));
store.loadReconcilePlan(plan);

const [item1, item2, item3] = store.reconcilePlan!.items;
assert(item1!.targetId === 'entry-001' && item1!.definitionChanged, '档案 1 命中 entry-001 且释义有新值');
assert(item2!.outcome === 'new', '档案 2 新建');
assert(item3!.attachOnly, '档案 3 识别为重复仅挂载');
assert(store.reconcilePending.length === 1, '有 1 条释义新值待决定');

store.setDefinitionChoice(item1!, 'update');
assert(store.reconcilePending.length === 0, '决定释义后无待处理项');

const result = store.applyReconcile();
assert(!result.storageError, `入库无存储错误（${result.storageError ?? ''}）`);
assert(result.created === 1 && result.updated === 1 && result.attachedOnly === 1, `统计 新建1/更新1/挂载1：${JSON.stringify(result)}`);

const after001 = store.entries.find((e) => e.id === 'entry-001')!;
assert(after001.status === 'review', '释义一变，原已确认失效 → 转待审');
assert(after001.definition === '修订释义·永不干涸', '释义已更新');
assert(after001.synonyms.includes('泉眼') && after001.synonyms.includes('清泉'), '同义词（含重复档案）跟到词条');
assert(after001.synonyms.filter((s) => s === '泉眼').length === 1, '同义词不重复');
assert(after001.reviewerComments.length === 1 && after001.reviewerComments[0]!.message === '新释义请复核', '重复档案里相同的意见只挂一次');
assert(after001.dialectVariants.length === 2, '已有的相同方言变体不重复合并');
assert(store.entries.length === originalCount + 1, '新词条已创建，总数 +1');
assert(store.versions.some((v) => v.action === '对账导入'), '写入产生版本快照');
assert(store.audit.some((a) => a.action === '跨系统对账导入'), '写入产生审计记录');
assert(storage.getItem('sologsb-1021-dictionary-v1')?.includes('修订释义·永不干涸'), '结果已写入 localStorage');

// ===== 失败回滚：让含新标记的写入必失败，原库必须保留 =====
const beforeSnapshot = storage.getItem('sologsb-1021-dictionary-v1')!;
storage.failOn = '无法写入的超大备份标记';
const backup2 = [
  { headword: 'big⁵⁵', partOfSpeech: '名词', definition: '无法写入的超大备份标记', synonyms: [] }
];
const records2 = backup2.map((raw, i) => ({ record: normalizeIncomingRecord(raw, 'g.json', i), sourceName: 'g.json' }));
const plan2 = buildReconcilePlan(store.entries, records2);
store.loadReconcilePlan(plan2);
const result2 = store.applyReconcile();
assert(!!result2.storageError, '超容量时返回存储错误');
assert(store.entries.every((e) => e.headword !== 'big⁵⁵'), '失败后条目未进入词库');
assert(storage.getItem('sologsb-1021-dictionary-v1') === beforeSnapshot, '失败后 localStorage 保留原库内容');
assert(store.entries.length === originalCount + 1, '失败后内存词条数与导入前一致');
assert(store.reconcileOpen === true && !!store.reconcilePlan, '失败后对话框保留，可处理后重试');
