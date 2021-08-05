import { Document } from "../types";
import { IModel } from "./model.interface";
import { IQueryOptions } from "./query-options.interface";

export interface IPreDelete<ModelType = IModel> {
  /**
   * Overridable hook which is called before each model deletion.
   * @param existing
   * @param options
   */
  preDelete(
    existing: Document<ModelType>,
    options: IQueryOptions<ModelType>
  ): Promise<void> | void;
}
