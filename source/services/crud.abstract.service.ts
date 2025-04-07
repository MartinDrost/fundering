import { Model, PopulateOptions, Schema, Types } from "mongoose";
import { IModel } from "../interfaces/model.interface";
import { IQueryOptions } from "../interfaces/query-options.interface";
import { Conditions } from "../types/conditions.type";
import { Document } from "../types/document.interface";
import {
  castConditions,
  deepMerge,
  getDeepestValues,
  getDeepKeys,
  getShallowLookupPipeline,
  hydrateList,
  optionToPipeline,
  populateOptionsToLookupPipeline,
} from "../utilities/service.utilities";
import { logError } from "../utilities/log-error.utilities";

const defaultMaxTime = 10000;
export abstract class CrudService<ModelType extends IModel> {
  public static verbose = false;

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
    const dereferencedOptions = { ...options };

    // back up the session if it exists
    const session = options?.session;

    payload._id = (payload._id ?? payload.id) || undefined;

    const model: Document<ModelType> = await new this._model(payload);
    model.$locals = model.$locals || {};
    model.$locals.options = dereferencedOptions;
    await model.save({ session });

    if (!dereferencedOptions) {
      return model as Document<ModelType>;
    }

    dereferencedOptions.limit = undefined;
    dereferencedOptions.match = undefined;
    dereferencedOptions.skip = undefined;
    dereferencedOptions.disableAuthorization = true;
    dereferencedOptions.session = session;

