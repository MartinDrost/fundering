import { Expression } from "../types";
import { IModel } from "./model.interface";
import { IQueryOptions } from "./query-options.interface";

export interface IOnAuthorization<ModelType = IModel> {
  /**
   * Overridable hook which is called before each find query.
   *
   * The returned expression will be used as extra restrictions for searching the
   * entities. This method is mainly used for defining authorization rules.
   *
   * Note that the returned expression is also used during population of relations.
   *
   * Reference: https://docs.mongodb.com/manual/meta/aggregation-quick-reference/#aggregation-expressions
   * @param options
   */
  onAuthorization(options?: IQueryOptions<ModelType>): Promise<Expression>;
}
