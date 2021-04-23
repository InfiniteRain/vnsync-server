import { EventResult } from "./interfaces/EventResult";

/**
 * Each rule should be a function that takes a value of the unknown type and
 * returns a tuple of [boolean, string]. The boolean is whether or not the
 * check has passed the validation, and string is the error message.
 */
type ValidationRule = (arg: unknown) => [boolean, string];

/**
 * A function used to validate event arguments.
 *
 * @param rules Validation rules.
 * @param args Arguments to validate.
 * @returns A failed EventResult or null of validation passed.
 */
export const validateEventArguments = <T = undefined>(
  rules: ValidationRule[],
  args: unknown[]
): EventResult<T> | null => {
  for (const [key, rule] of rules.entries()) {
    const result = rule(args[key] || undefined);

    if (result[0]) {
      continue;
    }

    return {
      status: "fail",
      failMessage: result[1],
    };
  }

  return null;
};

/**
 * A factory function which generates a validation rule for a non-empty string
 * field.
 *
 * @param fieldName The name of the field getting validated.
 * @returns The validation rule.
 */
export const nonEmptyString = (fieldName: string): ValidationRule => (
  field: unknown
) => [
  typeof field === "string" && field.length > 0,
  `${fieldName} should be a non-empty string.`,
];
