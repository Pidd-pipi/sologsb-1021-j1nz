<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useDictionaryStore } from '~/store/dictionary';
import {
  buildReconcilePlan, definitionDiverges, isPendingResolved, parseBackup, pendingToOperations
} from '~/utils/reconcile';
import type { BackupData, PendingDecision, PendingItem, ReconcilePlan } from '~/utils/reconcile';

const visible = defineModel<boolean>({ required: true });
const store = useDictionaryStore();

const step = ref<'select' | 'review' | 'importing' | 'done'>('select');
const fileName = ref('');
const parseError = ref('');
const backup = ref<BackupData | null>(null);
const plan = ref<ReconcilePlan | null>(null);
const decisions = reactive<Record<string, PendingDecision>>({});
const progress = ref({ current: 0, total: 0 });
const result = ref<{ imported: number; skipped: number; failed: Array<{ headword: string; reason: string }> } | null>(null);

const statusMeta = {
  draft: { label: '草稿', theme: 'default' },
  review: { label: '待审', theme: 'warning' },
  disputed: { label: '争议', theme: 'danger' },
  confirmed: { label: '已确认', theme: 'success' }
} as const;

const pending = computed<PendingItem[]>(() => plan.value?.pending ?? []);
const unresolvedCount = computed(() => pending.value.filter((item) => !isPendingResolved(item, decisions[item.key])).length);
const totalOperations = computed(() => (plan.value?.autoOperations.length ?? 0) + pending.value.filter((item) => {
  const d = decisions[item.key];
  if (!d) return false;
  if (item.kind === 'definitionDiverge') return !!d.definitionChoice;
  return d.action !== 'skip';
}).length);

watch(visible, (open) => {
  if (open) {
    step.value = 'select';
    fileName.value = '';
    parseError.value = '';
    backup.value = null;
    plan.value = null;
    result.value = null;
    Object.keys(decisions).forEach((key) => delete decisions[key]);
  }
});

const onFile = (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  fileName.value = file.name;
  parseError.value = '';
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = parseBackup(String(reader.result ?? ''));
      backup.value = data;
      plan.value = buildReconcilePlan(store.entries, data);
      Object.keys(decisions).forEach((key) => delete decisions[key]);
      pending.value.forEach((item) => { decisions[item.key] = { action: 'merge' }; });
      step.value = 'review';
    } catch (error) {
      parseError.value = error instanceof Error ? error.message : '备份解析失败';
    }
  };
  reader.onerror = () => { parseError.value = '读取文件失败'; };
  reader.readAsText(file);
};

const candidateDiverges = (item: PendingItem, candidateId: string) => {
  const candidate = item.candidates.find((entry) => entry.id === candidateId);
  return candidate ? definitionDiverges(item.incoming, candidate) : false;
};

const startImport = async () => {
  if (!plan.value || unresolvedCount.value > 0) return;
  const operations = [...plan.value.autoOperations, ...pendingToOperations(pending.value, decisions)];
  step.value = 'importing';
  progress.value = { current: 0, total: Math.max(1, Math.ceil(operations.length / 15)) };
  const res = await store.commitReconciliation(operations, (info) => { progress.value = info; });
  result.value = res;
  step.value = 'done';
};

const finish = () => {
  visible.value = false;
};
</script>

