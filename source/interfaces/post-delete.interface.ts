import { Document } from "../types/document.interface";
import { IModel } from "./model.interface";
import { IQueryOptions } from "./query-options.interface";

export interface IPostDelete<ModelType = IModel> {
  /**
   * Overridable hook which is called after each model deletion
   * @param deleted
   * @param options
   */
  postDelete(
    deleted: Document<ModelType>,
    options?: IQueryOptions<ModelType>
  ): Promise<void>;
}
