export type Conditions<ModelType = any> =
  | {
      [key in keyof ModelType | '$and' | '$or']?: any;
    }
  | { [key: string]: any };
