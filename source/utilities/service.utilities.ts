import { ObjectId } from "bson";
import {
  Document,
  isValidObjectId,
  PipelineStage,
  PopulateOptions,
  Types,
} from "mongoose";
import { castableOperators } from "../constants/castable-operators";
import { IPopulateOptions } from "../interfaces/populate-options.interface";
import { IQueryOptions } from "../interfaces/query-options.interface";
import { CrudService } from "../services/crud.abstract.service";
import { Expression } from "../types";
import { Conditions } from "../types/conditions.type";

/**
 * Returns the keys of an object recursively.
 * {a: { b: { c: 1 } d: 1 }, e: [{ f: 1 }], g: 1}
 * returns: ['a', 'a.b', 'a.b.c', 'a.d', 'e', 'e.0.f', 'g']
 * @param object
 * @param stack
 * @param path
 */
export const getDeepKeys = (
  object: Record<string, any>,
  stack: string[] = [],
  path: string[] = [],
  separator = "."
) => {
  if (
    object &&
    typeof object === "object" &&
    object instanceof Types.ObjectId === false
  ) {
    for (const key of Object.keys(object)) {
      // skip empty keys caused by keys ending with '.'
      if (key === undefined) {
        continue;
      }

      // branch off the path and add to the stack
      const branch = [...path];
      stack.push([...branch, key].join(separator));
      branch.push(key);

      // call self on array and object children
      const value = object[key];
      if (Array.isArray(value)) {
        value.forEach((item, i) =>
          getDeepKeys(item, stack, [...branch, i.toString()], separator)
        );
      } else if (typeof value === "object") {
        getDeepKeys(value, stack, [...branch], separator);
      }
    }
  } else {
    stack.push(path.join(separator));
  }

  return stack;
};

/**
 * Deep merge two objects.
 * @param source
 * @param changes
 */
export function deepMerge<Type = Record<string, any>>(
  source: Type,
  changes: Partial<Type>
): Type {
  for (const [key, value] of Object.entries<any>(changes)) {
    if (
      [undefined, null].includes((source as any)[key]) ||
      [undefined, null].includes(value) ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.entries(value).length === 0 ||
      value instanceof Types.ObjectId
    ) {
      (source as any)[key] = value;
    } else {
      (source as any)[key] = deepMerge((source as any)[key], value);
    }
  }

  return source;
}

/**
 * Builds and returns a lookup pipeline to aggregate virtuals
 * @param keys
 */
export const getShallowLookupPipeline = async (
  keys: string[],
  service: CrudService<any>,
  options?: IQueryOptions
): Promise<Conditions[]> => {
  const pipeline: Conditions[] = [];
  const populatedKeys: string[] = [];
  let unsets: string[] = [];
  for (const key of Array.from(new Set(keys))) {
    // filter mongo operators like $in, $or etc.
    const path = key
      .split(".")
      .filter((field) => !field.includes("$") && isNaN(+field));
    const journey: string[] = [];
    let _service = service;
    for (const field of path) {
      // move to the next service based on the path's virtual
      const virtual = (_service._model.schema as any).virtuals[field];
      _service = CrudService.serviceMap[virtual?.options?.ref];
      if (!_service) {
        break;
      }

      // prevent multiple lookups for the same field
      if (!populatedKeys.includes(journey.concat(field).join("."))) {
        const fieldPath = [...journey, field].filter(Boolean).join(".");

        // add the unset fields to the unsets list
        const pathUnset =
          (await _service.callHook("onCensor", options ?? {})) ?? [];
        unsets = unsets.concat(
          pathUnset.map((unset) => `${fieldPath}.${unset}`)
        );

        // get any authorization expressions for the related field
        const expression =
          (await _service.callHook("onAuthorization", options ?? {})) ?? {};

        // create a lookup aggregation to populate the models
        pipeline.push({
          $lookup: {
            from: _service._model.collection.collectionName,
            as: fieldPath,
            localField: [...journey, virtual.options.localField].join("."),
            foreignField: virtual.options.foreignField,
          },
        });

        if (Object.keys(expression).length) {
          pipeline.push({
            $addFields: {
              [fieldPath]: {
                $filter: {
                  input: "$" + fieldPath,
                  cond: contextualizeExpression("$this", expression),
                },
              },
            },
          });
        }

        // unwind the added fields to nested objects
        if (virtual.options.justOne) {
          pipeline.push({
            $unwind: {
              path: `$${journey.concat(field).join(".")}`,
              preserveNullAndEmptyArrays: true,
            },
          });
        }
      }

      // map journey
      journey.push(field);
      populatedKeys.push(journey.join("."));
    }
  }

  // add the unsets to the pipeline if there are any
  if (unsets.length) {
    pipeline.push({ $unset: unsets });
  }

  return pipeline;
};

