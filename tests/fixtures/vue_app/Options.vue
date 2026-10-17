<template><button @click="increment(1)">增加</button></template>
<script>
export default {
  data() { return { count: 0 } },
  methods: {
    increment(step = 1) {
      if (step > 0) { this.count += step }
      return this.count
    },
    reset() { this.increment(0) }
  }
}
</script>
