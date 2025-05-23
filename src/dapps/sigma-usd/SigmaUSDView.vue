<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  Ref,
  ref,
  shallowRef,
  triggerRef,
  watch
} from "vue";
import { ActionType, CoinType, FeeType, SigmaUSDBank } from "@fleet-sdk/ageusd-plugin";
import { BoxSource } from "@fleet-sdk/blockchain-providers";
import { useVuelidate } from "@vuelidate/core";
import { helpers } from "@vuelidate/validators";
import { pausableWatch, useIntervalFn } from "@vueuse/core";
import BigNumber from "bignumber.js";
import {
  ArrowDownIcon,
  ArrowDownUpIcon,
  DollarSignIcon,
  InfoIcon,
  LandmarkIcon,
  SettingsIcon
} from "lucide-vue-next";
import { I18nT, useI18n } from "vue-i18n";
import { useAppStore } from "@/stores/appStore";
import { useAssetsStore } from "@/stores/assetsStore";
import { useChainStore } from "@/stores/chainStore";
import { useWalletStore } from "@/stores/walletStore";
import { TransactionFeeConfig, TransactionSignDialog } from "@/components/transaction";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { StatsCard } from "@/components/ui/stats-card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { SAFE_MAX_CHANGE_TOKEN_LIMIT } from "@/chains/ergo/transaction/builder";
import { bn, dbn, undecimalize } from "@/common/bigNumber";
import { isErg } from "@/common/utils";
import { useFormat } from "@/composables";
import { useProgrammaticDialog } from "@/composables/useProgrammaticDialog";
import { ERG_DECIMALS, ERG_TOKEN_ID, MIN_BOX_VALUE, SAFE_MIN_FEE_VALUE } from "@/constants/ergo";
import { AssetInfo, FeeSettings } from "@/types/internal";
import { getBankBox, getOracleBox } from "./blockchainService";
import { Asset, AssetInputSelect } from "./components";
import { ERG_INFO, SIGSRV_INFO, SIGUSD_INFO } from "./metadata";
import { createExchangeTransaction } from "./transactionFactory";

const _0 = bn(0);
const MIN_BOX_VAL = dbn(MIN_BOX_VALUE, ERG_DECIMALS);
const RECOMMENDED_FEE = dbn(SAFE_MIN_FEE_VALUE * 2, ERG_DECIMALS);

const wallet = useWalletStore();
const app = useAppStore();
const assets = useAssetsStore();
const chain = useChainStore();
const format = useFormat();
const { t } = useI18n();

const { open: openTransactionSignDialog } = useProgrammaticDialog(TransactionSignDialog);

const bank = shallowRef<SigmaUSDBank | undefined>();
const loading = ref(false);
const lastChanged = ref<"from" | "to">("from");
const isFeeBreakdownOpen = ref<string | undefined>();
const fromAsset = ref<Asset | undefined>(convertibleAsset("sell", ERG_INFO));
const fromAmount = ref<BigNumber | undefined>();
const toAsset = ref<Asset | undefined>();
const toAmount = ref<BigNumber | undefined>();
const txFee = ref<FeeSettings>({ tokenId: ERG_TOKEN_ID, value: RECOMMENDED_FEE });
const flipButtonHover = ref(false);
const bankUpdateInterval = useIntervalFn(() => loadBankFrom("mempool"), 5_000 /* 5 seconds */);

const txFeeNanoergs = computed(() => udec(txFee.value.value, ERG_DECIMALS));
const reservedErgAmount = computed(() => {
  if (wallet.balance.length <= 1) return _0;

  const tokensCount = wallet.balance.length;
  const count = Math.ceil(tokensCount / SAFE_MAX_CHANGE_TOKEN_LIMIT) + 1; // +1 for incoming token
  return MIN_BOX_VAL.times(count);
});

const fromAssets = computed(() => [
  convertibleAsset("sell", ERG_INFO, toAsset),
  convertibleAsset("sell", SIGUSD_INFO, toAsset),
  convertibleAsset("sell", SIGSRV_INFO, toAsset)
]);

const toAssets = computed(() => [
  convertibleAsset("buy", ERG_INFO, fromAsset),
  convertibleAsset("buy", SIGUSD_INFO, fromAsset),
  convertibleAsset("buy", SIGSRV_INFO, fromAsset)
]);

