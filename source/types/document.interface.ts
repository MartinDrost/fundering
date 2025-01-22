import { Document as MongooseDocument } from "mongoose";
import { IModel } from "../interfaces/model.interface";
import { IQueryOptions } from "../interfaces/query-options.interface";

export type Document<ModelType = IModel> = MongooseDocument<string | object> &
  ModelType & {
    $locals: {
      options?: IQueryOptions<ModelType>;
    } & Record<string, any>;
  };
