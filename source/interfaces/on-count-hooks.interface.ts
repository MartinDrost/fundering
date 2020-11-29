import { IModel } from "./model.interface";
import { IQueryOptions } from "./query-options.interface";

export interface IOnCountHooks<ModelType = IModel> {
  /**
   * Overridable hook which is called after each count query.
   *
   * The method exists mainly for analytical purposes.
   * @param resultCount
   * @param options
   */
  postCount(
    resultCount: number,
    options?: IQueryOptions<ModelType>
  ): Promise<void>;
}
