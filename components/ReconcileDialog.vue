<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DictionaryEntry } from '~/types/dictionary';
import type { ReconcileItem } from '~/types/reconcile';
import { useDictionaryStore } from '~/store/dictionary';
import { buildReconcilePlan, parseBackupFiles } from '~/utils/reconcile';

const visible = defineModel<boolean>({ required: true });
const emit = defineEmits<{ applied: [] }>();
const store = useDictionaryStore();
const fileInput = ref<HTMLInputElement | null>(null);
const parsing = ref(false);
const notice = ref('');

const plan = computed(() => store.reconcilePlan);
const pending = computed(() => store.reconcilePending);
const result = computed(() => store.lastReconcileResult);

const localEntry = (id?: string): DictionaryEntry | undefined => store.entries.find((entry) => entry.id === id);

const outcomeMeta = {
  new: { label: '新建', theme: 'success' },
  matched: { label: '命中更新', theme: 'primary' },
  ambiguous: { label: '待裁定', theme: 'warning' },
  duplicate: { label: '重复档案', theme: 'default' },
  error: { label: '编号异常', theme: 'danger' }
} as const;

const chooseFiles = () => fileInput.value?.click();

const onFiles = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const files = input.files ? [...input.files] : [];
  input.value = '';
  if (!files.length) return;
  parsing.value = true;
  notice.value = '';
  try {
    const { records, errors } = await parseBackupFiles(files);
    if (!records.length) {
      notice.value = errors.length ? errors.map((error) => `${error.sourceName}：${error.message}`).join('；') : '备份中没有可读取的词条';
      return;
    }
    const next = buildReconcilePlan(store.entries, records);
    next.errors.push(...errors);
    store.loadReconcilePlan(next);
  } finally {
    parsing.value = false;
  }
};

const definitionRadio = (item: ReconcileItem) => {
  if (!item.definitionChanged) return '';
  if (item.definitionChoice === 'keep') return 'keep';
  if (item.definitionChoice === 'combine') return 'combine';
  if (item.definitionChoice === 'update') {
    if (item.definitionOverride) return `alt:${item.definitionAlternatives.indexOf(item.definitionOverride)}`;
    return 'incoming';
  }
  return '';
};

const pickDefinition = (item: ReconcileItem, value: string) => {
  if (value === 'keep') store.setDefinitionChoice(item, 'keep');
  else if (value === 'combine') store.setDefinitionChoice(item, 'combine', undefined);
  else if (value === 'incoming') store.setDefinitionChoice(item, 'update', undefined);
  else if (value.startsWith('alt:')) {
    const alt = item.definitionAlternatives[Number(value.slice(4))];
    if (alt) store.setDefinitionChoice(item, 'update', alt);
  }
};

const apply = () => {
  const outcome = store.applyReconcile();
  if (!outcome.storageError) emit('applied');
};

const close = () => {
  if (store.reconcileApplying) return;
  store.closeReconcile();
};
</script>

