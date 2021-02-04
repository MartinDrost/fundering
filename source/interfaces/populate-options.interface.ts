import { IQueryOptions } from "./query-options.interface";

export interface IPopulateOptions<ModelType = any>
  extends Omit<
    IQueryOptions<ModelType>,
    "random" | "pipelines" | "session" | "maxTimeMS"
  > {
  path: string;
  populate?: IPopulateOptions<ModelType>[];
}
