import { IQueryOptions } from "./query-options.interface";

/**
 * Options used for populating a model.
 * All options from IHttpOptions are available and work as expected
 * except for random, distinct, pipelines, session and maxTimeMS.
 */
export interface IPopulateOptions<ModelType = any>
  extends Omit<
    IQueryOptions<ModelType>,
    "random" | "distinct" | "pipelines" | "session" | "maxTimeMS"
  > {
  /**
   * The field to populate from the current level. Objects do not support dot notation.
   * @example "school"
   */
  path: string;

  /**
   * Recursive populate options used for deep population.
   */
  populate?: IPopulateOptions<ModelType>[];
}
