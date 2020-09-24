import { ClientSession } from "mongoose";
import { Conditions } from "../types/conditions.type";

export interface IQueryOptions<ModelType = any> {
  sort?: string[];
  random?: boolean;
  skip?: number;
  limit?: number;
  select?: string[];
  distinct?: string;

  filter?: Conditions<ModelType>;
  populate?: string[];

  pipelines?: Record<string, any>[];
  session?: ClientSession;
  maxTimeMS?: number;

  [key: string]: any;
}
