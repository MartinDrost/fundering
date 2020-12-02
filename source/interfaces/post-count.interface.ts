import { IModel } from "./model.interface";
import { IQueryOptions } from "./query-options.interface";

export interface IPostCount<ModelType = IModel> {
  /**
   * This hook is called after each count query called through the CrudService.
   *
   * The method exists mainly for analytical purposes.
   * @param resultCount
   * @param options
   */
  postCount(
    resultCount: number,
    options: IQueryOptions<ModelType>
  ): Promise<void>;
}
