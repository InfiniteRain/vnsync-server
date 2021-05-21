/**
 * Interface representing a successful result (outcome) of an event.
 */
export interface EventSuccessResult<T> {
  /**
   * The status of the result.
   */
  status: "ok";

  /**
   * The data associated with the result.
   */
  data: T;
}
