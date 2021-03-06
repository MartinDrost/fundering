import { Model, ModelUpdateOptions, Schema } from "mongoose";
import { IModel } from "../interfaces/model.interface";
import { IQueryOptions } from "../interfaces/query-options.interface";
import { Conditions } from "../types/conditions.type";
import { Document } from "../types/document.interface";
import {
  castConditions,
  deepMerge,
  getDeepKeys,
  getShallowLookupPipeline,
  hydrateList,
  optionToPipeline,
} from "../utilities/service.utilities";

const defaultMaxTime = 10000;
export abstract class CrudService<ModelType extends IModel> {
  /**
   * A record mapping model names to their respective services.
   */
  public static serviceMap: Record<string, CrudService<any>> = {};

  constructor(public _model: Model<Document | any>) {
    CrudService.serviceMap[_model.modelName] = this;

    // create the pre/post save/delete hooks
    const service = this;
    const schema = new Schema();
    schema.pre("save", async function (this: Document<ModelType>) {
      await service.callHook("preSave", this, this.$locals.options ?? {});

      // store the old state if the service has a postSave hook defined
      if (this._id && service.getHook("postSave")) {
        this.$locals._prevState = await service.findById(this._id);
      }
    });
    schema.post("save", async function (this: Document<ModelType>) {
      // fetch the old state and remove it from the model
      const prevState = this.$locals._prevState;
      delete this.$locals._prevState;

      await service.callHook(
        "postSave",
        this,
        prevState ?? null,
        this.$locals.options ?? {}
      );
    });
    schema.pre(
      "deleteOne",
      { query: false, document: true } as any,
      async function (this: Document<ModelType>) {
        await service.callHook("preDelete", this, this.$locals.options ?? {});
      }
    );
    schema.post(
      "deleteOne",
      { query: false, document: true },
      async function (this: Document<ModelType>) {
        await service.callHook("postDelete", this, this.$locals.options ?? {});
      }
    );
    require("mongoose/lib/helpers/model/applyHooks")(_model, schema);
  }

