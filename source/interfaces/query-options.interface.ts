import { ClientSession } from "mongoose";
import { Conditions } from "../types/conditions.type";
import { IPopulateOptions } from "./populate-options.interface";

export interface IQueryOptions<ModelType = any> {
  /**
   * Specifies the conditions which the documents must satisfy to be returned.
   * Queries must satisfy rules set by the $match stage of mongodb aggregations.
   * @example { name: { $in: ["John", "Jane"] } }
   * @see https://docs.mongodb.com/manual/reference/operator/aggregation/match/
   */
  match?: Conditions<ModelType>;

  /**
   * Specifies the fields on which should be sorted.
   * Fields can be prefixed with a hyphen (-) to sort in descending order.
   * @example ["-lastName", "firstName"]
   * @see https://docs.mongodb.com/manual/reference/operator/aggregation/sort/
   */
  sort?: string[];

  /**
   * Specifies the number of documents to skip.
   * @example 5
   * @see https://docs.mongodb.com/manual/reference/operator/aggregation/skip/
   */
  skip?: number;

  /**
   * Specifies the number of documents to return.
   * @example 10
   * @see https://docs.mongodb.com/manual/reference/operator/aggregation/limit/
   */
  limit?: number;

  /**
   * Specifies the fields to return in each model.
   * The fields can be nested by using dot notation.
   * @example ["name", "address.city"]
   * @see https://docs.mongodb.com/manual/reference/operator/aggregation/project/
   */
  select?: string[];

  /**
   * Specifies which fields should be populated on the returned models.
   * The fields can be defined using strings with dot notation for nesting or
   * by using population objects. The string notation is shorter but objects
   * allow you to specify match queries, sort orders, limits etc.
   * @example ['school.students']
   * @example [{ path: 'school', populate: [{ path: 'students' }] }]
   * @see https://mongoosejs.com/docs/populate.html
   */
  populate?: (string | IPopulateOptions<ModelType>)[];

  /**
   * Allows you to define an $addFields stage in the mongodb aggregation pipeline.
   * These fields can be used in the other stages of the pipeline such as match and sort.
   * @example { $addFields: { total: { $sum: ["$price", "$tax"] } } }
   * @see https://docs.mongodb.com/manual/reference/operator/aggregation/addFields/
   */
  addFields?: Record<string, any>;

  /**
   * Specifies the field which you only want distinct (unique) values for.
   * Inspired by SQL distinct.
   * @example "firstName"
   * @see https://www.w3schools.com/sql/sql_distinct.asp
   */
  distinct?: string | string[];

  /**
   * Defines whether you want the result to be in a random order. Useful for
   * batches of documents where you want to get a random sample of the results.
   * This option overrules the sort option.
   * @example true
   * @see https://docs.mongodb.com/manual/reference/operator/aggregation/sample/
   */
  random?: boolean;

  /**
   * Extra aggregation pipelines which should be run after the main pipeline is finished.
   * This is useful for manipulating the data structure of the result.
   * @example [{ $addFields: { total: { $add: ["$price", "$tax"] } } }]
   * @see https://docs.mongodb.com/manual/reference/operator/aggregation
   */
  pipelines?: Record<string, any>[];

  /**
   * The transaction session to use for this query.
   * @see https://mongoosejs.com/docs/api.html#query_Query-session
   */
  session?: ClientSession;

  /**
   * The maximum amount of time to allow the query to run in milliseconds.
   * @example 3000
   * @default 10000
   */
  maxTimeMS?: number;

  /**
   * Disables the authorization hook for this query when set to true.
   * @default false
   */
  disableAuthorization?: boolean;

  /**
   * All other fields which are not explicitly defined will be available in the options object
   * but have no out-of-the-box functionality.
   */
  [key: string]: any;
}
