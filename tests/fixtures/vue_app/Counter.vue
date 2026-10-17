<template>
  <!-- 中文与 😀 必须保持原始源码索引 -->
  <Child :label="String(count)" />
  <button @click="increment">增加</button>
  <p>{{ format(count) }}</p>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import Child from './Child.vue'
import { double } from './math'

const count = ref(0)
function increment(step: number = 1): number {
  if (step > 0) { count.value = double(count.value + step) }
  return count.value
}
const format = (value: number) => String(value)
</script>

<style scoped>
button { color: green; }
</style>
