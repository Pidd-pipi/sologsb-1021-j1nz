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
      // 对账导入失败回滚时锁定，防止中间态覆盖原库
      if (store.hydrated && !store.persistenceLocked) localStorage.setItem('sologsb-1021-dictionary-v1', JSON.stringify(value));
    },
    { deep: true }
  );
});

onBeforeUnmount(() => stopPersistence?.());
</script>

<template>
  <NuxtPage />
</template>