    return (await this.findById(model._id, dereferencedOptions))!;
  }

  /**
   * Create multiple new entities based on the provided payloads.
   * If any of the payloads are invalid, the whole operation will be aborted
   * and the database will be rolled back to the state before the operation.
   *
   * This method required the database to support transactions.
   * @param payloads an array of payloads to create
   * @param options an option object used to control the operation
   */
  async createMany(
    payloads: ModelType[],
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType>[]> {
    const dereferencedOptions = { ...options };
    const session =
      dereferencedOptions?.session || (await this._model.startSession());
    if (!session.inTransaction()) {
      session.startTransaction();
    }

    dereferencedOptions.session = session;

    try {
      const documents: Document<ModelType>[] = [];
      for (const payload of payloads) {
        documents.push(await this.create(payload, dereferencedOptions));
      }

      if (!options?.session) {
        await session.commitTransaction();
      }

      return documents;
    } catch (error) {
      if (CrudService.verbose) {
        logError(error, `${CrudService.name}.createMany`);
      }

      await session.abortTransaction();
      throw error;
    } finally {
      // end the session if it was created for the operation
      if (!options?.session) {
        await session.endSession();
      }
    }
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
    const dereferencedOptions = { ...options };
    return this.findOne({ _id: id }, dereferencedOptions);
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
    const dereferencedOptions = { ...options };
    return this.find({ _id: { $in: ids } }, dereferencedOptions);
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
    const dereferencedOptions: IQueryOptions<ModelType> = {
      ...options,
      limit: 1,
    };
    return (await this.find(conditions, dereferencedOptions))[0] ?? null;
  }

  /**
   * Find and hydrate multiple entities matching the provided conditions.
   * @param conditions
   * @param options
   */
  async find(
    conditions: Conditions<ModelType>,
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType>[]> {
    const dereferencedOptions = { ...options };
    // log time to calculate the time remaining for hydration
    const startTime = Date.now();

    // execute the query and convert the results to models
    const cursors = await this.query(conditions, dereferencedOptions);
    return hydrateList(
      cursors,
      this,
      (dereferencedOptions?.maxTimeMS ?? defaultMaxTime) -
        (Date.now() - startTime)
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
    const dereferencedOptions: IQueryOptions<ModelType> = {
      ...options,
      pipelines: [
        ...(options?.pipelines ?? []),
        {
          $count: "count",
        },
        { $limit: 1 },
      ],
      limit: 10000, // limit to 10k results to prevent overloading the database
      skip: undefined,
      sort: undefined,
      select: undefined,
      session: undefined,
      populate: undefined,
      random: undefined,
    };

    const result: number =
      (await this.query<{ count: number }>(conditions, dereferencedOptions))[0]
        ?.count ?? 0;
    await this.callHook("postCount", result, dereferencedOptions ?? {});

    return result;
  }

  /**
   * Find multiple entities by turning the provided conditions and options
   * into an aggregation query.
   * @param conditions
   * @param options
   */
  async query<ResponseType = ModelType>(
    conditions: Conditions<ModelType>,
    options: IQueryOptions<ModelType> = {}
  ): Promise<ResponseType[]> {
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
    // disable the authorization hook if the option is set to true and no population is requested
    if (!options.disableAuthorization || options.populate) {
      const authorization =
        (await this.callHook("onAuthorization", options ?? {})) ?? {};
      if (Object.keys(authorization).length) {
        pipeline.push({ $match: { $expr: authorization } });
      }
    }

    // add a unset stage to censor restricted fields
    const unset = (await this.callHook("onCensor", options ?? {})) ?? {};
    if (Object.keys(unset).length) {
      pipeline.push({ $unset: unset });
    }

    // add a shallow lookup stage for matching, sorting
    const filterKeys = getDeepKeys(conditions).concat(
      getDeepestValues(options.addFields ?? {}).map((value) =>
        value.toString().replace(/^\$/, "")
      ),
      Object.keys(sort[0]?.$sort ?? {})
    );
    pipeline = pipeline.concat(
      await getShallowLookupPipeline(filterKeys, this, options)
    );

    // add the $addFields stage for projecting fields
    if (Object.keys(options.addFields ?? {}).length) {
      pipeline.push({ $addFields: options.addFields });
    }

    pipeline.push({ $match: conditions });
    if (options.random) {
      pipeline = pipeline.concat(
        optionToPipeline.random(options.limit ?? (await this.count(conditions)))
      );
    } else {
      pipeline = pipeline.concat(sort);
    }

    if (options.distinct) {
      pipeline = pipeline.concat(optionToPipeline.distinct(options.distinct));

      // perform a second sort because grouping does not preserve the order
      // the first sort places the correct distinct item at the top so both are necessary
      pipeline = pipeline.concat(sort);
    }

    if (!options.random) {
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

    // populate the fields based on the populate options
    const populateStages = await populateOptionsToLookupPipeline(
      options.populate,
      this,
      options
    );
    if (populateStages?.length) {
      pipeline.push(...populateStages);
    }

    // execute aggregate with the built pipeline and the one provided through options
    return this._model
      .aggregate(pipeline.concat(options?.pipelines ?? []) as any)
      .option({
        session: options?.session,
        maxTimeMS: options?.maxTimeMS ?? defaultMaxTime,
      })
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
    const dereferencedOptions = { ...options };
    return (
      await this.upsert(
        { _id: payload._id || payload.id },
        payload,
        dereferencedOptions
      )
    )[0];
  }

  /**
   * Creates or updates multiple entities based on the provided payloads.
   * If any of the payloads are invalid, the whole operation will be aborted
   * and the database will be rolled back to the state before the operation.
   *
   * This method required the database to support transactions.
   * @param payloads an array of payloads to create or update
   * @param options an option object used to control the operation
   */
  async upsertModels(
    payloads: ModelType[],
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType>[]> {
    const dereferencedOptions = { ...options };
    const session =
      dereferencedOptions?.session || (await this._model.startSession());
    if (!session.inTransaction()) {
      session.startTransaction();
    }

    dereferencedOptions.session = session;

    try {
      const documents: Document<ModelType>[] = [];
      for (const payload of payloads) {
        documents.push(await this.upsertModel(payload, dereferencedOptions));
      }

      if (!options?.session) {
        await session.commitTransaction();
      }

      return documents;
    } catch (error) {
      if (CrudService.verbose) {
        logError(error, `${CrudService.name}.upsertModels`);
      }

      await session.abortTransaction();
      throw error;
    } finally {
      // end the session if it was created for the operation
      if (!options?.session) {
        await session.endSession();
      }
    }
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
    const dereferencedOptions = { ...options };
    // replace the models if it yields results
    const models = await this.merge(conditions, payload, dereferencedOptions);
    if (models.length) {
      return models;
    }

    const created = await this.create(payload, dereferencedOptions);
    return created ? [created] : [];
  }

  /**
   * Update a single model based its the (_)id field
   * @param payload
   * @param options
   */
  async replaceModel(payload: ModelType, options?: IQueryOptions<ModelType>) {
    const dereferencedOptions = { ...options };
    const updated = await this.replace(
      { _id: payload._id || payload.id },
      payload,
      dereferencedOptions
    );
    if (!updated[0]) {
      throw new Error("No model found with the provided id");
    }
    return updated[0];
  }

  /**
   * Updates multiple entities based on the provided payloads.
   * If any of the payloads are invalid, the whole operation will be aborted
   * and the database will be rolled back to the state before the operation.
   *
   * This method required the database to support transactions.
   * @param payloads an array of payloads to update
   * @param options an option object used to control the operation
   */
  async replaceModels(
    payloads: ModelType[],
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType>[]> {
    const dereferencedOptions = { ...options };
    const session =
      dereferencedOptions?.session || (await this._model.startSession());
    if (!session.inTransaction()) {
      session.startTransaction();
    }

    dereferencedOptions.session = session;

    try {
      const documents: Document<ModelType>[] = [];
      for (const payload of payloads) {
        documents.push(await this.replaceModel(payload, dereferencedOptions));
      }

      if (!options?.session) {
        await session.commitTransaction();
      }

      return documents;
    } catch (error) {
      if (CrudService.verbose) {
        logError(error, `${CrudService.name}.replaceModels`);
      }

      await session.abortTransaction();
      throw error;
    } finally {
      // end the session if it was created for the operation
      if (!options?.session) {
        await session.endSession();
      }
    }
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
    const dereferencedOptions = { ...options };

    // make sure we're not merging a IDocument
    payload = (payload as any).toObject?.() ?? payload;

    const existingModels = await this.find(conditions, {
      session: dereferencedOptions?.session,
    });
    const alteredModels: Document<ModelType>[] = [];
    for (const existing of existingModels) {
      const _payload = {
        ...payload,
        _id: existing._id,
        id: existing.id,
        __v: undefined,
      };

      let document = this._model.hydrate(_payload) as Document<ModelType>;
      if (mergeCallback && document !== existing) {
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

      document.$locals.options = dereferencedOptions;

      await document.save({ session: dereferencedOptions?.session });
      alteredModels.push(
        (await this.findById(document._id, dereferencedOptions)) ?? document
      );
    }
    return alteredModels;
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
    const dereferencedOptions = { ...options };
    const updated = await this.merge(
      { _id: payload._id || payload.id },
      payload,
      dereferencedOptions
    );
    if (!updated[0]) {
      throw new Error("No model found with the provided id");
    }
    return updated[0];
  }

  /**
   * Merges multiple entities based on the provided payloads.
   * If any of the payloads are invalid, the whole operation will be aborted
   * and the database will be rolled back to the state before the operation.
   *
   * This method required the database to support transactions.
   * @param payloads an array of payloads to merge
   * @param options an option object used to control the operation
   */
  async mergeModels(
    payloads: Partial<ModelType>[],
    options?: IQueryOptions<ModelType>
  ): Promise<Document<ModelType>[]> {
    const dereferencedOptions = { ...options };
    const session =
      dereferencedOptions?.session || (await this._model.startSession());
    if (!session.inTransaction()) {
      session.startTransaction();
    }

    dereferencedOptions.session = session;

    try {
      const documents: Document<ModelType>[] = [];
      for (const payload of payloads) {
        documents.push(await this.mergeModel(payload, dereferencedOptions));
      }

      if (!options?.session) {
        await session.commitTransaction();
      }

      return documents;
    } catch (error) {
      if (CrudService.verbose) {
        logError(error, `${CrudService.name}.mergeModels`);
      }

      await session.abortTransaction();
      throw error;
    } finally {
      // end the session if it was created for the operation
      if (!options?.session) {
        await session.endSession();
      }
    }
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
    const dereferencedOptions = { ...options };
    return this.replace(
      conditions,
      payload as ModelType,
      dereferencedOptions,
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
    const dereferencedOptions = { ...options };
    return (await this.delete({ _id: id }, dereferencedOptions))[0];
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
    const dereferencedOptions = { ...options };
    const selection = await this.find(conditions, dereferencedOptions);
    for (const existing of selection) {
      await existing.deleteOne({ session: dereferencedOptions?.session });
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
      | "onCensor"
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
      | "onCensor"
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
