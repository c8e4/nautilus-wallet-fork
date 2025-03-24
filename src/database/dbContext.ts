import { Dexie, Table } from "dexie";
import { uniqBy } from "es-toolkit";
import { ERG_TOKEN_ID } from "@/constants/ergo";
import {
  IAssetInfo,
  IDbAddress,
  IDbAsset,
  IDbDAppConnection,
  IDbUtxo,
  IDbWallet
} from "@/types/database";

class NautilusDb extends Dexie {
  wallets!: Table<IDbWallet, number>;
  addresses!: Table<IDbAddress, string>;
  assets!: Table<IDbAsset, string[]>;
  connectedDApps!: Table<IDbDAppConnection, string>;
  utxos!: Table<IDbUtxo, string>;
  assetInfo!: Table<IAssetInfo, string>;

  constructor() {
    super("nautilusDb");
    this.version(1).stores({
      wallets: "++id, network, &publicKey",
      addresses: "&script, type, walletId",
      assets: "&[tokenId+address], &[address+tokenId], walletId"
    });

    this.version(2).stores({ addresses: "&script, type, state, walletId" });

    this.version(3).stores({
      connectedDApps: "&origin, walletId",
      addresses: "&script, type, state, index, walletId"
    });

    this.version(4).upgrade(async (t) => {
      t.table("wallets").each((_, k) => {
        t.table("wallets").update(k.primaryKey, {
          "settings.avoidAddressReuse": false,
          "settings.hideUsedAddresses": false,
          "settings.defaultChangeIndex": 0
        });
      });
    });

    this.version(5).stores({ utxos: "&id, spentTxId, address, walletId" });

    this.version(6)
      .stores({ assetInfo: "&id, mintingBoxId, type, subtype" })
      .upgrade(async (t) => {
        const assets = await t.table("assets").toArray();
        if (assets.length === 0) return;

        const assetInfo = uniqBy(
          assets
            .filter((a) => a.tokenId !== ERG_TOKEN_ID)
            .map((a) => {
              return {
                id: a.tokenId,
                mintingBoxId: "",
                decimals: a.decimals,
                name: a.name
              } as IAssetInfo;
            }),
          (a) => a.id
        );
        await t.table("assetInfo").bulkAdd(assetInfo);
      });

    this.version(7).upgrade((tx) => {
      const hideUsedAddresses = "hideUsedAddresses" as keyof IDbWallet["settings"];
      return tx
        .table("wallets")
        .toCollection()
        .modify((wallet: IDbWallet) => {
          wallet.settings.addressFilter = wallet.settings[hideUsedAddresses] ? "active" : "all";
          delete wallet.settings[hideUsedAddresses];
        });
    });
  }
}

export const dbContext = new NautilusDb();