/**
 * Builds and returns Mongoose population options
 * @param keys
 */
export const getPopulateOptions = async (
  service: CrudService<any>,
  options: IQueryOptions
): Promise<PopulateOptions[]> => {
  if (!options.populate) {
    return [];
  }
  return buildPopulateOptions(options.populate, service, options);
};

/**
 * Build population options recursively
 * @param populateStructure
 * @param selectStructure
 * @param service
 */
const buildPopulateOptions = async (
  populateStructure: (string | IPopulateOptions)[],
  service: CrudService<any>,
  options: IQueryOptions | undefined = undefined
) => {
  // if an empty populate array has been provided, populate the root
  if (populateStructure?.length === 0) {
    populateStructure = Object.keys((service._model.schema as any).virtuals);
  }

  // turn population strings into deep populateOptions objects
  let rawPopulateOptions: IPopulateOptions[] =
    populateStructure?.map((item) => {
      if (typeof item === "string") {
        const paths = item.split(".");
        const option: IPopulateOptions = { path: paths.splice(0, 1)[0] };
        let ref = option;
        for (const path of paths) {
          const option = { path };
          ref.populate = [option];
          ref = option;
        }
        return option;
      }
      return item;
    }) ?? [];

  // merge populate options which share the same path
  const populateOptions = mergePopulateOptions(rawPopulateOptions);

  // turn the PopulateOptions into Mongoose PopulateOptions
  // with authorization rules
  const populate: PopulateOptions[] = [];
  for (const populateOption of populateOptions) {
    let _service = service;
    // move to the next service based on the path's virtual
    const virtual = (_service._model.schema as any).virtuals[
      populateOption.path
    ];
    _service = CrudService.serviceMap[virtual?.options?.ref];
    if (!_service) {
      continue;
    }

    // get any authorization expressions for the related field
    const onAuthorization: Expression | undefined = await _service.callHook(
      "onAuthorization",
      options ?? {}
    );
    const unsets = await _service.callHook("onCensor", options ?? {});
    populate.push({
      model: _service._model,
      localField: virtual.options.localField,
      foreignField: virtual.options.foreignField,
      justOne: virtual.options.justOne,
      path: populateOption.path,
      select: populateOption.select,
      match: {
        $and: [
          castConditions(populateOption.match ?? {}, _service),
          { $expr: onAuthorization ?? {} },
        ],
      },
      perDocumentLimit: +(populateOption.limit ?? 0) || undefined,
      options: {
        sort:
          typeof populateOption.sort === "string"
            ? [populateOption.sort]
            : populateOption.sort,
        skip: +(populateOption.skip ?? 0) || undefined,
        projection: unsets?.reduce((acc, unset) => {
          acc[unset] = 0;
          return acc;
        }, {}),
      },
      populate: populateOption.populate
        ? await buildPopulateOptions(populateOption.populate, _service, options)
        : undefined,
    });
  }
  return populate;
};

/**
 * Merges populates of populateOptions to ensure that path has 1 entry
 * @param populateOptions the list of populate options you want to merge
 * @returns a merged list of populate options
 */
const mergePopulateOptions = (populateOptions: IPopulateOptions[]) => {
  const mergedOptions: IPopulateOptions[] = [];
  const populateRecord: Record<string, IPopulateOptions> = {};
  for (const option of populateOptions) {
    if (!populateRecord[option.path]) {
      populateRecord[option.path] = option;
      mergedOptions.push(populateRecord[option.path]);
    }

    if (option.populate?.length) {
      populateRecord[option.path].populate = option.populate.concat(
        populateRecord[option.path].populate ?? []
      );
    }
  }
  return mergedOptions;
};

