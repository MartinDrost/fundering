import { Document, Model } from "mongoose";
import { IModel } from "../interfaces/model.interface";
import { IQueryOptions } from "../interfaces/query-options.interface";
import { Conditions } from "../types/conditions.type";
import {
  castConditions,
  deepMerge,
  getDeepKeys,
  getLookupPipeline,
} from "../utilities/service.utilities";

export abstract class CrudService<ModelType extends IModel> {
  /**
   * A record mapping model names to their respective services.
   */
  public static serviceMap: Record<string, CrudService<any>> = {};

  constructor(public _model: Model<ModelType & Document>) {
    CrudService.serviceMap[_model.modelName] = this;
  }

  /**
   * Create a new entity based on the provided payload.
   * @param payload
   * @param options
   */
  async create(payload: ModelType, options?: IQueryOptions<ModelType>) {
    const _payload = await this.onBeforeCreate(payload, options);
    const { _id, id } = await new this._model(_payload).save({
      session: options?.session,
    });
    const created = await this.findById(_id || id, options);

    return this.onAfterCreate(_payload, created, options);
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
  ): Promise<(ModelType & Document)[]> {
    conditions.$and = [
      ...(conditions.$and ?? []),
      await this.onBeforeFind(options),
    ];

    // execute the query and convert the results to models
    const cursors = await this.aggregate(conditions, options);
    const models = await Promise.all(
      cursors.map((cursor) => this._model.hydrate(cursor))
    );

    return this.onAfterFind(models, options);
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

    await this.onBeforeCount(_options);
    const result: number =
      (await this.aggregate(conditions, _options))[0]?.count ?? 0;
    await this.onAfterCount(result, _options);

    return result;
  }

