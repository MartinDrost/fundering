import { ClientSession } from "mongoose";
import { Conditions } from "../types/conditions.type";
import { IPopulateOptions } from "./populate-options.interface";

export interface IQueryOptions<ModelType = any> {
  sort?: string[];
  random?: boolean;
  skip?: number;
  limit?: number;
  select?: string[];
  distinct?: string;

  match?: Conditions<ModelType>;
  populate?: (string | IPopulateOptions<ModelType>)[];

  pipelines?: Record<string, any>[];
  session?: ClientSession;
  maxTimeMS?: number;

  [key: string]: any;
}