export const populateOptionsToLookupPipeline = async (
  rawPopulateOptions: IQueryOptions["populate"],
  service: CrudService<any>,
  options: IQueryOptions | undefined = undefined
): Promise<PipelineStage[] | undefined> => {
  if (!rawPopulateOptions) {
    return undefined;
  }

  const builtPopulateOptions = await buildPopulateOptions(
    rawPopulateOptions,
    service,
    options
  );

  const buildRecursiveLookup = (populateOptions: PopulateOptions[]) => {
    const stages: (
      | PipelineStage.Match
      | PipelineStage.Project
      | PipelineStage.Lookup
      | PipelineStage.Sort
      | PipelineStage.Skip
      | PipelineStage.Limit
      | PipelineStage.Unwind
      | PipelineStage.AddFields
    )[] = [];
    for (const populateOption of populateOptions) {
      const from =
        typeof populateOption.model === "string"
          ? populateOption.model
          : populateOption.model?.collection.collectionName;

      if (!from) {
        continue;
      }

      const postLookupStages: (
        | PipelineStage.Match
        | PipelineStage.Project
        | PipelineStage.Lookup
        | PipelineStage.Sort
        | PipelineStage.Skip
        | PipelineStage.Limit
        | PipelineStage.Unwind
        | PipelineStage.AddFields
      )[] = [];

      // the projection field contains the censored fields. We need to remove them from the projection
      // before performing the rest of the pipeline
      if (
        populateOption.options?.projection &&
        Object.keys(populateOption.options.projection).length
      ) {
        postLookupStages.push({
          $project: populateOption.options.projection as Record<string, any>,
        });
      }

      if (populateOption.match) {
        postLookupStages.push({
          $match: populateOption.match,
        });
      }

      if (populateOption.options?.sort) {
        postLookupStages.push(
          ...optionToPipeline.sort(populateOption.options.sort)
        );
      }

      if (populateOption.options?.skip) {
        postLookupStages.push({
          $skip: populateOption.options.skip,
        });
      }

      if (
        populateOption.options?.perDocumentLimit &&
        populateOption.justOne !== true
      ) {
        postLookupStages.push({
          $limit: populateOption.options.perDocumentLimit,
        });
      }
      if (populateOption.justOne) {
        postLookupStages.push({
          $limit: 1,
        });
      }

      if (populateOption.select?.length) {
        postLookupStages.push(
          ...optionToPipeline.select(populateOption.select)
        );
      }

      stages.push({
        $lookup: {
          from,
          localField: populateOption.localField,
          foreignField: populateOption.foreignField,
          as: populateOption.path,
          pipeline: [
            ...postLookupStages,
            ...buildRecursiveLookup(
              (populateOption.populate as PopulateOptions[]) ?? []
            ),
          ],
        },
      });

      // unwind the looked up field if justOne is true
      if (populateOption.justOne) {
        stages.push({
          $unwind: {
            path: `$${populateOption.path}`,
            preserveNullAndEmptyArrays: true,
          },
        });
        stages.push({
          $addFields: {
            [populateOption.path]: {
              $ifNull: [`$${populateOption.path}`, null],
            },
          },
        });
      }
    }

    return stages;
  };
  return buildRecursiveLookup(builtPopulateOptions);
};

/**
 * Casts basic field types in a conditions object to the correct type
 * based on their Mongoose schemas.
 * @param keys
 */