const bankInfo = computed(() => ({
  reserveRatio: Number(bank.value?.reserveRatio ?? 0),
  baseReserves: dbn(bank.value?.baseReserves ?? 0, ERG_INFO.metadata?.decimals),
  stableRate: dbn(bank.value?.stableCoinErgRate ?? _0, SIGUSD_INFO.metadata?.decimals),
  availableReserve: dbn(bank.value?.getAvailable("reserve") ?? 0, SIGSRV_INFO.metadata?.decimals),
  availableStable: dbn(bank.value?.getAvailable("stable") ?? 0, SIGUSD_INFO.metadata?.decimals),
  redeemableReserve: dbn(bank.value?.getRedeemable("reserve") ?? 0, SIGSRV_INFO.metadata?.decimals),
  redeemableStable: dbn(bank.value?.getRedeemable("stable") ?? 0, SIGUSD_INFO.metadata?.decimals)
}));

const nonErg = computed(() =>
  fromAsset.value?.tokenId === ERG_TOKEN_ID
    ? { asset: toAsset.value, amount: toAmount.value }
    : { asset: fromAsset.value, amount: fromAmount.value }
);

const hasInputValues = computed(() => fromAmount.value?.gt(0) && toAmount.value?.gt(0));
const networkFee = computed(() => (hasInputValues.value ? txFee.value.value : _0));
const protocolFee = computed(() => getFee("protocol", nonErg.value.asset, nonErg.value.amount));
const uiFee = computed(() => getFee("implementor", nonErg.value.asset, nonErg.value.amount));
const totalFee = computed(() => networkFee.value.plus(protocolFee.value.plus(uiFee.value)));
const action = computed<ActionType>(() =>
  fromAsset.value?.tokenId === ERG_INFO.tokenId ? "minting" : "redeeming"
);
/**
 * Total Conversion Rate (TCR)
 */
const tcr = computed(() => {
  if (!fromAmount.value || !toAmount.value) return;
  return toAmount.value.div(fromAmount.value);
});

const canFlipAssets = computed(() => {
  if (!fromAsset.value || !toAsset.value) return false;

  const fromBalance = wallet.balance.find((b) => b.tokenId === fromAsset.value?.tokenId)?.balance;
  const toBalance = wallet.balance.find((b) => b.tokenId === toAsset.value?.tokenId)?.balance;
  const canBuy = can("buy", fromAsset.value, fromBalance, toAsset.value, true);
  const canSell = can("sell", toAsset.value, toBalance, fromAsset.value, true);

  return canBuy && canSell;
});

const v$ = useVuelidate(
  computed(() => ({
    fromAmount: {
      balance: helpers.withMessage(
        () => t("dapps.sigmaUsd.insufficientBalance", { asset: fromAsset.value?.metadata?.name }),
        (n: BigNumber) => {
          if (!fromAsset.value || !n) return true;
          return n.lte(fromAsset.value.balance);
        }
      ),
      maxRedeem: helpers.withMessage(() => buildBankErrorMessage(fromAsset), maxAction(fromAsset))
    },
    toAmount: {
      maxMinting: helpers.withMessage(() => buildBankErrorMessage(toAsset), maxAction(toAsset))
    }
  })),
  { fromAmount, toAmount },
  { $autoDirty: true, $scope: "sigma-usd" }
);

watch(
  () => [txFee.value, bank.value, toAsset.value],
  () => convert(lastChanged.value, false)
);

watch(fromAsset, () => {
  if (
    fromAsset.value?.tokenId === toAsset.value?.tokenId || // can't swap between the same asset
    (fromAsset.value?.tokenId !== ERG_INFO.tokenId && toAsset.value?.tokenId !== ERG_INFO.tokenId) // can't swap between SigUSD and SigSRV
  ) {
    lastChanged.value = "from";
    toAsset.value = undefined;
    toAmount.value = undefined;
    return;
  }

  convert(lastChanged.value, false);
});

const fromWatcher = pausableWatch(fromAmount, () => convert("from"));
const toWatcher = pausableWatch(toAmount, () => convert("to"));

watch(
  () => chain.height,
  () => loadBankFrom("blockchain+mempool")
);

onMounted(async () => {
  loading.value = true;

  // Load metadata for SigUSD and SigSRV, if not already loaded
  assets.loadMetadata([SIGUSD_INFO.tokenId, SIGSRV_INFO.tokenId]);
  // Load bank and oracle boxes
  await loadBankFrom("blockchain+mempool");

  loading.value = false;
});