  /**
   * Find multiple entities by turning the provided conditions and options
   * into an aggregation query.
   * @param conditions
   * @param options
   */
  async aggregate(
    conditions: Conditions<ModelType>,
    options?: IQueryOptions<ModelType>
  ) {
    // merge the filter and onBeforeFind options with the $and conditions
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
    const filterKeys = getDeepKeys(conditions).concat(
      Object.keys(sort),
      Object.keys(projection)
    );
    let pipeline: Record<string, any>[] = await getLookupPipeline(
      filterKeys,
      this,
      options
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

    // concatenate the population pipeline
    if (options?.populate !== undefined) {
      // if an empty populate array has been provided, populate the root
      if (options.populate.length === 0) {
        options.populate = Object.keys((this._model.schema as any).virtuals);
      }

      // only populate keys which haven't occurred in the other pipelines
      const populateKeys = options.populate.filter((key) =>
        filterKeys.every((v) => !v.includes(key))
      );
      pipeline = pipeline.concat(
        await getLookupPipeline(populateKeys, this, options)
      );
    }

    if (Object.keys(projection).length) {
      pipeline.push({ $project: projection });
    }

    // execute aggregate with the built pipeline and the one provided through options
    return this._model
      .aggregate(pipeline.concat(options?.pipelines ?? []))
      .option({
        session: options?.session,
        maxTimeMS: options?.maxTimeMS ?? 10000,
      });
  }

  /**
   * Overwrite an entity with the provided payload.
   * @param payload
   * @param options
   * @param mergeCallback
   */
  async update(
    payload: ModelType,
    options?: IQueryOptions<ModelType>,
    mergeCallback?: (
      payload: Partial<ModelType>,
      existing: ModelType
    ) => Promise<ModelType>
  ) {
    // make sure we're not merging a Document
    payload = (payload as any).toObject?.() ?? payload;

    const id = payload._id || payload.id;
    const existing = (await this.findById(id))?.toObject();
    if (!existing) {
      throw new Error("No model found with the provided id");
    }

    let _payload = (await this.onBeforeUpdate(
      payload,
      existing,
      options
    )) as ModelType;
    if (mergeCallback) {
      _payload = await mergeCallback(_payload, existing);
    }

    await this._model.updateOne({ _id: id }, _payload as any, {
      session: options?.session,
    });

    const updated = await this.findById(id, options);
    return this.onAfterUpdate(_payload, updated, options);
  }

  /**
   * Merge an existing entity's fields with the provided payload.
   * @param payload
   * @param options
   */
  merge(payload: Partial<ModelType>, options?: IQueryOptions<ModelType>) {
    return this.update(
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
      if (!existing) {
        continue;
      }

      await this.onBeforeDelete(existing, options);
      await this._model
        .deleteOne(
          { _id: existing._id || existing.id },
          { session: options?.session }
        )
        .exec();

      await this.onAfterDelete(existing, options);
    }

    return selection;
  }

  /**
   * Overridable hook with is called before each create.
   *
   * The returned payload is the payload which is used during the create.
   * @param payload
   * @param options
   */
  async onBeforeCreate(
    payload: ModelType,
    options?: IQueryOptions<ModelType>
  ): Promise<ModelType> {
    return payload;
  }

  /**
   * Overridable hook which is called after each create.
   *
   * The returned object will be used as the return value of the create() method.
   * @param payload
   * @param created
   * @param options
   */
  async onAfterCreate(
    payload: ModelType,
    created: ModelType & Document,
    options?: IQueryOptions<ModelType>
  ): Promise<ModelType & Document> {
    return created;
  }

  /**
   * Overridable hook which is called before each count query.
   *
   * The method exists mainly for analytical purposes.
   * @param options
   */
  async onBeforeCount(options?: IQueryOptions<ModelType>): Promise<void> {
    return;
  }

  /**
   * Overridable hook which is called after each count query.
   *
   * The method exists mainly for analytical purposes.
   * @param resultCount
   * @param options
   */
  async onAfterCount(
    resultCount: number,
    options?: IQueryOptions<ModelType>
  ): Promise<void> {
    return;
  }

  /**
   * Overridable hook which is called before each find query.
   *
   * The returned conditions will be used as extra restrictions for searching the
   * entities. This method is mainly used for defining authorization rules.
   *
   * Note that the returned conditions are also used during population of relations.
   * @param options
   */
  async onBeforeFind(
    options?: IQueryOptions<ModelType>
  ): Promise<Conditions<ModelType>> {
    return {};
  }

  /**
   * Overridable hook which is called after each find query.
   *
   * The returned model array will be used as the return value of the find method.
   * @param result
   * @param options
   */
  async onAfterFind(
    result: (ModelType & Document)[],
    options?: IQueryOptions<ModelType>
  ): Promise<(ModelType & Document)[]> {
    return result;
  }

  /**
   * Overridable hook which is called before each update/merge.
   *
   * The returned payload will be used as input for the update/merge method.
   * @param payload
   * @param existing
   * @param options
   */
  async onBeforeUpdate(
    payload: Partial<ModelType>,
    existing: ModelType,
    options?: IQueryOptions<ModelType>
  ): Promise<Partial<ModelType>> {
    return payload;
  }

  /**
   * Overridable hook which is called after each update/merge.
   *
   * The returned model will be used as the return value of the update/merge method.
   * @param payload
   * @param updated
   * @param options
   */
  async onAfterUpdate(
    payload: Partial<ModelType>,
    updated: ModelType & Document,
    options?: IQueryOptions<ModelType>
  ): Promise<ModelType & Document> {
    return updated;
  }

  /**
   * Overridable hook which is called before each delete.
   * @param existing
   * @param options
   */
  async onBeforeDelete(
    existing: ModelType,
    options?: IQueryOptions<ModelType>
  ): Promise<void> {
    return;
  }

  /**
   * Overridable hook which is called after each delete
   * @param deleted
   * @param options
   */
  async onAfterDelete(
    deleted: ModelType & Document,
    options?: IQueryOptions<ModelType>
  ): Promise<void> {
    return;
  }
}