export const castConditions = (
  conditions: Conditions,
  service: CrudService<any>
): Conditions => {
  // get the keys of the object
  let keys = getDeepKeys(conditions, [], [], "|");

  // filter out shortened versions of extended paths so we pass keys just once
  keys = keys.filter(
    (key) =>
      keys.filter(
        (v) =>
          v.startsWith(key) && v.split("|").length !== key.split("|").length
      ).length === 0
  );

  const castedConditions = deepCopy(conditions);
  for (const key of keys) {
    let reference = castedConditions;
    let type: string | undefined = undefined;
    const conditionFields = key.split("|");
    for (let i = 0; i < conditionFields.length; i++) {
      const conditionField = conditionFields[i];
      const schemaFields = conditionField.split(".");

      // break out of the parent loop when we encounter an ObjectId instance
      if (reference[conditionField] instanceof Types.ObjectId) {
        break;
      }
      let deepService = service;
      let schemaReference = deepService._model.schema as any;
      for (let j = 0; j < schemaFields.length; j++) {
        const schemaField = schemaFields[j];
        schemaReference =
          schemaReference?.paths?.[schemaField] ||
          schemaReference?.options?.type?.paths?.[schemaField];

        const virtual = (deepService._model.schema as any).virtuals[
          schemaField
        ];
        if (virtual?.options?.ref) {
          deepService =
            CrudService.serviceMap[virtual?.options?.ref] || deepService;
          schemaReference = deepService._model.schema as any;
          continue;
        }

        // determine the type of the field based on the schema and cast the value if necessary
        type =
          schemaReference?.$embeddedSchemaType?.instance ||
          schemaReference?.instance ||
          type;

        type = type?.toLowerCase();

        // cast the final field from the path
        if (
          i + 1 === conditionFields.length &&
          j + 1 === schemaFields.length &&
          reference[conditionField] !== null &&
          reference[conditionField] !== undefined
        ) {
          // check if we're casting a mongodb operator directly
          if (schemaField.startsWith("$")) {
            // only cast supported operators
            if (!castableOperators.includes(schemaField)) {
              continue;
            }

            // set the types of typed operators
            if (schemaField === "$exists") {
              type = "boolean";
            }
            if (schemaField === "$size") {
              type = "number";
            }
          }

          // cast to the collected field type
          if (
            type === "objectid" &&
            isValidObjectId(reference[conditionField])
          ) {
            reference[conditionField] = ObjectId.createFromHexString(
              reference[conditionField]
            );
          } else if (type === "string") {
            reference[conditionField] = reference[conditionField].toString();
          } else if (type === "number") {
            reference[conditionField] = +reference[conditionField] || 0;
          } else if (type === "boolean") {
            reference[conditionField] = ["1", "true"].includes(
              (reference[conditionField] + "").toLowerCase()
            );
          } else if (type === "date") {
            reference[conditionField] = new Date(reference[conditionField]);
          }
        }
      }

      // move the reference deeper into the conditions object
      reference = reference[conditionField];
    }
  }

  return castedConditions;
};

/**
 * Recursively hydrates a list of models
 * @param cursors
 * @param service
 */
export const hydrateList = (
  cursors: any[],
  service: CrudService<any>,
  allowedTime: number
) => {
  // start timeout timer
  const startTime = Date.now();
  if (allowedTime <= 0) {
    throw new Error("Schema hydration timed out");
  }

  const models: any[] = [];
  for (const cursor of cursors) {
    if (!cursor._id) {
      continue;
    }

    const virtuals = (service._model.schema as any).virtuals;
    const hydratedVirtualsByField: Record<string, any> = {};
    for (const field of Object.keys(virtuals)) {
      const virtual = virtuals[field];
      if (!virtual.options.ref || cursor[field] === undefined) {
        continue;
      }

      if (cursor[field] === null) {
        hydratedVirtualsByField[field] = null;
      } else if (Array.isArray(cursor[field])) {
        hydratedVirtualsByField[field] = hydrateList(
          cursor[field],
          CrudService.serviceMap[virtual?.options?.ref],
          allowedTime - (Date.now() - startTime)
        );
      } else {
        hydratedVirtualsByField[field] = hydrateList(
          [cursor[field]],
          CrudService.serviceMap[virtual?.options?.ref],
          allowedTime - (Date.now() - startTime)
        )[0];
      }
    }

    const model = service._model.hydrate(cursor) as Document<any>;
    for (const field of Object.keys(hydratedVirtualsByField)) {
      model[field] = hydratedVirtualsByField[field];
    }

    models.push(model);
  }
  return models;
};

/**
 * A collection of methods used to transform IQueryOption options to
 * aggregation pipelines. If undefined or insufficient data is provided
 * the methods will return an empty pipeline.
 */
