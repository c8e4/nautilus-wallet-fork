<script setup lang="ts">
import { computed, HTMLAttributes, onMounted, ref, shallowRef, watch } from "vue";
import { extractTokenIdFromBabelContract, isValidBabelBox } from "@fleet-sdk/babel-fees-plugin";
import { areEqualBy, isEmpty } from "@fleet-sdk/common";
import { useVuelidate } from "@vuelidate/core";
import { helpers } from "@vuelidate/validators";
import BigNumber from "bignumber.js";
import { groupBy, maxBy, sortBy } from "es-toolkit";
import { ChevronsUpDownIcon, InfoIcon, Loader2Icon } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useAppStore } from "@/stores/appStore";
import { useAssetsStore } from "@/stores/assetsStore";
import { useWalletStore } from "@/stores/walletStore";
import { AssetIcon, AssetSelect } from "@/components/asset";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form";
import { PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { fetchBabelBoxes, getNanoErgsPerTokenRate } from "@/chains/ergo/babelFees";
import { bn, decimalize } from "@/common/bigNumber";
import { cn } from "@/common/utils";
import { useFormat } from "@/composables/useFormat";
import { ERG_DECIMALS, ERG_TOKEN_ID, MIN_BOX_VALUE, SAFE_MIN_FEE_VALUE } from "@/constants/ergo";
import { AssetInfo, FeeSettings } from "@/types/internal";
import { bigNumberMinValue } from "@/validators";

interface FeeAsset extends AssetInfo {
  nanoErgsPerToken: BigNumber;
  balance?: BigNumber;
}

interface Props {
  modelValue: FeeSettings;
  includeMinAmountPerBox?: number;
  disabled?: boolean;
  maxMultiplier?: number;
  class?: HTMLAttributes["class"];
  ergOnly?: boolean;
}

const BN_MIN_ERG_FEE = bn(SAFE_MIN_FEE_VALUE);
const BN_MIN_BOX_VAL = bn(MIN_BOX_VALUE);

const format = useFormat();
const appStore = useAppStore();
const assetsStore = useAssetsStore();
const wallet = useWalletStore();
const { t } = useI18n();

const props = withDefaults(defineProps<Props>(), {
  includeMinAmountPerBox: 0,
  maxMultiplier: 10,
  class: undefined
});

const emit = defineEmits<{ (e: "update:modelValue", payload: FeeSettings): void }>();

const assets = shallowRef<FeeAsset[]>([]);
const intSelected = shallowRef<FeeAsset>({ tokenId: ERG_TOKEN_ID, nanoErgsPerToken: bn(0) });
const internalMultiplier = shallowRef([1]);
const cachedMinRequired = shallowRef(bn(0));
const loading = ref(false);

const ergPrice = computed(() => assetsStore.prices.get(ERG_TOKEN_ID)?.fiat || 0);
const minTokenFee = computed(() => getTokenUnitsFor(BN_MIN_ERG_FEE));
const nanoErgsFee = computed(() => BN_MIN_ERG_FEE.times(multiplier.value));
const tokenUnitsFee = computed(() => minTokenFee.value.times(multiplier.value));

const multiplier = computed<number>({
  get: () => internalMultiplier.value[0],
  set: (newVal) => (internalMultiplier.value = [newVal])
});

const conversionCurrency = computed(() => {
  return intSelected.value.tokenId === ERG_TOKEN_ID ? appStore.settings.conversionCurrency : "ERG";
});

const feeAmount = computed(() => {
  const value =
    intSelected.value.tokenId === ERG_TOKEN_ID ? nanoErgsFee.value : tokenUnitsFee.value;
  return decimalize(value, intSelected.value.metadata?.decimals ?? 0);
});

const price = computed(() => {
  if (intSelected.value.tokenId === ERG_TOKEN_ID) {
    return decimalize(nanoErgsFee.value, ERG_DECIMALS).times(ergPrice.value);
  }

  return decimalize(intSelected.value.nanoErgsPerToken.times(tokenUnitsFee.value), ERG_DECIMALS);
});

const v$ = useVuelidate(
  computed(() => ({
    feeAmount: {
      minValue: helpers.withMessage(
        ({ $params }) =>
          t("transaction.send.minFeeError", {
            min: $params.min,
            name: props.modelValue.assetInfo?.name
          }),
        bigNumberMinValue(cachedMinRequired.value)
      )
    }
  })),
  { feeAmount }
);

watch(
  () => props.modelValue,
  (newVal) => {
    if (newVal.tokenId == intSelected.value.tokenId) return;

    const asset = assets.value.find((x) => x.tokenId === newVal.tokenId);
    if (asset) intSelected.value = asset;
  }
);

watch(
  () => intSelected.value,
  (newVal, oldVal) => {
    if (newVal.tokenId === oldVal.tokenId) return;

    if (multiplier.value != 1) multiplier.value = 1;
    recalculateMinRequired();
    emitSelected();
  }
);

watch(() => feeAmount.value, emitSelected);
watch(() => props.includeMinAmountPerBox, recalculateMinRequired);

watch(
  () => ({ walletId: wallet.id, assets: wallet.nonArtworkBalance }),
  (newVal, oldVal) => {
    if (areEqualBy(newVal.assets, oldVal.assets, (asset) => asset.tokenId)) return;
    loadAssets();
  }
);

onMounted(loadAssets);

async function loadAssets() {
  loading.value = true;

  const erg: FeeAsset = {
    tokenId: ERG_TOKEN_ID,
    nanoErgsPerToken: bn(1),
    metadata: assetsStore.metadata.get(ERG_TOKEN_ID)
  };

  multiplier.value = 1;
  assets.value = [erg];
  intSelected.value = { tokenId: ERG_TOKEN_ID, nanoErgsPerToken: bn(0) };
  cachedMinRequired.value = bn(0);
  select(erg);

  if (props.ergOnly) {
    loading.value = false;
    return;
  }

  const tokenIds = wallet.nonArtworkBalance
    .filter((x) => x.tokenId !== ERG_TOKEN_ID)
    .map((x) => x.tokenId);

  if (isEmpty(tokenIds)) {
    loading.value = false;
    return;
  }

  const allBoxes = await fetchBabelBoxes(tokenIds);
  const groups = groupBy(allBoxes.filter(isValidBabelBox), (box) =>
    extractTokenIdFromBabelContract(box.ergoTree)
  );

  const newAssets = Object.keys(groups)
    .map((tokenId): FeeAsset => {
      const price = maxBy(
        groups[tokenId].map((box) => getNanoErgsPerTokenRate(box)),
        (p) => p.toNumber()
      );

      return {
        tokenId,
        metadata: assetsStore.metadata.get(tokenId),
        nanoErgsPerToken: price || bn(0)
      };
    })
    .filter((asset) => !asset.nanoErgsPerToken.isZero());

  assets.value = assets.value.concat(
    sortBy(
      newAssets.filter((x) => x.nanoErgsPerToken),
      [(x) => x.nanoErgsPerToken.toNumber()]
    )
  );

  loading.value = false;
}

function getTokenUnitsFor(nanoErgs: BigNumber): BigNumber {
  if (
    nanoErgs.isZero() ||
    !intSelected.value ||
    !intSelected.value.nanoErgsPerToken ||
    intSelected.value.nanoErgsPerToken.isZero()
  ) {
    return bn(0);
  }

  return nanoErgs.div(intSelected.value.nanoErgsPerToken).integerValue(BigNumber.ROUND_UP);
}

function recalculateMinRequired() {
  if (intSelected.value.tokenId === ERG_TOKEN_ID) {
    cachedMinRequired.value = decimalize(BN_MIN_ERG_FEE, ERG_DECIMALS);
    if (!v$.value.$dirty) multiplier.value = 1;
  } else {
    cachedMinRequired.value = decimalize(
      getTokenUnitsFor(BN_MIN_ERG_FEE.plus(BN_MIN_BOX_VAL.times(props.includeMinAmountPerBox))),
      intSelected.value.metadata?.decimals || 0
    );

    if (cachedMinRequired.value.isGreaterThan(feeAmount.value)) {
      const m = cachedMinRequired.value.dividedBy(feeAmount.value).integerValue(BigNumber.ROUND_UP);
      multiplier.value = m.isGreaterThan(10) ? 10 : m.toNumber();
    }
  }
}

function select(asset: FeeAsset) {
  intSelected.value = asset;
}

function emitSelected() {
  emit("update:modelValue", {
    tokenId: intSelected.value.tokenId,
    nanoErgsPerToken: intSelected.value.nanoErgsPerToken,
    value: feeAmount.value,
    assetInfo: intSelected.value.metadata
  });
}
</script>

<template>
  <FormField :validation="v$">
    <div
      :class="
        cn(
          'border-input relative flex w-full flex-col gap-1 rounded-md border bg-transparent px-4 py-3 text-sm shadow-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          disabled && 'pointer-events-none opacity-50',
          props.class
        )
      "
    >
      <div class="flex grow gap-2">
        <div class="flex grow flex-row items-start gap-2">
          <div class="flex h-full flex-row items-center gap-1">
            <div class="font-bold" v-once>{{ t("common.fee") }}</div>
            <div>{{ feeAmount.toString() }}</div>

            <TooltipProvider :delay-duration="100">
              <Tooltip>
                <TooltipTrigger as-child>
                  <InfoIcon class="text-muted-foreground size-3" />
                </TooltipTrigger>
                <TooltipContent class="text-center">
                  <div v-if="ergPrice">
                    {{ price.toString() }} {{ format.string.uppercase(conversionCurrency) }}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
        <div>
          <AssetSelect v-model="intSelected" :assets="assets" selectable>
            <PopoverTrigger :disabled="loading || ergOnly">
              <Button
                :disabled="loading || ergOnly"
                variant="secondary"
                class="disabled:opacity-100"
              >
                <AssetIcon
                  class="size-4"
                  :token-id="intSelected.tokenId"
                  :type="intSelected.metadata?.type"
                />
                {{ format.asset.name(intSelected) }}

                <template v-if="!ergOnly">
                  <Loader2Icon v-if="loading" class="size-4 animate-spin opacity-50" />
                  <ChevronsUpDownIcon v-else class="size-4 opacity-50" />
                </template>
              </Button>
            </PopoverTrigger>
          </AssetSelect>
        </div>
      </div>
      <div class="pt-3 pb-2">
        <Slider v-model="internalMultiplier" :max="props.maxMultiplier" :step="1" :min="1" />
      </div>
    </div>
  </FormField>
</template>