<template>
  <t-dialog v-model:visible="visible" header="跨系统对账导入" width="1080px" :footer="false" class="reconcile-dialog">
    <!-- 第一步：选择备份 -->
    <div v-if="step === 'select'" class="reconcile-select">
      <div class="select-drop">
        <input type="file" accept=".json,application/json" @change="onFile" />
        <div class="select-hint">
          <strong>选择档案室备份 JSON</strong>
          <span>备份包含词条、版本与审计记录。解析后先按档案编号认词条，编号缺失时再按统一词形、词性和方言组合匹配。</span>
        </div>
      </div>
      <t-alert v-if="parseError" theme="error" :title="parseError" />
      <div class="select-note">
        <p>· 一份档案落到多条词条，或释义都有新值时，会列出候选供人工决定，处理完才入库。</p>
        <p>· 释义一变，原已确认的词条状态自动失效；审校意见与同义词引用跟到对应词条，重复档案只挂一次。</p>
        <p>· 备份超过本地容量时分批处理，失败批次保留原库、不破坏已有数据。</p>
      </div>
    </div>

    <!-- 第二步：对账预览与待决 -->
    <div v-else-if="step === 'review' && plan" class="reconcile-review">
      <div class="reconcile-summary">
        <div><strong>{{ plan.summary.total }}</strong><span>备份记录</span></div>
        <div><strong>{{ plan.summary.deduped }}</strong><span>去重后</span></div>
        <div><strong>{{ plan.summary.byArchiveNo }}</strong><span>按编号匹配</span></div>
        <div><strong>{{ plan.summary.byFallback }}</strong><span>按词形/词性/方言</span></div>
        <div><strong>{{ plan.summary.creates }}</strong><span>新建词条</span></div>
        <div><strong>{{ plan.summary.merges }}</strong><span>自动合并</span></div>
        <div :class="{ 'pending-on': unresolvedCount > 0 }"><strong>{{ unresolvedCount }}</strong><span>待决定</span></div>
      </div>

      <t-alert v-if="unresolvedCount > 0" theme="warning" :title="`还有 ${unresolvedCount} 项待决定，处理完才能入库`" />
      <t-alert v-else theme="success" title="全部待决项已处理，可以入库" />

      <div v-if="pending.length" class="pending-list">
        <article v-for="item in pending" :key="item.key" class="pending-card">
          <header class="pending-head">
            <t-tag size="small" :theme="item.basis === 'archiveNo' ? 'primary' : 'default'" variant="light">
              {{ item.basis === 'archiveNo' ? `档案编号 ${item.archiveNo}` : '编号缺失·兜底匹配' }}
            </t-tag>
            <strong>{{ item.incoming.headword || '未命名词条' }}</strong>
            <span class="pending-pos">{{ item.incoming.partOfSpeech || '词性待定' }}</span>
            <t-tag v-if="item.kind === 'multiMatch'" size="small" theme="warning" variant="light">一份档案落到 {{ item.candidates.length }} 条词条</t-tag>
            <t-tag v-else size="small" theme="warning" variant="light">释义都有新值</t-tag>
          </header>

          <!-- 多条词条候选 -->
          <template v-if="item.kind === 'multiMatch'">
            <div class="candidate-grid">
              <label
                v-for="candidate in item.candidates"
                :key="candidate.id"
                class="candidate-card"
                :class="{ selected: decisions[item.key]?.action === 'merge' && decisions[item.key]?.targetId === candidate.id }"
              >
                <input type="radio" :name="item.key" :value="candidate.id" v-model="decisions[item.key]!.targetId" @change="decisions[item.key]!.action = 'merge'" />
                <div class="candidate-body">
                  <div class="candidate-title"><strong>{{ candidate.headword }}</strong><t-tag size="small" :theme="statusMeta[candidate.status].theme" variant="light">{{ statusMeta[candidate.status].label }}</t-tag></div>
                  <p>{{ candidate.definition || '（无释义）' }}</p>
                  <small>编号 {{ candidate.archiveNo || '缺失' }} · {{ candidate.dialectVariants.length }} 方言变体</small>
                </div>
              </label>
              <label class="candidate-card create-card" :class="{ selected: decisions[item.key]?.action === 'create' }">
                <input type="radio" :name="item.key" value="__create__" :checked="decisions[item.key]?.action === 'create'" @change="decisions[item.key] = { action: 'create' }" />
                <div class="candidate-body"><strong>作为新词条创建</strong><p>不并入任何现有词条</p></div>
              </label>
              <label class="candidate-card skip-card" :class="{ selected: decisions[item.key]?.action === 'skip' }">
                <input type="radio" :name="item.key" value="__skip__" :checked="decisions[item.key]?.action === 'skip'" @change="decisions[item.key] = { action: 'skip' }" />
                <div class="candidate-body"><strong>跳过此条</strong><p>本次不入库</p></div>
              </label>
            </div>
            <div v-if="decisions[item.key]?.action === 'merge' && candidateDiverges(item, decisions[item.key]!.targetId!)" class="definition-choice">
              <span>释义冲突：</span>
              <label><input type="radio" :name="`${item.key}-def`" value="keep" v-model="decisions[item.key]!.definitionChoice" /> 保留现条</label>
              <label><input type="radio" :name="`${item.key}-def`" value="incoming" v-model="decisions[item.key]!.definitionChoice" /> 采用档案</label>
              <label><input type="radio" :name="`${item.key}-def`" value="combine" v-model="decisions[item.key]!.definitionChoice" /> 拼接两者</label>
            </div>
          </template>

          <!-- 释义冲突 -->
          <template v-else>
            <div class="definition-compare">
              <div class="definition-box"><span>现条释义</span><p>{{ item.candidates[0]?.definition }}</p></div>
              <div class="definition-box"><span>档案释义</span><p>{{ item.incoming.definition }}</p></div>
            </div>
            <div class="definition-choice">
              <label><input type="radio" :name="`${item.key}-def`" value="keep" v-model="decisions[item.key]!.definitionChoice" /> 保留现条</label>
              <label><input type="radio" :name="`${item.key}-def`" value="incoming" v-model="decisions[item.key]!.definitionChoice" /> 采用档案（已确认状态失效）</label>
              <label><input type="radio" :name="`${item.key}-def`" value="combine" v-model="decisions[item.key]!.definitionChoice" /> 拼接两者（已确认状态失效）</label>
            </div>
          </template>
        </article>
      </div>

      <details v-if="plan.autoOperations.length" class="auto-details">
        <summary>自动处理 {{ plan.autoOperations.length }} 条（新建 {{ plan.summary.creates }} · 合并 {{ plan.summary.merges }}）</summary>
        <div class="auto-list">
          <span v-for="(op, index) in plan.autoOperations" :key="index">{{ op.kind === 'create' ? '＋ ' : '↳ ' }}{{ op.incoming.headword || '未命名词条' }}</span>
        </div>
      </details>

      <div class="dialog-actions">
        <t-button variant="outline" @click="step = 'select'">重新选择</t-button>
        <t-button theme="primary" :disabled="unresolvedCount > 0 || !totalOperations" @click="startImport">确认入库（{{ totalOperations }} 条）</t-button>
      </div>
    </div>

    <!-- 第三步：分批导入进度 -->
    <div v-else-if="step === 'importing'" class="reconcile-importing">
      <t-loading size="large" />
      <p>正在分批处理第 {{ progress.current }} / {{ progress.total }} 批…</p>
      <span>每批先校验本地容量，失败批次保留原库、继续处理后续批次。</span>
    </div>

    <!-- 第四步：结果报告 -->
    <div v-else-if="step === 'done' && result" class="reconcile-done">
      <t-alert theme="success" :title="`对账完成：成功入库 ${result.imported} 条，跳过 ${result.skipped} 条`" />
      <div v-if="result.failed.length" class="failed-list">
        <h4>未入库记录（原库未受影响）</h4>
        <article v-for="(item, index) in result.failed" :key="index">
          <strong>{{ item.headword }}</strong><span>{{ item.reason }}</span>
        </article>
      </div>
      <div v-else class="all-done"><t-alert theme="success" title="全部记录已入库" /></div>
      <div class="dialog-actions"><t-button theme="primary" @click="finish">完成</t-button></div>
    </div>
  </t-dialog>
</template>