export const optionToPipeline = {
  /**
   * Transform the sort option into a pipeline containing the $sort stage
   * @param sort
   * @returns
   */
  sort: (
    sort?: string[] | Record<string, 1 | -1> | string
  ): PipelineStage.Sort[] => {
    if (typeof sort === "object" && !Array.isArray(sort)) {
      return [{ $sort: sort }];
    }

    if (typeof sort === "string") {
      sort = [sort];
    }

    if (!sort?.length) {
      return [];
    }

    const $sort: Record<string, 1 | -1> = {};
    sort?.forEach((field) => {
      const desc = field.startsWith("-");
      const cleanField = desc ? field.replace("-", "") : field;
      $sort[cleanField] = desc ? -1 : 1;
    });

    return [{ $sort }];
  },

  /**
   * Returns a $sample stage with the provided limit.
   * @param limit
   * @returns
   */
  random: (limit?: number) => {
    if (limit === undefined) {
      return [];
    }
    return [{ $sample: { size: limit } }];
  },

  /**
   * Transform the skip option into a pipeline containing the $skip stage
   * @param skip
   * @returns
   */
  skip: (skip?: number) => {
    if (skip === undefined) {
      return [];
    }
    return [{ $skip: skip }];
  },

  /**
   * Transform the limit option into a pipeline containing the $limit stage
   * @param limit
   * @returns
   */
  limit: (limit?: number) => {
    if (limit === undefined) {
      return [];
    }
    return [{ $limit: limit }];
  },

  /**
   * Transform the select option into a pipeline containing the $project stage
   * @param select
   * @returns
   */
  select: (select?: string[]): PipelineStage.Project[] => {
    const projection: Record<string, any> = {};
    for (const path of select ?? []) {
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
    select
      ?.filter((field) => !field.includes("."))
      .forEach((field) => (projection[field] = 1));

    if (!Object.keys(projection).length) {
      return [];
    }
    return [{ $project: projection }];
  },

  /**
   * Transform the distinct option into a pipeline containing a $group and
   * $replaceRoot stage.
   * @param distinct
   * @returns
   */
  distinct: (distinct?: string | string[]) => {
    if (!distinct || !distinct.length) {
      return [];
    }

    const distinctFields = Array.isArray(distinct) ? distinct : [distinct];
    return [
      {
        $group: {
          _id: distinctFields.reduce((acc, field) => {
            acc[field] = "$" + field;
            return acc;
          }, {}),
          doc: { $first: "$$ROOT" },
        },
      },
      { $replaceRoot: { newRoot: "$doc" } },
    ];
  },
};

/**
 * Moves recursively through the object to point all array values from an
 * expression that start with a $ to the given context.
 *
 * @example ..("$this", { $eq: [ "$name", "Martin" ] }) returns { $eq: [ "$$this.name", "Martin" ] }
 * @param context
 * @param expression
 */
export const contextualizeExpression = (
  context: string,
  expression: Expression | string
) => {
  if (Array.isArray(expression)) {
    return expression.map((item) => contextualizeExpression(context, item));
  }

  if (typeof expression === "string" && expression.startsWith("$")) {
    return "$" + expression.replace("$", context + ".");
  }

  if (typeof expression === "object" && !isValidObjectId(expression)) {
    return Object.entries(expression).reduce((acc, [key, value]) => {
      const newValue = contextualizeExpression(context, value);
      return { ...acc, [key]: newValue };
    }, {});
  }

  return expression;
};

/**
 * Copies all nested objects in the given object and replaces all references
 * @param object
 */
export const deepCopy = (object: Record<string, any>) => {
  // deep copy every item in arrays
  if (Array.isArray(object)) {
    return object.map(deepCopy);
  }

  // deep copy every item in objects
  if (
    Object.entries(object ?? {}).length &&
    typeof object === "object" &&
    !isValidObjectId(object)
  ) {
    return Object.entries(object).reduce((acc, [key, value]) => {
      const newValue = deepCopy(value);
      return { ...acc, [key]: newValue };
    }, {});
  }

  // return primitive values
  return object;
};

/**
 * Returns an array of the deepest values within a nested object.
 */
export const getDeepestValues = (object: Object) => {
  if (Object.keys(object).length === 0) {
    return [];
  }

  const recur = (
    object: Object | any[] | string | number | boolean,
    accumulator: any[] = []
  ) => {
    // deep copy every item in arrays
    if (Array.isArray(object)) {
      object.forEach((item) => recur(item, accumulator));
    }

    // deep copy every item in objects
    else if (
      Object.entries(object ?? {}).length &&
      typeof object === "object" &&
      !isValidObjectId(object)
    ) {
      Object.entries(object).forEach(([key, value]) => {
        recur(value, accumulator);
      });
    } else {
      accumulator.push(object);
    }

    return accumulator;
  };

  return recur(object);
};
