import { EventFailedResult } from "./EventFailResult";
import { EventSuccessResult } from "./EventSuccessResult";

/**
 * A union type representing an event result.
 */
export type EventResult<T = undefined> =
  | EventSuccessResult<T>
  | EventFailedResult;
