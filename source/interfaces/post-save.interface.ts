import { Document } from "../types/document.interface";
import { IModel } from "./model.interface";
import { IQueryOptions } from "./query-options.interface";

export interface IPostSave<ModelType = IModel> {
  /**
   * Overridable hook which is called after each document save.
   * @param model
   * @param prevState
   * @param updated
   * @param options
   */
  postSave(
    model: Document<ModelType>,
    prevState: Document<ModelType> | null,
    options: IQueryOptions<ModelType>
  ): Promise<void> | void;
}
