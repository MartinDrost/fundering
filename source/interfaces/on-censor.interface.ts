import { IModel } from "./model.interface";
import { IQueryOptions } from "./query-options.interface";

export interface IOnCensor<ModelType = IModel> {
  /**
   * This hook is called before each find query called through the CrudService.
   *
   * The returned array should contain the fields which should be censored. These
   * fields will be removed on query level and will not be available in the result.
   * The hook is implemented after the authorization rules are applied and before
   * the addFields and match options are set to make all fields available when
   * restrictring documents while preventing the user to manipulate or match on the data.
   *
   * The returned array is also used to censor populated data.
   *
   * Reference: https://www.mongodb.com/docs/v4.4/reference/operator/aggregation/unset/
   * @param options
   */
  onCensor(options: IQueryOptions<ModelType>): Promise<string[]> | string[];
}
