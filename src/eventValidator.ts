import { EventResult } from "./interfaces/EventResult";
import { VNSyncSocket } from "./interfaces/VNSyncSocket";

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

/**
 * A factory function which generates a validation rule for a string field.
 *
 * @param fieldName The name of the field getting validated.
 * @returns The validation rule.
 */
export const string = (fieldName: string): ValidationRule => (
  field: unknown
) => [typeof field === "string", `${fieldName} should be a string.`];

/**
 * Validates the room presence of a client.
 *
 * @param socket The socket of the client in question.
 * @param expected Expected presence. True for the client being present in a
 * room, and false for not.
 * @returns A boolean depending on whether the client is in a room or not.
 */
export const validateRoomPresence = <T = undefined>(
  socket: VNSyncSocket,
  expected: boolean
): EventResult<T> | null => {
  const isInRoom = socket.data.room !== null;

  if (isInRoom === expected) {
    return null;
  }

  return {
    status: "fail",
    failMessage: expected
      ? "This user is not yet in a room."
      : "This user is already in a room.",
  };
};