<template>
  <t-dialog v-model:visible="visible" header="跨系统备份对账" width="1040px" :footer="false" class="reconcile-dialog" @close="close">
    <div class="reconcile-shell">
      <div class="reconcile-toolbar">
        <div class="reconcile-intro">
          <strong>两套词典备份对账</strong>
          <span>先按档案编号认词条与方言变体；编号缺失再按「统一词形 + 词性 + 方言组合」匹配。歧义与释义新值处理完才入库。</span>
        </div>
        <input ref="fileInput" type="file" accept=".json,application/json" multiple hidden @change="onFiles" />
        <t-button theme="primary" :loading="parsing" @click="chooseFiles">选择备份 JSON（可多选）</t-button>
      </div>

      <div v-if="notice" class="reconcile-notice">{{ notice }}</div>

      <template v-if="plan">
        <div class="reconcile-summary">
          <div><strong>{{ plan.totalIncoming }}</strong><span>档案条目</span></div>
          <div><strong>{{ plan.items.filter((item) => item.outcome === 'new').length }}</strong><span>将新建</span></div>
          <div><strong>{{ plan.items.filter((item) => item.outcome === 'matched').length }}</strong><span>命中更新</span></div>
          <div><strong class="warn">{{ pending.length }}</strong><span>待处理（不入库）</span></div>
          <div><strong>{{ plan.items.filter((item) => item.outcome === 'duplicate').length }}</strong><span>重复仅挂载</span></div>
          <div class="source-names">来源：{{ plan.sourceNames.join(' · ') }}</div>
        </div>

        <div v-if="plan.errors.length" class="reconcile-error-list">
          <div v-for="(error, index) in plan.errors" :key="index" class="reconcile-error-row">
            <t-tag size="small" theme="danger" variant="light">解析异常</t-tag>
            <strong>{{ error.sourceName }}</strong><span>{{ error.ref }}：{{ error.message }}</span>
          </div>
        </div>

        <div v-if="result?.storageError" class="reconcile-notice danger">入库失败，原库已保留：{{ result.storageError }}</div>

        <div class="reconcile-list">
          <div
            v-for="item in plan.items"
            :key="item.ref"
            class="reconcile-item"
            :class="{ pending: pending.includes(item), skipped: item.skipped, duplicate: item.attachOnly }"
          >
            <div class="reconcile-item-head">
              <span class="reconcile-ref">{{ item.ref }}</span>
              <t-tag size="small" variant="light" :theme="outcomeMeta[item.outcome].theme">{{ outcomeMeta[item.outcome].label }}</t-tag>
              <strong class="reconcile-word">{{ item.incoming.headword }}</strong>
              <span class="reconcile-pos">{{ item.incoming.partOfSpeech || '词性缺失' }}</span>
              <span v-if="item.archiveId" class="reconcile-archive">档案号 {{ item.archiveId }}</span>
              <span v-else class="reconcile-archive missing">无档案号</span>
              <span class="reconcile-reason">{{ item.reason }}</span>
              <span v-if="item.incoming.dialectVariants.length" class="reconcile-dialects">
                方言：{{ item.incoming.dialectVariants.map((variant) => variant.dialect || '（未标方言）').join('、') }}
              </span>
            </div>

            <!-- 编号与词形冲突：必须人工选定词条或跳过 -->
            <div v-if="item.outcome === 'error' && !item.skipped" class="reconcile-action danger-box">
              <p>{{ item.error }}</p>
              <div class="candidate-row">
                <span>认到哪条：</span>
                <t-select
                  size="small" class="candidate-select" :popup-props="{ attach: 'body' }" placeholder="选择本地词条"
                  :value="item.targetId ?? ''"
                  @change="(value: string) => store.resolveReconcileError(item, value)"
                >
                  <t-option value="__skip__" label="跳过此档案（不入库）" />
                  <t-option
                    v-for="candidate in store.entries" :key="candidate.id"
                    :value="candidate.id" :label="`${candidate.headword}（${candidate.partOfSpeech || '—'}）${candidate.archiveId ? ' · ' + candidate.archiveId : ''}`"
                  />
                </t-select>
              </div>
            </div>

            <!-- 一份档案落到多条词条：列候选让人决定 -->
            <div v-else-if="item.outcome === 'ambiguous' && !item.targetId && !item.skipped" class="reconcile-action warn-box">
              <p>{{ item.reason }}。请选择对应词条，或另立为新词条：</p>
              <div class="candidate-grid">
                <button
                  v-for="candidateId in item.candidateIds" :key="candidateId"
                  class="candidate-card"
                  @click="store.resolveReconcileCandidate(item, candidateId)"
                >
                  <strong>{{ localEntry(candidateId)?.headword }}</strong>
                  <span>{{ localEntry(candidateId)?.partOfSpeech || '—' }} · {{ localEntry(candidateId)?.definition || '无释义' }}</span>
                  <small v-if="localEntry(candidateId)?.archiveId">档案号 {{ localEntry(candidateId)?.archiveId }}</small>
                </button>
                <button class="candidate-card create" @click="store.resolveReconcileCandidate(item, '__new__')">
                  <strong>＋ 另立为新词条</strong><span>同形异义或本库确无此条</span>
                </button>
              </div>
            </div>

            <!-- 释义有新值：保留 / 更新 / 拼接 / 选重复档案里的另一释义 -->
            <div v-if="item.definitionChanged && !item.skipped && item.targetId" class="reconcile-action definition-box">
              <div class="definition-compare">
                <div class="definition-col">
                  <span>本库释义{{ item.confirmInvalid ? '（该条原已确认，释义一变确认即失效，转待审）' : '' }}</span>
                  <p>{{ localEntry(item.targetId)?.definition || '（空）' }}</p>
                </div>
                <div class="definition-arrow">⇄</div>
                <div class="definition-col">
                  <span>备份新释义</span>
                  <p>{{ item.incoming.definition }}</p>
                </div>
              </div>
              <div class="definition-choices" :class="{ disabled: item.definitionChoice !== 'pending' && !['keep', 'update', 'combine'].includes(item.definitionChoice) }">
                <label><input type="radio" :name="`def-${item.ref}`" :checked="definitionRadio(item) === 'keep'" @change="pickDefinition(item, 'keep')" /> 保留原释义</label>
                <label><input type="radio" :name="`def-${item.ref}`" :checked="definitionRadio(item) === 'incoming'" @change="pickDefinition(item, 'incoming')" /> 采用备份释义</label>
                <label v-for="(alt, altIndex) in item.definitionAlternatives" :key="altIndex">
                  <input type="radio" :name="`def-${item.ref}`" :checked="definitionRadio(item) === `alt:${altIndex}`" @change="pickDefinition(item, `alt:${altIndex}`)" />
                  采用重复档案的另一释义
                </label>
                <label><input type="radio" :name="`def-${item.ref}`" :checked="definitionRadio(item) === 'combine'" @change="pickDefinition(item, 'combine')" /> 拼接两条释义</label>
              </div>
              <p v-if="item.definitionAlternatives.length" class="alt-text">另一释义：{{ item.definitionAlternatives.join('　｜　') }}</p>
              <div class="definition-newline">
                <t-button size="small" variant="text" @click="store.resolveReconcileCandidate(item, '__new__')">其实是同形异义，改为新建词条</t-button>
              </div>
            </div>

            <!-- 其余字段冲突一览 -->
            <div v-if="item.conflicts.filter((conflict) => conflict.field !== 'definition').length && !item.skipped" class="conflict-list">
              <div v-for="conflict in item.conflicts.filter((c) => c.field !== 'definition')" :key="conflict.field" class="conflict-row">
                <span class="conflict-label">{{ conflict.label }}</span>
                <span class="conflict-local">{{ conflict.localValue }}</span>
                <span class="conflict-arrow">→</span>
                <span class="conflict-incoming">{{ conflict.incomingValue }}</span>
              </div>
            </div>

            <!-- 命中 / 新建的附属信息：意见、同义词、变体随条走 -->
            <div v-if="!item.attachOnly" class="attach-meta">
              <span>{{ item.incoming.reviewerComments.length }} 条审校意见跟随</span>
              <span>{{ item.incoming.synonyms.length }} 个同义词引用：{{ item.incoming.synonyms.join('、') || '—' }}</span>
              <span>{{ item.incoming.dialectVariants.length }} 条方言变体</span>
              <span>{{ item.incoming.examples.length }} 条例句</span>
            </div>

            <!-- 重复档案：只挂一次 -->
            <div v-if="item.attachOnly" class="attach-only-box">
              <span>{{ item.reason }}</span>
              <span class="attach-detail">{{ item.incoming.reviewerComments.length }} 条意见、{{ item.incoming.synonyms.length }} 个同义词将挂到主档案对应词条，不覆盖任何字段。</span>
            </div>

            <div class="reconcile-item-foot">
              <t-button
                size="small" variant="text"
                @click="store.skipReconcileItem(item, !item.skipped)"
              >{{ item.skipped ? '撤销跳过' : '跳过此档案' }}</t-button>
              <span v-if="item.skipped" class="skipped-note">已标记跳过，不入库</span>
            </div>
          </div>
        </div>

        <div class="reconcile-footer">
          <span class="pending-tip" :class="{ blocked: pending.length > 0 }">
            {{ pending.length ? `还有 ${pending.length} 项未处理完，暂不入库` : '全部处理完毕，可以入库' }}
          </span>
          <t-button variant="outline" :disabled="store.reconcileApplying" @click="close">取消</t-button>
          <t-button
            theme="primary"
            :loading="store.reconcileApplying"
            :disabled="pending.length > 0 || !plan.items.some((item) => !item.skipped)"
            @click="apply"
          >分批写入词库</t-button>
        </div>
      </template>

      <t-empty v-else-if="!parsing" description="选择两套备份 JSON 后开始对账；档案编号优先，缺失时按统一词形/词性/方言组合匹配" />
    </div>
  </t-dialog>
</template>