onBeforeUnmount(() => bankUpdateInterval.pause());

async function convert(source: "from" | "to", retainSourceInfo = true) {
  const sourceAsset = source === "from" ? fromAsset.value : toAsset.value;
  const targetAsset = source === "from" ? toAsset.value : fromAsset.value;
  const sourceAmount = source === "from" ? fromAmount.value : toAmount.value;
  const targetAmount = source === "from" ? toAmount : fromAmount;
  const targetWatcher = source === "from" ? toWatcher : fromWatcher;

  if (!sourceAsset || !targetAsset) return;
  if (sourceAsset.tokenId === targetAsset.tokenId) return;

  try {
    targetWatcher.pause();

    await nextTick(() => {
      if (!sourceAmount || sourceAmount.isZero() || !bank.value) {
        targetAmount.value = _0;
        return;
      }

      const decimals = targetAsset.metadata?.decimals ?? 0;
      targetAmount.value =
        sourceAsset.tokenId === ERG_INFO.tokenId
          ? dbn(findTokenAmount(action.value, sourceAmount, targetAsset, bank.value), decimals)
          : dbn(findErgAmount(action.value, sourceAmount, sourceAsset, bank.value), decimals);
    });
  } finally {
    if (retainSourceInfo) lastChanged.value = source;
    targetWatcher.resume();
  }
}

function findErgAmount(
  action: ActionType,
  token: BigNumber,
  asset: Asset,
  bankInstance: SigmaUSDBank
): bigint {
  let x = udec(token, asset.metadata?.decimals);
  return action === "minting"
    ? bankInstance.getMintingCostFor(x, getCoinType(asset), "total", txFeeNanoergs.value)
    : bankInstance.getRedeemingAmountFor(x, getCoinType(asset), "total", txFeeNanoergs.value);
}

function findTokenAmount(
  action: ActionType,
  erg: BigNumber,
  asset: Asset,
  bankInstance: SigmaUSDBank
): bigint {
  return action === "minting"
    ? findMintingTokenAmount(erg, asset, bankInstance)
    : findRedeemingTokenAmount(erg, asset, bankInstance);
}

function findMintingTokenAmount(ergAmount: BigNumber, asset: Asset, bank: SigmaUSDBank): bigint {
  const type = getCoinType(asset);
  const txFee = txFeeNanoergs.value;
  const p = type === "stable" ? bank.stableCoinPrice : bank.reserveCoinPrice;

  let x = udec(ergAmount, ERG_DECIMALS);
  let low = 0n;
  let high = x;
  let mid = 0n;

  while (low <= high) {
    mid = low + (high - low) / 2n;
    const c = bank.getMintingCostFor(mid / p, type, "total", txFee);

    if (c === x || (c < x && c + p > x)) return mid / p;
    if (c < x) low = mid + 1n;
    else high = mid - 1n;
  }

  return mid / p;
}

function findRedeemingTokenAmount(ergAmount: BigNumber, asset: Asset, bank: SigmaUSDBank): bigint {
  const p = getCoinType(asset) === "stable" ? bank.stableCoinPrice : bank.reserveCoinPrice;
  const x = udec(ergAmount, ERG_DECIMALS);
  const fees = bank.getProtocolFee(x) + bank.getImplementorFee(x) + txFeeNanoergs.value;

  return (x + fees) / p;
}

async function loadBankFrom(from: BoxSource) {
  if (bankUpdateInterval.isActive) bankUpdateInterval.pause();

  try {
    const [bankBox, oracleBox] = await Promise.all([
      getBankBox(from),
      // always load oracle box from the blockchain to avoid tx getting
      // dropped by oracle updates during price changes
      from !== "mempool" ? getOracleBox() : undefined
    ]);

    if (!bank.value) {
      if (!bankBox || !oracleBox) return;

      bank.value = new SigmaUSDBank(bankBox, oracleBox).setImplementorFee({
        percentage: 22n,
        precision: 4n,
        address: "9g2FAxryPZ98qH6W5E3qyVYj2kyqgUE7HjfA1CdBT25FJWewpav"
      });
      return;
    }

    let changed = false;
    if (bankBox && bankBox.boxId !== bank.value.bankBox.boxId) {
      changed = true;
      bank.value.bankBox = bankBox;
    }
    if (oracleBox && oracleBox.boxId !== bank.value.oracleBox.boxId) {
      changed = true;
      bank.value.oracleBox = oracleBox;
    }

    if (changed) triggerRef(bank);
  } finally {
    bankUpdateInterval.resume();
  }
}

