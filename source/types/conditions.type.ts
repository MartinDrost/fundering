export type Conditions<ModelType = any> =
  | {
      [key in keyof ModelType | "$and" | "$or" | "$expr"]?: any;
    }
  | { [key: string]: any };
