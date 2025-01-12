import { BabelSwapPlugin } from "@fleet-sdk/babel-fees-plugin";
import { EIP12UnsignedTransaction, isEmpty } from "@fleet-sdk/common";
import { CherryPickSelectionStrategy, OutputBuilder, TransactionBuilder } from "@fleet-sdk/core";
import { BigNumber } from "bignumber.js";
import { useAppStore } from "@/stores/appStore";
import { StateAsset, useWalletStore } from "@/stores/walletStore";
import { graphQLService } from "@/chains/ergo/services/graphQlService";
import { bn, undecimalize } from "@/common/bigNumber";
import { hdKeyPool } from "@/common/objectPool";
import { ERG_DECIMALS, ERG_TOKEN_ID, MIN_BOX_VALUE, SAFE_MIN_FEE_VALUE } from "@/constants/ergo";
import { FeeSettings, WalletType } from "@/types/internal";
import { UnconfirmedTransactionSummary } from "@/types/transactions";
import { fetchBabelBoxes, getNanoErgsPerTokenRate, selectBestBabelBox } from "../babelFees";
import { fetchBoxes } from "../boxFetcher";

const SAFE_MAX_CHANGE_TOKEN_LIMIT = 100;

const wallet = useWalletStore();
const app = useAppStore();

export type TxAssetAmount = {
  asset: StateAsset;
  amount?: BigNumber;
};

export async function createRBFCancellationTransaction(
  unconfirmedTx: UnconfirmedTransactionSummary
): Promise<EIP12UnsignedTransaction> {
  const { inputs, currentHeight } = await getContext();
  const ownBoxIds = new Set(unconfirmedTx.ownInputs.map((input) => input.boxId));
  const unsigned = new TransactionBuilder(currentHeight)
    .from(unconfirmedTx.ownInputs, { ensureInclusion: true })
    .and.from(inputs.filter((input) => !ownBoxIds.has(input.boxId)))
    .payFee(undecimalize(unconfirmedTx.fee, ERG_DECIMALS).plus(SAFE_MIN_FEE_VALUE).toString())
    .sendChangeTo(safeGetChangeAddress());

  setSelectionAndChangeStrategy(unsigned, wallet.type);

  return unsigned.build().toEIP12Object();
}

async function getContext() {
  const [inputs, currentHeight] = await Promise.all([
    fetchBoxes(wallet.id, app.settings.zeroConf),
    graphQLService.getHeight()
  ]);

  if (isEmpty(inputs)) {
    throw Error("Unable to fetch inputs, please check your connection.");
  }

  if (!currentHeight) {
    throw Error("Unable to fetch current height, please check your connection.");
  }

  return {
    inputs,
    currentHeight
  };
}

export async function createP2PTransaction({
  recipientAddress,
  assets,
  fee,
  walletType
}: {
  recipientAddress: string;
  assets: TxAssetAmount[];
  fee: FeeSettings;
  walletType: WalletType;
}): Promise<EIP12UnsignedTransaction> {
  const { inputs, currentHeight } = await getContext();
  const isBabelFee = fee.tokenId !== ERG_TOKEN_ID;
  const sendingNanoErgs = getSendingNanoErgs(assets);

  const unsigned = new TransactionBuilder(currentHeight)
    .from(inputs)
    .to(
      new OutputBuilder(
        sendingNanoErgs.eq(0) && isBabelFee ? BigInt(MIN_BOX_VALUE) : sendingNanoErgs.toString(),
        recipientAddress
      ).addTokens(
        assets
          .filter((a) => a.asset.tokenId !== ERG_TOKEN_ID && a.amount && !a.amount.isZero())
          .map((token) => ({
            tokenId: token.asset.tokenId,
            amount: undecimalize(token.amount || bn(0), token.asset.metadata?.decimals).toString()
          }))
      )
    )
    .sendChangeTo(safeGetChangeAddress());

  await setFee(unsigned, fee);
  setSelectionAndChangeStrategy(unsigned, walletType);

  return unsigned.build().toEIP12Object();
}

export function setSelectionAndChangeStrategy(
  builder: TransactionBuilder,
  walletType: WalletType
): TransactionBuilder {
  if (walletType === WalletType.Ledger) {
    return builder
      .configure((settings) => settings.isolateErgOnChange().setMaxTokensPerChangeBox(1))
      .configureSelector((selector) => selector.defineStrategy(new CherryPickSelectionStrategy()));
  }

  return builder
    .configure((settings) => settings.setMaxTokensPerChangeBox(SAFE_MAX_CHANGE_TOKEN_LIMIT))
    .configureSelector((selector) => selector.orderBy((input) => input.creationHeight));
}

export async function setFee(
  builder: TransactionBuilder,
  fee: FeeSettings
): Promise<TransactionBuilder> {
  const isBabelFee = fee.tokenId !== ERG_TOKEN_ID;
  let feeNanoErgs = undecimalize(fee.value, ERG_DECIMALS);
  let sendingNanoErgs = bn(builder.outputs.sum().nanoErgs.toString());

  if (isBabelFee) {
    const tokenUnits = undecimalize(fee.value, fee.assetInfo?.decimals);
    const selectedBox = selectBestBabelBox(
      await fetchBabelBoxes([fee.tokenId], fee.nanoErgsPerToken),
      tokenUnits
    );

    if (!selectedBox) {
      throw Error(
        "There is not enough liquidity in the Babel Boxes for the selected fee asset in the selected price range."
      );
    } else {
      fee.box = selectedBox;
    }

    feeNanoErgs = tokenUnits.multipliedBy(getNanoErgsPerTokenRate(selectedBox));
    if (
      sendingNanoErgs.gt(0) &&
      sendingNanoErgs.lte(MIN_BOX_VALUE) &&
      sendingNanoErgs.lte(feeNanoErgs.minus(SAFE_MIN_FEE_VALUE))
    ) {
      sendingNanoErgs = bn(MIN_BOX_VALUE);
      feeNanoErgs = feeNanoErgs.minus(sendingNanoErgs);
    }

    builder.extend(
      BabelSwapPlugin(fee.box, { tokenId: fee.tokenId, amount: tokenUnits.toString() })
    );
  }

  return builder.payFee(feeNanoErgs.toString());
}

function getSendingNanoErgs(assets: TxAssetAmount[]): BigNumber {
  const erg = assets.find((a) => a.asset.tokenId === ERG_TOKEN_ID);
  return erg && erg.amount ? undecimalize(erg.amount, ERG_DECIMALS) : bn(0);
}

export function safeGetChangeAddress(): string {
  const index = wallet.changeAddress.index ?? 0;
  return hdKeyPool.get(wallet.publicKey).deriveAddress(index).script;
}
