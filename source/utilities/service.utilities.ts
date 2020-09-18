import { isValidObjectId, Types } from "mongoose";
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
  if (object && typeof object === "object") {
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
      Array.isArray(value)
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
export const getLookupPipeline = async (
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
        const expression = await _service.onAuthorization(options);

        // create a lookup aggregation to populate the models
        pipeline.push({
          $lookup: {
            from: _service._model.collection.collectionName,
            as: fieldPath,
            localField: [...journey, virtual.options.localField].join("."),
            foreignField: virtual.options.foreignField,
          },
        });
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
 * Casts basic field types in a conditions object to the correct type
 * based on their Mongoose schemas.
 * @param keys
 */
export const castConditions = (
  conditions: Conditions,
  service: CrudService<any>
): Conditions => {
  let keys = getDeepKeys(conditions, [], [], "|");
  keys = keys.filter((key) => keys.filter((v) => v.includes(key)).length === 1);

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

export const hydrateList = (cursors: any[], service: CrudService<any>) => {
  let _service = service;
  const models: any[] = [];
  for (const cursor of cursors) {
    const virtuals = (_service._model.schema as any).virtuals;
    for (const field of Object.keys(virtuals)) {
      const virtual = virtuals[field];
      if (!virtual.options.ref || [undefined, null].includes(cursor[field])) {
        continue;
      }
      if (virtual.options.justOne) {
        cursor[field] = hydrateList(
          [cursor[field]],
          CrudService.serviceMap[virtual?.options?.ref]
        )[0];
      } else {
        cursor[field] = hydrateList(
          cursor[field],
          CrudService.serviceMap[virtual?.options?.ref]
        );
      }
    }

    models.push(_service._model.hydrate(cursor));
  }
  return models;
};