function getMax(asset: Ref<Asset | undefined>, action: ActionType): BigNumber {
  const coinType = getCoinType(asset.value);
  return action === "redeeming"
    ? coinType === "stable"
      ? bankInfo.value.redeemableStable
      : bankInfo.value.redeemableReserve
    : coinType === "stable"
      ? bankInfo.value.availableStable
      : bankInfo.value.availableReserve;
}

function maxAction(asset: Ref<Asset | undefined>) {
  return (amount: BigNumber) => {
    if (!asset.value || !amount || isErg(asset.value.tokenId)) return true; // can always use ERG
    return amount.lte(getMax(asset, action.value));
  };
}

function buildBankErrorMessage(asset: Ref<Asset | undefined>) {
  return t("dapps.sigmaUsd.blockedAction", {
    action: action.value === "minting" ? t("dapps.sigmaUsd.buy") : t("dapps.sigmaUsd.sell"),
    amount: format.number.decimal(getMax(asset, action.value)),
    asset: asset.value?.metadata?.name
  });
}

function convertibleAsset(
  action: "buy" | "sell",
  asset: AssetInfo,
  oddSelection?: Ref<Asset | undefined>
): Asset {
  let balance: BigNumber;
  if (action === "sell") {
    balance = wallet.balance.find((b) => b.tokenId === asset.tokenId)?.balance ?? _0;
  } else {
    if (asset.tokenId === SIGUSD_INFO.tokenId) {
      balance = bankInfo.value.availableStable;
    } else if (asset.tokenId === SIGSRV_INFO.tokenId) {
      balance = bankInfo.value.availableReserve;
    } else {
      balance = bn(-1); // forces balance hidden state
    }
  }

  return {
    ...asset,
    balance,
    disabled: !can(action, asset, balance, oddSelection?.value)
  };
}

function can(
  action: "buy" | "sell",
  asset: AssetInfo,
  balance?: BigNumber,
  oddAsset?: Asset,
  strict = false
): boolean {
  if (!bank.value) return true; // if it's called before bank is loaded
  if (asset.tokenId !== ERG_INFO.tokenId && loading.value) return false;

  if (!strict && action === "buy") {
    if (asset.tokenId === oddAsset?.tokenId) return false; // can't buy the same asset
    if (oddAsset && asset.tokenId !== ERG_INFO.tokenId && oddAsset?.tokenId !== ERG_INFO.tokenId) {
      return false; // can't swap between SigUSD and SigSRV
    }
  }

  balance = balance ?? _0;
  const rr = bankInfo.value.reserveRatio;
  if (asset.tokenId === SIGUSD_INFO.tokenId) {
    if (action === "sell") return balance.gt(0); // can always sell SigUSD if balance is above 0
    return rr >= 400; // can only buy SigUSD if reserve is above 400%
  }
  if (asset.tokenId === SIGSRV_INFO.tokenId) {
    if (action === "sell") return rr >= 400 && balance.gt(0); // can only sell SigSRV if reserve is above 400% and balance is above 0
    return rr <= 800; // can only buy SigRSV if reserve is below 800%
  }

  return true; // can always buy/sell ERG
}

function sendTransaction() {
  openTransactionSignDialog({ transactionBuilder: createTransaction, onSuccess: resetInputs });
}

function resetInputs() {
  fromAmount.value = _0;
  toAmount.value = _0;
  fromAsset.value = fromAssets.value[0];
  toAsset.value = undefined;
  txFee.value = { tokenId: ERG_TOKEN_ID, value: RECOMMENDED_FEE };
}

async function createTransaction() {
  if (!bank.value) throw new Error("Bank is not loaded");

  const amount = udec(nonErg.value.amount, nonErg.value.asset?.metadata?.decimals);
  const coin = getCoinType(nonErg.value.asset);

  return createExchangeTransaction(
    bank.value,
    action.value === "minting" ? { mint: coin, amount } : { redeem: coin, amount },
    txFeeNanoergs.value
  );
}

