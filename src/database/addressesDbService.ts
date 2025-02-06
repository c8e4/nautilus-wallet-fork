import { dbContext } from "@/database/dbContext";
import { IDbAddress, IDbWallet } from "@/types/database";
import { AddressState } from "@/types/internal";
import { walletsDbService } from "./walletsDbService";

class AddressesDbService {
  async getByScript(script: string): Promise<IDbAddress | undefined> {
    return dbContext.addresses.where({ script }).first();
  }

  async getByWalletIdAndScripts(
    walletId: number,
    scripts: string[],
    mode = "loose" as "strict" | "loose"
  ): Promise<IDbAddress[]> {
    const result = await dbContext.addresses
      .where("script")
      .anyOf(scripts)
      .and((a) => a.walletId === walletId)
      .toArray();

    if (mode === "strict" && result.length !== scripts.length) {
      throw Error("One or more selected addresses are not associated with the connected wallet.");
    }

    return result;
  }

  async getByWalletId(walletId: number): Promise<IDbAddress[]> {
    return dbContext.addresses.where({ walletId }).sortBy("index");
  }

  async getByState(walletId: number, state: AddressState): Promise<IDbAddress[]> {
    const addresses = await dbContext.addresses
      .orderBy("index")
      .filter((a) => a.walletId === walletId && a.state == state)
      .toArray();

    return addresses;
  }

  async getChangeAddress(walletId: number): Promise<IDbAddress | undefined> {
    const wallet = await walletsDbService.getById(walletId);
    if (!wallet) {
      return;
    }

    const address = await this._getChangeAddress(wallet);
    if (!address) {
      return await dbContext.addresses
        .orderBy("index")
        .filter((a) => a.walletId === walletId)
        .first();
    }

    return address;
  }

  private async _getChangeAddress(wallet: IDbWallet): Promise<IDbAddress | undefined> {
    if (wallet.settings.avoidAddressReuse) {
      return dbContext.addresses
        .orderBy("index")
        .filter((a) => a.walletId === wallet.id && a.state === AddressState.Unused)
        .first();
    }

    return dbContext.addresses
      .filter((a) => a.walletId === wallet.id && a.index === wallet.settings.defaultChangeIndex)
      .first();
  }

  async put(address: IDbAddress): Promise<string> {
    return dbContext.addresses.put(address);
  }

  async bulkPut(addresses: IDbAddress[]): Promise<void> {
    if (addresses.length === 0) return;
    await dbContext.addresses.bulkPut(addresses);
  }
}

export const addressesDbService = new AddressesDbService();
