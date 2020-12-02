import { isValidObjectId, ModelPopulateOptions, Types } from "mongoose";
import { castableOperators } from "../constants/castable-operators";
import { IQueryOptions } from "../interfaces/query-options.interface";
import { CrudService } from "../services/crud.abstract.service";
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

        // get any authorization expressions for the related field
        const expression =
          (await _service.getHook("onAuthorization")?.(options ?? {})) ?? {};

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
                  cond: expression,
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

  return pipeline;
};

/**
 * Builds and returns Mongoose population options
 * @param keys
 */
export const getPopulateOptions = async (
  service: CrudService<any>,
  options: IQueryOptions
): Promise<ModelPopulateOptions[]> => {
  // if an empty populate array has been provided, populate the root
  if (options.populate?.length === 0) {
    options.populate = Object.keys((service._model.schema as any).virtuals);
  }

  // build a population structure based on the separated paths
  const populateStructure: Record<string, any> = {};
  for (const key of Array.from(new Set(options.populate))) {
    const cleanKey = key
      .split(".")
      .filter((field) => !field.includes("$") && isNaN(+field));

    let reference = populateStructure;
    for (const field of cleanKey) {
      reference[field] = reference[field] ?? {};
      reference = reference[field];
    }
  }

  // build a select structure to project populated data
  const selectStructure: Record<string, any> = {};
  for (const key of Array.from(new Set(options.select))) {
    const splitKey = key.split(".");
    let reference = selectStructure;
    for (const field of splitKey) {
      reference[field] = reference[field] ?? {};
      reference = reference[field];
    }
  }

  /**
   * Build population options recursively
   * @param populateStructure
   * @param selectStructure
   * @param service
   */
  const recursion = async (
    populateStructure: Record<string, any>,
    selectStructure: Record<string, any>,
    service: CrudService<any>
  ) => {
    const populate: ModelPopulateOptions[] = [];
    for (const [key, children] of Object.entries(populateStructure)) {
      let _service = service;
      // move to the next service based on the path's virtual
      const virtual = (_service._model.schema as any).virtuals[key];
      _service = CrudService.serviceMap[virtual?.options?.ref];
      if (!_service) {
        continue;
      }

      // get any authorization expressions for the related field
      const $expr =
        (await _service.getHook("onAuthorization")?.(options ?? {})) ?? {};
      const match = Object.keys($expr).length ? { $expr } : undefined;
      populate.push({
        path: key,
        select: Object.keys(selectStructure[key] || {}).join(" "),
        match,
        populate: await recursion(
          children,
          selectStructure[key] || {},
          _service
        ),
      });
    }

    return populate;
  };

  return recursion(populateStructure, selectStructure, service);
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

  const castedConditions = { ...conditions };
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

      for (let j = 0; j < schemaFields.length; j++) {
        const schemaField = schemaFields[j];

        const virtual = (service._model.schema as any).virtuals[schemaField];
        service = CrudService.serviceMap[virtual?.options?.ref] || service;

        // determine the type of the field based on the schema and cast the value if necessary
        type =
          (service._model.schema as any)?.paths?.[schemaField]?.instance ||
          type;

        // cast the final field from the path
        if (
          i + 1 === conditionFields.length &&
          j + 1 === schemaFields.length &&
          reference[schemaField] !== null &&
          reference[schemaField] !== undefined
        ) {
          // check if we're casting a mongodb operator directly
          if (schemaField.startsWith("$")) {
            // only cast supported operators
            if (!castableOperators.includes(schemaField)) {
              continue;
            }

            // set the types of typed operators
            if (schemaField === "$exists") {
              type = "Boolean";
            }
            if (schemaField === "$size") {
              type = "Number";
            }
          }

          // cast to the collected field type
          if (type === "ObjectID" && isValidObjectId(reference[schemaField])) {
            reference[schemaField] = new Types.ObjectId(reference[schemaField]);
          } else if (type === "String") {
            reference[schemaField] = reference[schemaField].toString();
          } else if (type === "Number") {
            reference[schemaField] = +reference[schemaField] || 0;
          } else if (type === "Boolean") {
            reference[schemaField] = ["1", "true"].includes(
              (reference[schemaField] + "").toLowerCase()
            );
          } else if (type === "Date") {
            reference[schemaField] = new Date(reference[schemaField]);
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
export const hydrateList = async (
  cursors: any[],
  service: CrudService<any>,
  allowedTime: number,
  options?: IQueryOptions
) => {
  // start timeout timer
  const startTime = Date.now();
  if (allowedTime <= 0) {
    throw new Error("Schema hydration timed out");
  }

  // concatenate the population pipeline
  let populateOptions: ModelPopulateOptions[] = [];
  if (options?.populate !== undefined) {
    populateOptions = await getPopulateOptions(service, options);
  }

  const models: any[] = [];
  for (const cursor of cursors) {
    if (!cursor._id) {
      continue;
    }

    const virtuals = (service._model.schema as any).virtuals;
    for (const field of Object.keys(virtuals)) {
      const virtual = virtuals[field];
      if (!virtual.options.ref || [undefined, null].includes(cursor[field])) {
        continue;
      }
      if (Array.isArray(cursor[field])) {
        cursor[field] = hydrateList(
          cursor[field],
          CrudService.serviceMap[virtual?.options?.ref],
          allowedTime - (Date.now() - startTime)
        );
      } else {
        cursor[field] = hydrateList(
          [cursor[field]],
          CrudService.serviceMap[virtual?.options?.ref],
          allowedTime - (Date.now() - startTime)
        )[0];
      }
    }

    models.push(
      await new Promise((resolve, reject) => {
        service._model
          .hydrate(cursor)
          .populate(populateOptions, (error, result) => {
            if (error) {
              reject(error);
            } else if (Date.now() - startTime > allowedTime) {
              reject("Schema population timed out");
            } else {
              // add options object to model $locals
              result.$locals = options || {};
              resolve(result);
            }
          });
      })
    );
  }
  return models;
};
