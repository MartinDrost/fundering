import { Document } from "../types/document.interface";
import { IModel } from "./model.interface";
import { IQueryOptions } from "./query-options.interface";

export interface IOnDeleteHooks<ModelType = IModel> {
  /**
   * Overridable hook which is called before each delete.
   * @param existing
   * @param options
   */
  preDelete(
    existing: ModelType,
    options?: IQueryOptions<ModelType>
  ): Promise<void>;

  /**
   * Overridable hook which is called after each delete
   * @param deleted
   * @param options
   */
  postDelete(
    deleted: Document<ModelType>,
    options?: IQueryOptions<ModelType>
  ): Promise<void>;
}
