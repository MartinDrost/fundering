import { Document } from "../types";
import { IModel } from "./model.interface";
import { IQueryOptions } from "./query-options.interface";

export interface IPreSave<ModelType = IModel> {
  /**
   * Overridable hook which is called before each model save.
   *
   * The altered payload will be used as body for saving the model.
   * @param payload
   * @param existing
   * @param options
   */
  preSave(
    payload: Document<ModelType>,
    options: IQueryOptions<ModelType>
  ): Promise<void> | void;
}
