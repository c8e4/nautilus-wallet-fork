<script setup lang="ts">
import { cn } from '@/common/utils'
import { Label, type LabelProps } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

const props = defineProps<LabelProps & { class?: HTMLAttributes['class'], disabled?: boolean }>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props

  return delegated
})
</script>

<template>
  <Label
    v-bind="delegatedProps"
    :class="
      cn(
        'text-sm font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        props.disabled && 'opacity-70 cursor-not-allowed',
        props.class,
      )
    "
  >
    <slot />
  </Label>
</template>
