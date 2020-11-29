import { Aggregate, Model, ModelUpdateOptions, Schema } from "mongoose";
import { IModel } from "../interfaces/model.interface";
import { IQueryOptions } from "../interfaces/query-options.interface";
import { Conditions } from "../types/conditions.type";
import { Document } from "../types/document.interface";
import { Expression } from "../types/expression.type";
import {
  castConditions,
  deepMerge,
  getDeepKeys,
  getShallowLookupPipeline,
  hydrateList,
} from "../utilities/service.utilities";

const defaultMaxTime = 10000;
export abstract class CrudService<ModelType extends IModel> {
  /**
   * A record mapping model names to their respective services.
   */
  public static serviceMap: Record<string, CrudService<any>> = {};

  constructor(public _model: Model<Document<ModelType>>) {
    CrudService.serviceMap[_model.modelName] = this;

    // create the pre/post save/delete hooks
    const service = this;
    const schema = new Schema();
    schema.pre("save", async function (this: Document<ModelType>) {
      await service.preSave?.(this, this.$locals.options);

      // store the old state if the service has a postSave hook defined
      if (this._id && service.postSave) {
        this.$locals._prevState = await service.findById(this._id);
      }
    });
    schema.post("save", async function (this: Document<ModelType>) {
      // fetch the old state and remove it from the model
      const prevState = this.$locals._prevState;
      delete this.$locals._prevState;

      await service.postSave?.(this, prevState, this.$locals.options);
    });
    schema.pre(
      "deleteOne",
      { query: false, document: true } as any,
      async function (this: Document<ModelType>) {
        await service.preDelete?.(this, this.$locals.options);
      }
    );
    schema.post(
      "deleteOne",
      { query: false, document: true },
      async function (this: Document<ModelType>) {
        await service.postDelete?.(this, this.$locals.options);
      }
    );
    require("mongoose/lib/helpers/model/applyHooks")(_model, schema);
  }

  /**
   * Create a new entity based on the provided payload.
   * @param payload
   * @param options
   */
  create(payload: ModelType, options?: IQueryOptions<ModelType>) {
    return new this._model(payload).save({ session: options?.session });
  }

  /**
   * Find a single entity with the provided id.
   * @param id
   * @param options
   */
  async findById(id: any, options?: IQueryOptions<ModelType>) {
    return (await this.find({ _id: id }, options))[0];
  }

  /**
   * Find multiple entities containing one of the provided ids.
   * @param ids
   * @param options
   */
  findByIds(ids: any[], options?: IQueryOptions<ModelType>) {
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
  ) {
    const _options: IQueryOptions<ModelType> = {
      ...options,
      limit: 1,
    };
    return (await this.find(conditions, _options))[0];
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
  ) {
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
    await this.postCount?.(result, _options);

    return result;
  }

