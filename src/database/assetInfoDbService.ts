import { isEmpty } from "@fleet-sdk/common";
import { difference, uniqBy } from "es-toolkit";
import { dbContext } from "@/database/dbContext";
import { IAssetInfo } from "@/types/database";

class AssetInfoDbService {
  public async addIfNotExists(assets: IAssetInfo[]) {
    if (isEmpty(assets)) return;

    assets = uniqBy(assets, (a) => a.id);
    const paramIds = assets.map((a) => a.id);
    const dbIds = await dbContext.assetInfo.where("id").anyOf(paramIds).primaryKeys();
    const uncommited = difference(paramIds, dbIds);

    if (!isEmpty(uncommited)) {
      await dbContext.assetInfo.bulkAdd(assets.filter((a) => uncommited.includes(a.id)));
    }
  }

  public async bulkPut(infos: IAssetInfo[]) {
    await dbContext.assetInfo.bulkPut(infos);
  }

  public async getAnyOf(ids: string[]): Promise<IAssetInfo[]> {
    if (isEmpty(ids)) return [];
    return await dbContext.assetInfo.where("id").anyOf(ids).toArray();
  }

  public async getAllExcept(ids: string[]): Promise<IAssetInfo[]> {
    return await dbContext.assetInfo.where("id").noneOf(ids).toArray();
  }

  public async getAll(): Promise<IAssetInfo[]> {
    return await dbContext.assetInfo.toArray();
  }

  public async get(tokenId: string): Promise<IAssetInfo | undefined> {
    return await dbContext.assetInfo.get(tokenId);
  }
}

export const assetInfoDbService = new AssetInfoDbService();