  /**
   * Create a new entity based on the provided payload.
   * @param payload
   * @param options
   */
  async create(
    payload: ModelType,
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType>> {
    const model = await new this._model(payload);
    model.$locals = model.$locals || {};
    model.$locals.options = options;
    await model.save({
      session: options?.session,
    });

    if (!options) {
      return model as Document<ModelType>;
    }

    return (await this.findById(model._id, {
      populate: options?.populate,
      select: options?.select,
      session: options?.session,
      maxTimeMS: options?.maxTimeMS,
    }))!;
  }

  /**
   * Find a single entity with the provided id.
   * @param id
   * @param options
   */
  async findById(
    id: any,
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType> | null> {
    return this.findOne({ _id: id }, options);
  }

  /**
   * Find multiple entities containing one of the provided ids.
   * @param ids
   * @param options
   */
  findByIds(
    ids: any[],
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType>[]> {
    return this.find({ _id: { $in: ids } }, options);
  }

  /**
   * Finds a single entity matching the provided conditions.
   * @param conditions
   * @param options
   */
  async findOne(
    conditions: Conditions<ModelType>,
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType> | null> {
    const _options: IQueryOptions<ModelType> = {
      ...options,
      limit: 1,
    };
    return (await this.find(conditions, _options))[0] ?? null;
  }

  /**
   * Find multiple entities matching the provided conditions.
   * @param conditions
   * @param options
   */
  async find(
    conditions: Conditions<ModelType>,
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType>[]> {
    // log time to calculate the time remaining for hydration
    const startTime = Date.now();

    // execute the query and convert the results to models
    const cursors = await this.query(conditions, options);
    return hydrateList(
      cursors,
      this,
      (options?.maxTimeMS ?? defaultMaxTime) - (Date.now() - startTime),
      options
    );
  }

  /**
   * Returns the total number of documents that would result from the conditions and options
   * @param conditions
   * @param options
   */
  async count(
    conditions: Conditions<ModelType>,
    options?: IQueryOptions<ModelType>
  ): Promise<number> {
    // disable options that would limit the results or add redundant load
    const _options: IQueryOptions<ModelType> = {
      ...options,
      pipelines: [
        {
          $count: "count",
        },
        { $limit: 1 },
      ],
      limit: undefined,
      skip: undefined,
      sort: undefined,
      select: undefined,
      session: undefined,
      populate: undefined,
      random: undefined,
    };

    const result: number =
      (await this.query(conditions, _options))[0]?.count ?? 0;
    await this.callHook("postCount", result, _options ?? {});

    return result;
  }

  /**
   * Find multiple entities by turning the provided conditions and options
   * into an aggregation query.
   * @param conditions
   * @param options
   */
  async query(
    conditions: Conditions<ModelType>,
    options: IQueryOptions<ModelType> = {}
  ) {
    // clone the conditions object
    conditions = { ...conditions };

    // merge the match options with the $and conditions
    conditions.$and = [{}, ...(conditions.$and ?? []), options?.match ?? {}];

    // cast any eligible fields to their basic types
    conditions = castConditions(conditions, this);

    // set sort fields based on sort options
    const sort = optionToPipeline.sort(options.sort);

    // build the aggregation pipeline
    let pipeline: Record<string, any>[] = [];

    // add a match stage for the authorization expression
    const authorization =
      (await this.callHook("onAuthorization", options ?? {})) ?? {};
    if (Object.keys(authorization).length) {
      pipeline.push({ $match: { $expr: authorization } });
    }

    // add a shallow lookup stage for matching, sorting
    const filterKeys = getDeepKeys(conditions).concat(
      Object.keys(sort[0] ?? {})
    );
    pipeline = pipeline.concat(
      await getShallowLookupPipeline(filterKeys, this, options)
    );

    pipeline.push({ $match: conditions });
    pipeline = pipeline.concat(optionToPipeline.distinct(options.distinct));
    if (options.random) {
      pipeline = pipeline.concat(
        optionToPipeline.random(options.limit ?? (await this.count(conditions)))
      );
    } else {
      pipeline = pipeline.concat(sort);
      pipeline = pipeline.concat(optionToPipeline.skip(options.skip));
    }
    pipeline = pipeline.concat(optionToPipeline.limit(options.limit));

    // unset virtuals populated for conditions and sorting
    pipeline.push({
      $project: Object.keys((this._model.schema as any).virtuals).reduce(
        (prev, curr) => {
          prev[curr] = 0;
          return prev;
        },
        {}
      ),
    });

    // set projection fields based on select options
    pipeline = pipeline.concat(optionToPipeline.select(options.select));

    // execute aggregate with the built pipeline and the one provided through options
    return this._model
      .aggregate(pipeline.concat(options?.pipelines ?? []))
      .option({
        session: options?.session,
        maxTimeMS: options?.maxTimeMS ?? defaultMaxTime,
      })
      .exec();
  }

  /**
   * Perform a mongodb updateOne query.
   * Merely a placeholder to work consistently through Fundering.
   * @param conditions
   * @param updateQuery
   */
  updateOne(
    conditions: Conditions,
    updateQuery: Conditions,
    updateOptions: ModelUpdateOptions = {}
  ): Promise<any> {
    return this._model
      .updateOne(conditions as any, updateQuery as any, updateOptions)
      .exec();
  }

  /**
   * Perform a mongodb updateMany query.
   * Merely a placeholder to work consistently through Fundering.
   * @param conditions
   * @param updateQuery
   */
  updateMany(
    conditions: Conditions,
    updateQuery: Conditions,
    updateOptions: ModelUpdateOptions = {}
  ): Promise<any> {
    return this._model
      .updateMany(conditions as any, updateQuery as any, updateOptions)
      .exec();
  }

  /**
   * Update an entity if the (_)id matches, create it otherwise
   * @param payload
   * @param options
   */
  async upsertModel(
    payload: ModelType,
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType>> {
    return (
      await this.upsert({ _id: payload._id || payload.id }, payload, options)
    )[0];
  }

  /**
   * Update entities if the conditions match, create the payload otherwise
   * @param payload
   * @param options
   */
  async upsert(
    conditions: Conditions,
    payload: ModelType,
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType>[]> {
    // replace the models if it yields results
    const models = await this.replace(conditions, payload, options);
    if (models.length) {
      return models;
    }

    // remove the id's and create the payload otherwise
    delete payload._id;
    delete payload.id;

    const created = await this.create(payload, options);
    return created ? [created] : [];
  }

  /**
   * Update a single model based its the (_)id field
   * @param payload
   * @param options
   */
  async replaceModel(payload: ModelType, options?: IQueryOptions<ModelType>) {
    const updated = await this.replace(
      { _id: payload._id || payload.id },
      payload,
      options
    );
    if (!updated[0]) {
      throw new Error("No model found with the provided id");
    }
    return updated[0];
  }

  /**
   * Overwrite entities with the provided payload.
   * @param payload
   * @param options
   * @param mergeCallback
   */
  async replace(
    conditions: Conditions,
    payload: ModelType,
    options?: IQueryOptions<ModelType>,
    mergeCallback?: (
      payload: Partial<ModelType>,
      existing: ModelType
    ) => Promise<ModelType>
  ): Promise<Document<ModelType>[]> {
    // make sure we're not merging a IDocument
    payload = (payload as any).toObject?.() ?? payload;

    const existingModels = await this.find(conditions);
    return Promise.all(
      existingModels.map(async (existing) => {
        const _payload = {
          ...payload,
          _id: existing._id,
          id: existing.id,
          __v: undefined,
        };

        let document = this._model.hydrate(_payload) as Document<ModelType>;
        if (mergeCallback) {
          document = (await mergeCallback(_payload, existing)) as any;
        } else {
          // mark changed paths as modified and define undefined values
          for (const field of Object.keys(this._model.schema.paths)) {
            _payload[field] = _payload[field] ?? null;
            if (_payload[field] !== existing[field]) {
              document.markModified(field);
            }
          }
        }

        // marking the version number causes conflicts
        document.unmarkModified("__v");
        delete document.__v;
        await document.save({ session: options?.session });
        return (await this.findById(document._id, options))!;
      })
    );
  }

  /**
   * Merge a single model based its the (_)id field
   * @param payload
   * @param options
   */
  async mergeModel(
    payload: Partial<ModelType>,
    options?: IQueryOptions<ModelType>
  ) {
    const updated = await this.merge(
      { _id: payload._id || payload.id },
      payload,
      options
    );
    if (!updated[0]) {
      throw new Error("No model found with the provided id");
    }
    return updated[0];
  }

  /**
   * Merge existing entities' fields with the provided payload.
   * @param payload
   * @param options
   */
  merge(
    conditions: Conditions,
    payload: Partial<ModelType>,
    options?: IQueryOptions<ModelType>
  ) {
    return this.replace(
      conditions,
      payload as ModelType,
      options,
      async (payload, existing) => deepMerge<ModelType>(existing, payload)
    );
  }

  /**
   * Delete an existing entity by its id.
   * @param id
   * @param options
   */
  async deleteById(
    id: any,
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType> | null> {
    return (await this.delete({ _id: id }, options))[0];
  }

  /**
   * Delete a selection of entities.
   * @param id
   * @param options
   */
  async delete(
    conditions: Conditions<ModelType>,
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType>[]> {
    const selection = await this.find(conditions, options);
    for (const existing of selection) {
      await existing.deleteOne({ session: options?.session } as any);
    }

    return selection;
  }

  /**
   * Gets the corresponding registered hook method if defined.
   * @param hook
   */
  getHook(
    hook:
      | "onAuthorization"
      | "postCount"
      | "preSave"
      | "postSave"
      | "preDelete"
      | "postDelete"
  ): undefined | ((...args: any[]) => Promise<any>) {
    return this[hook as any];
  }

  /**
   * Calls the corresponding registered hook method if defined.
   * @param hook
   */
  callHook(
    hook:
      | "onAuthorization"
      | "postCount"
      | "preSave"
      | "postSave"
      | "preDelete"
      | "postDelete",
    ...args: any[]
  ): any {
    return this[hook as any]?.(...args);
  }
}