  /**
   * Perform a mongodb aggregate query.
   * Merely a placeholder to work consistently through Fundering.
   * @param aggregations
   */
  aggregate(aggregations?: any | undefined): Aggregate<any[]> {
    return this._model.aggregate(aggregations).exec();
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

    // merge the filter options with the $and conditions
    conditions.$and = [{}, ...(conditions.$and ?? []), options?.filter ?? {}];

    // cast any eligible fields to their basic types
    conditions = castConditions(conditions, this);

    // set projection fields based on select options
    const projection: Record<string, any> = {};
    for (const path of options?.select ?? []) {
      let reference = projection;
      const splitPath = path.split(".");
      for (let i = 0; i < splitPath.length; i++) {
        const key = splitPath[i];
        if (typeof reference[key] !== "object") {
          reference[key] = {};
        }
        // set the tail to 1 if it's no filled object
        if (i + 1 === splitPath.length && !Object.keys(reference[key]).length) {
          reference[key] = 1;
        }

        reference = reference[key];
      }
    }
    options?.select
      ?.filter((field) => !field.includes("."))
      .forEach((field) => (projection[field] = 1));

    // set sort fields based on sort options
    const sort: Record<string, number> = {};
    options?.sort?.forEach((field) => {
      const desc = field.startsWith("-");
      const cleanField = desc ? field.replace("-", "") : field;
      sort[cleanField] = desc ? -1 : 1;
    });

    // build the aggregation pipeline
    let pipeline: Record<string, any>[] = [];

    // add a match stage for the authorization expression
    const authorization = (await this.onAuthorization?.(options)) ?? {};
    if (Object.keys(authorization).length) {
      pipeline.push({ $match: { $expr: authorization } });
    }

    // add a shallow lookup stage for matching, sorting
    const filterKeys = getDeepKeys(conditions).concat(Object.keys(sort));
    pipeline = pipeline.concat(
      await getShallowLookupPipeline(filterKeys, this, options)
    );

    pipeline.push({ $match: conditions });
    if (options?.distinct) {
      pipeline.push({
        $group: {
          _id: `$${options.distinct}`,
          doc: { $first: "$$ROOT" },
        },
      });
      pipeline.push({ $replaceRoot: { newRoot: "$doc" } });
    }
    if (options?.random) {
      const size = options.limit ?? (await this.count(conditions));
      pipeline.push({ $sample: { size } });
    } else {
      if (Object.keys(sort).length) {
        pipeline.push({ $sort: sort });
      }
      if (options?.skip) {
        pipeline.push({ $skip: options.skip });
      }
    }
    if (options?.limit) {
      pipeline.push({ $limit: options.limit });
    }

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

    if (Object.keys(projection).length) {
      pipeline.push({ $project: projection });
    }

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

        let document: Document<ModelType> = this._model.hydrate(_payload);
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

        return document.save({ session: options?.session });
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
  async deleteById(id: any, options?: IQueryOptions<ModelType>) {
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
  ) {
    const selection = await this.find(conditions, options);
    for (const existing of selection) {
      await existing.deleteOne({ session: options?.session } as any);
    }

    return selection;
  }

  /**
   * Overridable hook which is called before each find query.
   *
   * The returned expression will be used as extra restrictions for searching the
   * entities. This method is mainly used for defining authorization rules.
   *
   * Note that the returned expression is also used during population of relations.
   *
   * Reference: https://docs.mongodb.com/manual/meta/aggregation-quick-reference/#aggregation-expressions
   * @param options
   */
  onAuthorization?: (options?: IQueryOptions<ModelType>) => Promise<Expression>;

  /**
   * Overridable hook which is called after each count query.
   *
   * The method exists mainly for analytical purposes.
   * @param resultCount
   * @param options
   */
  postCount?: (
    resultCount: number,
    options?: IQueryOptions<ModelType>
  ) => Promise<void>;

  /**
   * Overridable hook which is called before each replace/merge.
   *
   * The returned payload will be used as input for the replace/merge method.
   * @param payload
   * @param existing
   * @param options
   */
  preSave?: (
    payload: Partial<ModelType>,
    options?: IQueryOptions<ModelType>
  ) => Promise<Partial<ModelType>>;

  /**
   * Overridable hook which is called after each replace/merge.
   * @param model
   * @param prevState
   * @param updated
   * @param options
   */
  postSave?: (
    model: Document<ModelType>,
    prevState: Document<ModelType>,
    options?: IQueryOptions<ModelType>
  ) => Promise<void>;

  /**
   * Overridable hook which is called before each delete.
   * @param existing
   * @param options
   */
  preDelete?: (
    existing: ModelType,
    options?: IQueryOptions<ModelType>
  ) => Promise<void>;

  /**
   * Overridable hook which is called after each delete
   * @param deleted
   * @param options
   */
  postDelete?: (
    deleted: Document<ModelType>,
    options?: IQueryOptions<ModelType>
  ) => Promise<void>;
}