function flipAssets() {
  if (!canFlipAssets.value) return;

  const from = fromAsset.value;
  const to = toAsset.value;
  fromAsset.value = fromAssets.value.find((x) => x.tokenId === to?.tokenId);
  toAsset.value = toAssets.value.find((x) => x.tokenId === from?.tokenId);

  if (lastChanged.value === "from") {
    lastChanged.value = "to";
    toAmount.value = fromAmount.value;
  } else {
    lastChanged.value = "from";
    fromAmount.value = toAmount.value;
  }
}

function getFee(feeType: FeeType, asset?: Asset, amount?: BigNumber): BigNumber {
  if (!bank.value || !asset || !amount) return _0;

  return dbn(
    bank.value.getFeeAmountFor(
      udec(amount, asset.metadata?.decimals),
      getCoinType(asset),
      feeType,
      txFeeNanoergs.value
    ),
    ERG_DECIMALS
  );
}

function getCoinType(asset: AssetInfo | undefined): CoinType {
  if (asset?.tokenId === SIGUSD_INFO.tokenId) return "stable";
  else return "reserve";
}

function udec(amount: BigNumber | undefined, decimals?: number): bigint {
  if (!amount) return BigInt(0);
  return BigInt(undecimalize(amount, decimals).toString());
}
</script>
<template>
  <div class="flex h-full flex-col gap-4 p-4">
    <div class="flex gap-4">
      <StatsCard
        class="w-full"
        :title="t('dapps.sigmaUsd.bankReserves')"
        :icon="LandmarkIcon"
        content-class="items-end gap-1 justify-between"
      >
        <template v-if="loading">
          <Skeleton class="h-5 w-13" />
          <Skeleton class="h-3.5 w-12" />
        </template>
        <template v-else>
          <p class="text-xl leading-none font-semibold">
            {{ format.number.percent(bankInfo.reserveRatio / 100) }}
          </p>
          <p class="text-muted-foreground text-xs leading-tight">
            {{ format.number.currency(bankInfo.baseReserves, "erg") }}
          </p>
        </template>
      </StatsCard>
      <StatsCard
        class="w-full min-w-max"
        :title="t('dapps.sigmaUsd.oracleRate')"
        :icon="DollarSignIcon"
        content-class="items-end gap-1 justify-between"
      >
        <template v-if="loading">
          <Skeleton class="h-5 w-14" />
          <Skeleton class="h-3.5 w-9" />
        </template>
        <template v-else>
          <p class="text-xl leading-none font-semibold">
            {{ format.number.currency(bankInfo.stableRate, app.settings.conversionCurrency) }}
          </p>
          <p class="text-muted-foreground text-xs leading-tight" v-once>
            {{ format.number.namedCurrency(1, "ERG") }}
          </p>
        </template>
      </StatsCard>
    </div>

    <div class="relative flex flex-col gap-2">
      <AssetInputSelect
        v-model:amount="fromAmount"
        v-model:selected-asset="fromAsset"
        :reserved-amount="fromAsset && isErg(fromAsset.tokenId) ? reservedErgAmount : undefined"
        :disabled="loading"
        :assets="fromAssets"
      />
      <AssetInputSelect
        v-model:amount="toAmount"
        v-model:selected-asset="toAsset"
        :disabled="loading"
        :assets="toAssets"
      />

      <Button
        :disabled="loading || !canFlipAssets"
        tabindex="-1"
        size="icon"
        variant="outline"
        class="absolute top-1/2 left-1/2 size-8 -translate-x-1/2 -translate-y-1/2 disabled:opacity-100"
        @click="flipAssets"
        @mouseover="flipButtonHover = true"
        @mouseout="flipButtonHover = false"
      >
        <ArrowDownUpIcon
          v-if="canFlipAssets && flipButtonHover && !loading"
          class="in-disabled:opacity-50"
        />
        <ArrowDownIcon v-else class="in-disabled:opacity-50" />
      </Button>
    </div>

    <div class="-mt-2 -mb-2 grow space-y-4">
      <Accordion
        v-if="bankInfo && tcr?.isPositive()"
        v-model="isFeeBreakdownOpen"
        type="single"
        collapsible
      >
        <AccordionItem value="opened" class="border-none">
          <AccordionTrigger class="text-muted-foreground p-0 pr-2 text-xs hover:no-underline">
            <div class="text-muted-foreground flex w-full items-center justify-between px-2">
              <div>
                {{
                  format.number.namedCurrency(1, format.asset.name(fromAsset)) +
                  " = " +
                  format.number.namedCurrency(
                    tcr,
                    format.asset.name(toAsset),
                    Math.min(toAsset?.metadata?.decimals ?? 0, 4)
                  )
                }}
              </div>
              <I18nT
                v-if="!isFeeBreakdownOpen"
                keypath="dapps.sigmaUsd.feeSummary"
                tag="div"
                class="font-semibold"
                scope="global"
              >
                <template #amount>
                  <span class="font-normal">{{
                    format.number.namedCurrency(totalFee, "ERG", 4)
                  }}</span>
                </template>
              </I18nT>
            </div>
          </AccordionTrigger>
          <AccordionContent class="space-y-1 px-2 pt-2 pb-0 text-xs">
            <div class="flex items-center justify-between">
              <div class="font-medium">
                <I18nT keypath="dapps.sigmaUsd.protocolFee" scope="global">
                  <template #rate>
                    <span class="text-muted-foreground" v-once>{{
                      format.number.percent(0.02)
                    }}</span>
                  </template>
                </I18nT>

                <TooltipProvider :delay-duration="100">
                  <Tooltip>
                    <TooltipTrigger class="cursor-default pl-1">
                      <InfoIcon class="inline size-3.5" />
                    </TooltipTrigger>
                    <TooltipContent class="max-w-52 hyphens-auto">
                      {{ t("dapps.sigmaUsd.protocolFeeDesc") }}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div>{{ format.number.namedCurrency(protocolFee, "ERG") }}</div>
            </div>
            <div class="flex items-center justify-between">
              <div class="font-medium">
                <I18nT keypath="dapps.sigmaUsd.serviceFee" scope="global">
                  <template #rate>
                    <span class="text-muted-foreground" v-once>{{
                      format.number.percent(0.0022)
                    }}</span>
                  </template>
                </I18nT>

                <TooltipProvider :delay-duration="100">
                  <Tooltip>
                    <TooltipTrigger class="cursor-default pl-1">
                      <InfoIcon class="inline size-3.5" />
                    </TooltipTrigger>
                    <TooltipContent class="max-w-52 hyphens-auto">
                      {{ t("dapps.sigmaUsd.serviceFeeDesc") }}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div>{{ format.number.namedCurrency(uiFee, "ERG") }}</div>
            </div>
            <div class="flex items-center justify-between">
              <div class="font-medium">
                {{ t("dapps.sigmaUsd.networkFee") }}
                <TooltipProvider :delay-duration="100">
                  <Tooltip>
                    <TooltipTrigger class="cursor-default">
                      <InfoIcon class="inline size-3.5" />
                    </TooltipTrigger>
                    <TooltipContent class="max-w-52 hyphens-auto">
                      {{ t("dapps.sigmaUsd.networkFeeDesc") }}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <Popover>
                  <PopoverTrigger as-child>
                    <Button
                      variant="minimal"
                      :disabled="loading"
                      class="ml-1 size-3.5 align-middle"
                      size="condensed"
                    >
                      <SettingsIcon />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent class="p-0">
                    <TransactionFeeConfig
                      v-model="txFee"
                      erg-only
                      :max-multiplier="1000"
                      class="border-0 shadow-none"
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div>{{ format.number.namedCurrency(networkFee, "ERG") }}</div>
            </div>
            <div class="flex items-center justify-between font-semibold">
              <div>{{ t("dapps.sigmaUsd.totalFee") }}</div>
              <div>{{ format.number.namedCurrency(totalFee, "ERG") }}</div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <Alert variant="destructive" class="space-x-2" v-if="v$.$errors.length">
        <AlertDescription class="text-xs">
          <ul :class="v$.$errors.length > 1 ? 'ml-4 list-disc' : 'list-none'">
            <li v-for="e in v$.$errors" :key="e.$uid">{{ e.$message }}</li>
          </ul>
        </AlertDescription>
      </Alert>
    </div>

    <Button
      :disabled="loading || !hasInputValues || v$.$invalid"
      class="w-full"
      size="lg"
      @click="sendTransaction"
      >{{ t("common.swap") }}</Button
    >
  </div>
</template>
