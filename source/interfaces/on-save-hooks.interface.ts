import { Document } from "../types/document.interface";
import { IModel } from "./model.interface";
import { IQueryOptions } from "./query-options.interface";

export interface IOnSaveHooks<ModelType = IModel> {
  /**
   * Overridable hook which is called before each replace/merge.
   *
   * The returned payload will be used as input for the replace/merge method.
   * @param payload
   * @param existing
   * @param options
   */
  preSave(
    payload: Partial<ModelType>,
    options?: IQueryOptions<ModelType>
  ): Promise<Partial<ModelType>>;

  /**
   * Overridable hook which is called after each replace/merge.
   * @param model
   * @param prevState
   * @param updated
   * @param options
   */
  postSave(
    model: Document<ModelType>,
    prevState: Document<ModelType>,
    options?: IQueryOptions<ModelType>
  ): Promise<void>;
}
