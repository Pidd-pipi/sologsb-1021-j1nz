<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useDictionaryStore } from '~/store/dictionary';

const store = useDictionaryStore();
let stopPersistence: (() => void) | undefined;

onMounted(() => {
  store.hydrateFromBrowser();
  stopPersistence = watch(
    () => store.persistableSnapshot,
    (value) => {
      if (store.hydrated) {
        try {
          localStorage.setItem('sologsb-1021-dictionary-v1', JSON.stringify(value));
        } catch {
          // 容量不足等写入失败：保留内存数据，不破坏原库，下次变更再尝试持久化
        }
      }
    },
    { deep: true }
  );
});

onBeforeUnmount(() => stopPersistence?.());
</script>

<template>
  <NuxtPage />
</template>
